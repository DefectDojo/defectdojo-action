import { EnvHttpProxyAgent } from "undici";

declare const __ACTION_VERSION__: string;
export const ACTION_VERSION = typeof __ACTION_VERSION__ === "string" ? __ACTION_VERSION__ : "dev";

export class DojoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

export interface Response<T> {
  status: number;
  body: T;
}

const MAX_BODY_IN_ERROR = 600;
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 5000, 10000];

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

interface RequestOptions {
  body?: FormData;
  signal?: AbortSignal;
  allow?: number[];
}

export class DojoClient {
  // Imports can take longer than undici's default 5 minute header timeout. timeout-minutes bounds them instead.
  // EnvHttpProxyAgent keeps HTTPS_PROXY / NO_PROXY working.
  private readonly dispatcher = new EnvHttpProxyAgent({ headersTimeout: 0, bodyTimeout: 0 });

  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async request<T>(method: string, path: string, what: string, options: RequestOptions = {}): Promise<Response<T>> {
    // Only reads are retried: repeating an upload could import the report twice.
    const attempts = method === "GET" ? RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, what, options);
      } catch (err) {
        const retryable = err instanceof DojoError && (err.status === undefined ? !err.timedOut : RETRY_STATUSES.has(err.status));
        if (!retryable || attempt >= attempts) throw err;
        await this.sleep(RETRY_DELAYS_MS[attempt - 1]!);
      }
    }
  }

  private async once<T>(method: string, path: string, what: string, options: RequestOptions): Promise<Response<T>> {
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
        // Never follow: a redirected POST loses its body, and a cross-origin one would send the report elsewhere.
        redirect: "manual",
        // @ts-expect-error dispatcher is an undici extension to fetch's options.
        dispatcher: this.dispatcher,
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
        throw new DojoError(`Timed out while ${what}. Raise timeout-minutes if the import is large.`, undefined, true);
      }
      const detail = cause?.code ?? cause?.message ?? (err as Error).message;
      const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(detail)
        ? " If the instance uses a private certificate authority, set NODE_EXTRA_CA_CERTS to its certificate on this step."
        : "";
      throw new DojoError(`Could not reach ${new URL(this.baseUrl).host} while ${what} (${detail}).${tls}`);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      const target = location ? new URL(location, this.baseUrl + path) : undefined;
      const suggestion = target ? ` Set defectdojo-url to ${target.origin}${target.pathname.replace(/\/api\/v2\/.*$/, "")}.` : "";
      throw new DojoError(`DefectDojo redirected the request (HTTP ${res.status}) while ${what}, and the action does not follow redirects.${suggestion}`, res.status);
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
