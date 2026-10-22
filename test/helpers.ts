import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export interface Call {
  method: string;
  path: string;
  form?: FormData;
}

type Handler = (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** Routes fetch() to handlers and records every call. */
export function fakeDojo(handler: Handler): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = { method: init.method ?? "GET", path: u.pathname + u.search, form: init.body instanceof FormData ? init.body : undefined };
    calls.push(call);
    const res = handler(call) ?? { status: 404, body: { detail: "Not found." } };
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json", ...res.headers },
    });
  });
  return { calls };
}

const SEVERITIES = ["info", "low", "medium", "high", "critical"];

export function stats(perSeverity: Record<string, number>): Record<string, { active: number; total: number }> {
  const out: Record<string, { active: number; total: number }> = {};
  let sum = 0;
  for (const s of SEVERITIES) {
    const n = perSeverity[s] ?? 0;
    sum += n;
    out[s] = { active: n, total: n };
  }
  out.total = { active: sum, total: sum };
  return out;
}

/** Answers the findings count query from a severity map. */
export function findingsCount(call: Call, counts: Record<string, number>): { status: number; body: unknown } | undefined {
  if (!call.path.startsWith("/api/v2/findings/")) return undefined;
  const severity = new URLSearchParams(call.path.split("?")[1]).get("severity");
  const count = severity === null ? Object.values(counts).reduce((a, b) => a + b, 0) : (counts[severity.toLowerCase()] ?? 0);
  return { status: 200, body: { count, results: [] } };
}

export interface Env {
  dir: string;
  report: string;
  output: () => string;
  summary: () => string;
}

/** A clean GitHub Actions environment with a report file and the given inputs. */
export function actionEnv(inputs: Record<string, string>, extra: Record<string, string> = {}): Env {
  for (const key of Object.keys(process.env)) if (key.startsWith("INPUT_") || key.startsWith("GITHUB_")) delete process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "dd-action-"));
  const report = join(dir, "results.sarif");
  writeFileSync(report, '{"version":"2.1.0","runs":[]}');
  const output = join(dir, "output");
  const summary = join(dir, "summary.md");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  Object.assign(process.env, {
    GITHUB_REPOSITORY: "acme/payments-api",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: "abc123",
    GITHUB_RUN_ID: "4242",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    ...extra,
  });
  const all = { "defectdojo-url": "https://dojo.example.com", "api-token": "secret-token", file: report, "scan-type": "SARIF", ...inputs };
  for (const [name, value] of Object.entries(all)) process.env[`INPUT_${name.toUpperCase()}`] = value;
  return { dir, report, output: () => readFileSync(output, "utf8"), summary: () => readFileSync(summary, "utf8") };
}

export function outputs(raw: string): Record<string, string> {
  // GITHUB_OUTPUT uses name<<delimiter\nvalue\ndelimiter blocks.
  const out: Record<string, string> = {};
  const re = /^(.+?)<<(.+)\n([\s\S]*?)\n\2$/gm;
  for (const m of raw.matchAll(re)) out[m[1]!] = m[3]!;
  return out;
}

export function formFields(form: FormData | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of form?.entries() ?? []) (out[key] ??= []).push(typeof value === "string" ? value : `<file ${(value as File).name}>`);
  return out;
}
