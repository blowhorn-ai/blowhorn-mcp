// SPDX-License-Identifier: Apache-2.0
/*
 * blowhorn-mcp-hosted: an INTERIM transport proxy for the MCP resource
 * https://mcp.blowhorn.ai/mcp until Blowhorn Cloud answers on that origin
 * itself (blowhorn-ai/blowhorn#1509, U3). Retire this Worker then.
 *
 * This Worker is not an MCP server, not an OAuth authorization server, and
 * not a token gateway: it carries each MCP request to
 * https://cloud.blowhorn.ai/mcp and the answer back, byte for byte
 * (src/proxy.js), except a GET /mcp with no usable Bearer token, which it
 * answers with the 401 challenge and does not forward. Cloud owns the
 * canonical resource and audience
 * (https://cloud.blowhorn.ai/mcp), token validation and the tools. The Worker
 * serves RFC 9728 metadata locally (src/metadata.js) pointing at Cloud's
 * Blowhorn issuer, and rewrites Cloud's 401 WWW-Authenticate so
 * resource_metadata names this origin. Nothing here knows what a valid token
 * is.
 *
 * What the Worker itself keeps, because it is the only browser-facing edge
 * and the only flood control in front of Cloud:
 *  - the Origin allowlist on /mcp (public metadata is the one exception),
 *  - the per-address rate limit on every request it would carry, and the
 *    per-caller limit on a tools/call (src/ratelimit.js, one Durable Object,
 *    exported below; a missing binding fails closed),
 *  - a 1 MB request body bound and one JSON-RPC message per POST.
 */
import { bearerToken } from "./auth.js";
import { protectedResourceMetadata, publicChallenge } from "./metadata.js";
import { BodyTimeoutError, MAX_REQUEST_BYTES, REQUEST_HEADERS, ROUTES, VERSION, cloudBase, failureResponse, forward, forwardHeaders, readBounded, returnHeaders } from "./proxy.js";
import { RateLimiter, addressKey, callerKey, refusal, refuses, unavailable } from "./ratelimit.js";

// Workers treat every named export of the main module as an entrypoint.
// RateLimiter is the Durable Object class (wrangler.jsonc). Everything else
// stays module-private, including NAME.
const NAME = "blowhorn-mcp-hosted";
export { RateLimiter };

const MCP_METHODS = "POST, GET, DELETE, OPTIONS";
const METADATA_METHODS = "GET, HEAD, OPTIONS";

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function rpcError(status, code, message, headers) {
  return json(status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/** The allowed origins from `env.ALLOWED_ORIGINS`, a comma-separated list; never a wildcard. */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "*");
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Mcp-Protocol-Version, Mcp-Session-Id, WWW-Authenticate, Retry-After",
    Vary: "Origin",
  };
}

/** Public metadata documents (RFC 9728) are readable by any origin; they carry no credential and set no cookie. */
const METADATA_CORS = Object.freeze({ "Access-Control-Allow-Origin": "*" });

function log(fields) {
  console.log(JSON.stringify(fields));
}

/** Whether a parsed JSON-RPC message is a tools/call. Keys are matched without case, as lenient decoders do, so no spelling slips past the caller limit. */
function isToolsCall(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  return Object.entries(message).some(([key, value]) => key.toLowerCase() === "method" && value === "tools/call");
}

/** Carries the request to Cloud and returns its answer, or the failure's response. */
async function carry({ base, path, request, headers, body, cors, route }) {
  const result = await forward({ base, path, method: request.method, headers, body });
  if (result.failure) {
    log({ event: "upstream_failed", outcome: result.failure, route: route.kind, error: result.error });
    return failureResponse(result.failure, cors);
  }
  const out = returnHeaders(result.response.headers);
  // Point clients at this origin's RFC 9728 document, not Cloud's tenant host string.
  if (route.kind === "mcp" && result.response.status === 401) {
    out.set("WWW-Authenticate", publicChallenge(result.response.headers.get("WWW-Authenticate")));
  }
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(request.method === "HEAD" ? null : result.response.body, { status: result.response.status, headers: out });
}

