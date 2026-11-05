// SPDX-License-Identifier: Apache-2.0
/*
 * Per-caller and per-address rate limits on /mcp. One enforcer: the
 * RateLimiter Durable Object bound as RATE_LIMITER (wrangler.jsonc,
 * durable_objects and migrations). Cloudflare's simple `ratelimits` bindings
 * do not enforce on a live worker (cloudflare/workers-sdk#16097), so this
 * file has no second path through them.
 *
 * Each key is its own object, named "<limit>:<key>". The caller key is the
 * hex SHA-256 of the bearer token, never the token. The address key is
 * CF-Connecting-IP, an IPv6 address folded to its /64. The object keeps a
 * strict fixed window: an epoch-aligned counter in memory, written through
 * to storage on every check so an eviction does not reset it. limit()
 * returns { success, retryAfter }.
 *
 * index.js checks the address limit on every /mcp request but a preflight,
 * before anything else, and the caller limit once the token and the body
 * parse, before any Cloud call, counting one for a tools/call message and
 * nothing for any other. A refused request answers 429 with Retry-After
 * (seconds left in the window) and blowhorn-mcp-1010 from errors/mcp.json,
 * and is neither sent to Cloud nor recorded as an event.
 *
 * The limits themselves (count and period) live only in the RATE_LIMITS var
 * in wrangler.jsonc, a JSON string validated by schemas/rate-limits.schema.json.
 * LIMITS below keeps only each limit's probable cause.
 *
 * Fail closed. A missing RATE_LIMITER binding, a RATE_LIMITS value the
 * schema's shape rejects, or a limiter that throws refuses the request with
 * 503 and logs once (ratelimit_unbound / ratelimit_misconfigured) or per
 * failure (ratelimit_failed, the error's name only). The previous simple
 * bindings failed open, which is how a limiter that never enforces shipped.
 * These limits are not authentication, but they are the only flood control
 * in front of Cloud, so an outage must not become an unlimited gateway.
 * GET /healthz does not consult the limiter.
 */
import { DurableObject } from "cloudflare:workers";
import { definition } from "./errors.js";

/** The Durable Object namespace on env. wrangler.jsonc binds this name. */
export const RATE_LIMITER_BINDING = "RATE_LIMITER";

/**
 * What the code needs of each limit beyond RATE_LIMITS. `cause` is the
 * probable cause in blowhorn-mcp-1010 a refusal names.
 */
export const LIMITS = Object.freeze({
  address: Object.freeze({ cause: "shared-address" }),
  caller: Object.freeze({ cause: "too-many-calls" }),
});

/*
 * JSON-RPC 2.0 leaves -32000 to -32099 to the server. The gateway answers
 * -32000 for HTTP-level refusals and -32001 for a missing token; -32029
 * echoes HTTP 429 so it reads at a glance, and neither the MCP spec nor the
 * SDK's ErrorCode uses it.
 */
export const RATE_LIMITED = -32029;

const RATE_LIMITED_ERROR = definition("rate_limited");
const PERIODS = new Set([10, 60]);
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const HEXTET = /^[0-9a-f]{1,4}$/;
/** Logged once per isolate: the binding is missing, or RATE_LIMITS does not parse. */
const UNBOUND = new Set();

/**
 * Strict fixed-window counter. One instance serves one key (the object id).
 * `state` is `{ window, count }`: `window` is `floor(now / periodMs)`, `count`
 * is how many checks landed in it. Memory is the hot copy; storage is the
 * copy that survives eviction. SQLite-backed (`new_sqlite_classes`).
 */
export class RateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.window = null;
    this.count = 0;
    this.loaded = this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get("state");
      if (stored && Number.isInteger(stored.window) && Number.isInteger(stored.count) && stored.count >= 0) {
        this.window = stored.window;
        this.count = stored.count;
      }
    });
  }

  /**
   * Count one check against `limit` per `period` seconds. `retryAfter` is the
   * whole seconds left in this window, at least 1, including when the check
   * is allowed (the caller ignores it then).
   */
  async limit({ limit, period }) {
    await this.loaded;
    if (!Number.isInteger(limit) || limit < 1 || !PERIODS.has(period)) throw new TypeError("RateLimiter limit");
    const periodMs = period * 1000;
    const now = Date.now();
    const window = Math.floor(now / periodMs);
    if (this.window !== window) {
      this.window = window;
      this.count = 0;
    }
    this.count += 1;
    await this.ctx.storage.put("state", { window: this.window, count: this.count });
    const retryAfter = Math.max(1, Math.ceil(((window + 1) * periodMs - now) / 1000));
    return { success: this.count <= limit, retryAfter };
  }
}

