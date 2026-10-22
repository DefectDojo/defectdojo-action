import { openAsBlob, statSync } from "node:fs";
import { basename } from "node:path";
import * as core from "@actions/core";
import { DojoError, type DojoClient } from "./client.js";
import { PRO_FEATURES, type Edition } from "./edition.js";
import { InputError, SEVERITIES, type Config, type Severity } from "./inputs.js";

type SeverityStats = Record<string, { active?: number; total?: number } | undefined>;

export interface ImportResponse {
  test_id?: number;
  test?: number;
  engagement_id?: number;
  product_id?: number;
  product_type_id?: number;
  statistics?: {
    before?: SeverityStats;
    delta?: Record<"created" | "closed" | "reactivated" | "untouched", SeverityStats | undefined>;
    after?: SeverityStats;
  };
  deduplication_complete?: boolean;
  pro?: string[];
  status?: string;
  findings_parsed?: number;
  message?: string;
  name_resolution?: { message?: string };
}

const TERMINAL = new Set(["Processed", "Failed"]);
const POLL_INTERVAL_MS = 5000;

function add(form: FormData, field: string, value: string | boolean | undefined): void {
  if (value === undefined) return;
  form.append(field, typeof value === "boolean" ? String(value) : value);
}

export async function buildForm(config: Config, edition: Edition): Promise<FormData> {
  let size: number;
  try {
    size = statSync(config.file).size;
  } catch {
    throw new InputError(`file "${config.file}" does not exist. Check the path your scanner wrote the report to.`);
  }
  if (size === 0) throw new InputError(`file "${config.file}" is empty, so there is nothing to import.`);

  const form = new FormData();
  add(form, "scan_type", config.scanType);
  add(form, "product_type_name", config.productTypeName);
  add(form, "product_name", config.productName);
  add(form, "engagement_name", config.engagementName);
  add(form, "test_title", config.testTitle);
  add(form, "auto_create_context", config.autoCreateContext);
  add(form, "close_old_findings", config.closeOldFindings);
  add(form, "close_old_findings_product_scope", config.closeOldFindingsProductScope);
  add(form, "do_not_reactivate", config.doNotReactivate);
  add(form, "minimum_severity", config.minimumSeverity);
  // Left out unless set, so the scanner's own active and verified values are kept.
  add(form, "active", config.active);
  add(form, "verified", config.verified);
  for (const tag of config.tags) form.append("tags", tag);
  add(form, "apply_tags_to_findings", config.applyTagsToFindings);
  add(form, "service", config.service);
  add(form, "environment", config.environment);
  add(form, "version", config.version);
  add(form, "build_id", config.buildId);
  add(form, "branch_tag", config.branchTag);
  add(form, "commit_hash", config.commitHash);
  add(form, "source_code_management_uri", config.sourceCodeManagementUri);
  add(form, "group_by", config.groupBy);
  add(form, "deduplication_on_engagement", config.deduplicationOnEngagement);
  add(form, "push_to_jira", config.pushToJira);

  if (edition !== "community") {
    for (const feature of PRO_FEATURES) add(form, feature.field, feature.enabled(config));
  }
  // Wait for deduplication so the counts and the gate see the final state. Older servers ignore the field.
  if (!(edition !== "community" && config.pro.backgroundImport)) add(form, "deduplication_execution_mode", "async_wait");

  form.append("file", await openAsBlob(config.file), basename(config.file));
  return form;
}

export async function runImport(client: DojoClient, config: Config, edition: Edition, signal: AbortSignal): Promise<ImportResponse> {
  const path = config.reimport ? "/api/v2/reimport-scan/" : "/api/v2/import-scan/";
  const what = config.reimport ? "reimporting the report" : "importing the report";
  const res = await client.request<ImportResponse>("POST", path, what, { body: await buildForm(config, edition), signal });
  if (typeof res.body !== "object" || res.body === null) throw new DojoError(`DefectDojo answered ${what} with something other than JSON.`);
  return res.body;
}

export function testIdOf(response: ImportResponse): number {
  const id = response.test_id ?? response.test;
  if (typeof id !== "number") throw new DojoError("DefectDojo did not say which test the import went into.");
  return id;
}

/** Background imports (Pro) answer before the findings exist; follow the test until it settles. */
export async function waitForProcessing(client: DojoClient, testId: number, response: ImportResponse, deadline: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  let status = response.status;
  if (status === undefined || TERMINAL.has(status)) {
    if (status === "Failed") throw new DojoError(`DefectDojo could not process the report in test ${testId}.`);
    return;
  }
  core.info(`DefectDojo is processing the report in the background (${status}).`);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await client.request<{ status?: string }>("GET", `/api/v2/tests/${testId}/`, "checking the import's progress");
    const next = res.body.status;
    if (next === undefined) {
      core.warning("DefectDojo did not report the test's status, so the counts below may be incomplete.");
      return;
    }
    if (next !== status) core.info(`Status: ${next}`);
    status = next;
    if (status === "Processed") return;
    if (status === "Failed") throw new DojoError(`DefectDojo could not process the report in test ${testId}.`);
  }
  throw new DojoError(`Test ${testId} was still processing when timeout-minutes ran out. The import continues in DefectDojo.`);
}

export type Counts = Record<Severity, number>;

/** Active, non-duplicate findings in the test, by severity. */
export async function activeCounts(client: DojoClient, testId: number): Promise<Counts> {
  const entries = await Promise.all(
    SEVERITIES.map(async (severity) => {
      const query = new URLSearchParams({ test: String(testId), active: "true", duplicate: "false", severity, limit: "1" });
      const res = await client.request<{ count?: number }>("GET", `/api/v2/findings/?${query}`, "counting the test's findings");
      return [severity, res.body.count ?? 0] as const;
    }),
  );
  return Object.fromEntries(entries) as Counts;
}

type Change = "created" | "closed" | "reactivated" | "untouched";
export type Delta = Record<Change, number> & { bySeverity: Record<Severity, Record<Change, number>> };

function deltaFrom(changes: Partial<Record<Change, SeverityStats | undefined>>): Delta {
  const count = (stats: SeverityStats | undefined, key: string) => stats?.[key]?.total ?? 0;
  const pick = (key: string) => ({
    created: count(changes.created, key),
    closed: count(changes.closed, key),
    reactivated: count(changes.reactivated, key),
    untouched: count(changes.untouched, key),
  });
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, pick(s.toLowerCase())])) as Delta["bySeverity"];
  return { ...pick("total"), bySeverity };
}

/** What the import changed, when the server reports it. */
export function deltaOf(response: ImportResponse, reimport: boolean): Delta | undefined {
  const stats = response.statistics;
  if (!stats) return undefined;
  if (stats.delta) return deltaFrom(stats.delta);
  // A fresh import (or a reimport that created its test) creates every finding in the test.
  if (!reimport || !stats.before) return deltaFrom({ created: stats.after });
  return undefined;
}

export function atOrAbove(counts: Counts, threshold: Severity): number {
  return SEVERITIES.slice(SEVERITIES.indexOf(threshold)).reduce((sum, s) => sum + counts[s], 0);
}
