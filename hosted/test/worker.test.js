// SPDX-License-Identifier: Apache-2.0
/*
 * The Worker's own surface: which paths and methods it serves at all, its
 * Origin policy, its config guard, and that no credential ever lands in a log
 * line or a body it wrote. What it carries to and from Cloud is in
 * test/proxy.test.js; the OAuth flow through it is in test/oauth-contract.test.js.
 */
import test from "node:test";
import assert from "node:assert";
import worker, * as main from "../src/index.js";
import { VERSION } from "../src/proxy.js";
import { ACCEPT, ENV, INIT, MCP, MCP_ORIGIN, PRM, PRM_PATH, fakeCloud, mockFetch } from "./support/harness.js";

const TOKEN = "fake-test-token-0123456789";
const ALLOWED = "https://app.example.test";
const FOREIGN = "https://evil.example.test";
const auth = { Authorization: `Bearer ${TOKEN}` };

/** Every body and log line the Worker wrote in this file, to check the token never appears. */
const bodies = [];
const logs = [];

async function call(request, env = ENV) {
  const res = await worker.fetch(request, env, {});
  const text = await res.clone().text();
  bodies.push(text);
  return { res, text };
}

function rpc(method, params = {}, headers = {}) {
  return new Request(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const originalLog = console.log;
test.before(() => {
  console.log = (...args) => logs.push(args.join(" "));
});
test.after(() => {
  console.log = originalLog;
  for (const text of [...bodies, ...logs]) assert.ok(!text.includes(TOKEN), "the token appeared in a response or a log line");
  assert.ok(bodies.length > 10);
});

test("the main module exports the default handler and the RateLimiter Durable Object", () => {
  assert.deepStrictEqual(Object.keys(main).sort(), ["RateLimiter", "default"]);
  assert.strictEqual(typeof main.default.fetch, "function");
  assert.strictEqual(typeof main.RateLimiter, "function");
});

test("GET /healthz answers without calling Cloud", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  const { res, text } = await call(new Request("https://mcp.blowhorn.ai/healthz"));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(JSON.parse(text), { ok: true, name: "blowhorn-mcp-hosted", version: VERSION, interim: true });
  assert.strictEqual(calls.length, 0);
  const post = await call(new Request("https://mcp.blowhorn.ai/healthz", { method: "POST" }));
  assert.strictEqual(post.res.status, 405);
  assert.strictEqual(post.res.headers.get("Allow"), "GET, HEAD");
});

test("only /mcp and the two protected resource metadata paths exist; every other path is a 404 and Cloud is never called", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  const paths = [
    "/",
    "/mcp/",
    "/MCP",
    "/sse",
    "/api/content-items",
    // The Worker invents no authorization server: Cloud's issuer is the only one.
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/openid-configuration",
    "/.well-known/openid-configuration/mcp",
    "/.well-known/oauth-protected-resource/",
    "/.well-known/oauth-protected-resource/other",
    "/.well-known/oauth-protected-resource/mcp/",
    "/oauth/register",
    "/oauth/token",
    "/authorize",
    "/token",
    "/register",
    "/hydra/oauth2/auth",
    "/__proto__",
    "/constructor",
  ];
  for (const p of paths) {
    for (const method of ["GET", "POST"]) {
      const { res, text } = await call(new Request(`${MCP_ORIGIN}${p}`, { method, headers: auth, body: method === "POST" ? "{}" : undefined }));
      assert.strictEqual(res.status, 404, `${method} ${p}`);
      assert.ok(JSON.parse(text).error);
    }
  }
  assert.strictEqual(calls.length, 0);
});

test("unsupported methods are 405 with Allow, and Cloud is never called", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  for (const method of ["PUT", "PATCH", "HEAD"]) {
    const { res } = await call(new Request(MCP, { method, headers: auth }));
    assert.strictEqual(res.status, 405, method);
    assert.strictEqual(res.headers.get("Allow"), "POST, GET, DELETE, OPTIONS");
  }
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const { res } = await call(new Request(PRM, { method, body: method === "PUT" || method === "POST" || method === "PATCH" ? "{}" : undefined }));
    assert.strictEqual(res.status, 405, method);
    assert.strictEqual(res.headers.get("Allow"), "GET, HEAD, OPTIONS");
  }
  assert.strictEqual(calls.length, 0);
});

