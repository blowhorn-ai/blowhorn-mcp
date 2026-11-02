// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Per-caller and per-address rate limits on /mcp, with Cloudflare's Workers
 * Rate Limiting bindings declared in wrangler.jsonc (`ratelimits`), so a
 * runaway client cannot flood Blowhorn Cloud or the activity feed through
 * the gateway. index.js checks the address limit before anything else a POST
 * does, and the caller limit once a bearer token is parsed, before any Cloud
 * call. A refused request answers 429 with blowhorn-mcp-1010 from
 * errors/mcp.json, and is neither sent to Cloud nor recorded as an event.
 *
 * The counters are per Cloudflare location and eventually consistent, so the
 * limits are approximate: a burst spread across locations can pass more.
 */
import { definition } from "./errors.js";

/**
 * The limits, exactly as wrangler.jsonc declares them; test/ratelimit.test.js
 * fails when the two differ. The binding cannot report its own period, so
 * Retry-After is the period: the longest a refused caller has to wait.
 * `cause` is the probable cause in blowhorn-mcp-1010 a refusal names.
 */
export const LIMITS = Object.freeze({
  address: Object.freeze({ binding: "RATE_LIMIT_ADDRESS", namespaceId: "41302", limit: 300, period: 60, cause: "shared-address" }),
  caller: Object.freeze({ binding: "RATE_LIMIT_CALLER", namespaceId: "41301", limit: 60, period: 60, cause: "too-many-calls" }),
});

/*
 * JSON-RPC 2.0 leaves -32000 to -32099 to the server. The gateway answers
 * -32000 for HTTP-level refusals and -32001 for a missing token; -32029
 * echoes HTTP 429 so it reads at a glance, and neither the MCP spec nor the
 * SDK's ErrorCode uses it.
 */
export const RATE_LIMITED = -32029;

const RATE_LIMITED_ERROR = definition("rate_limited");
for (const [name, { cause }] of Object.entries(LIMITS)) {
  if (!RATE_LIMITED_ERROR.probableCauses.some((c) => c.id === cause)) throw new Error(`${RATE_LIMITED_ERROR.code} has no cause ${cause} for the ${name} limit`);
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const HEXTET = /^[0-9a-f]{1,4}$/;

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
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return mapped[1];
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
 * Whether the `name` limit (a LIMITS key) refuses `key`. A binding missing
 * from `env` (local tests that pass none) skips the limit; the deployed
 * config is checked by test/ratelimit.test.js. A binding that throws lets
 * the request through and logs ratelimit_failed: the limits protect Cloud,
 * they are not authentication, so a limiter outage must not take the gateway
 * down with it.
 */
export async function refuses(env, name, key) {
  const binding = env?.[LIMITS[name].binding];
  if (typeof binding?.limit !== "function") return false;
  try {
    const { success } = await binding.limit({ key });
    return success === false;
  } catch (err) {
    console.log(JSON.stringify({ event: "ratelimit_failed", limit: name, error: err?.name ?? "Error" }));
    return false;
  }
}

/**
 * The 429 for a request the `name` limit refused: Retry-After, the given CORS
 * headers, and a JSON-RPC error whose message is blowhorn-mcp-1010's short
 * description and whose data is its code, moniker and reference, with only
 * the probable cause this limit names, and that cause's remediations.
 */
export function refusal(name, headers = {}) {
  const { period, cause } = LIMITS[name];
  const causes = RATE_LIMITED_ERROR.probableCauses;
  const body = {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: RATE_LIMITED,
      message: RATE_LIMITED_ERROR.shortDescription,
      data: {
        code: RATE_LIMITED_ERROR.code,
        moniker: RATE_LIMITED_ERROR.moniker,
        probableCauses: causes.filter((c) => c.id === cause),
        referenceUrl: RATE_LIMITED_ERROR.referenceUrl,
        retryAfter: period,
      },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(period), ...headers },
  });
}
