import { readFileSync } from "node:fs";
import * as core from "@actions/core";

export const SEVERITIES = ["Info", "Low", "Medium", "High", "Critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

const GROUP_BY = ["component_name", "component_name+component_version", "file_path", "finding_title", "vuln_id_from_tool"];

export interface Config {
  url: string;
  token: string;
  file: string;
  scanType: string;
  productName: string;
  productTypeName: string;
  engagementName: string;
  testTitle?: string;
  reimport: boolean;
  autoCreateContext: boolean;
  closeOldFindings?: boolean;
  closeOldFindingsProductScope?: boolean;
  doNotReactivate?: boolean;
  minimumSeverity: Severity;
  active?: boolean;
  verified?: boolean;
  tags: string[];
  applyTagsToFindings?: boolean;
  service?: string;
  environment?: string;
  version?: string;
  buildId?: string;
  branchTag?: string;
  commitHash?: string;
  sourceCodeManagementUri?: string;
  groupBy?: string;
  deduplicationOnEngagement?: boolean;
  pushToJira?: boolean;
  failOn?: Severity;
  timeoutMinutes: number;
  strict: boolean;
  pro: {
    pushToConnector?: boolean;
    backgroundImport?: boolean;
  };
}

export class InputError extends Error {}

function text(name: string): string | undefined {
  const value = core.getInput(name).trim();
  return value === "" ? undefined : value;
}

function bool(name: string): boolean | undefined {
  const value = text(name);
  if (value === undefined) return undefined;
  if (/^(true|yes|1)$/i.test(value)) return true;
  if (/^(false|no|0)$/i.test(value)) return false;
  throw new InputError(`${name} must be true or false, not "${value}".`);
}

function severity(name: string, value: string): Severity {
  const match = SEVERITIES.find((s) => s.toLowerCase() === value.toLowerCase());
  if (!match) throw new InputError(`${name} must be one of ${SEVERITIES.join(", ")}, not "${value}".`);
  return match;
}

/** Either the classic name or its Pro label, never both. */
function aliased(classic: string, label: string): string | undefined {
  const a = text(classic);
  const b = text(label);
  if (a && b && a !== b) throw new InputError(`Set ${classic} or ${label}, not both.`);
  return a ?? b;
}

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(`defectdojo-url "${raw}" is not a URL. Use the address you open DefectDojo at, for example https://defectdojo.example.com.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new InputError("defectdojo-url must start with https:// or http://.");
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/api\/v2$/, "");
}

interface GitHubContext {
  owner?: string;
  repo?: string;
  branch?: string;
  sha?: string;
  runId?: string;
  repoUrl?: string;
  /** True when the run is for something other than the default branch: a pull request, the merge queue, a tag or another branch. */
  offDefaultBranch: boolean;
}

export function githubContext(env: NodeJS.ProcessEnv = process.env): GitHubContext {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  let event: { pull_request?: { head?: { sha?: string } }; merge_group?: { base_ref?: string }; repository?: { default_branch?: string } } = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      // Work from the environment alone.
    }
  }

  // On pull requests GITHUB_SHA is the temporary merge commit, so record the head commit instead.
  const sha = (eventName.startsWith("pull_request") ? event.pull_request?.head?.sha : undefined) ?? env.GITHUB_SHA;
  let branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || undefined;
  // Merge queue refs are unique per run (gh-readonly-queue/main/pr-12-<sha>), so share one engagement per base branch.
  if (eventName === "merge_group") {
    const base = event.merge_group?.base_ref?.replace(/^refs\/heads\//, "");
    if (base) branch = `merge-queue/${base}`;
  }
  const defaultBranch = event.repository?.default_branch;
  const offDefaultBranch = defaultBranch
    ? env.GITHUB_REF_TYPE === "tag" || eventName.startsWith("pull_request") || eventName === "merge_group" || branch !== defaultBranch
    : env.GITHUB_REF_TYPE === "tag" || eventName.startsWith("pull_request") || eventName === "merge_group";

  return {
    owner: owner || undefined,
    repo: repo || undefined,
    branch,
    sha,
    runId: env.GITHUB_RUN_ID,
    repoUrl: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : undefined,
    offDefaultBranch,
  };
}

function required(name: string, value: string | undefined, hint: string): string {
  if (!value) throw new InputError(`${name} is required. ${hint}`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gh = githubContext(env);

  const token = required("api-token", text("api-token"), "Pass a DefectDojo API v2 key from a secret, for example ${{ secrets.DEFECTDOJO_API_TOKEN }}.");
  core.setSecret(token);
  // A stray character would otherwise surface in fetch's header error, which quotes the value.
  if (!/^[\x21-\x7e]+$/.test(token)) throw new InputError("api-token contains spaces, line breaks or other characters an API key can't have. Check the secret's value.");

  const groupBy = text("group-by");
  if (groupBy && !GROUP_BY.includes(groupBy)) throw new InputError(`group-by must be one of ${GROUP_BY.join(", ")}.`);

  const failOn = text("fail-on");
  const timeoutMinutes = Number(text("timeout-minutes") ?? "30");
  // GitHub stops a job after 6 hours, and longer timers overflow.
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 360) throw new InputError("timeout-minutes must be a number from 1 to 360.");

  const reimport = bool("reimport") ?? true;
  const closeOldFindingsProductScope = bool("close-old-findings-product-scope");
  const doNotReactivate = bool("do-not-reactivate");
  if (reimport && closeOldFindingsProductScope !== undefined) {
    throw new InputError("close-old-findings-product-scope only applies when reimport is false.");
  }
  if (!reimport && doNotReactivate !== undefined) throw new InputError("do-not-reactivate only applies when reimport is true.");

  return {
    url: normalizeUrl(required("defectdojo-url", text("defectdojo-url"), "Set it to the address of your DefectDojo instance.")),
    token,
    file: required("file", text("file"), "Point it at the report your scanner wrote."),
    scanType: required("scan-type", text("scan-type"), 'Use the DefectDojo scan type name, for example "SARIF" or "Trivy Scan".'),
    productName: required("product-name", aliased("product-name", "asset-name") ?? gh.repo, "Set product-name (or asset-name)."),
    productTypeName: required("product-type-name", aliased("product-type-name", "organization-name") ?? gh.owner, "Set product-type-name (or organization-name)."),
    engagementName: required("engagement-name", text("engagement-name") ?? gh.branch, "Set engagement-name."),
    testTitle: text("test-title"),
    reimport,
    autoCreateContext: bool("auto-create-context") ?? true,
    closeOldFindings: bool("close-old-findings"),
    closeOldFindingsProductScope,
    doNotReactivate,
    minimumSeverity: severity("minimum-severity", text("minimum-severity") ?? "Info"),
    active: bool("active"),
    verified: bool("verified"),
    tags: (text("tags") ?? "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean),
    applyTagsToFindings: bool("apply-tags-to-findings"),
    service: text("service"),
    environment: text("environment"),
    version: text("version"),
    buildId: text("build-id") ?? gh.runId,
    branchTag: text("branch-tag") ?? gh.branch,
    commitHash: text("commit-hash") ?? gh.sha,
    sourceCodeManagementUri: text("source-code-management-uri") ?? gh.repoUrl,
    groupBy,
    // Off the default branch, the engagement is created to deduplicate within itself. Otherwise findings first seen on a
    // branch would mark the default branch's copies as duplicates, and an abandoned branch would keep them active.
    deduplicationOnEngagement: bool("deduplication-on-engagement") ?? (text("engagement-name") === undefined && gh.offDefaultBranch ? true : undefined),
    pushToJira: bool("push-to-jira"),
    failOn: failOn === undefined || failOn.toLowerCase() === "none" ? undefined : severity("fail-on", failOn),
    timeoutMinutes,
    strict: bool("strict") ?? false,
    pro: {
      pushToConnector: bool("push-to-connector"),
      backgroundImport: bool("background-import"),
    },
  };
}
