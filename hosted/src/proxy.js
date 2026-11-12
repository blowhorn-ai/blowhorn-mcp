// SPDX-License-Identifier: Apache-2.0
/*
 * The transport half of the gateway: carries one MCP request to Blowhorn
 * Cloud's /mcp and the answer back, and does nothing else. The Worker and
 * Cloud's /mcp are one MCP service edge. Cloud owns the canonical resource
 * and audience https://cloud.blowhorn.ai/mcp, the tokens and the tools; this
 * module never reads, mints or checks a credential, and never decides what a
 * token is audience for. RFC 9728 metadata is served by src/metadata.js.
 *
 * The rules, each held by test/proxy.test.js:
 *  - The upstream URL is the constant base (cloudBase) plus the route's own
 *    path. It is never built from the inbound host, path or query.
 *  - Only the headers in REQUEST_HEADERS go to Cloud. No cookie, no
 *    forwarded host, address or protocol, no client identity, no Origin.
 *  - Only the headers in RESPONSE_HEADERS come back. No Set-Cookie, no
 *    Location, no Access-Control-*: the Worker applies its own CORS.
 *  - A redirect from Cloud is never followed and never passed on: 502.
 *  - The answer's body is streamed, never buffered. The 20 s timeout covers
 *    the status and headers only, so a long-lived SSE stream is not cut.
 *  - The request body goes out as the exact bytes received.
 */
import pkg from "../package.json" with { type: "json" };
import { definition } from "./errors.js";

export const VERSION = pkg.version;
export const USER_AGENT = `blowhorn-mcp-hosted/${VERSION}`;
export const DEFAULT_BASE = "https://cloud.blowhorn.ai";
export const TIMEOUT_MS = 20_000;
export const MAX_REQUEST_BYTES = 1024 * 1024;

const ALLOWED_BASES = [DEFAULT_BASE];

/**
 * The only paths the gateway serves, each mapped to the same path on Cloud.
 * Everything else is a 404 from the Worker. `methods` are the ones carried to
 * Cloud; the Worker answers OPTIONS itself, and src/index.js answers a
 * GET /mcp with no usable Bearer token. The metadata routes are public
 * RFC 9728 documents answered locally by src/metadata.js (not forwarded), so
 * a client that starts at https://mcp.blowhorn.ai learns Cloud's Blowhorn
 * issuer and the canonical audience without depending on Cloud's tenant host
 * strings.
 */
export const ROUTES = Object.freeze({
  "/mcp": Object.freeze({ kind: "mcp", methods: Object.freeze(["POST", "GET", "DELETE"]) }),
  "/.well-known/oauth-protected-resource/mcp": Object.freeze({ kind: "metadata", methods: Object.freeze(["GET", "HEAD"]) }),
  "/.well-known/oauth-protected-resource": Object.freeze({ kind: "metadata", methods: Object.freeze(["GET", "HEAD"]) }),
});

/** Request headers carried to Cloud on /mcp. Anything not listed is dropped. */
export const REQUEST_HEADERS = Object.freeze(["Authorization", "Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID", "traceparent", "tracestate"]);
/** Answer headers carried back to the client. Content-Length is not: the runtime frames the streamed body. */
export const RESPONSE_HEADERS = Object.freeze(["Content-Type", "WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version", "Allow", "Retry-After", "Cache-Control", "Link"]);

/**
 * The Cloud base URL from `env.CLOUD_API_BASE`, without a trailing slash, or
 * null when it is not exactly an allowed origin (the gateway then refuses to
 * serve), so a changed variable can never send credentials to another host.
 */
export function cloudBase(env = {}) {
  const raw = String(env.CLOUD_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  return ALLOWED_BASES.includes(raw) ? raw : null;
}

/** The headers to send Cloud: `names` from `inbound`, plus the gateway's own User-Agent. */
export function forwardHeaders(inbound, names) {
  const out = new Headers();
  for (const name of names) {
    const value = inbound.get(name);
    if (value !== null) out.set(name, value);
  }
  out.set("User-Agent", USER_AGENT);
  return out;
}

/** The headers to return to the client: RESPONSE_HEADERS from Cloud's answer. */
export function returnHeaders(upstream) {
  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/** The client did not finish sending its body within the read budget. */
export class BodyTimeoutError extends Error {}

/**
 * The request body as the exact bytes received, or null when it is over
 * `max`. Reads at most max + 1 bytes: a body over the cap is never held. The
 * whole read has `timeoutMs` (the same 20 s budget as the trip to Cloud), so
 * a client that trickles bytes cannot hold the request open; past it the
 * body is cancelled and a BodyTimeoutError is thrown.
 */
export async function readBounded(request, max = MAX_REQUEST_BYTES, timeoutMs = TIMEOUT_MS) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeoutError("request body read timed out")), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof BodyTimeoutError) await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    expired.catch(() => {});
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Carries one request to Cloud. Resolves to `{ response }` (Cloud's answer,
 * its body still a stream) or `{ failure }`, one of the outcomes in
 * src/errors.js: upstream_unreachable, upstream_timeout or upstream_redirect.
 * Never throws for a network failure.
 */
export async function forward({ base, path, method, headers, body, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetchImpl(`${base}${path}`, { method, headers, body, redirect: "manual", signal: controller.signal });
  } catch (err) {
    return { failure: controller.signal.aborted ? "upstream_timeout" : "upstream_unreachable", error: err?.name ?? "Error" };
  } finally {
    clearTimeout(timer);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    // Release the connection; nothing from a redirect is read or passed on.
    await upstream.body?.cancel().catch(() => {});
    return { failure: "upstream_redirect", error: String(upstream.status) };
  }
  if (upstream.status < 200 || upstream.status > 599) {
    await upstream.body?.cancel().catch(() => {});
    return { failure: "upstream_unreachable", error: "status" };
  }
  return { response: upstream };
}

const FAILURE_STATUS = Object.freeze({ upstream_unreachable: 502, upstream_timeout: 504, upstream_redirect: 502, request_timeout: 408 });

/**
 * The answer for a failed trip to Cloud (502 or 504), or for a client body that
 * did not arrive in time (408), a JSON-RPC internal
 * error whose message is the code's short description and whose data is its
 * ErrorDefinition (src/errors.js), with the given CORS headers.
 */
export function failureResponse(outcome, headers = {}) {
  const d = definition(outcome);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: d.shortDescription, data: d } }), {
    status: FAILURE_STATUS[outcome],
    headers: { "Content-Type": "application/json", ...headers },
  });
}
