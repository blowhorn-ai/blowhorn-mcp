// SPDX-License-Identifier: Apache-2.0
/*
 * Multi-tenancy is Cloud's. The hosted tools (getConnections,
 * getPlatformSessions, ...) are served by Cloud behind this transport proxy,
 * which carries the caller's token and the organization selector the client
 * put in the tool arguments, and decides nothing about whose data comes back.
 * These tests hold that line with getPlatformSessions ("where is this social
 * account signed in?") as the case: the selector arrives at Cloud as sent, the
 * token arrives untouched, the request goes to the one constant Cloud URL with
 * no query, the gateway adds no identity or tenant of its own, and Cloud's 404
 * (non-member), 403 (no permission) and rows come back exactly as Cloud
 * answered, JSON or event stream. Cloud is a FAKE UPSTREAM (test/support/harness.js).
 */
import test from "node:test";
import assert from "node:assert";
import worker from "../src/index.js";
import { ACCEPT, CLOUD, ENV, MCP, mockFetch, plainHeaders } from "./support/harness.js";

const TOKEN = "tenancy-test-token-0123456789";
const ORG = "11111111-2222-4333-8444-555555555555";
const OTHER_ORG = "99999999-8888-4777-8666-555555555555";
const JSON_TYPE = { "Content-Type": "application/json" };

function call(args, id = 7) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "getPlatformSessions", arguments: args } });
}

function post(body, headers = {}) {
  return new Request(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: `Bearer ${TOKEN}`, ...headers },
    body,
  });
}

const rpc = (result) => JSON.stringify({ jsonrpc: "2.0", id: 7, result });
const textOf = (bytes) => new TextDecoder().decode(new Uint8Array(bytes));

test("the organization selector and the filters reach Cloud as the client sent them, the token is untouched, and the URL is Cloud's constant", async (t) => {
  const calls = mockFetch(t, () => new Response(rpc({ content: [] }), { status: 200, headers: JSON_TYPE }));
  const body = call({ organizationId: ORG, platform: "x", handle: "blowhorn_ai", installationId: OTHER_ORG });
  const res = await worker.fetch(post(body), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 1, "one request, no retry");
  assert.strictEqual(calls[0].url, `${CLOUD}/mcp`, "no query or path derived from the selector or the filters");
  assert.strictEqual(calls[0].init.method, "POST");
  assert.strictEqual(textOf(calls[0].init.body), body, "the selector travels in the body, byte for byte");
  assert.strictEqual(plainHeaders(calls[0].init.headers).authorization, `Bearer ${TOKEN}`);
});

test("the gateway adds no identity or tenant of its own, and drops any a client supplies", async (t) => {
  const calls = mockFetch(t, () => new Response(rpc({ content: [] }), { status: 200, headers: JSON_TYPE }));
  await worker.fetch(post(call({ organizationId: ORG }), { "X-Current-Orgid": OTHER_ORG, "X-Blowhorn-User": "someone-else", "X-Blowhorn-Org": ORG }), ENV, {});
  const got = plainHeaders(calls[0].init.headers);
  assert.deepStrictEqual(Object.keys(got).sort(), ["accept", "authorization", "content-type", "user-agent", "x-forwarded-mcp-resource"]);
  assert.strictEqual(got["x-forwarded-mcp-resource"], MCP, "the public resource, which names no tenant");
});

test("Cloud's tenancy answers come back as Cloud gave them, once, for the organization named: 404 for a non-member, 403 without permission", async (t) => {
  for (const [status, text] of [
    [404, '{"error":"not_found"}'],
    [403, '{"error":"forbidden"}'],
  ]) {
    await t.test(`${status}`, async (sub) => {
      // Cloud decides from the organization in the body; the Worker only carries the decision.
      const calls = mockFetch(sub, (_url, init) => (textOf(init.body).includes(OTHER_ORG) ? new Response(text, { status, headers: JSON_TYPE }) : new Response(rpc({ content: [] }), { status: 200, headers: JSON_TYPE })));
      const refused = await worker.fetch(post(call({ organizationId: OTHER_ORG })), ENV, {});
      assert.strictEqual(refused.status, status);
      assert.strictEqual(await refused.text(), text);
      const allowed = await worker.fetch(post(call({ organizationId: ORG })), ENV, {});
      assert.strictEqual(allowed.status, 200, "the same token for another organization is Cloud's call, not the Worker's");
      assert.strictEqual(calls.length, 2, "no retry, no second try with another selector");
    });
  }
});

test("rows are not filtered, re-scoped or rewritten: the answer is Cloud's bytes, whatever the rows name", async (t) => {
  const answer = rpc({
    structuredContent: {
      locations: [
        { desktop: { connectionId: "c1", installationId: "i1", status: "connected" }, session: { platform: "x", handle: "blowhorn_ai", state: "signed_in" } },
        { desktop: { connectionId: "c2", installationId: "i2", status: "disconnected" }, session: { platform: "x", handle: "someone_else", state: "unknown" } },
      ],
      totalCount: 2,
      page: 0,
      pageSize: 10,
    },
  });
  mockFetch(t, () => new Response(answer, { status: 200, headers: JSON_TYPE }));
  const res = await worker.fetch(post(call({ handle: "blowhorn_ai" })), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), answer, "the gateway does not apply the handle filter, or any other, to Cloud's rows");
});

test("an event-stream answer is relayed byte for byte as well", async (t) => {
  const sse = `event: message\ndata: ${rpc({ structuredContent: { locations: [{ session: { handle: "someone_else" } }], totalCount: 1 } })}\n\n`;
  mockFetch(t, () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const res = await worker.fetch(post(call({ handle: "blowhorn_ai" })), ENV, {});
  assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream");
  assert.strictEqual(await res.text(), sse);
});

test("a tools/list that names the tool is relayed untouched: the gateway keeps no tool list of its own", async (t) => {
  const list = rpc({ tools: [{ name: "getConnections" }, { name: "getPlatformSessions" }, { name: "aToolThisGatewayNeverHeardOf" }] });
  const calls = mockFetch(t, () => new Response(list, { status: 200, headers: JSON_TYPE }));
  const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  const res = await worker.fetch(post(request), ENV, {});
  assert.strictEqual(await res.text(), list);
  assert.strictEqual(textOf(calls[0].init.body), request);
});
