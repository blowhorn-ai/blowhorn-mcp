// SPDX-License-Identifier: Apache-2.0
/*
 * The transport proxy against the real Worker entry point (worker.fetch), with
 * Cloud stood in behind globalThis.fetch: unauthenticated discovery relay,
 * byte fidelity, header filtering both ways, redirects, streaming, size
 * bounds and failures. Cloud here is a FAKE UPSTREAM (test/support/harness.js).
 */
import test from "node:test";
import assert from "node:assert";
import worker from "../src/index.js";
import { CODES } from "../src/errors.js";
import { MAX_REQUEST_BYTES, METADATA_REQUEST_HEADERS, REQUEST_HEADERS, RESPONSE_HEADERS, TIMEOUT_MS, USER_AGENT } from "../src/proxy.js";
import { ACCEPT, CLOUD, ENV, INIT, ISSUER, MCP, PRM, PRM_PATH, fakeCloud, mockFetch, plainHeaders } from "./support/harness.js";

const TOKEN = "proxy-test-token-0123456789";
const auth = { Authorization: `Bearer ${TOKEN}` };
const ALLOWED = "https://app.example.test";
const CHALLENGE = `Bearer resource_metadata="${PRM}"`;

const logs = [];
const originalLog = console.log;
test.before(() => {
  console.log = (...args) => logs.push(args.join(" "));
});
test.after(() => {
  console.log = originalLog;
  assert.ok(!logs.join("\n").includes(TOKEN), "the token appeared in a log line");
});

function post(message, headers = {}) {
  return new Request(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers },
    body: typeof message === "string" || message instanceof Uint8Array ? message : JSON.stringify(message),
  });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT };

/** The headers the Worker handed to its fetch of Cloud, as a lower-case object. */
function sent(call) {
  return plainHeaders(call.init.headers);
}

test("an unauthenticated POST gets Cloud's 401 challenge and body back verbatim; the Worker answers none of it", async (t) => {
  const cloud = fakeCloud();
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  const res = await worker.fetch(post(initialize), ENV, {});
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE);
  assert.match(res.headers.get("Content-Type"), /^application\/json/);
  assert.deepStrictEqual(await res.json(), { error: "unauthorized" });
  assert.deepStrictEqual(calls.map((c) => [c.init.method, c.url]), [["POST", `${CLOUD}/mcp`]]);
  assert.strictEqual(sent(calls[0]).authorization, undefined);
  // The challenge is Cloud's text, so it is never the old Worker-written realm.
  assert.ok(!res.headers.get("WWW-Authenticate").includes("blowhorn-mcp"));
});

test("a presented but invalid token gets Cloud's invalid_token challenge, byte for byte", async (t) => {
  const cloud = fakeCloud();
  mockFetch(t, (url, init) => cloud.handle(url, init));
  const res = await worker.fetch(post(initialize, auth), ENV, {});
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get("WWW-Authenticate"), `Bearer error="invalid_token", resource_metadata="${PRM}"`);
  // A header that is not a well-formed Bearer is Cloud's to judge as well.
  for (const Authorization of ["Basic abc", "Bearer", `Bearer ${TOKEN} extra`, "Bearer " + "x".repeat(5000)]) {
    const r = await worker.fetch(post(initialize, { Authorization }), ENV, {});
    assert.strictEqual(r.status, 401, Authorization.slice(0, 20));
    assert.strictEqual(r.headers.get("WWW-Authenticate"), `Bearer error="invalid_token", resource_metadata="${PRM}"`);
  }
  assert.strictEqual(cloud.seen.at(-1).headers.authorization, "Bearer " + "x".repeat(5000), "the header went to Cloud exactly as received");
});

