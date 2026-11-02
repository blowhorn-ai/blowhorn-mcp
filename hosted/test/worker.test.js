// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker, * as main from "../src/index.js";
import { TOOLS, buildRequest, dispatch } from "../src/cloud.js";
import { eventProblems } from "../src/events.js";

const TOKEN = "fake-test-token-0123456789";
const ORG = "11111111-2222-4333-8444-555555555555";
const ITEM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
/** A fake Workers Rate Limiting binding that never refuses: these tests want no limiting (test/ratelimit.test.js covers it). */
const UNLIMITED = Object.freeze({ limit: async () => ({ success: true }) });
const ENV = { CLOUD_API_BASE: "https://cloud.blowhorn.ai", ALLOWED_ORIGINS: "https://app.example.test", RATE_LIMIT_ADDRESS: UNLIMITED, RATE_LIMIT_CALLER: UNLIMITED };
const MCP = "https://mcp.blowhorn.ai/mcp";
const ACCEPT = "application/json, text/event-stream";
const EVENTS = "https://cloud.blowhorn.ai/api/events";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every response body and posted event body the worker sent in this test file, to check the token never appears. */
const bodies = [];
const logs = [];

async function call(request, env = ENV) {
  const res = await worker.fetch(request, env, {});
  const text = await res.clone().text();
  bodies.push(text);
  return { res, text };
}

function rpc(method, params = {}, headers = {}, id = 1) {
  return new Request(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const auth = { Authorization: `Bearer ${TOKEN}` };

/** Replaces globalThis.fetch (Cloud) for the test; returns the list of calls it saw. */
function mockCloud(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === EVENTS) bodies.push(String(init.body));
    return respond(String(url), init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** An execution context whose waitUntil keeps the promises the worker hands it, for a test to settle. */
function collector() {
  const promises = [];
  return { promises, waitUntil: (p) => promises.push(p), settle: () => Promise.all(promises) };
}

/** An SDK client connected to the worker through a fetch that never leaves the process. */
async function client(t, headers = auth, ctx = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers },
    fetch: async (url, init) => {
      const res = await worker.fetch(new Request(url, init), ENV, ctx);
      bodies.push(await res.clone().text());
      return res;
    },
  });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(transport);
  t.after(() => c.close());
  return c;
}

const originalLog = console.log;
test.before(() => {
  console.log = (...args) => logs.push(args.join(" "));
});
test.after(() => {
  console.log = originalLog;
  for (const text of [...bodies, ...logs]) assert.ok(!text.includes(TOKEN), "the token appeared in a response or a log line");
  assert.ok(bodies.length > 20);
});

test("the main module exports only the default handler, as Workers require", () => {
  assert.deepStrictEqual(Object.keys(main), ["default"]);
  assert.strictEqual(typeof main.default.fetch, "function");
});

test("GET /healthz answers without calling Cloud", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const { res, text } = await call(new Request("https://mcp.blowhorn.ai/healthz"));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(JSON.parse(text), { ok: true, name: "blowhorn-mcp-hosted", version: "0.1.0", tools: 4, interim: true });
  assert.strictEqual(calls.length, 0);
});

test("other paths are 404 JSON", async () => {
  for (const p of ["/", "/mcp/", "/sse", "/api/content-items"]) {
    const { res, text } = await call(new Request(`https://mcp.blowhorn.ai${p}`));
    assert.strictEqual(res.status, 404, p);
    assert.ok(JSON.parse(text).error);
  }
});

test("GET and DELETE /mcp are 405 with Allow: POST", async () => {
  for (const method of ["GET", "DELETE"]) {
    const { res } = await call(new Request(MCP, { method, headers: auth }));
    assert.strictEqual(res.status, 405, method);
    assert.strictEqual(res.headers.get("Allow"), "POST");
  }
});

