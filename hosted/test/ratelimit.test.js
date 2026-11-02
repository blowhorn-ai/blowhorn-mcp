// SPDX-License-Identifier: AGPL-3.0-only
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
import { LIMITS, RATE_LIMITED, addressKey, callerKey } from "../src/ratelimit.js";
import { errorDefinitionSchema, errorDefinitionValidator } from "../scripts/registry.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "ratelimit-test-token-0123456789";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const IP = "203.0.113.7";
const ORIGIN = "https://app.example.test";
const BASE_ENV = { CLOUD_API_BASE: "https://cloud.blowhorn.ai", ALLOWED_ORIGINS: ORIGIN };
const MCP = "https://mcp.blowhorn.ai/mcp";
const EVENTS = "https://cloud.blowhorn.ai/api/events";
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const auth = { Authorization: `Bearer ${TOKEN}`, "CF-Connecting-IP": IP };

/** A 429's error.data is an ErrorDefinition instance, checked with the registry check's own validator. */
const DEFINITION = errorDefinitionSchema();
const DATA = errorDefinitionValidator(DEFINITION);
const CALL = ["tools/call", { name: "getEvents", arguments: {} }];

/** A fake Workers Rate Limiting binding: limit({ key }) answers { success }, and every key it saw is kept. */
function binding(success = true) {
  const keys = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success: typeof success === "function" ? success(keys.length) : success };
    },
  };
}

