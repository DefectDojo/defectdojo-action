declare const __ACTION_VERSION__: string;
export const ACTION_VERSION = typeof __ACTION_VERSION__ === "string" ? __ACTION_VERSION__ : "dev";

export class DojoError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface Response<T> {
  status: number;
  body: T;
}

const MAX_BODY_IN_ERROR = 600;

/**
 * Flattens DRF validation errors ({"field": ["msg"]}) into one readable line. DefectDojo also adds "message"
 * (a Python repr of the same errors) and "pro" (product announcements), which are left out when field errors exist.
 */
export function describeErrorBody(body: unknown): string {
  if (body === null || body === undefined || body === "") return "";
  if (typeof body === "string") return body.slice(0, MAX_BODY_IN_ERROR);
  if (Array.isArray(body)) return body.map(describeErrorBody).join("; ");
  if (typeof body === "object") {
    const entries = Object.entries(body as Record<string, unknown>).filter(([key]) => key !== "pro");
    const hasFields = entries.some(([key]) => key !== "detail" && key !== "message");
    return entries
      .filter(([key]) => !(hasFields && key === "message"))
      .map(([key, value]) => (key === "detail" || key === "message" ? describeErrorBody(value) : `${key}: ${describeErrorBody(value)}`))
      .join("; ")
      .slice(0, MAX_BODY_IN_ERROR);
  }
  return String(body);
}

function explainStatus(status: number, what: string): string {
  switch (status) {
    case 401:
      return `DefectDojo rejected the API token (HTTP 401) while ${what}. Check that api-token holds a current API v2 key.`;
    case 403:
      return `The API token's user is not allowed to do this (HTTP 403) while ${what}. The user needs import permission on the product, or permission to create it when auto-create-context is on.`;
    case 413:
      return `The report is larger than this DefectDojo instance accepts (HTTP 413) while ${what}. The limit is DD_SCAN_FILE_MAX_SIZE on the server, and any proxy in front of it may set its own.`;
    default:
      return `DefectDojo returned HTTP ${status} while ${what}.`;
  }
}

export class DojoClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request<T>(method: string, path: string, what: string, options: { body?: FormData; signal?: AbortSignal; allow?: number[] } = {}): Promise<Response<T>> {
    let res: globalThis.Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Token ${this.token}`,
          Accept: "application/json",
          "User-Agent": `defectdojo-action/${ACTION_VERSION}`,
        },
        body: options.body,
        signal: options.signal,
        redirect: "follow",
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
        throw new DojoError(`Timed out while ${what}. Raise timeout-minutes if the import is large.`);
      }
      const detail = cause?.code ?? cause?.message ?? (err as Error).message;
      const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(detail)
        ? " If the instance uses a private certificate authority, set NODE_EXTRA_CA_CERTS to its certificate on this step."
        : "";
      throw new DojoError(`Could not reach ${new URL(this.baseUrl).host} while ${what} (${detail}).${tls}`);
    }

    const raw = await res.text();
    let body: unknown = raw;
    if (raw && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        // Keep the raw text.
      }
    }

    if (res.ok || options.allow?.includes(res.status)) return { status: res.status, body: body as T };

    const detail = describeErrorBody(typeof body === "string" && /<html/i.test(body) ? "" : body);
    throw new DojoError(explainStatus(res.status, what) + (detail ? ` ${detail}` : ""), res.status);
  }
}