test("/mcp without a valid bearer token is 401 with WWW-Authenticate, initialize included", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const cases = [
    {},
    { Authorization: `Basic ${TOKEN}` },
    { Authorization: "Bearer " },
    { Authorization: "Bearer" },
    { Authorization: `Bearer ${TOKEN} extra` },
    { Authorization: `Bearer ${"a".repeat(4097)}` },
  ];
  for (const headers of cases) {
    for (const method of ["initialize", "tools/list"]) {
      const { res, text } = await call(rpc(method, method === "initialize" ? INIT : {}, headers));
      assert.strictEqual(res.status, 401, `${method} ${JSON.stringify(headers).slice(0, 40)}`);
      // RFC 6750 3.1: no error code when no credentials were sent at all.
      const challenge = headers.Authorization === undefined ? 'Bearer realm="blowhorn-mcp"' : 'Bearer realm="blowhorn-mcp", error="invalid_token"';
      assert.strictEqual(res.headers.get("WWW-Authenticate"), challenge);
      const body = JSON.parse(text);
      assert.strictEqual(body.jsonrpc, "2.0");
      assert.match(body.error.message, /Cloud API token/);
      assert.match(body.error.message, /Bearer/);
    }
  }
  assert.strictEqual(calls.length, 0);
});

test("a lowercase bearer scheme is accepted", async () => {
  const { res } = await call(rpc("initialize", INIT, { Authorization: `bearer ${TOKEN}` }));
  assert.strictEqual(res.status, 200);
});

