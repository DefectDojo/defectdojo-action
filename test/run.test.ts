import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import { actionEnv, fakeDojo, findingsCount, formFields, outputs, stats } from "./helpers.js";

let stdout: string;

beforeEach(() => {
  stdout = "";
  process.exitCode = undefined;
  // @actions/core caches the summary path on first use; each test has its own file.
  (core.summary as unknown as { _filePath?: string })._filePath = undefined;
  core.summary.emptyBuffer();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

const LICENSE = "/api/v2/license/license_status/";

describe("Community Edition", () => {
  it("reimports, reports counts and pitches Pro for a skipped Pro input", async () => {
    const env = actionEnv({ "push-to-connector": "true", tags: "ci,sast" });
    const { calls } = fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 404, body: { detail: "Not found." } };
      if (call.path === "/api/v2/reimport-scan/") {
        return {
          status: 201,
          body: {
            test_id: 7,
            engagement_id: 3,
            product_id: 2,
            statistics: {
              before: stats({ high: 2 }),
              delta: { created: stats({ high: 1 }), closed: stats({ low: 1 }), reactivated: stats({}), untouched: stats({ high: 2 }) },
              after: stats({ high: 3 }),
            },
            deduplication_complete: true,
            pro: ["Get Pro from $100/mo or email us at hello@defectdojo.com"],
          },
        };
      }
      return findingsCount(call, { high: 3 });
    });

    await run();

    expect(process.exitCode).toBeUndefined();
    const fields = formFields(calls.find((c) => c.method === "POST")?.form);
    expect(fields).toMatchObject({
      scan_type: ["SARIF"],
      product_name: ["payments-api"],
      product_type_name: ["acme"],
      engagement_name: ["main"],
      auto_create_context: ["true"],
      tags: ["ci", "sast"],
      build_id: ["4242"],
      commit_hash: ["abc123"],
      deduplication_execution_mode: ["async_wait"],
      file: ["<file results.sarif>"],
    });
    expect(fields.push_to_connector).toBeUndefined();
    expect(fields.active).toBeUndefined();
    expect(fields.verified).toBeUndefined();

    expect(stdout).toContain("::warning::push-to-connector is a DefectDojo Pro feature, so Community Edition skips it.");
    expect(outputs(env.output())).toMatchObject({ edition: "community", "test-id": "7", "test-url": "https://dojo.example.com/test/7", active: "3", "active-high": "3", created: "1", closed: "1" });

    const summary = env.summary();
    expect(summary).toContain("[test 7](https://dojo.example.com/test/7)");
    expect(summary).toContain("| High | 3 | 1 | 0 | 0 |");
    expect(summary).toContain("### What DefectDojo Pro adds");
    expect(summary).toContain("You set `push-to-connector`, which Community Edition skips.");
    expect(summary).not.toContain("$100");
    expect(summary).toContain("Sensei scans code repositories");
  });

  it("does not import when strict is on and a Pro input is set", async () => {
    actionEnv({ "background-import": "true", strict: "true" });
    const { calls } = fakeDojo((call) => (call.path === LICENSE ? { status: 404 } : undefined));
    await run();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("strict is on, so the import was not run.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("fails the step at the fail-on severity", async () => {
    actionEnv({ "fail-on": "high", reimport: "false" });
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 404 };
      if (call.path === "/api/v2/import-scan/") return { status: 201, body: { test: 9, statistics: { after: stats({ critical: 1, low: 4 }) } } };
      return findingsCount(call, { critical: 1, low: 4 });
    });
    await run();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("::error::1 active finding at High or above (fail-on: High). https://dojo.example.com/test/9");
  });

  it("passes when nothing reaches the fail-on severity", async () => {
    const env = actionEnv({ "fail-on": "critical" });
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 404 };
      if (call.method === "POST") return { status: 201, body: { test_id: 4, statistics: { after: stats({ high: 2 }) } } };
      return findingsCount(call, { high: 2 });
    });
    await run();
    expect(process.exitCode).toBeUndefined();
    expect(env.summary()).toContain("**Passed:** no active findings at Critical or above.");
  });

  it("flattens validation errors into one line", async () => {
    actionEnv({ "scan-type": "Not A Scanner" });
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 404 };
      // The shape DefectDojo's exception handler returns: field errors, a repr of them, and announcements.
      if (call.method === "POST") {
        return {
          status: 400,
          body: {
            scan_type: ['"Not A Scanner" is not a valid choice.'],
            message: "{'scan_type': [ErrorDetail(string='\"Not A Scanner\" is not a valid choice.', code='invalid_choice')]}",
            pro: ["Pro comes with support."],
          },
        };
      }
      return undefined;
    });
    await run();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('::error::DefectDojo returned HTTP 400 while reimporting the report. scan_type: "Not A Scanner" is not a valid choice.\n');
  });

  it("explains a rejected token", async () => {
    actionEnv({});
    fakeDojo(() => ({ status: 401, body: { detail: "Invalid token." } }));
    await run();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("DefectDojo rejected the API token (HTTP 401) while checking the DefectDojo edition.");
    expect(stdout).toContain("::add-mask::secret-token");
    expect(stdout.split("\n").filter((line) => !line.startsWith("::add-mask::")).join("\n")).not.toContain("secret-token");
  });

  it("explains a missing report", async () => {
    actionEnv({ file: "/nope/results.sarif" });
    fakeDojo((call) => (call.path === LICENSE ? { status: 404 } : undefined));
    await run();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('file "/nope/results.sarif" does not exist.');
  });
});