test("GET and DELETE /mcp go to Cloud, and Cloud's answer (a 405 and its Allow, or a 401) comes back", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  const noAuth = await worker.fetch(new Request(MCP, { method: "GET", headers: { Accept: "text/event-stream" } }), ENV, {});
  assert.strictEqual(noAuth.status, 401);
  assert.strictEqual(noAuth.headers.get("WWW-Authenticate"), CHALLENGE);
  for (const method of ["GET", "DELETE"]) {
    const res = await worker.fetch(new Request(MCP, { method, headers: { ...auth, "Mcp-Session-Id": "s-1" } }), ENV, {});
    assert.strictEqual(res.status, 405, method);
    assert.strictEqual(res.headers.get("Allow"), "POST", method);
  }
  assert.deepStrictEqual(calls.map((c) => c.init.method), ["GET", "GET", "DELETE"]);
  assert.ok(calls.every((c) => c.url === `${CLOUD}/mcp`));
});

test("both protected resource metadata paths are Cloud's documents, carried unchanged and without any credential", async (t) => {
  const cloud = fakeCloud();
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  for (const path of [PRM_PATH, "/.well-known/oauth-protected-resource"]) {
    const res = await worker.fetch(new Request(`https://mcp.blowhorn.ai${path}`, { headers: { ...auth, Cookie: "sid=1", Accept: "application/json" } }), ENV, {});
    assert.strictEqual(res.status, 200, path);
    assert.deepStrictEqual(await res.json(), { resource: MCP, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] });
    assert.match(res.headers.get("Content-Type"), /^application\/json/);
    assert.strictEqual(res.headers.get("Cache-Control"), "public, max-age=300");
    const head = await worker.fetch(new Request(`https://mcp.blowhorn.ai${path}`, { method: "HEAD" }), ENV, {});
    assert.strictEqual(head.status, 200);
    assert.strictEqual(await head.text(), "");
  }
  assert.deepStrictEqual(calls.map((c) => c.url), [PRM_PATH, PRM_PATH, "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource"].map((p) => `${CLOUD}${p}`));
  assert.deepStrictEqual(calls.map((c) => c.init.method), ["GET", "HEAD", "GET", "HEAD"]);
  for (const c of calls) {
    const allowedNames = [...METADATA_REQUEST_HEADERS.map((h) => h.toLowerCase()), "user-agent"];
    assert.ok(Object.keys(sent(c)).every((k) => allowedNames.includes(k)), Object.keys(sent(c)).join(","));
    assert.strictEqual(sent(c).authorization, undefined, "no credential goes to a public document");
    assert.strictEqual(sent(c).cookie, undefined);
  }
});

test("only the allowlisted headers go to Cloud on /mcp, unchanged; no cookie, forwarded host, client identity or Origin", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  const trace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const allowed = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: ACCEPT,
    "Mcp-Protocol-Version": "2025-06-18",
    "Mcp-Session-Id": "session-abc",
    "Last-Event-ID": "evt-9",
    traceparent: trace,
    tracestate: "vendor=1",
  };
  const dropped = {
    Cookie: "session=secret; other=1",
    "Set-Cookie": "x=1",
    Host: "evil.example",
    Forwarded: "for=192.0.2.1;host=evil.example;proto=http",
    "X-Forwarded-Host": "evil.example",
    "X-Forwarded-Proto": "http",
    "X-Forwarded-For": "192.0.2.1",
    "X-Real-IP": "192.0.2.1",
    "X-Original-URL": "/admin",
    "X-Original-Host": "evil.example",
    "X-Blowhorn-User": "someone",
    "X-Blowhorn-Org": "org",
    "CF-Connecting-IP": "203.0.113.7",
    "CF-Ray": "abc",
    "CF-IPCountry": "US",
    "True-Client-IP": "192.0.2.1",
    Origin: ALLOWED,
    Referer: "https://app.example.test/page",
    "X-Current-Orgid": "11111111-2222-4333-8444-555555555555",
    "User-Agent": "attacker/1.0",
    "Proxy-Authorization": "Basic abc",
    Via: "1.1 evil",
    "X-Custom": "1",
  };
  const res = await worker.fetch(post(initialize, { ...allowed, ...dropped }), ENV, {});
  assert.strictEqual(res.status, 200);
  const got = sent(calls[0]);
  assert.deepStrictEqual(Object.keys(got).sort(), [...REQUEST_HEADERS.map((h) => h.toLowerCase()), "user-agent"].sort());
  for (const [name, value] of Object.entries(allowed)) assert.strictEqual(got[name.toLowerCase()], value, name);
  assert.strictEqual(got["user-agent"], USER_AGENT, "the gateway's own User-Agent, never the client's");
  assert.match(USER_AGENT, /^blowhorn-mcp-hosted\/\d+\.\d+\.\d+$/);
  // Cloud saw nothing of the dropped names, whatever the case or spelling.
  const everything = JSON.stringify(cloud.seen.at(-1));
  for (const value of Object.values(dropped)) if (value.length > 5 && value !== "attacker/1.0") assert.ok(!everything.includes(value), value);
  for (const name of Object.keys(dropped)) assert.ok(!(name.toLowerCase() in got) || name === "User-Agent", name);
});

