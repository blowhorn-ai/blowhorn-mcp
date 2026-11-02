// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Per-caller and per-address rate limits on /mcp, with Cloudflare's Workers
 * Rate Limiting bindings declared in wrangler.jsonc (`ratelimits`), so a
 * runaway client cannot flood Blowhorn Cloud or the activity feed through
 * the gateway. index.js checks the address limit on every /mcp request but a
 * preflight, before anything else, and the caller limit once the token and
 * the body parse and a batch is refused, before any Cloud call, counting one
 * for a tools/call message and nothing for any other. A refused request
 * answers 429 with blowhorn-mcp-1010 from errors/mcp.json, and is neither
 * sent to Cloud nor recorded as an event.
 *
 * The counters are per Cloudflare location and eventually consistent, so the
 * limits are approximate: a burst spread across locations can pass more.
 */
import { definition } from "./errors.js";

/**
 * What the code needs of each limit. The limit itself (requests per period)
 * and the namespace id live only in wrangler.jsonc's `ratelimits`;
 * test/ratelimit.test.js fails when a binding here is not declared there
 * with the same period. The binding cannot report its own period, so
 * Retry-After is the period: the longest a refused caller has to wait.
 * `cause` is the probable cause in blowhorn-mcp-1010 a refusal names.
 */
export const LIMITS = Object.freeze({
  address: Object.freeze({ binding: "RATE_LIMIT_ADDRESS", period: 60, cause: "shared-address" }),
  caller: Object.freeze({ binding: "RATE_LIMIT_CALLER", period: 60, cause: "too-many-calls" }),
});

/*
 * JSON-RPC 2.0 leaves -32000 to -32099 to the server. The gateway answers
 * -32000 for HTTP-level refusals and -32001 for a missing token; -32029
 * echoes HTTP 429 so it reads at a glance, and neither the MCP spec nor the
 * SDK's ErrorCode uses it.
 */
export const RATE_LIMITED = -32029;

const RATE_LIMITED_ERROR = definition("rate_limited");
/** The bindings found missing from env, so each logs ratelimit_unbound once per isolate. */
const UNBOUND = new Set();
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
 * from `env` (a deploy that dropped `ratelimits`, or a wrangler `env` block,
 * which does not inherit them) lets the request through and logs one
 * ratelimit_unbound line per isolate naming the binding, so the gap shows in
 * Workers Logs. A binding that throws lets the request through and logs
 * ratelimit_failed. Either way the limits protect Cloud, they are not
 * authentication, so a limiter outage must not take the gateway down with it.
 */
export async function refuses(env, name, key) {
  const { binding: bindingName } = LIMITS[name];
  const binding = env?.[bindingName];
  if (typeof binding?.limit !== "function") {
    if (!UNBOUND.has(bindingName)) {
      UNBOUND.add(bindingName);
      console.log(JSON.stringify({ event: "ratelimit_unbound", limit: name, binding: bindingName }));
    }
    return false;
  }
  try {
    const { success } = await binding.limit({ key });
    return success === false;
  } catch (err) {
    console.log(JSON.stringify({ event: "ratelimit_failed", limit: name, error: err?.name ?? "Error" }));
    return false;
  }
}

/**
 * The 429 for a request the `name` limit refused: Retry-After (the period),
 * the given CORS headers, and a JSON-RPC error whose message is
 * blowhorn-mcp-1010's short description and whose data is an ErrorDefinition
 * instance: blowhorn-mcp-1010 itself, with only the probable cause this limit
 * names (its remediations kept). test/ratelimit.test.js validates it against
 * the vendored ErrorDefinition construct.
 */
export function refusal(name, headers = {}) {
  const { period, cause } = LIMITS[name];
  const body = {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: RATE_LIMITED,
      message: RATE_LIMITED_ERROR.shortDescription,
      data: { ...RATE_LIMITED_ERROR, probableCauses: RATE_LIMITED_ERROR.probableCauses.filter((c) => c.id === cause) },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(period), ...headers },
  });
}