describe("Requests", () => {
  it("refuses to follow a redirect and names the address to use", async () => {
    actionEnv({ "defectdojo-url": "http://dojo.example.com" });
    const { calls } = fakeDojo(() => ({ status: 301, headers: { location: "https://dojo.example.com/api/v2/license/license_status/" } }));
    await run();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("::warning::defectdojo-url uses http://");
    expect(stdout).toContain("does not follow redirects. Set defectdojo-url to https://dojo.example.com.");
    expect(calls).toHaveLength(1);
  });

  it("retries a read after a 502 but never repeats an upload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    actionEnv({});
    let edition = 0;
    let uploads = 0;
    fakeDojo((call) => {
      if (call.path === LICENSE) return ++edition === 1 ? { status: 502 } : { status: 404 };
      if (call.method === "POST") {
        uploads++;
        return { status: 502 };
      }
      return undefined;
    });
    const done = run();
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(edition).toBe(2);
    expect(uploads).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("DefectDojo returned HTTP 502 while reimporting the report.");
  });

  it("says counts may include duplicates when the server doesn't report deduplication", async () => {
    const env = actionEnv({});
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 404 };
      if (call.method === "POST") return { status: 201, body: { test_id: 5, statistics: { after: stats({ low: 1 }) } } };
      return findingsCount(call, { low: 1 });
    });
    await run();
    expect(env.summary()).toContain("Deduplication was still running");
  });
});

describe("DefectDojo Pro", () => {
  it("recognizes Pro releases from before license_status", async () => {
    const env = actionEnv({ "push-to-connector": "true" });
    const { calls } = fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 404 };
      if (call.path === "/api/v2/license/") return { status: 200, body: { count: 1, results: [] } };
      if (call.method === "POST") return { status: 201, body: { test_id: 21, statistics: { after: stats({}) }, deduplication_complete: true } };
      return findingsCount(call, {});
    });
    await run();
    expect(outputs(env.output()).edition).toBe("pro");
    expect(formFields(calls.find((c) => c.method === "POST")?.form).push_to_connector).toEqual(["true"]);
    expect(stdout).not.toContain("::warning::");
  });

  it("treats an Error status as a failed background import", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    actionEnv({ "background-import": "true" });
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 200, body: {} };
      if (call.method === "POST") return { status: 201, body: { test_id: 22, status: "Processing" } };
      if (call.path === "/api/v2/tests/22/") return { status: 200, body: { status: "Error: could not parse the report" } };
      return undefined;
    });
    const done = run();
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("could not process the report in test 22 (Error: could not parse the report).");
  });

  it("fails when a background import parsed findings but the test is empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    actionEnv({ "background-import": "true", "fail-on": "high" });
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 200, body: {} };
      if (call.method === "POST") return { status: 201, body: { test_id: 23, status: "Processing", findings_parsed: 5 } };
      if (call.path === "/api/v2/tests/23/") return { status: 200, body: { status: "Processed" } };
      return findingsCount(call, {});
    });
    const done = run();
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("DefectDojo parsed 5 findings, but test 23 has none after processing");
  });

  it("sends Pro inputs, waits for a background import and skips the pitch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const env = actionEnv({ "background-import": "true", "push-to-connector": "true", "organization-name": "Fintech" });
    let polls = 0;
    const { calls } = fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 200, body: { status: "valid" } };
      if (call.method === "POST") return { status: 201, body: { test_id: 11, status: "Processing", findings_parsed: 40 } };
      if (call.path === "/api/v2/tests/11/") return { status: 200, body: { status: ++polls < 2 ? "Post Processing - Deduplication" : "Processed" } };
      return findingsCount(call, { medium: 5 });
    });

    const done = run();
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();

    expect(process.exitCode).toBeUndefined();
    const fields = formFields(calls.find((c) => c.method === "POST")?.form);
    expect(fields).toMatchObject({ background_import: ["true"], push_to_connector: ["true"], product_type_name: ["Fintech"] });
    expect(fields.deduplication_execution_mode).toBeUndefined();
    expect(polls).toBe(2);
    expect(outputs(env.output())).toMatchObject({ edition: "pro", "test-id": "11", active: "5" });
    expect(stdout).not.toContain("::warning::");
    expect(env.summary()).not.toContain("What DefectDojo Pro adds");
    expect(env.summary()).toContain("on DefectDojo Pro");
  });

  it("fails when background processing fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    actionEnv({ "background-import": "true" });
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 200, body: {} };
      if (call.method === "POST") return { status: 201, body: { test_id: 12, status: "Processing" } };
      if (call.path === "/api/v2/tests/12/") return { status: 200, body: { status: "Failed" } };
      return undefined;
    });
    const done = run();
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("DefectDojo could not process the report in test 12 (Failed).");
  });

  it("surfaces Pro's name resolution warning", async () => {
    const env = actionEnv({});
    fakeDojo((call) => {
      if (call.path === LICENSE) return { status: 200, body: {} };
      if (call.method === "POST") {
        return { status: 201, body: { test_id: 13, statistics: { after: stats({}) }, name_resolution: { message: 'Rename "payments-api" to "Payments" in the pipeline.' } } };
      }
      return findingsCount(call, {});
    });
    await run();
    expect(stdout).toContain('::warning::Rename "payments-api" to "Payments" in the pipeline.');
    expect(env.summary()).toContain('> Rename "payments-api" to "Payments" in the pipeline.');
  });
});
