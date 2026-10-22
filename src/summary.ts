import { PRO_FEATURES, PRO_LINK, type Edition, type ProFeature } from "./edition.js";
import { SEVERITIES, type Config, type Severity } from "./inputs.js";
import type { Counts, Delta } from "./importer.js";

export interface RunReport {
  config: Config;
  edition: Edition;
  testId: number;
  testUrl: string;
  counts: Counts;
  delta?: Delta;
  gate?: { threshold: Severity; count: number };
  skipped: ProFeature[];
  serverNotes: string[];
  dedupIncomplete: boolean;
}

const EDITION_LABEL: Record<Edition, string> = { pro: "DefectDojo Pro", community: "Community Edition", unknown: "DefectDojo" };

function escape(text: string): string {
  return text.replace(/[|<>]/g, (c) => `\\${c}`);
}

export function renderSummary(r: RunReport): string {
  const { config } = r;
  const lines: string[] = [];
  const verb = config.reimport ? "Reimported" : "Imported";
  lines.push(`## DefectDojo`);
  lines.push("");
  lines.push(
    `${verb} \`${escape(config.file)}\` (${escape(config.scanType)}) into [test ${r.testId}](${r.testUrl}): ` +
      `${escape(config.productTypeName)} / ${escape(config.productName)} / ${escape(config.engagementName)}, on ${EDITION_LABEL[r.edition]}.`,
  );
  lines.push("");

  const header = ["Severity", "Active"];
  if (r.delta) header.push("New", "Closed", "Reactivated");
  lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
  for (const severity of [...SEVERITIES].reverse()) {
    const d = r.delta?.bySeverity[severity];
    lines.push(`| ${severity} | ${r.counts[severity]} |${d ? ` ${d.created} | ${d.closed} | ${d.reactivated} |` : ""}`);
  }
  if (r.delta) {
    const active = SEVERITIES.reduce((sum, s) => sum + r.counts[s], 0);
    lines.push(`| **Total** | **${active}** | **${r.delta.created}** | **${r.delta.closed}** | **${r.delta.reactivated}** |`);
  }
  lines.push("");

  if (r.gate) {
    lines.push(
      r.gate.count > 0
        ? `**Failed:** ${r.gate.count} active finding${r.gate.count === 1 ? "" : "s"} at ${r.gate.threshold} or above.`
        : `**Passed:** no active findings at ${r.gate.threshold} or above.`,
    );
    lines.push("");
  }
  if (r.dedupIncomplete) {
    lines.push("> Deduplication was still running when DefectDojo answered, so these counts may include findings it later marks as duplicates.");
    lines.push("");
  }

  const notes = r.serverNotes.filter(Boolean);
  if (notes.length) {
    for (const note of notes) lines.push(`> ${escape(note)}`);
    lines.push("");
  }

  if (r.edition === "community") {
    const skippedInputs = new Set(r.skipped.map((f) => f.input));
    lines.push("### What DefectDojo Pro adds");
    lines.push("");
    for (const feature of r.skipped) lines.push(`- ${feature.pitch} You set \`${feature.input}\`, which Community Edition skips.`);
    for (const feature of PRO_FEATURES.filter((f) => !skippedInputs.has(f.input))) lines.push(`- ${feature.pitch}`);
    lines.push("- Sensei drafts fixes for findings like these and opens them as pull requests.");
    lines.push("");
    lines.push(`[Compare editions](${PRO_LINK}&utm_content=job-summary)`);
    lines.push("");
  }
  return lines.join("\n");
}