test("the upstream URL is the constant Cloud URL: never the inbound host, path suffix or query", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  const req = new Request("https://mcp.blowhorn.ai/mcp?redirect=https://evil.example&x=1#frag", {
    method: "POST",
    headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example", "Content-Type": "application/json", Accept: ACCEPT, ...auth },
    body: JSON.stringify(initialize),
  });
  assert.strictEqual((await worker.fetch(req, ENV, {})).status, 200);
  const meta = await worker.fetch(new Request(`https://evil.example${PRM_PATH}?resource=https://evil.example`, { headers: { Host: "evil.example" } }), ENV, {});
  assert.strictEqual(meta.status, 200);
  assert.deepStrictEqual(calls.map((c) => c.url), [`${CLOUD}/mcp`, `${CLOUD}${PRM_PATH}`]);
  assert.deepStrictEqual((await meta.json()).resource, MCP, "the metadata is the same whatever host asked");
});

test("the request body goes out as the exact bytes received, and redirects are never followed", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  // Unusual whitespace, key order and non-ASCII text that a parse-and-reserialize would change.
  const text = '{ "params" :{"name":"getEvents","arguments":{"q":"caf\u00e9 \u{1f600} \\u00e9"}},\n\t"method":"tools/call","jsonrpc":"2.0",  "id":"a" }';
  const bytes = new TextEncoder().encode(text);
  const res = await worker.fetch(post(bytes, auth), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cloud.seen.at(-1).body, text);
  const upstreamBody = calls[0].init.body;
  assert.ok(upstreamBody instanceof ArrayBuffer, "forwarded as the received bytes, not re-encoded text");
  assert.deepStrictEqual(new Uint8Array(upstreamBody), bytes);
  assert.strictEqual(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal, "a timeout signal is set");
  // GET and DELETE carry no body.
  await worker.fetch(new Request(MCP, { method: "GET", headers: auth }), ENV, {});
  assert.strictEqual(calls[1].init.body, undefined);
});

test("without a Bearer token the body is Cloud's business: a non-JSON body and a batch are carried, not judged", async (t) => {
  const cloud = fakeCloud();
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  for (const body of ["this is not json", JSON.stringify([initialize, initialize]), ""]) {
    const res = await worker.fetch(post(body), ENV, {});
    assert.strictEqual(res.status, 401, body.slice(0, 12));
    assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE);
  }
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(cloud.seen[0].body, "this is not json");
});

test("with a Bearer token the body must be one JSON-RPC message: a batch or invalid JSON is refused before Cloud", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  const batch = await worker.fetch(post(JSON.stringify([initialize, initialize]), auth), ENV, {});
  assert.strictEqual(batch.status, 400);
  assert.strictEqual((await batch.json()).error.code, -32600);
  for (const body of ["{not json", "", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])]) {
    const res = await worker.fetch(post(body, auth), ENV, {});
    assert.strictEqual(res.status, 400, String(body));
    assert.strictEqual((await res.json()).error.code, -32700);
  }
  assert.strictEqual(calls.length, 0);
});