test("/mcp Origin: absent is allowed, an allowed origin is allowed, a foreign or unlisted one is 403 before Cloud", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  assert.strictEqual((await call(rpc("initialize", INIT, auth))).res.status, 200);
  const allowed = await call(rpc("initialize", INIT, { ...auth, Origin: ALLOWED }));
  assert.strictEqual(allowed.res.status, 200);
  assert.strictEqual(allowed.res.headers.get("Access-Control-Allow-Origin"), ALLOWED);
  assert.strictEqual(allowed.res.headers.get("Vary"), "Origin");
  const upstream = calls.length;

  for (const method of ["POST", "GET", "DELETE"]) {
    const foreign = await call(new Request(MCP, { method, headers: { ...auth, Origin: FOREIGN, Accept: ACCEPT, "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined }));
    assert.strictEqual(foreign.res.status, 403, method);
    assert.strictEqual(JSON.parse(foreign.text).jsonrpc, "2.0");
    assert.strictEqual(foreign.res.headers.get("Access-Control-Allow-Origin"), null);
  }
  for (const Origin of ["null", "https://app.example.test.evil.test", "http://app.example.test", "https://app.example.test:8443", "*"]) {
    assert.strictEqual((await call(rpc("initialize", INIT, { ...auth, Origin }))).res.status, 403, Origin);
  }
  const noList = await call(rpc("initialize", INIT, { ...auth, Origin: ALLOWED }), { ...ENV, ALLOWED_ORIGINS: "" });
  assert.strictEqual(noList.res.status, 403);
  const wildcard = await call(rpc("initialize", INIT, { ...auth, Origin: FOREIGN }), { ...ENV, ALLOWED_ORIGINS: "*" });
  assert.strictEqual(wildcard.res.status, 403, "a wildcard in ALLOWED_ORIGINS allows nothing");
  assert.strictEqual(calls.length, upstream, "no refused request reached Cloud");
});

test("OPTIONS /mcp is 204 only for an allowed origin, and never reaches Cloud", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  const ok = await call(new Request(MCP, { method: "OPTIONS", headers: { Origin: ALLOWED } }));
  assert.strictEqual(ok.res.status, 204);
  assert.strictEqual(ok.res.headers.get("Access-Control-Allow-Origin"), ALLOWED);
  assert.strictEqual(ok.res.headers.get("Access-Control-Allow-Methods"), "POST, GET, DELETE");
  const allowHeaders = ok.res.headers.get("Access-Control-Allow-Headers").split(/,\s*/);
  for (const h of ["Authorization", "Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"]) assert.ok(allowHeaders.includes(h), h);
  assert.match(ok.res.headers.get("Access-Control-Expose-Headers"), /\bMcp-Session-Id\b/);
  assert.match(ok.res.headers.get("Access-Control-Expose-Headers"), /\bWWW-Authenticate\b/);
  assert.strictEqual((await call(new Request(MCP, { method: "OPTIONS", headers: { Origin: FOREIGN } }))).res.status, 403);
  assert.strictEqual((await call(new Request(MCP, { method: "OPTIONS" }))).res.status, 403);
  assert.strictEqual(calls.length, 0);
});

test("public metadata is readable from any origin, and that does not loosen /mcp", async (t) => {
  const cloud = fakeCloud();
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  for (const Origin of [undefined, ALLOWED, FOREIGN, "null"]) {
    const { res, text } = await call(new Request(PRM, { headers: Origin ? { Origin } : {} }));
    assert.strictEqual(res.status, 200, String(Origin));
    assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.strictEqual(JSON.parse(text).resource, MCP);
    // /mcp with that very Origin is judged by the allowlist as before.
    const mcpStatus = (await call(rpc("initialize", INIT, Origin ? { Origin } : {}))).res.status;
    assert.strictEqual(mcpStatus, Origin === FOREIGN || Origin === "null" ? 403 : 401, String(Origin));
  }
  const pre = await call(new Request(PRM, { method: "OPTIONS", headers: { Origin: FOREIGN, "Access-Control-Request-Method": "GET" } }));
  assert.strictEqual(pre.res.status, 204);
  assert.strictEqual(pre.res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.strictEqual(pre.res.headers.get("Access-Control-Allow-Methods"), "GET, HEAD");
  assert.ok(!pre.res.headers.has("Access-Control-Allow-Credentials"));
  assert.ok(calls.every((c) => !c.url.endsWith("/mcp") || c.init.headers.get("Authorization") === null));
});

test("a CLOUD_API_BASE other than https://cloud.blowhorn.ai is refused on /mcp, metadata and /healthz", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  for (const CLOUD_API_BASE of ["http://cloud.blowhorn.ai", "https://evil.example.test", "https://cloud.blowhorn.ai.evil.example.test", "https://cloud.blowhorn.ai/api", "https://cloud.blowhorn.ai:8443"]) {
    const env = { ...ENV, CLOUD_API_BASE };
    assert.strictEqual((await call(rpc("initialize", INIT, auth), env)).res.status, 500, CLOUD_API_BASE);
    assert.strictEqual((await call(new Request(PRM), env)).res.status, 500, CLOUD_API_BASE);
    assert.strictEqual((await call(new Request("https://mcp.blowhorn.ai/healthz"), env)).res.status, 500, CLOUD_API_BASE);
  }
  assert.strictEqual(calls.length, 0);
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  mockFetch(t, (url, init) => cloud.handle(url, init));
  assert.strictEqual((await call(rpc("initialize", INIT, auth), { ...ENV, CLOUD_API_BASE: "https://cloud.blowhorn.ai/" })).res.status, 200);
});

test("the metadata path constant is the RFC 9728 path-inserted form of the resource", () => {
  assert.strictEqual(PRM, `${MCP_ORIGIN}/.well-known/oauth-protected-resource${new URL(MCP).pathname}`);
  assert.strictEqual(PRM_PATH, "/.well-known/oauth-protected-resource/mcp");
});
