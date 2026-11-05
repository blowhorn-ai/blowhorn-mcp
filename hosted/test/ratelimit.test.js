// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../src/index.js";
import { definition } from "../src/errors.js";
import { Validator } from "@cfworker/json-schema";
import { DurableObject } from "cloudflare:workers";
import { LIMITS, RATE_LIMITED, RATE_LIMITER_BINDING, RateLimiter, addressKey, callerKey, rateLimits } from "../src/ratelimit.js";
import { errorDefinitionSchema, errorDefinitionValidator } from "../scripts/registry.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "ratelimit-test-token-0123456789";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const IP = "203.0.113.7";
const ORIGIN = "https://app.example.test";
const BASE_ENV = { CLOUD_API_BASE: "https://cloud.blowhorn.ai", ALLOWED_ORIGINS: ORIGIN };
const CONFIG = { address: { limit: 1200, period: 60 }, caller: { limit: 60, period: 60 } };
const MCP = "https://mcp.blowhorn.ai/mcp";
const EVENTS = "https://cloud.blowhorn.ai/api/events";
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const auth = { Authorization: `Bearer ${TOKEN}`, "CF-Connecting-IP": IP };

/** A 429's error.data is an ErrorDefinition instance, checked with the registry check's own validator. */
const DEFINITION = errorDefinitionSchema();
const DATA = errorDefinitionValidator(DEFINITION);
const CALL = ["tools/call", { name: "getEvents", arguments: {} }];

/**
 * A fake RATE_LIMITER namespace. `address` and `caller` are the `success`
 * each limit returns, or a function of how many times that limit has been
 * checked (1-based). `throwOn` names a limit whose stub throws. Keys seen
 * are kept on `env.keys`, split by limit, without the "<limit>:" prefix.
 */
function envWith({ address = true, caller = true, retryAfter = 60, throwOn = null, limits = CONFIG } = {}) {
  const keys = { address: [], caller: [] };
  const ns = {
    idFromName: (name) => name,
    get(id) {
      return {
        limit: async () => {
          const name = id.startsWith("caller:") ? "caller" : "address";
          const key = id.slice(name.length + 1);
          if (throwOn === name) throw new TypeError(`limiter down ${TOKEN}`);
          keys[name].push(key);
          const rule = name === "address" ? address : caller;
          const success = typeof rule === "function" ? rule(keys[name].length) : rule;
          return { success, retryAfter };
        },
      };
    },
  };
  const env = {
    ...BASE_ENV,
    [RATE_LIMITER_BINDING]: ns,
    RATE_LIMITS: typeof limits === "string" ? limits : JSON.stringify(limits),
  };
  env.keys = keys;
  return env;
}

/** A real RateLimiter backed by a Map, one object per id, so tests exercise the class. */
function durableEnv(limits = CONFIG) {
  const keys = { address: [], caller: [] };
  const objects = new Map();
  const ns = {
    idFromName: (name) => name,
    get(id) {
      const name = id.startsWith("caller:") ? "caller" : "address";
      keys[name].push(id.slice(name.length + 1));
      let entry = objects.get(id);
      if (!entry) {
        const store = new Map();
        entry = {
          store,
          inst: new RateLimiter(
            {
              storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) },
              blockConcurrencyWhile: (fn) => fn(),
            },
            {},
          ),
        };
        objects.set(id, entry);
      }
      return entry.inst;
    },
  };
  const env = { ...BASE_ENV, [RATE_LIMITER_BINDING]: ns, RATE_LIMITS: JSON.stringify(limits) };
  env.keys = keys;
  env.objects = objects;
  return env;
}

function post(body, headers = auth) {
  return new Request(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
}

function rpc(method, params = {}, headers = auth) {
  return post(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), headers);
}

/** Replaces globalThis.fetch (Cloud) for the test; returns the calls it saw. */
function mockCloud(t, respond = () => assert.fail("Cloud was called")) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** Cloud answering every tool call with an empty list and every event post with 201. */
function mockCloudOk(t) {
  return mockCloud(t, (url) => (url === EVENTS ? new Response(null, { status: 201 }) : new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })));
}

/** Captures console.log for the test's duration; the returned array holds the parsed lines. */
function captureLogs(t) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(JSON.parse(args.join(" ")));
  t.after(() => {
    console.log = original;
  });
  return lines;
}

function collector() {
  const promises = [];
  return { promises, waitUntil: (p) => promises.push(p), settle: () => Promise.all(promises) };
}

/**
 * Checks a 429 from the `name` limit: Retry-After, a JSON-RPC error answering
 * `id` (the refused tools/call's for the caller limit, null for the address
 * limit, which refuses before the body is read), and data that is
 * blowhorn-mcp-1010 with only that limit's cause.
 */