async function mcp(request, env, origin) {
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") {
    if (!origin) return rpcError(403, -32000, "Forbidden: preflight needs an allowed Origin.");
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, GET, DELETE",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  // Before anything else, so a refused request gets no work and no Cloud call. Its 429
  // answers id null: the body is not read yet.
  const addressLimit = await refuses(env, "address", addressKey(request.headers.get("CF-Connecting-IP")));
  if (addressLimit.unavailable) return unavailable(cors);
  if (addressLimit.refused) {
    log({ outcome: "rate_limited", limit: "address" });
    return refusal("address", cors, null, addressLimit.retryAfter);
  }
  if (!ROUTES["/mcp"].methods.includes(request.method)) {
    return rpcError(405, -32000, "Method not allowed.", { Allow: MCP_METHODS, ...cors });
  }
  const base = cloudBase(env);
  if (!base) return rpcError(500, -32603, "Gateway misconfigured: CLOUD_API_BASE is not an https URL.", cors);

  let body;
  if (request.method === "POST") {
    // Read once, bounded, and sent on as the same bytes. A request without a Bearer token is
    // Cloud's to challenge, so its body is not looked at. With one, the body must be one
    // JSON-RPC message: a batch could hide any number of tools/call from the caller limit.
    try {
      body = await readBounded(request, MAX_REQUEST_BYTES);
    } catch (err) {
      if (!(err instanceof BodyTimeoutError)) throw err;
      log({ event: "request_failed", outcome: "request_timeout", route: "mcp" });
      return failureResponse("request_timeout", cors);
    }
    if (body === null) return rpcError(413, -32000, `Request body too large: the limit is ${MAX_REQUEST_BYTES} bytes.`, cors);
    const token = bearerToken(request.headers.get("Authorization"));
    if (token) {
      let message;
      try {
        message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return rpcError(400, -32700, "Parse error: Invalid JSON", cors);
      }
      if (Array.isArray(message)) return rpcError(400, -32600, "Invalid Request: JSON-RPC batches are not supported; send one message per POST.", cors);
      // Only tools/call counts per caller, so a client's initialize, notifications,
      // tools/list and ping never spend its calls. Keyed by the token's hash, never the token.
      if (isToolsCall(message)) {
        const caller = await callerKey(token);
        const callerLimit = await refuses(env, "caller", caller);
        if (callerLimit.unavailable) return unavailable(cors);
        if (callerLimit.refused) {
          log({ outcome: "rate_limited", limit: "caller", caller: caller.slice(0, 8) });
          return refusal("caller", cors, message.id, callerLimit.retryAfter);
        }
      }
    }
  }
  // A browser GET sends Accept: text/html and no token. Cloud answers that
  // with a login redirect, which this gateway refuses (502, blowhorn-mcp-1013).
  // Answer the same 401 challenge the unauthenticated case already returns,
  // and do not call Cloud. A usable Bearer token, and POST and DELETE, still go.
  if (request.method === "GET" && !bearerToken(request.headers.get("Authorization"))) {
    return json(
      401,
      {
        error: "unauthorized",
        error_description: "Bearer token required. Discover the authorization server via the resource_metadata URL in WWW-Authenticate.",
      },
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "WWW-Authenticate": publicChallenge(),
        ...cors,
      },
    );
  }
  return carry({ base, path: "/mcp", request, headers: forwardHeaders(request.headers, REQUEST_HEADERS), body, cors, route: ROUTES["/mcp"] });
}

/** A public RFC 9728 document answered here (not forwarded to Cloud), readable by any origin. */
async function metadata(request, env, path) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...METADATA_CORS, "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Allow-Headers": "Accept", "Access-Control-Max-Age": "600" },
    });
  }
  // Same flood control as /mcp: an unauthenticated read still spends the address limit.
  const addressLimit = await refuses(env, "address", addressKey(request.headers.get("CF-Connecting-IP")));
  if (addressLimit.unavailable) return unavailable(METADATA_CORS);
  if (addressLimit.refused) {
    log({ outcome: "rate_limited", limit: "address" });
    return refusal("address", METADATA_CORS, null, addressLimit.retryAfter);
  }
  if (!ROUTES[path].methods.includes(request.method)) {
    return rpcError(405, -32000, "Method not allowed.", { Allow: METADATA_METHODS, ...METADATA_CORS });
  }
  if (!cloudBase(env)) return rpcError(500, -32603, "Gateway misconfigured: CLOUD_API_BASE is not an https URL.", METADATA_CORS);
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
    ...METADATA_CORS,
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(JSON.stringify(protectedResourceMetadata()), { status: 200, headers });
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
      const ok = cloudBase(env) !== null;
      return json(ok ? 200 : 500, { ok, name: NAME, version: VERSION, interim: true });
    }
    const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
    if (!route) return json(404, { error: "not found" });
    if (route.kind === "metadata") return metadata(request, env, url.pathname);

    const origin = request.headers.get("Origin");
    if (origin !== null && !allowedOrigins(env).includes(origin)) return rpcError(403, -32000, "Forbidden: this Origin is not allowed.");
    return mcp(request, env, origin);
  },
};
