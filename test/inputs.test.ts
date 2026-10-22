import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeUrl, readConfig } from "../src/inputs.js";
import { actionEnv } from "./helpers.js";

describe("readConfig", () => {
  it("fills names and build metadata from the GitHub run", () => {
    actionEnv({});
    const c = readConfig();
    expect(c).toMatchObject({
      productName: "payments-api",
      productTypeName: "acme",
      engagementName: "main",
      reimport: true,
      autoCreateContext: true,
      buildId: "4242",
      branchTag: "main",
      commitHash: "abc123",
      sourceCodeManagementUri: "https://github.com/acme/payments-api",
      minimumSeverity: "Info",
      failOn: undefined,
      strict: false,
    });
    expect(c.active).toBeUndefined();
    expect(c.verified).toBeUndefined();
    expect(c.closeOldFindings).toBeUndefined();
  });

  it("uses the pull request branch and head commit", () => {
    const env = actionEnv({});
    const event = join(env.dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: "headsha" } } }));
    Object.assign(process.env, { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_HEAD_REF: "fix-login", GITHUB_REF_NAME: "17/merge", GITHUB_SHA: "mergesha" });
    const c = readConfig();
    expect(c.commitHash).toBe("headsha");
    expect(c.branchTag).toBe("fix-login");
    expect(c.engagementName).toBe("fix-login");
  });

  it("isolates engagements off the default branch so they can't mark its findings as duplicates", () => {
    const env = actionEnv({});
    const event = join(env.dir, "event.json");
    const write = (payload: object) => writeFileSync(event, JSON.stringify({ repository: { default_branch: "main" }, ...payload }));
    process.env.GITHUB_EVENT_PATH = event;

    write({});
    Object.assign(process.env, { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main", GITHUB_REF_TYPE: "branch" });
    expect(readConfig().deduplicationOnEngagement).toBeUndefined();

    Object.assign(process.env, { GITHUB_REF_NAME: "feature-x" });
    expect(readConfig().deduplicationOnEngagement).toBe(true);

    Object.assign(process.env, { GITHUB_REF_NAME: "v1.2.0", GITHUB_REF_TYPE: "tag" });
    expect(readConfig()).toMatchObject({ engagementName: "v1.2.0", deduplicationOnEngagement: true });

    write({ pull_request: { head: { sha: "headsha" } } });
    Object.assign(process.env, { GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "fix-login", GITHUB_REF_NAME: "17/merge", GITHUB_REF_TYPE: "branch" });
    expect(readConfig()).toMatchObject({ engagementName: "fix-login", deduplicationOnEngagement: true });

    // An explicit engagement or setting is the caller's choice.
    process.env["INPUT_ENGAGEMENT-NAME"] = "Pipeline";
    expect(readConfig().deduplicationOnEngagement).toBeUndefined();
    process.env["INPUT_ENGAGEMENT-NAME"] = "";
    process.env["INPUT_DEDUPLICATION-ON-ENGAGEMENT"] = "false";
    expect(readConfig().deduplicationOnEngagement).toBe(false);
  });

  it("gives the merge queue one engagement per base branch", () => {
    const env = actionEnv({});
    const event = join(env.dir, "event.json");
    writeFileSync(event, JSON.stringify({ repository: { default_branch: "main" }, merge_group: { base_ref: "refs/heads/main" } }));
    Object.assign(process.env, { GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: "merge_group", GITHUB_REF_NAME: "gh-readonly-queue/main/pr-12-abc" });
    expect(readConfig()).toMatchObject({ engagementName: "merge-queue/main", deduplicationOnEngagement: true });
  });

  it("rejects a token with characters an API key can't have, without echoing it", () => {
    actionEnv({ "api-token": "abc def" });
    expect(() => readConfig()).toThrow(/^api-token contains spaces/);
  });

  it("caps timeout-minutes at GitHub's six hour job limit", () => {
    actionEnv({ "timeout-minutes": "100000" });
    expect(() => readConfig()).toThrow("timeout-minutes must be a number from 1 to 360.");
  });

  it("accepts Pro's asset and organization names", () => {
    actionEnv({ "asset-name": "Payments", "organization-name": "Fintech" });
    expect(readConfig()).toMatchObject({ productName: "Payments", productTypeName: "Fintech" });
  });

  it("rejects a product name and a different asset name together", () => {
    actionEnv({ "product-name": "A", "asset-name": "B" });
    expect(() => readConfig()).toThrow("Set product-name or asset-name, not both.");
  });

  it("rejects a boolean it can't read", () => {
    actionEnv({ reimport: "maybe" });
    expect(() => readConfig()).toThrow('reimport must be true or false, not "maybe".');
  });

  it("reads severities in any case and none for fail-on", () => {
    actionEnv({ "fail-on": "HIGH", "minimum-severity": "medium" });
    expect(readConfig()).toMatchObject({ failOn: "High", minimumSeverity: "Medium" });
    actionEnv({ "fail-on": "None" });
    expect(readConfig().failOn).toBeUndefined();
  });

  it("rejects options for the other import mode", () => {
    actionEnv({ "close-old-findings-product-scope": "true" });
    expect(() => readConfig()).toThrow("only applies when reimport is false");
    actionEnv({ reimport: "false", "do-not-reactivate": "true" });
    expect(() => readConfig()).toThrow("only applies when reimport is true");
  });

  it("splits tags on commas and new lines", () => {
    actionEnv({ tags: "ci, sast\nnightly" });
    expect(readConfig().tags).toEqual(["ci", "sast", "nightly"]);
  });

  it("requires the token", () => {
    actionEnv({ "api-token": "" });
    expect(() => readConfig()).toThrow("api-token is required");
  });
});

describe("normalizeUrl", () => {
  it("strips trailing slashes and an /api/v2 suffix", () => {
    expect(normalizeUrl("https://dojo.example.com/")).toBe("https://dojo.example.com");
    expect(normalizeUrl("https://dojo.example.com/api/v2/")).toBe("https://dojo.example.com");
    expect(normalizeUrl("https://example.com/dojo")).toBe("https://example.com/dojo");
  });

  it("rejects something that isn't a URL", () => {
    expect(() => normalizeUrl("dojo.example.com")).toThrow("is not a URL");
    expect(() => normalizeUrl("ftp://dojo.example.com")).toThrow("must start with https://");
  });
});