async function assertRefused(res, name, id = name === "caller" ? 1 : null, retryAfter = 60) {
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get("Retry-After"), String(retryAfter));
  assert.strictEqual(res.headers.get("Content-Type"), "application/json");
  const body = await res.json();
  const d = definition("rate_limited");
  assert.strictEqual(body.jsonrpc, "2.0");
  assert.strictEqual(body.id, id);
  assert.strictEqual(body.error.code, RATE_LIMITED);
  assert.ok(body.error.code <= -32000 && body.error.code >= -32099, "a JSON-RPC server error code");
  assert.strictEqual(body.error.message, d.shortDescription);
  const { valid, errors } = DATA.validate(body.error.data);
  assert.ok(valid, errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; "));
  assert.deepStrictEqual(Object.keys(body.error.data).sort(), [...DEFINITION.required].sort(), "every required field, and no other");
  assert.deepStrictEqual(body.error.data, { ...d, probableCauses: d.probableCauses.filter((c) => c.id === LIMITS[name].cause) });
  assert.strictEqual(body.error.data.code, "blowhorn-mcp-1010");
  assert.strictEqual(body.error.data.probableCauses.length, 1);
  assert.ok(body.error.data.probableCauses[0].remediations.length >= 2);
  return body;
}

/**
 * wrangler.jsonc as an object: JSON with // and block comments, which are
 * dropped outside strings. A trailing comma fails the parse, loudly.
 */
function readWranglerConfig() {
  const text = fs.readFileSync(path.join(HOSTED, "wrangler.jsonc"), "utf8");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      assert.ok(end > 0, "wrangler.jsonc: unclosed block comment");
      i = end + 1;
    } else out += c;
  }
  return JSON.parse(out);
}

/** README.md's Rate limits table, as { address|caller: { limit, period } }. */
function readmeLimits() {
  const readme = fs.readFileSync(path.join(HOSTED, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n## Rate limits\n"), readme.indexOf("\n## ", readme.indexOf("\n## Rate limits\n") + 1));
  const rows = [...section.matchAll(/^\|[^|\n]*\| `(address|caller)` \|[^|\n]*\| (\d+) (?:requests|tool calls) per (\d+) s \|/gm)];
  return Object.fromEntries(rows.map(([, name, limit, period]) => [name, { limit: Number(limit), period: Number(period) }]));
}

test("wrangler.jsonc binds RateLimiter, migrates it, and has no simple ratelimits", () => {
  const cfg = readWranglerConfig();
  assert.strictEqual(cfg.ratelimits, undefined, "simple ratelimits are not configured");
  const bindings = cfg.durable_objects?.bindings ?? [];
  const ours = bindings.filter((b) => b.name === RATE_LIMITER_BINDING && b.class_name === "RateLimiter");
  assert.strictEqual(ours.length, 1, "RATE_LIMITER binds the RateLimiter class once");
  const migrated = (cfg.migrations ?? []).some((m) => Array.isArray(m.new_sqlite_classes) && m.new_sqlite_classes.includes("RateLimiter"));
  assert.ok(migrated, "a migration lists RateLimiter in new_sqlite_classes");
  const schema = JSON.parse(fs.readFileSync(path.join(HOSTED, "schemas", "rate-limits.schema.json"), "utf8"));
  const validator = new Validator(schema, "2020-12", false);
  const parsed = JSON.parse(cfg.vars.RATE_LIMITS);
  const { valid, errors } = validator.validate(parsed);
  assert.ok(valid, errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; "));
  assert.deepStrictEqual(rateLimits(cfg.vars.RATE_LIMITS), parsed);
  assert.deepStrictEqual(parsed, CONFIG);
  assert.strictEqual(validator.validate({ caller: CONFIG.caller }).valid, false, "address is required");
  assert.strictEqual(validator.validate({ ...CONFIG, extra: { limit: 1, period: 60 } }).valid, false, "no extra limit");
  assert.strictEqual(validator.validate({ ...CONFIG, caller: { limit: 0, period: 60 } }).valid, false, "limit is at least 1");
  assert.ok(parsed.address.limit > parsed.caller.limit, "the address limit is the looser one");
  // A stateless client sends about 4 requests per tool call (initialize, initialized, a GET, tools/call).
  assert.ok(parsed.address.limit >= 4 * 4 * parsed.caller.limit, "the address limit holds 4 stateless clients at the caller limit");
  assert.deepStrictEqual(readmeLimits(), parsed, "README.md's Rate limits table states RATE_LIMITS");
});

test("every limit names a probable cause of blowhorn-mcp-1010", () => {
  const causes = definition("rate_limited").probableCauses.map((c) => c.id);
  for (const [name, { cause }] of Object.entries(LIMITS)) assert.ok(causes.includes(cause), `${name}: ${cause}`);
});

test("under both limits a session runs as usual, keyed by the address and the token's SHA-256, never the token", async (t) => {
  const env = envWith();
  const logs = captureLogs(t);
  const calls = mockCloudOk(t);
  const ctx = collector();
  const methods = [];
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: auth },
    fetch: (url, init) => {
      methods.push(init?.method ?? "GET");
      return worker.fetch(new Request(url, init), env, ctx);
    },
  });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(transport);
  t.after(() => c.close());
  await c.listTools();
  assert.ok(!(await c.callTool({ name: "getEvents", arguments: {} })).isError);
  await ctx.settle();
  assert.strictEqual(calls.filter((x) => x.url === EVENTS).length, 1);
  // Every /mcp request counts for its address; only the one tools/call for the caller.
  assert.strictEqual(env.keys.address.length, methods.length);
  assert.deepStrictEqual(new Set(env.keys.address), new Set([IP]));
  assert.ok(methods.filter((m) => m === "POST").length >= 4, "initialize, initialized, tools/list and tools/call");
  assert.deepStrictEqual(env.keys.caller, [HASH]);
  assert.match(HASH, /^[0-9a-f]{64}$/);
  assert.ok(!env.keys.caller.some((k) => k.includes(TOKEN)));
  assert.ok(!JSON.stringify(env.keys).includes(TOKEN));
  assert.ok(!logs.some((l) => l.outcome === "rate_limited"));
});