test("Origin: absent is allowed, an allowed origin is allowed, a foreign origin is 403", async () => {
  assert.strictEqual((await call(rpc("initialize", INIT, auth))).res.status, 200);
  const allowed = await call(rpc("initialize", INIT, { ...auth, Origin: "https://app.example.test" }));
  assert.strictEqual(allowed.res.status, 200);
  assert.strictEqual(allowed.res.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  const foreign = await call(rpc("initialize", INIT, { ...auth, Origin: "https://evil.example.test" }));
  assert.strictEqual(foreign.res.status, 403);
  assert.strictEqual(JSON.parse(foreign.text).jsonrpc, "2.0");
  assert.strictEqual(foreign.res.headers.get("Access-Control-Allow-Origin"), null);
  const noList = await call(rpc("initialize", INIT, { ...auth, Origin: "https://app.example.test" }), { ...ENV, ALLOWED_ORIGINS: "" });
  assert.strictEqual(noList.res.status, 403);
});

test("OPTIONS /mcp is 204 only for an allowed origin", async () => {
  const ok = await call(new Request(MCP, { method: "OPTIONS", headers: { Origin: "https://app.example.test" } }));
  assert.strictEqual(ok.res.status, 204);
  assert.strictEqual(ok.res.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.strictEqual(ok.res.headers.get("Access-Control-Allow-Methods"), "POST");
  assert.strictEqual((await call(new Request(MCP, { method: "OPTIONS", headers: { Origin: "https://evil.example.test" } }))).res.status, 403);
  assert.strictEqual((await call(new Request(MCP, { method: "OPTIONS" }))).res.status, 403);
});

test("a CLOUD_API_BASE other than https://cloud.blowhorn.ai is refused on /mcp and /healthz", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  for (const CLOUD_API_BASE of ["http://cloud.blowhorn.ai", "https://evil.example.test", "https://cloud.blowhorn.ai.evil.example.test", "https://cloud.blowhorn.ai/api", "https://cloud.blowhorn.ai:8443"]) {
    assert.strictEqual((await call(rpc("initialize", INIT, auth), { ...ENV, CLOUD_API_BASE })).res.status, 500, CLOUD_API_BASE);
    assert.strictEqual((await call(new Request("https://mcp.blowhorn.ai/healthz"), { ...ENV, CLOUD_API_BASE })).res.status, 500, CLOUD_API_BASE);
  }
  assert.strictEqual((await call(rpc("initialize", INIT, auth), { ...ENV, CLOUD_API_BASE: "https://cloud.blowhorn.ai/" })).res.status, 200);
  assert.strictEqual(calls.length, 0);
});

test("the SDK client initializes and lists exactly the catalog tools, all read-only", async (t) => {
  const c = await client(t);
  assert.strictEqual(c.getServerVersion().name, "blowhorn-mcp-hosted");
  assert.match(c.getInstructions(), /read-only/i);
  const { tools } = await c.listTools();
  assert.deepStrictEqual(tools.map((x) => x.name).sort(), ["getConnections", "getContentItem", "getEvents", "listContentItems"]);
  for (const x of tools) {
    assert.strictEqual(x.annotations.readOnlyHint, true, x.name);
    assert.strictEqual(x.annotations.destructiveHint, false, x.name);
    assert.strictEqual(x.inputSchema.type, "object");
    assert.ok(x.title && x.description, x.name);
  }
});

test("tools/call listContentItems forwards one GET with the bearer, the query and X-Current-Orgid, and nothing else", async (t) => {
  const calls = mockCloud(t, () => jsonResponse(200, { items: [{ id: ITEM }], totalCount: 1 }));
  const c = await client(t);
  const result = await c.callTool({ name: "listContentItems", arguments: { page: 2, pageSize: 5, search: "launch day", organizationId: ORG } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepStrictEqual(result.structuredContent, { items: [{ id: ITEM }], totalCount: 1 });
  assert.deepStrictEqual(JSON.parse(result.content[0].text), { items: [{ id: ITEM }], totalCount: 1 });
  assert.strictEqual(calls.length, 1);
  const { url, init } = calls[0];
  const u = new URL(url);
  assert.strictEqual(u.origin + u.pathname, "https://cloud.blowhorn.ai/api/content-items");
  assert.deepStrictEqual([...u.searchParams].sort(), [["page", "2"], ["pageSize", "5"], ["search", "launch day"]]);
  assert.strictEqual(init.method, "GET");
  assert.strictEqual(init.redirect, "manual");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepStrictEqual(Object.keys(init.headers).sort(), ["Accept", "Authorization", "User-Agent", "X-Current-Orgid"]);
  assert.strictEqual(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(init.headers["X-Current-Orgid"], ORG);
  assert.strictEqual(init.headers.Accept, "application/json");
  assert.strictEqual(init.headers["User-Agent"], "blowhorn-mcp-hosted/0.1.0");
  assert.strictEqual(init.body, undefined);
});

test("array query arguments are sent as repeated keys", async (t) => {
  const calls = mockCloud(t, () => jsonResponse(200, { connections: [] }));
  const c = await client(t);
  const result = await c.callTool({ name: "getConnections", arguments: { status: ["connected", "registered"], kind: ["kubernetes"] } });
  assert.ok(!result.isError);
  const u = new URL(calls[0].url);
  assert.strictEqual(u.pathname, "/api/integrations/connections");
  assert.deepStrictEqual(u.searchParams.getAll("status"), ["connected", "registered"]);
  assert.deepStrictEqual(u.searchParams.getAll("kind"), ["kubernetes"]);
  assert.ok(!("X-Current-Orgid" in calls[0].init.headers));
});

test("getContentItem puts its path value in one encoded segment", async (t) => {
  const calls = mockCloud(t, () => jsonResponse(200, { id: ITEM }));
  const c = await client(t);
  assert.ok(!(await c.callTool({ name: "getContentItem", arguments: { contentItemId: ITEM } })).isError);
  assert.strictEqual(calls[0].url, `https://cloud.blowhorn.ai/api/content-items/${ITEM}`);
  // A traversal attempt fails the uuid format, so it never reaches Cloud...
  const bad = await c.callTool({ name: "getContentItem", arguments: { contentItemId: "a/../b" } });
  assert.strictEqual(bad.isError, true);
  assert.strictEqual(calls.length, 1);
  // ...and even past validation, the request builder keeps it in one segment.
  const req = buildRequest(TOOLS.get("getContentItem"), { contentItemId: "a/../b" }, { base: "https://cloud.blowhorn.ai", token: TOKEN });
  assert.strictEqual(req.url, "https://cloud.blowhorn.ai/api/content-items/a%2F..%2Fb");
  assert.strictEqual(new URL(req.url).pathname, "/api/content-items/a%2F..%2Fb");
  assert.throws(() => buildRequest(TOOLS.get("getContentItem"), { contentItemId: ".." }, { base: "https://cloud.blowhorn.ai", token: TOKEN }));
});

test("invalid arguments are a tool error that names no value, and Cloud is never called", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const c = await client(t);
  const unknown = await c.callTool({ name: "listContentItems", arguments: { bogus: "SENTINEL-VALUE" } });
  assert.strictEqual(unknown.isError, true);
  assert.match(unknown.content[0].text, /bogus/);
  assert.ok(!unknown.content[0].text.includes("SENTINEL-VALUE"));
  const wrongType = await c.callTool({ name: "listContentItems", arguments: { page: "SENTINEL-VALUE" } });
  assert.strictEqual(wrongType.isError, true);
  assert.match(wrongType.content[0].text, /\/page/);
  assert.ok(!wrongType.content[0].text.includes("SENTINEL-VALUE"));
  const missing = await c.callTool({ name: "getContentItem", arguments: {} });
  assert.strictEqual(missing.isError, true);
  assert.strictEqual(calls.length, 0);
});

test("an unknown tool is a JSON-RPC error", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const c = await client(t);
  await assert.rejects(c.callTool({ name: "deleteContentItem", arguments: {} }), /Unknown tool/);
  assert.strictEqual(calls.length, 0);
});

test("a Cloud 401 is a tool error carrying Cloud's message, truncated", async (t) => {
  mockCloud(t, () => jsonResponse(401, { message: `token rejected ${"x".repeat(400)}` }));
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /^Cloud answered 401\. token rejected x+\.\.\.$/);
  assert.ok(result.content[0].text.length < 340);
});

test("a Cloud message that echoes the token is scrubbed", async (t) => {
  mockCloud(t, () => jsonResponse(403, { message: `bad token ${TOKEN}` }));
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.ok(!result.content[0].text.includes(TOKEN));
});

test("a Cloud redirect is an error and is never followed", async (t) => {
  const calls = mockCloud(t, () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test/steal" } }));
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /302/);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].init.redirect, "manual");
});