/** The caller limit's key: the hex SHA-256 of `token`. Non-reversible, and never the token itself. */
export async function callerKey(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let hex = "";
  for (const b of digest) hex += HEX[b];
  return hex;
}

/**
 * The address limit's key for a CF-Connecting-IP value: an IPv4 address as
 * is, an IPv6 address as its /64 (`2001:db8:0:1::/64`), since one client
 * usually holds a whole /64 and could rotate through it. `unknown` when
 * there is no header, which Cloudflare always sets in production; a value
 * that does not parse is used as it is.
 */
export function addressKey(ip) {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const lower = ip.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return ip;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => HEXTET.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * RATE_LIMITS from env: a JSON string (wrangler vars are strings) or, in
 * tests, the object itself. Null when it is missing or not the schema's
 * shape (exactly address and caller, each a positive integer limit and a
 * period of 10 or 60). The schema file is what the tests validate; this
 * check is the same shape, so a bad deploy fails closed without reading
 * the file from disk inside the worker.
 */
export function rateLimits(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2) return null;
  const out = {};
  for (const name of Object.keys(LIMITS)) {
    const item = value[name];
    if (!item || typeof item !== "object") return null;
    if (!Number.isInteger(item.limit) || item.limit < 1 || !PERIODS.has(item.period)) return null;
    if (Object.keys(item).length !== 2) return null;
    out[name] = { limit: item.limit, period: item.period };
  }
  return out;
}

function logOnce(kind, fields) {
  if (UNBOUND.has(kind)) return;
  UNBOUND.add(kind);
  console.log(JSON.stringify(fields));
}

/**
 * Whether the `name` limit (a LIMITS key) refuses `key`. `{ refused: false }`
 * when the window still has room. `{ refused: true, retryAfter }` when it
 * does not. `{ unavailable: true }` when the limiter cannot be consulted:
 * the request must be refused (see `unavailable`). The log line never
 * carries the key, so a caller key's hash and an address never land in logs
 * from here; the token never does either.
 */
export async function refuses(env, name, key) {
  const limits = rateLimits(env?.RATE_LIMITS);
  if (!limits) {
    logOnce("config", { event: "ratelimit_misconfigured" });
    return { unavailable: true };
  }
  const ns = env?.[RATE_LIMITER_BINDING];
  if (typeof ns?.idFromName !== "function" || typeof ns?.get !== "function") {
    logOnce("binding", { event: "ratelimit_unbound", binding: RATE_LIMITER_BINDING });
    return { unavailable: true };
  }
  const { limit, period } = limits[name];
  try {
    const stub = ns.get(ns.idFromName(`${name}:${key}`));
    if (typeof stub?.limit !== "function") throw new TypeError("RateLimiter stub");
    const result = await stub.limit({ limit, period });
    if (typeof result?.success !== "boolean") throw new TypeError("RateLimiter result");
    if (result.success) return { refused: false };
    const retryAfter = Number.isInteger(result.retryAfter) && result.retryAfter > 0 ? result.retryAfter : period;
    return { refused: true, retryAfter };
  } catch (err) {
    console.log(JSON.stringify({ event: "ratelimit_failed", limit: name, error: err?.name ?? "Error" }));
    return { unavailable: true };
  }
}

/**
 * The 429 for a request the `name` limit refused: Retry-After (seconds left
 * in the window, from the Durable Object), the given CORS headers, and a
 * JSON-RPC error answering `id`, the refused request's JSON-RPC id when its
 * body was read (null when it was not, or when the id is not a string or
 * number), whose message is blowhorn-mcp-1010's short description and whose
 * data is an ErrorDefinition instance: blowhorn-mcp-1010 itself, with only
 * the probable cause this limit names (its remediations kept).
 * test/ratelimit.test.js validates it against the vendored ErrorDefinition
 * construct.
 */
export function refusal(name, headers = {}, id = null, retryAfter) {
  const body = {
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: {
      code: RATE_LIMITED,
      message: RATE_LIMITED_ERROR.shortDescription,
      data: { ...RATE_LIMITED_ERROR, probableCauses: RATE_LIMITED_ERROR.probableCauses.filter((c) => c.id === LIMITS[name].cause) },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter), ...headers },
  });
}

/**
 * The 503 for a request the limiter could not answer. Fail closed: nothing
 * is sent to Cloud. `id` is null because the address check, which runs
 * first, may refuse before the body is read; a later caller-side failure
 * uses the same response so both cases look the same to the client.
 */
export function unavailable(headers = {}) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Gateway misconfigured: the rate limiter is unavailable." },
    }),
    { status: 503, headers: { "Content-Type": "application/json", ...headers } },
  );
}