test("callerKey is the hex SHA-256 of the token", async () => {
  assert.strictEqual(await callerKey(TOKEN), HASH);
  assert.strictEqual(await callerKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notStrictEqual(await callerKey(`${TOKEN}x`), HASH);
});

test("over the address limit is 429 before authentication: no caller check, no Cloud call, no event", async (t) => {
  const calls = mockCloud(t);
  const logs = captureLogs(t);
  const env = envWith({ address: false });
  const ctx = collector();
  const cases = [
    rpc(...CALL),
    rpc("initialize", INIT, { "CF-Connecting-IP": IP }),
    rpc("initialize", INIT, { Authorization: "Bearer", "CF-Connecting-IP": IP }),
    new Request(MCP, { method: "GET", headers: { "CF-Connecting-IP": IP } }),
  ];
  for (const request of cases) {
    const res = await worker.fetch(request, env, ctx);
    assert.strictEqual(res.headers.get("WWW-Authenticate"), null);
    await assertRefused(res, "address");
  }
  assert.strictEqual(env.keys.caller.length, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(ctx.promises.length, 0);
  assert.deepStrictEqual(logs, cases.map(() => ({ outcome: "rate_limited", limit: "address" })));
});

test("over the caller limit a tools/call is 429 with the caller's cause: no Cloud call, no event, one log line without the token or its hash", async (t) => {
  const calls = mockCloud(t);
  const logs = captureLogs(t);
  const ctx = collector();
  const env = envWith({ caller: false });
  await assertRefused(await worker.fetch(rpc(...CALL), env, ctx), "caller");
  await ctx.settle();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(ctx.promises.length, 0);
  assert.deepStrictEqual(logs, [{ outcome: "rate_limited", limit: "caller", caller: HASH.slice(0, 8) }]);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes(TOKEN) && !text.includes(HASH));
});

test("a caller 429 answers the refused tools/call's id; an id that is not a string or number answers null", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const env = envWith({ caller: false });
  const [method, params] = CALL;
  for (const [id, expected] of [["call-7", "call-7"], [42, 42], [0, 0], [{ n: 1 }, null], [undefined, null]]) {
    const res = await worker.fetch(post(JSON.stringify({ jsonrpc: "2.0", id, method, params })), env, {});
    await assertRefused(res, "caller", expected);
  }
});

test("an address 429 answers id null, since the body is not read yet", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const [method, params] = CALL;
  const res = await worker.fetch(post(JSON.stringify({ jsonrpc: "2.0", id: "call-9", method, params })), envWith({ address: false }), {});
  await assertRefused(res, "address", null);
});

test("initialize, notifications, tools/list and ping never count toward the caller limit, even over it", async (t) => {
  mockCloud(t);
  const logs = captureLogs(t);
  const env = envWith({ caller: false });
  const notification = post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  for (const [request, status] of [[rpc("initialize", INIT), 200], [notification, 202], [rpc("tools/list"), 200], [rpc("ping"), 200]]) {
    assert.strictEqual((await worker.fetch(request, env, {})).status, status);
  }
  assert.strictEqual(env.keys.caller.length, 0);
  assert.ok(!logs.some((l) => l.outcome === "rate_limited"));
});