test("a body over 1 MB is 413 and never reaches Cloud, declared or not; one at the limit goes through", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  const calls = mockFetch(t, (url, init) => cloud.handle(url, init));
  const filler = (n) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(n) } });
  const overhead = filler(0).length;
  const over = await worker.fetch(post(filler(MAX_REQUEST_BYTES), auth), ENV, {});
  assert.strictEqual(over.status, 413);
  // A chunked body with no Content-Length is cut off at the cap while being read.
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sentChunks = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sentChunks++ >= 100) return controller.close();
      controller.enqueue(chunk);
    },
  });
  const chunked = await worker.fetch(new Request(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: ACCEPT, ...auth }, body: stream, duplex: "half" }), ENV, {});
  assert.strictEqual(chunked.status, 413);
  assert.ok(sentChunks < 100, "the Worker stopped reading once the cap was passed");
  const unauth = await worker.fetch(post(filler(MAX_REQUEST_BYTES)), ENV, {});
  assert.strictEqual(unauth.status, 413, "the bound holds without a token too");
  assert.strictEqual(calls.length, 0);
  const exact = await worker.fetch(post(filler(MAX_REQUEST_BYTES - overhead), auth), ENV, {});
  assert.strictEqual(exact.status, 200);
  assert.strictEqual(calls.length, 1);
});

test("Cloud's answer headers are filtered: Set-Cookie, Location and Access-Control-* never come back; the Worker's own CORS applies", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN], leaky: true });
  mockFetch(t, (url, init) => cloud.handle(url, init));
  const res = await worker.fetch(post(initialize, { ...auth, Origin: ALLOWED }), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("Set-Cookie"), null);
  assert.strictEqual(res.headers.get("X-Cloud-Internal"), null);
  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), ALLOWED, "the Worker's allowlisted CORS, not Cloud's");
  assert.strictEqual(res.headers.get("Mcp-Session-Id"), "session-from-cloud");
  assert.match(res.headers.get("Content-Type"), /^application\/json/);
  const noOrigin = await worker.fetch(post(initialize, auth), ENV, {});
  assert.strictEqual(noOrigin.headers.get("Access-Control-Allow-Origin"), null, "Cloud's CORS header is dropped, not echoed");
  const challenge = await worker.fetch(post(initialize), ENV, {});
  assert.strictEqual(challenge.headers.get("WWW-Authenticate"), CHALLENGE);
  assert.strictEqual(challenge.headers.get("Set-Cookie"), null);
  const meta = await worker.fetch(new Request(PRM), ENV, {});
  assert.strictEqual(meta.headers.get("Set-Cookie"), null);
  assert.strictEqual(meta.headers.get("Access-Control-Allow-Origin"), "*", "public metadata carries the Worker's own CORS value");
  assert.deepStrictEqual(RESPONSE_HEADERS.filter((h) => /^(set-cookie|location|access-control)/i.test(h)), []);
});

test("Cloud's status, Retry-After and body for a 429, 500 or 503 come back unchanged", async (t) => {
  for (const [status, headers, body] of [
    [429, { "Retry-After": "7" }, '{"error":"slow down"}'],
    [500, {}, "oops"],
    [503, { "Retry-After": "120", "Content-Type": "text/plain" }, "maintenance"],
  ]) {
    mockFetch(t, () => new Response(body, { status, headers }));
    const res = await worker.fetch(post(initialize, auth), ENV, {});
    assert.strictEqual(res.status, status);
    assert.strictEqual(res.headers.get("Retry-After"), headers["Retry-After"] ?? null);
    assert.strictEqual(await res.text(), body);
  }
});

test("a redirect from Cloud is a 502 with blowhorn-mcp-1013; it is not followed and Location is not passed on", async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = mockFetch(t, () => new Response("moved", { status, headers: { Location: "https://evil.example/steal", "Set-Cookie": "a=b" } }));
    const res = await worker.fetch(post(initialize, auth), ENV, {});
    assert.strictEqual(res.status, 502, String(status));
    assert.strictEqual(res.headers.get("Location"), null);
    assert.strictEqual(res.headers.get("Set-Cookie"), null);
    const body = await res.json();
    assert.strictEqual(body.error.data.code, CODES.upstream_redirect);
    assert.strictEqual(body.error.code, -32603);
    assert.ok(!JSON.stringify(body).includes("evil.example"));
    assert.strictEqual(calls.length, 1, "one request, no hop");
  }
  const meta = mockFetch(t, () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }));
  const res = await worker.fetch(new Request(PRM), ENV, {});
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.strictEqual(meta.length, 1);
});