test("a Cloud answer over 2 MB is an error", async (t) => {
  mockCloud(t, () => new Response(JSON.stringify({ blob: "x".repeat(2 * 1024 * 1024) }), { status: 200 }));
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /larger than 2 MB/);
});

test("values under secret-named keys are redacted; booleans, null and look-alikes are kept", async (t) => {
  const body = {
    items: [{ id: ITEM, accessToken: "s3cr3t-a", api_key: "s3cr3t-b", authToken: "s3cr3t-c", password: { nested: "s3cr3t-d" } }],
    tokenConfigured: true,
    session_cookie: null,
    idempotencyKey: "keep-1",
    authStatus: "keep-2",
    author: "keep-3",
  };
  mockCloud(t, () => jsonResponse(200, body));
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.ok(!result.isError);
  for (const secret of ["s3cr3t-a", "s3cr3t-b", "s3cr3t-c", "s3cr3t-d"]) {
    assert.ok(!result.content[0].text.includes(secret), secret);
    assert.ok(!JSON.stringify(result.structuredContent).includes(secret), secret);
  }
  const item = result.structuredContent.items[0];
  assert.deepStrictEqual([item.accessToken, item.api_key, item.authToken, item.password], ["[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
  assert.strictEqual(result.structuredContent.tokenConfigured, true);
  assert.strictEqual(result.structuredContent.session_cookie, null);
  assert.deepStrictEqual([result.structuredContent.idempotencyKey, result.structuredContent.authStatus, result.structuredContent.author], ["keep-1", "keep-2", "keep-3"]);
});

test("a JSON array answer is text content without structuredContent", async (t) => {
  mockCloud(t, () => jsonResponse(200, [{ id: ITEM }]));
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.ok(!result.isError);
  assert.strictEqual(result.structuredContent, undefined);
  assert.deepStrictEqual(JSON.parse(result.content[0].text), [{ id: ITEM }]);
});

test("dispatch refuses any method but GET, a non-catalog path and another host", async (t) => {
  const calls = mockCloud(t, () => jsonResponse(200, {}));
  const base = "https://cloud.blowhorn.ai";
  const headers = { Accept: "application/json" };
  await assert.rejects(dispatch({ method: "POST", url: `${base}/api/content-items`, headers }, { base }), /not GET/);
  await assert.rejects(dispatch({ method: "DELETE", url: `${base}/api/content-items/${ITEM}`, headers }, { base }), /not GET/);
  await assert.rejects(dispatch({ method: "GET", url: `${base}/api/identity/users/profile`, headers }, { base }), /not from the catalog/);
  await assert.rejects(dispatch({ method: "GET", url: `${base}/api/content-items/a/b`, headers }, { base }), /not from the catalog/);
  await assert.rejects(dispatch({ method: "GET", url: "https://elsewhere.example.test/api/content-items", headers }, { base }), /not on the Cloud API base/);
  assert.strictEqual(calls.length, 0);
  await dispatch({ method: "GET", url: `${base}/api/content-items?page=1`, headers }, { base });
  assert.strictEqual(calls.length, 1);
});

function post(body, headers = auth) {
  return new Request(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers }, body });
}