test("a tools/call counts once, and a batch of tools/call messages is refused as a batch without counting", async (t) => {
  const calls = mockCloudOk(t);
  captureLogs(t);
  const env = envWith({ caller: (n) => n <= 60 });
  assert.strictEqual((await worker.fetch(rpc(...CALL), env, collector())).status, 200);
  assert.strictEqual(env.keys.caller.length, 1);
  const cloudCalls = calls.length;
  const [method, params] = CALL;
  const batch = post(JSON.stringify(Array.from({ length: 61 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method, params }))));
  const res = await worker.fetch(batch, env, {});
  assert.strictEqual(res.status, 400);
  const { error } = await res.json();
  assert.strictEqual(error.code, -32600);
  assert.match(error.message, /batch/i);
  assert.strictEqual(env.keys.caller.length, 1, "the batch spent none of the caller's calls");
  assert.strictEqual(calls.length, cloudCalls, "nor reached Cloud");
  assert.strictEqual((await worker.fetch(rpc(...CALL), env, collector())).status, 200);
  assert.strictEqual(env.keys.caller.length, 2);
});

test("a body that does not parse is not counted and gets the gateway's usual parse error", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const env = envWith({ caller: false });
  const res = await worker.fetch(post('{"jsonrpc": "2.0", "method": "tools/call"'), env, {});
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(await res.json(), { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null });
  assert.strictEqual(env.keys.caller.length, 0);
});

test("a burst of tool calls passes up to the limit, then is refused", async (t) => {
  mockCloudOk(t);
  captureLogs(t);
  const env = envWith({ caller: (n) => n <= 3 });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await worker.fetch(rpc(...CALL), env, collector())).status);
  assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
});

test("a 429 for an allowed Origin carries the CORS headers, Retry-After exposed", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const res = await worker.fetch(rpc(...CALL, { ...auth, Origin: ORIGIN }), envWith({ caller: false, retryAfter: 17 }), {});
  await assertRefused(res, "caller", 1, 17);
  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.strictEqual(res.headers.get("Vary"), "Origin");
  assert.match(res.headers.get("Access-Control-Expose-Headers"), /\bRetry-After\b/);
});

test("/healthz and the OPTIONS preflight are never limited", async (t) => {
  mockCloud(t);
  const env = envWith({ address: false, caller: false });
  const health = await worker.fetch(new Request("https://mcp.blowhorn.ai/healthz", { headers: { "CF-Connecting-IP": IP } }), env, {});
  assert.strictEqual(health.status, 200);
  const preflight = await worker.fetch(new Request(MCP, { method: "OPTIONS", headers: { Origin: ORIGIN, "CF-Connecting-IP": IP } }), env, {});
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(env.keys.address.length + env.keys.caller.length, 0);
});

test("without RATE_LIMITER the request is refused, and the isolate logs ratelimit_unbound once", async (t) => {
  const calls = mockCloud(t);
  const logs = captureLogs(t);
  const env = { ...BASE_ENV, RATE_LIMITS: JSON.stringify(CONFIG) };
  const ctx = collector();
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(rpc(...CALL), env, ctx);
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(await res.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Gateway misconfigured: the rate limiter is unavailable." },
    });
  }
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(ctx.promises.length, 0);
  assert.deepStrictEqual(logs.filter((l) => l.event === "ratelimit_unbound"), [{ event: "ratelimit_unbound", binding: RATE_LIMITER_BINDING }]);
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
});

test("a RATE_LIMITS value that is not the schema's shape fails closed and logs ratelimit_misconfigured once", async (t) => {
  const calls = mockCloud(t);
  const logs = captureLogs(t);
  const env = envWith({ limits: "not-json" });
  for (let i = 0; i < 3; i++) assert.strictEqual((await worker.fetch(rpc(...CALL), env, collector())).status, 503);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(logs.filter((l) => l.event === "ratelimit_misconfigured"), [{ event: "ratelimit_misconfigured" }]);
  assert.strictEqual(env.keys.address.length, 0);
});

