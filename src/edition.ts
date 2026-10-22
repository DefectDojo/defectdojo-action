import type { Config } from "./inputs.js";
import type { DojoClient } from "./client.js";

export type Edition = "pro" | "community" | "unknown";

export const PRO_LINK = "https://defectdojo.com/pricing?utm_source=github&utm_medium=action&utm_campaign=defectdojo-action";

export interface ProFeature {
  input: string;
  field: string;
  enabled: (config: Config) => boolean | undefined;
  pitch: string;
}

/** Inputs that only DefectDojo Pro acts on. Community Edition ignores the fields, so the action warns instead. */
export const PRO_FEATURES: ProFeature[] = [
  {
    input: "push-to-connector",
    field: "push_to_connector",
    enabled: (c) => c.pro.pushToConnector,
    pitch: "Push new findings to Jira, ServiceNow and other connected tools as they are imported.",
  },
  {
    input: "background-import",
    field: "background_import",
    enabled: (c) => c.pro.backgroundImport,
    pitch: "Import large reports in the background so the pipeline keeps moving.",
  },
];

/**
 * Pro answers the license API, Community Edition has no such route. license_status/ arrived in Pro 2.53.5, so older
 * Pro is recognized by the license/ list route instead.
 */
export async function detectEdition(client: DojoClient): Promise<{ edition: Edition; status: number }> {
  const what = "checking the DefectDojo edition";
  let res = await client.request("GET", "/api/v2/license/license_status/", what, { allow: [403, 404] });
  if (res.status === 404) res = await client.request("GET", "/api/v2/license/", what, { allow: [403, 404] });
  if (res.status === 404) return { edition: "community", status: res.status };
  if (res.status >= 200 && res.status < 300) return { edition: "pro", status: res.status };
  return { edition: "unknown", status: res.status };
}

/** Pro-only inputs the caller set to true. */
export function requestedProFeatures(config: Config): ProFeature[] {
  return PRO_FEATURES.filter((f) => f.enabled(config) === true);
}