test("a JSON-RPC batch is 400 with a JSON-RPC error, and Cloud is never called", async (t) => {
  const calls = mockCloud(t, () => jsonResponse(200, {}));
  const one = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "getEvents", arguments: {} } });
  for (const batch of [[one(1), one(2), one(3)], [one(1)], []]) {
    const { res, text } = await call(post(JSON.stringify(batch)));
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(text);
    assert.strictEqual(body.jsonrpc, "2.0");
    assert.strictEqual(body.error.code, -32600);
    assert.match(body.error.message, /batch/i);
  }
  assert.strictEqual(calls.length, 0);
});

test("a body that is not JSON is 400 with a parse error", async () => {
  const { res, text } = await call(post("{not json"));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(JSON.parse(text).error.code, -32700);
});

test("a body over 1 MB is 413", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "getEvents", arguments: { search: "x".repeat(1024 * 1024) } } });
  const { res, text } = await call(post(big));
  assert.strictEqual(res.status, 413);
  assert.strictEqual(JSON.parse(text).jsonrpc, "2.0");
  assert.strictEqual(calls.length, 0);
});

test("a notification is 202 with no body", async () => {
  const { res, text } = await call(post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })));
  assert.strictEqual(res.status, 202);
  assert.strictEqual(text, "");
});

test("a wrong Accept is 406 and a wrong Content-Type is 415", async () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
  assert.strictEqual((await call(post(init, { ...auth, Accept: "application/json" }))).res.status, 406);
  const noAccept = new Request(MCP, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: init });
  assert.strictEqual((await call(noAccept)).res.status, 406);
  assert.strictEqual((await call(post(init, { ...auth, "Content-Type": "text/plain" }))).res.status, 415);
});

test("a Cloud timeout, before or during the body, is a tool error", async (t) => {
  let mode = "fetch";
  mockCloud(t, () => {
    if (mode === "fetch") throw new DOMException("timed out", "TimeoutError");
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"items": ['));
        c.error(new DOMException("timed out", "TimeoutError"));
      },
    });
    return new Response(body, { status: 200 });
  });
  const c = await client(t);
  for (mode of ["fetch", "body"]) {
    const result = await c.callTool({ name: "getEvents", arguments: {} });
    assert.strictEqual(result.isError, true, mode);
    assert.match(result.content[0].text, /did not answer within 20 seconds/, mode);
  }
});

test("a Cloud body that breaks partway is a tool error, not a JSON-RPC error", async (t) => {
  mockCloud(t, () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"items": ['));
        c.error(new TypeError("connection reset SENTINEL-RUNTIME"));
      },
    });
    return new Response(body, { status: 200 });
  });
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.content[0].text, "Could not reach Cloud.");
});

test("an organizationId with CR/LF or not a UUID is a tool error, and Cloud is never called", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const c = await client(t);
  for (const organizationId of [`${ORG}\r\nX-Evil: 1`, `${ORG.slice(0, 34)}\r\n`, "not-a-uuid", `${ORG}x`]) {
    const result = await c.callTool({ name: "getEvents", arguments: { organizationId } });
    assert.strictEqual(result.isError, true, JSON.stringify(organizationId));
    assert.match(result.content[0].text, /\/organizationId/);
  }
  assert.strictEqual(calls.length, 0);
});

test("a success body that echoes the token is scrubbed and carries no structuredContent", async (t) => {
  mockCloud(t, () => jsonResponse(200, { note: `issued for ${TOKEN}`, id: ITEM }));
  const c = await client(t);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.ok(!result.isError);
  assert.strictEqual(result.structuredContent, undefined);
  assert.ok(!result.content[0].text.includes(TOKEN));
  assert.deepStrictEqual(JSON.parse(result.content[0].text), { note: "issued for [redacted]", id: ITEM });
});