test("a limiter that throws refuses the request and logs ratelimit_failed with the error name only", async (t) => {
  const calls = mockCloud(t);
  const logs = captureLogs(t);
  const res = await worker.fetch(rpc(...CALL), envWith({ throwOn: "address" }), collector());
  assert.strictEqual(res.status, 503);
  assert.deepStrictEqual(logs.filter((l) => l.event?.startsWith("ratelimit_")), [{ event: "ratelimit_failed", limit: "address", error: "TypeError" }]);
  assert.strictEqual(calls.length, 0);
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
  const callerDown = await worker.fetch(rpc(...CALL), envWith({ throwOn: "caller" }), collector());
  assert.strictEqual(callerDown.status, 503);
  assert.ok(logs.some((l) => l.event === "ratelimit_failed" && l.limit === "caller" && l.error === "TypeError"));
});

test("the address key is the IPv4 address, or the IPv6 address's /64", async (t) => {
  const cases = [
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd:12::/64"],
    ["2001:DB8:0:0:8:800:200C:417A", "2001:db8:0:0::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:0db8:00ab::", "2001:db8:ab:0::/64"],
    ["::1", "0:0:0:0::/64"],
    [null, "unknown"],
    ["", "unknown"],
    ["1:2:3", "1:2:3"],
    ["1::2::3", "1::2::3"],
    ["1:2:3:4:5:6:7:8::", "1:2:3:4:5:6:7:8::"],
    ["gggg::1", "gggg::1"],
  ];
  for (const [ip, key] of cases) assert.strictEqual(addressKey(ip), key, String(ip));

  mockCloud(t);
  const env = envWith();
  for (const ip of ["2001:db8:1:2::a", "2001:db8:1:2:ffff::b", "2001:db8:1:3::a"]) await worker.fetch(rpc("initialize", INIT, { ...auth, "CF-Connecting-IP": ip }), env, {});
  assert.deepStrictEqual(env.keys.address, ["2001:db8:1:2::/64", "2001:db8:1:2::/64", "2001:db8:1:3::/64"]);
});

test("the 429 example in README.md is exactly what the caller limit sends", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const readme = fs.readFileSync(path.join(HOSTED, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n## Rate limits\n"));
  const example = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
  const res = await worker.fetch(rpc(...CALL), envWith({ caller: false }), {});
  assert.deepStrictEqual(await res.json(), example);
});

test("RateLimiter extends DurableObject so Workers expose limit as an RPC method", () => {
  assert.ok(RateLimiter.prototype instanceof DurableObject);
});

test("RateLimiter counts a strict fixed window, persists it, and reports retryAfter", async (t) => {
  const period = 60;
  const periodMs = period * 1000;
  let now = 1_700_000_060_000;
  const original = Date.now;
  Date.now = () => now;
  t.after(() => {
    Date.now = original;
  });
  const store = new Map();
  const ctx = {
    storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const limiter = new RateLimiter(ctx, {});
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await limiter.limit({ limit: 3, period }));
  assert.deepStrictEqual(results.map((r) => r.success), [true, true, true, false]);
  const retryAfter = Math.max(1, Math.ceil(((Math.floor(now / periodMs) + 1) * periodMs - now) / 1000));
  assert.strictEqual(results[3].retryAfter, retryAfter);
  assert.ok(retryAfter >= 1 && retryAfter <= period);
  assert.deepStrictEqual(store.get("state"), { window: Math.floor(now / periodMs), count: 4 });

  const revived = new RateLimiter(ctx, {});
  assert.strictEqual((await revived.limit({ limit: 3, period })).success, false, "storage keeps the count across a new instance");

  now = (Math.floor(now / periodMs) + 1) * periodMs + 10;
  assert.strictEqual((await revived.limit({ limit: 3, period })).success, true, "the next window starts at zero");
  assert.strictEqual(store.get("state").count, 1);
});

test("over a real fixed window the 429's Retry-After is the time left, and the token is not a key", async (t) => {
  const periodMs = 60_000;
  let now = 1_700_000_060_000;
  const original = Date.now;
  Date.now = () => now;
  t.after(() => {
    Date.now = original;
  });
  mockCloudOk(t);
  captureLogs(t);
  const env = durableEnv({ address: { limit: 1200, period: 60 }, caller: { limit: 2, period: 60 } });
  const ctx = collector();
  assert.strictEqual((await worker.fetch(rpc(...CALL), env, ctx)).status, 200);
  assert.strictEqual((await worker.fetch(rpc(...CALL), env, ctx)).status, 200);
  const res = await worker.fetch(rpc(...CALL), env, ctx);
  const retryAfter = Math.max(1, Math.ceil(((Math.floor(now / periodMs) + 1) * periodMs - now) / 1000));
  await assertRefused(res, "caller", 1, retryAfter);
  assert.deepStrictEqual(env.keys.caller, [HASH, HASH, HASH]);
  assert.ok(env.keys.caller.every((k) => k === HASH && !k.includes(TOKEN)));
  await ctx.settle();
});
