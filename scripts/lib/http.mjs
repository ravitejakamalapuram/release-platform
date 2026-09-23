// Minimal JSON-over-HTTP client for Google APIs. `fetch` is injectable for tests.

export class ApiError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/** Pull the human-readable message out of a Google API error payload. */
export function googleErrorMessage(body, fallback) {
  if (body && typeof body === 'object') {
    const e = body.error;
    if (e && typeof e === 'object' && e.message) return e.message;
    if (typeof e === 'string') return body.error_description ? `${e}: ${body.error_description}` : e;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  return fallback;
}

/**
 * Perform a request against a Google API and return the parsed JSON body.
 * Throws ApiError (with .status and .body) on any non-2xx response.
 */
export async function request({ method = 'GET', url, token, json, body, contentType, fetchImpl = globalThis.fetch }) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload = body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (body !== undefined) {
    headers['Content-Type'] = contentType ?? 'application/octet-stream';
  }

  const res = await fetchImpl(url, { method, headers, body: payload });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Keep raw text; some error pages are HTML.
  }
  if (!res.ok) {
    const msg = googleErrorMessage(parsed, `HTTP ${res.status}`);
    throw new ApiError(`${method} ${redact(url)} failed (${res.status}): ${msg}`, { status: res.status, body: parsed, url });
  }
  return parsed;
}

// Never leak query strings (they never carry secrets here, but keep logs short).
function redact(url) {
  return String(url).split('?')[0];
}