test("unbounded source parameters get default bounds: 50 items, 1000 characters, a maximum of 1000000", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const c = await client(t);
  const cases = [
    ["getConnections", { kind: Array(51).fill("k") }, /\/kind/],
    ["getEvents", { search: "x".repeat(1001) }, /\/search/],
    ["getEvents", { page: 1e300 }, /\/page/],
    ["listContentItems", { pageSize: 1000001 }, /\/pageSize/],
  ];
  for (const [name, args, where] of cases) {
    const result = await c.callTool({ name, arguments: args });
    assert.strictEqual(result.isError, true, name);
    assert.match(result.content[0].text, where);
  }
  assert.strictEqual(calls.length, 0);
});

test("a request URL over 8192 bytes is refused before Cloud is called", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  const long = Array(50).fill("k".repeat(255));
  assert.throws(() => buildRequest(TOOLS.get("getConnections"), { kind: long }, { base: "https://cloud.blowhorn.ai", token: TOKEN }), /over 8192 bytes/);
  const c = await client(t);
  const result = await c.callTool({ name: "getConnections", arguments: { kind: long, type: long } });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /over 8192 bytes/);
  assert.strictEqual(calls.length, 0);
});

test("the gateway serves with code generation forbidden, as Workers do", async (t) => {
  const original = globalThis.Function;
  globalThis.Function = new Proxy(original, {
    construct: () => assert.fail("new Function was called"),
    apply: () => assert.fail("Function() was called"),
  });
  t.after(() => {
    globalThis.Function = original;
  });
  mockCloud(t, () => jsonResponse(200, { events: [] }));
  const c = await client(t);
  assert.strictEqual((await c.listTools()).tools.length, 4);
  assert.ok(!(await c.callTool({ name: "getEvents", arguments: { page: 1 } })).isError);
});

/** The posted event bodies the worker sent to Cloud's createEvent, as parsed objects. */
function postedEvents(calls) {
  return calls.filter((c) => c.url === EVENTS).map((c) => JSON.parse(c.init.body));
}

/** A Cloud mock: `answer` for every call except the createEvent POST, which gets `event`. */
function cloudWith(t, answer, event = () => new Response(null, { status: 201 })) {
  return mockCloud(t, (url, init) => (url === EVENTS ? event(init) : answer(url, init)));
}

test("a successful tool call posts one tool_called event, as the caller, after its result", async (t) => {
  const calls = cloudWith(t, () => jsonResponse(200, { events: [] }));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  const result = await c.callTool({ name: "getEvents", arguments: { page: 1, organizationId: ORG } });
  assert.ok(!result.isError);
  await ctx.settle();
  const posts = calls.filter((x) => x.url === EVENTS);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].init.method, "POST");
  assert.strictEqual(posts[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(posts[0].init.headers["X-Current-Orgid"], ORG);
  const [event] = postedEvents(calls);
  assert.strictEqual(event.category, "mcp");
  assert.strictEqual(event.action, "tool_called");
  assert.strictEqual(event.severity, "informational");
  assert.strictEqual(event.metadata.tool, "getEvents");
  assert.strictEqual(event.metadata.outcome, "ok");
  assert.strictEqual(event.metadata.httpStatus, 200);
  assert.strictEqual(typeof event.metadata.durationMs, "number");
  assert.match(event.idempotencyKey, new RegExp(`^mcp-hosted:${UUID.source.slice(1, -1)}$`));
  assert.match(event.operationId, UUID);
  assert.deepStrictEqual(eventProblems(event), []);
});

test("the operationId is the traceparent's trace id, and a bad traceparent falls back to a random UUID", async (t) => {
  const calls = cloudWith(t, () => jsonResponse(200, {}));
  const ctx = collector();
  const c = await client(t, { ...auth, traceparent: `00-${TRACE}-00f067aa0ba902b7-01` }, ctx);
  await c.callTool({ name: "getEvents", arguments: {} });
  await ctx.settle();
  assert.strictEqual(postedEvents(calls)[0].operationId, "4bf92f35-77b3-4da6-a3ce-929d0e0e4736");

  const bad = collector();
  const d = await client(t, { ...auth, traceparent: `00-${"0".repeat(32)}-00f067aa0ba902b7-01` }, bad);
  await d.callTool({ name: "getEvents", arguments: {} });
  await bad.settle();
  const fallback = postedEvents(calls)[1].operationId;
  assert.match(fallback, UUID);
  assert.notStrictEqual(fallback, "00000000-0000-0000-0000-000000000000");
});