function envWith({ address = binding(), caller = binding() } = {}) {
  return { ...BASE_ENV, RATE_LIMIT_ADDRESS: address, RATE_LIMIT_CALLER: caller };
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
async function assertRefused(res, name, id = name === "caller" ? 1 : null) {
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get("Retry-After"), String(LIMITS[name].period));
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

/** README.md's Rate limits table, as { binding: { limit, period } } from its "N requests per P s" or "N tool calls per P s" cells. */
function readmeLimits() {
  const readme = fs.readFileSync(path.join(HOSTED, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n## Rate limits\n"), readme.indexOf("\n## ", readme.indexOf("\n## Rate limits\n") + 1));
  const rows = [...section.matchAll(/^\|[^|\n]*\| `(RATE_LIMIT_[A-Z]+)` \|[^|\n]*\| (\d+) (?:requests|tool calls) per (\d+) s \|/gm)];
  return Object.fromEntries(rows.map(([, binding, limit, period]) => [binding, { limit: Number(limit), period: Number(period) }]));
}

test("wrangler.jsonc declares every LIMITS binding with its period, a positive integer limit and its own namespace", () => {
  const { ratelimits } = readWranglerConfig();
  assert.ok(Array.isArray(ratelimits), "wrangler.jsonc has a ratelimits list");
  for (const [name, l] of Object.entries(LIMITS)) {
    const declared = ratelimits.filter((r) => r.name === l.binding);
    assert.strictEqual(declared.length, 1, `${name}: ${l.binding} is declared once`);
    const [{ namespace_id: namespaceId, simple }] = declared;
    assert.strictEqual(simple?.period, l.period, `${name}: the period in wrangler.jsonc is LIMITS' period`);
    assert.ok(Number.isInteger(simple.limit) && simple.limit > 0, `${name}: the limit is a positive integer`);
    assert.ok([10, 60].includes(simple.period), `${name}: period is 10 or 60`);
    assert.match(String(namespaceId), /^[1-9][0-9]*$/, `${name}: namespace_id is a string integer`);
    assert.strictEqual(typeof namespaceId, "string", `${name}: namespace_id is a string`);
  }
  const namespaces = ratelimits.map((r) => r.namespace_id);
  assert.strictEqual(new Set(namespaces).size, namespaces.length, "every namespace_id is distinct");
  const limit = (name) => ratelimits.find((r) => r.name === LIMITS[name].binding).simple.limit;
  assert.ok(limit("address") > limit("caller"), "the address limit is the looser one");
  // A stateless client sends about 4 requests per tool call (initialize, initialized, a GET, tools/call).
  assert.ok(limit("address") >= 4 * 4 * limit("caller"), "the address limit holds 4 stateless clients at the caller limit");
});

test("README.md's Rate limits table states the limits wrangler.jsonc declares", () => {
  const { ratelimits } = readWranglerConfig();
  const declared = Object.fromEntries(ratelimits.map((r) => [r.name, { limit: r.simple.limit, period: r.simple.period }]));
  assert.deepStrictEqual(readmeLimits(), declared);
});

test("every limit names a probable cause of blowhorn-mcp-1010", () => {
  const causes = definition("rate_limited").probableCauses.map((c) => c.id);
  for (const [name, { cause }] of Object.entries(LIMITS)) assert.ok(causes.includes(cause), `${name}: ${cause}`);
});

test("under both limits a session runs as usual, keyed by the address and the token's SHA-256, never the token", async (t) => {
  const address = binding();
  const caller = binding();
  const env = envWith({ address, caller });
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
  assert.strictEqual(address.keys.length, methods.length);
  assert.deepStrictEqual(new Set(address.keys), new Set([IP]));
  assert.ok(methods.filter((m) => m === "POST").length >= 4, "initialize, initialized, tools/list and tools/call");
  assert.deepStrictEqual(caller.keys, [HASH]);
  assert.match(HASH, /^[0-9a-f]{64}$/);
  assert.ok(!caller.keys.some((k) => k.includes(TOKEN)));
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
  const caller = binding();
  const env = envWith({ address: binding(false), caller });
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
  assert.strictEqual(caller.keys.length, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(ctx.promises.length, 0);
  assert.deepStrictEqual(logs, cases.map(() => ({ outcome: "rate_limited", limit: "address" })));
});

test("over the caller limit a tools/call is 429 with the caller's cause: no Cloud call, no event, one log line without the token or its hash", async (t) => {
  const calls = mockCloud(t);
  const logs = captureLogs(t);
  const ctx = collector();
  const env = envWith({ caller: binding(false) });
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
  const env = envWith({ caller: binding(false) });
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
  const res = await worker.fetch(post(JSON.stringify({ jsonrpc: "2.0", id: "call-9", method, params })), envWith({ address: binding(false) }), {});
  await assertRefused(res, "address", null);
});

test("initialize, notifications, tools/list and ping never count toward the caller limit, even over it", async (t) => {
  mockCloud(t);
  const logs = captureLogs(t);
  const caller = binding(false);
  const env = envWith({ caller });
  const notification = post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  for (const [request, status] of [[rpc("initialize", INIT), 200], [notification, 202], [rpc("tools/list"), 200], [rpc("ping"), 200]]) {
    assert.strictEqual((await worker.fetch(request, env, {})).status, status);
  }
  assert.strictEqual(caller.keys.length, 0);
  assert.ok(!logs.some((l) => l.outcome === "rate_limited"));
});

test("a tools/call counts once, and a batch of tools/call messages is refused as a batch without counting", async (t) => {
  const calls = mockCloudOk(t);
  captureLogs(t);
  const caller = binding((n) => n <= 60);
  const env = envWith({ caller });
  assert.strictEqual((await worker.fetch(rpc(...CALL), env, collector())).status, 200);
  assert.strictEqual(caller.keys.length, 1);
  const cloudCalls = calls.length;
  const [method, params] = CALL;
  const batch = post(JSON.stringify(Array.from({ length: 61 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method, params }))));
  const res = await worker.fetch(batch, env, {});
  assert.strictEqual(res.status, 400);
  const { error } = await res.json();
  assert.strictEqual(error.code, -32600);
  assert.match(error.message, /batch/i);
  assert.strictEqual(caller.keys.length, 1, "the batch spent none of the caller's calls");
  assert.strictEqual(calls.length, cloudCalls, "nor reached Cloud");
  assert.strictEqual((await worker.fetch(rpc(...CALL), env, collector())).status, 200);
  assert.strictEqual(caller.keys.length, 2);
});

test("a body that does not parse is not counted and gets the gateway's usual parse error", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const caller = binding(false);
  const res = await worker.fetch(post('{"jsonrpc": "2.0", "method": "tools/call"'), envWith({ caller }), {});
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(await res.json(), { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null });
  assert.strictEqual(caller.keys.length, 0);
});

test("a burst of tool calls passes up to the limit, then is refused", async (t) => {
  mockCloudOk(t);
  captureLogs(t);
  const env = envWith({ caller: binding((n) => n <= 3) });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await worker.fetch(rpc(...CALL), env, collector())).status);
  assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
});

