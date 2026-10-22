import * as core from "@actions/core";
import { DojoClient, DojoError } from "./client.js";
import { detectEdition, PRO_LINK, requestedProFeatures } from "./edition.js";
import { activeCounts, atOrAbove, deltaOf, findingCount, runImport, testIdOf, waitForProcessing } from "./importer.js";
import { InputError, readConfig } from "./inputs.js";
import { renderSummary } from "./summary.js";

export async function run(): Promise<void> {
  try {
    const config = readConfig();
    const deadline = Date.now() + config.timeoutMinutes * 60_000;
    const client = new DojoClient(config.url, config.token);
    const host = new URL(config.url).hostname;
    if (config.url.startsWith("http:") && !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      core.warning("defectdojo-url uses http://, so the API token and the report cross the network unencrypted. Use https:// if the instance supports it.");
    }

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
    const waited = await waitForProcessing(client, testId, response, deadline);
    // Pro can record a failed background import as Processed. A parsed report that left a new test empty is the tell.
    if (waited && (response.findings_parsed ?? 0) > 0 && config.minimumSeverity === "Info" && (await findingCount(client, testId)) === 0) {
      throw new DojoError(
        `DefectDojo parsed ${response.findings_parsed} findings, but test ${testId} has none after processing, so the background import most likely failed. Check the test in DefectDojo.`,
      );
    }

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

    // response.pro (Community Edition's product announcements) is left out: the summary has its own Pro section.
    const serverNotes = [response.name_resolution?.message].filter((n): n is string => typeof n === "string");
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
          // Servers before 3.1.0 don't report it and deduplicate in the background after answering.
          dedupIncomplete: response.deduplication_complete === false || (response.deduplication_complete === undefined && !waited),
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