test("a Cloud 500 is an error event with the MeshkitError shape; a Cloud 404 is a warning", async (t) => {
  const calls = cloudWith(t, (url) => (url.includes("/api/events/list") ? jsonResponse(500, { message: "boom" }) : jsonResponse(404, {})));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  assert.strictEqual((await c.callTool({ name: "getEvents", arguments: {} })).isError, true);
  assert.strictEqual((await c.callTool({ name: "getContentItem", arguments: { contentItemId: ITEM } })).isError, true);
  await ctx.settle();
  const [failed, missing] = postedEvents(calls);
  assert.strictEqual(failed.severity, "error");
  assert.strictEqual(failed.metadata.outcome, "cloud_failed");
  assert.strictEqual(failed.metadata.httpStatus, 500);
  assert.strictEqual(failed.metadata.error.error, "Cloud answered 500. boom");
  assert.strictEqual(failed.metadata.error.code, "blowhorn-mcp-1004");
  assert.ok(failed.metadata.error.probableCause.length > 0);
  assert.ok(failed.metadata.error.suggestedRemediation.length > 0);
  assert.ok(!("severity" in failed.metadata.error));
  assert.ok(!failed.description.includes("boom"));
  assert.deepStrictEqual(eventProblems(failed), []);
  assert.strictEqual(missing.severity, "warning");
  assert.strictEqual(missing.metadata.outcome, "cloud_rejected");
  assert.strictEqual(missing.metadata.httpStatus, 404);
  assert.deepStrictEqual(eventProblems(missing), []);
});

test("invalid arguments are a warning that names the argument, never its value; Cloud is not called", async (t) => {
  const calls = cloudWith(t, () => assert.fail("Cloud was called"));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  const result = await c.callTool({ name: "listContentItems", arguments: { bogus: "SENTINEL-VALUE" } });
  assert.strictEqual(result.isError, true);
  await ctx.settle();
  const [event] = postedEvents(calls);
  assert.strictEqual(event.severity, "warning");
  assert.strictEqual(event.metadata.outcome, "invalid_arguments");
  assert.deepStrictEqual(event.metadata.argumentNames, ["bogus"]);
  assert.strictEqual(event.metadata.arguments, undefined);
  assert.ok(!JSON.stringify(event).includes("SENTINEL-VALUE"));
  assert.deepStrictEqual(eventProblems(event), []);
});

test("an unknown tool records a warning event and still answers with the JSON-RPC error", async (t) => {
  const calls = cloudWith(t, () => assert.fail("Cloud was called"));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  await assert.rejects(c.callTool({ name: "deleteContentItem", arguments: { contentItemId: ITEM } }), /Unknown tool/);
  await ctx.settle();
  const [event] = postedEvents(calls);
  assert.strictEqual(event.severity, "warning");
  assert.strictEqual(event.metadata.outcome, "unknown_tool");
  assert.strictEqual(event.metadata.tool, "deleteContentItem");
  assert.deepStrictEqual(event.metadata.argumentNames, ["contentItemId"]);
  assert.ok(!JSON.stringify(event).includes(ITEM));
});

test("a Cloud 401 records nothing and logs that it was skipped", async (t) => {
  const calls = cloudWith(t, () => jsonResponse(401, { message: "token rejected" }));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  assert.strictEqual((await c.callTool({ name: "getEvents", arguments: {} })).isError, true);
  await ctx.settle();
  assert.strictEqual(postedEvents(calls).length, 0);
  assert.strictEqual(ctx.promises.length, 0);
  assert.ok(logs.map((l) => JSON.parse(l)).some((l) => l.method === "tools/call" && l.tool === "getEvents" && l.status === 401 && l.event === "skipped_unauthenticated"));
});