test("a 429 for an allowed Origin carries the CORS headers, Retry-After exposed", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const res = await worker.fetch(rpc(...CALL, { ...auth, Origin: ORIGIN }), envWith({ caller: binding(false) }), {});
  await assertRefused(res, "caller");
  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.strictEqual(res.headers.get("Vary"), "Origin");
  assert.match(res.headers.get("Access-Control-Expose-Headers"), /\bRetry-After\b/);
});

test("/healthz and the OPTIONS preflight are never limited", async (t) => {
  mockCloud(t);
  const address = binding(false);
  const caller = binding(false);
  const env = envWith({ address, caller });
  const health = await worker.fetch(new Request("https://mcp.blowhorn.ai/healthz", { headers: { "CF-Connecting-IP": IP } }), env, {});
  assert.strictEqual(health.status, 200);
  const preflight = await worker.fetch(new Request(MCP, { method: "OPTIONS", headers: { Origin: ORIGIN, "CF-Connecting-IP": IP } }), env, {});
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(address.keys.length + caller.keys.length, 0);
});

test("without the bindings in env the request passes, and each missing binding logs ratelimit_unbound once per isolate", async (t) => {
  mockCloudOk(t);
  const logs = captureLogs(t);
  for (let i = 0; i < 3; i++) assert.strictEqual((await worker.fetch(rpc(...CALL), BASE_ENV, collector())).status, 200);
  assert.deepStrictEqual(
    logs.filter((l) => l.event === "ratelimit_unbound"),
    [
      { event: "ratelimit_unbound", limit: "address", binding: "RATE_LIMIT_ADDRESS" },
      { event: "ratelimit_unbound", limit: "caller", binding: "RATE_LIMIT_CALLER" },
    ],
  );
});

test("a binding that throws lets the request through and logs ratelimit_failed with the error name only", async (t) => {
  mockCloudOk(t);
  const logs = captureLogs(t);
  const broken = { limit: async () => Promise.reject(new TypeError(`limiter down ${TOKEN}`)) };
  const res = await worker.fetch(rpc(...CALL), envWith({ address: broken, caller: broken }), collector());
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(logs.filter((l) => l.event?.startsWith("ratelimit_")), [
    { event: "ratelimit_failed", limit: "address", error: "TypeError" },
    { event: "ratelimit_failed", limit: "caller", error: "TypeError" },
  ]);
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

  const address = binding();
  mockCloud(t);
  const env = envWith({ address });
  for (const ip of ["2001:db8:1:2::a", "2001:db8:1:2:ffff::b", "2001:db8:1:3::a"]) await worker.fetch(rpc("initialize", INIT, { ...auth, "CF-Connecting-IP": ip }), env, {});
  assert.deepStrictEqual(address.keys, ["2001:db8:1:2::/64", "2001:db8:1:2::/64", "2001:db8:1:3::/64"]);
});

test("the 429 example in README.md is exactly what the caller limit sends", async (t) => {
  mockCloud(t);
  captureLogs(t);
  const readme = fs.readFileSync(path.join(HOSTED, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n## Rate limits\n"));
  const example = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
  const res = await worker.fetch(rpc(...CALL), envWith({ caller: binding(false) }), {});
  assert.deepStrictEqual(await res.json(), example);
});
