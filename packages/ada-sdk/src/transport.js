/** HTTP transport for the ADA ingestion API.
 *
 * One place that knows the wire format: bearer auth, JSON, timeout, and the
 * retry classification. Both the SDK (mobile surface) and the direct API
 * client (desktop surface) sit on top of this.
 */

export class AdaHttpError extends Error {
  constructor(message, { status, body, retryable }) {
    super(message);
    this.name = "AdaHttpError";
    this.status = status ?? 0;
    this.body = body;
    this.retryable = retryable;
  }
}

/** Network failure, 429, and 5xx are worth another attempt. A 4xx means the
 *  request itself is wrong and will stay wrong. */
function isRetryableStatus(status) {
  return status === 429 || status === 408 || status >= 500;
}

export async function adaFetch(
  path,
  { baseUrl, apiKey, method = "GET", body, timeoutMs = 4000, query } = {}
) {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause?.name === "AbortError";
    throw new AdaHttpError(
      aborted ? `ADA request timed out after ${timeoutMs}ms: ${method} ${path}`
              : `ADA request failed: ${method} ${path}: ${cause?.message ?? cause}`,
      { status: 0, retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  }

  if (!response.ok) {
    throw new AdaHttpError(
      `ADA ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`,
      { status: response.status, body: payload, retryable: isRetryableStatus(response.status) }
    );
  }
  return payload;
}

export function backoffMs(attempt, base = 250, cap = 4000) {
  const exponential = Math.min(cap, base * 2 ** attempt);
  return Math.round(exponential * (0.5 + Math.random() * 0.5)); // jitter
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