test("a missing or malformed token calls no Cloud and logs why", async (t) => {
  const calls = mockCloud(t, () => assert.fail("Cloud was called"));
  for (const [headers, reason] of [[{}, "missing"], [{ Authorization: `Basic ${TOKEN}` }, "malformed"]]) {
    const ctx = collector();
    const res = await worker.fetch(rpc("tools/call", { name: "getEvents", arguments: {} }, headers), ENV, ctx);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(ctx.promises.length, 0);
    bodies.push(await res.text());
    assert.ok(logs.map((l) => JSON.parse(l)).some((l) => l.event === "auth_failed" && l.reason === reason), reason);
  }
  assert.strictEqual(calls.length, 0);
});

test("a token in a tool argument is scrubbed from the posted event", async (t) => {
  const calls = cloudWith(t, () => jsonResponse(200, { events: [] }));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  await c.callTool({ name: "getEvents", arguments: { search: `find ${TOKEN}` } });
  await ctx.settle();
  const [event] = postedEvents(calls);
  assert.strictEqual(event.metadata.arguments.search, "find [redacted]");
  assert.ok(!JSON.stringify(event).includes(TOKEN));
});

test("an events POST that never resolves does not delay the tool result", async (t) => {
  cloudWith(t, () => jsonResponse(200, { events: [{ id: ITEM }] }), () => new Promise(() => {}));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.deepStrictEqual(result.structuredContent, { events: [{ id: ITEM }] });
  assert.strictEqual(ctx.promises.length, 1);
});

test("a rejected or 500 events POST only logs event_post_failed and never changes the result", async (t) => {
  const calls = cloudWith(t, () => jsonResponse(200, { events: [] }), () => {
    throw new TypeError("socket SENTINEL-RUNTIME");
  });
  const ctx = collector();
  const c = await client(t, auth, ctx);
  const result = await c.callTool({ name: "getEvents", arguments: {} });
  assert.ok(!result.isError);
  await ctx.settle();
  assert.strictEqual(calls.filter((x) => x.url === EVENTS).length, 1);
  assert.ok(logs.map((l) => JSON.parse(l)).some((l) => l.event === "event_post_failed" && l.error === "TypeError" && l.tool === "getEvents"));

  const answered = cloudWith(t, () => jsonResponse(200, { events: [] }), () => new Response("{}", { status: 500 }));
  const next = collector();
  const d = await client(t, auth, next);
  assert.ok(!(await d.callTool({ name: "getEvents", arguments: {} })).isError);
  await next.settle();
  assert.strictEqual(answered.filter((x) => x.url === EVENTS).length, 1);
  assert.ok(logs.map((l) => JSON.parse(l)).some((l) => l.event === "event_post_failed" && l.status === 500));
});

test("with no waitUntil in the context, nothing is posted", async (t) => {
  const calls = cloudWith(t, () => jsonResponse(200, { events: [] }));
  const c = await client(t, auth, {});
  assert.ok(!(await c.callTool({ name: "getEvents", arguments: {} })).isError);
  assert.strictEqual(postedEvents(calls).length, 0);
});

test("log lines carry only the fields the gateway names", () => {
  const lines = logs.map((l) => JSON.parse(l));
  assert.ok(lines.length > 0);
  const tool = ["method", "ms", "outcome", "status", "tool"];
  const allowed = {
    tool_call: [...tool],
    skipped: ["event", "method", "status", "tool"],
    auth: ["event", "reason"],
    post: ["event", "error", "status", "tool"],
    invalid: ["event", "problems"],
  };
  for (const line of lines) {
    const keys = Object.keys(line).sort();
    const kind = line.method ? (line.event ? "skipped" : "tool_call") : line.event === "auth_failed" ? "auth" : line.event === "event_invalid" ? "invalid" : "post";
    assert.ok(keys.every((k) => allowed[kind].includes(k)), `${kind}: ${keys.join(",")}`);
  }
});

test("a failed call naming an organization records its event without that organization's header", async (t) => {
  const calls = cloudWith(t, () => jsonResponse(404, {}));
  const ctx = collector();
  const c = await client(t, auth, ctx);
  assert.strictEqual((await c.callTool({ name: "getEvents", arguments: { organizationId: ORG } })).isError, true);
  await ctx.settle();
  const posts = calls.filter((x) => x.url === EVENTS);
  assert.strictEqual(posts.length, 1);
  assert.ok(!("X-Current-Orgid" in posts[0].init.headers));
});