test("Cloud unreachable is a 502 with blowhorn-mcp-1011 and a log line that names only the error type", async (t) => {
  mockFetch(t, () => {
    throw new TypeError(`connect failed for ${TOKEN}`);
  });
  const before = logs.length;
  const res = await worker.fetch(post(initialize, { ...auth, Origin: ALLOWED }), ENV, {});
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), ALLOWED);
  const body = await res.json();
  assert.strictEqual(body.error.data.code, CODES.upstream_unreachable);
  assert.strictEqual(body.error.message, body.error.data.shortDescription);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.deepStrictEqual(logs.slice(before).map((l) => JSON.parse(l)), [{ event: "upstream_failed", outcome: "upstream_unreachable", route: "mcp", error: "TypeError" }]);
});

test("a status outside 200-599 from Cloud is treated as unreachable, never passed on", async (t) => {
  mockFetch(t, () => ({ status: 700, headers: new Headers(), body: null }));
  const res = await worker.fetch(post(initialize, auth), ENV, {});
  assert.strictEqual(res.status, 502);
  assert.strictEqual((await res.json()).error.data.code, CODES.upstream_unreachable);
});

test("Cloud not answering within 20 s is a 504 with blowhorn-mcp-1012, and the upstream request is aborted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const calls = mockFetch(
    t,
    (url, init) =>
      new Promise((_, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const pending = worker.fetch(post(initialize, auth), ENV, {});
  while (calls.length === 0) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(TIMEOUT_MS - 1);
  assert.strictEqual(signal.aborted, false);
  t.mock.timers.tick(1);
  const res = await pending;
  assert.strictEqual(res.status, 504);
  assert.strictEqual((await res.json()).error.data.code, CODES.upstream_timeout);
  assert.strictEqual(signal.aborted, true);
});

test("a streamed answer is passed through as it arrives, and the 20 s timeout covers only the headers", async (t) => {
  const cloud = fakeCloud({ legacyTokens: [TOKEN], sse: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  mockFetch(t, (url, init) => cloud.handle(url, init));
  const res = await worker.fetch(new Request(MCP, { headers: { ...auth, Accept: "text/event-stream", "Last-Event-ID": "evt-1" } }), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream");
  assert.strictEqual(res.headers.get("Cache-Control"), "no-cache");
  assert.strictEqual(cloud.seen.at(-1).headers["last-event-id"], "evt-1");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  // Cloud's stream is still open (its gate is shut), so this arrived before the answer finished: not buffered.
  assert.match(decoder.decode(first.value), /notifications\/first/);
  t.mock.timers.tick(TIMEOUT_MS * 3);
  cloud.gate.resolve();
  const second = await reader.read();
  assert.match(decoder.decode(second.value), /notifications\/second/);
  assert.strictEqual((await reader.read()).done, true);
});

test("a client that goes away cancels the upstream stream", async (t) => {
  let cancelled = false;
  mockFetch(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: message\ndata: {}\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const res = await worker.fetch(new Request(MCP, { headers: { ...auth, Accept: "text/event-stream" } }), ENV, {});
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.strictEqual(cancelled, true);
});

test("legacy header tokens are carried to Cloud exactly like any other Bearer: the Worker never inspects the value", async (t) => {
  // Whether Cloud accepts a legacy token is Cloud's; here, only that the Worker neither
  // reads nor rewrites it, and nothing about it changes the route.
  const cloud = fakeCloud({ legacyTokens: [TOKEN] });
  mockFetch(t, (url, init) => cloud.handle(url, init));
  const ok = await worker.fetch(post(initialize, auth), ENV, {});
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).result.serverInfo.name, "fake-cloud-mcp");
  assert.strictEqual(cloud.seen.at(-1).headers.authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(cloud.seen.at(-1).url, `${CLOUD}/mcp`);
});
