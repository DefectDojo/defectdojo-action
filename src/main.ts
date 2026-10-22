import * as core from "@actions/core";
import { DojoClient, DojoError } from "./client.js";
import { detectEdition, PRO_LINK, requestedProFeatures } from "./edition.js";
import { activeCounts, atOrAbove, deltaOf, runImport, testIdOf, waitForProcessing } from "./importer.js";
import { InputError, readConfig } from "./inputs.js";
import { renderSummary } from "./summary.js";

export async function run(): Promise<void> {
  try {
    const config = readConfig();
    const deadline = Date.now() + config.timeoutMinutes * 60_000;
    const client = new DojoClient(config.url, config.token);

    const { edition, status } = await detectEdition(client);
    core.info(`DefectDojo edition: ${edition === "pro" ? "Pro" : edition === "community" ? "Community Edition" : `unknown (HTTP ${status})`}`);
    core.setOutput("edition", edition);

    const skipped = edition === "community" ? requestedProFeatures(config) : [];
    for (const feature of skipped) {
      const message = `${feature.input} is a DefectDojo Pro feature, so Community Edition skips it. ${PRO_LINK}&utm_content=warning`;
      if (config.strict) throw new InputError(`${message} strict is on, so the import was not run.`);
      core.warning(message);
    }

    core.info(`${config.reimport ? "Reimporting" : "Importing"} ${config.file} as "${config.scanType}" into ${config.productTypeName} / ${config.productName} / ${config.engagementName}`);
    const response = await runImport(client, config, edition, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
    const testId = testIdOf(response);
    await waitForProcessing(client, testId, response, deadline);

    const counts = await activeCounts(client, testId);
    const delta = deltaOf(response, config.reimport);
    const testUrl = `${config.url}/test/${testId}`;
    const gate = config.failOn ? { threshold: config.failOn, count: atOrAbove(counts, config.failOn) } : undefined;

    core.setOutput("test-id", testId);
    core.setOutput("test-url", testUrl);
    if (response.engagement_id !== undefined) core.setOutput("engagement-id", response.engagement_id);
    if (response.product_id !== undefined) core.setOutput("product-id", response.product_id);
    core.setOutput("active", Object.values(counts).reduce((a, b) => a + b, 0));
    for (const [severity, count] of Object.entries(counts)) core.setOutput(`active-${severity.toLowerCase()}`, count);
    if (delta) {
      core.setOutput("created", delta.created);
      core.setOutput("closed", delta.closed);
      core.setOutput("reactivated", delta.reactivated);
    }

    const serverNotes = [response.name_resolution?.message, ...(response.pro ?? [])].filter((n): n is string => typeof n === "string");
    if (response.name_resolution?.message) core.warning(response.name_resolution.message);

    await core.summary
      .addRaw(
        renderSummary({
          config,
          edition,
          testId,
          testUrl,
          counts,
          delta,
          gate,
          skipped,
          serverNotes,
          dedupIncomplete: response.deduplication_complete === false,
        }),
      )
      .write();

    core.info(`Test: ${testUrl}`);
    if (gate && gate.count > 0) {
      core.setFailed(`${gate.count} active finding${gate.count === 1 ? "" : "s"} at ${gate.threshold} or above (fail-on: ${gate.threshold}). ${testUrl}`);
    }
  } catch (err) {
    if (err instanceof InputError || err instanceof DojoError) core.setFailed(err.message);
    else core.setFailed(`Unexpected error: ${(err as Error).stack ?? String(err)}`);
  }
}
