// SPDX-License-Identifier: Apache-2.0
/*
 * Cloud's missing-organization answer is a tool error, never an HTTP 401.
 * schemas/org-required.json holds a PLACEHOLDER code (pending Cloud's
 * schema, shape in schemas/org-required.schema.json); src/orgrequired.js
 * reads it from there. The mapping fires on the code only, never on message
 * text, and only
 * for a tools/call. Every other 401 stays a 401 with the public challenge.
 * Cloud is a FAKE UPSTREAM (test/support/harness.js).
 */
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Validator } from "@cfworker/json-schema";
import worker from "../src/index.js";
import { ORG_REQUIRED_CODE, ORG_REQUIRED_MESSAGE, MAX_CLASSIFY_BYTES } from "../src/orgrequired.js";
import { ACCEPT, ENV, MCP, PRM, mockFetch } from "./support/harness.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => JSON.parse(readFileSync(path.join(HOSTED, ...p), "utf8"));
const TOKEN = "org-required-test-token-0123456789";
const JSON_TYPE = { "Content-Type": "application/json" };
const CODE = ORG_REQUIRED_CODE;

function post(message, headers = {}) {
  return new Request(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(message),
  });
}
const toolsCall = (id = 42) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "listSchedules", arguments: {} } });
const cloud = (status, body, headers = JSON_TYPE) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

async function assertToolError(res, id) {
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("WWW-Authenticate"), null);
  assert.match(res.headers.get("Content-Type"), /^application\/json/);
  const doc = await res.json();
  assert.deepStrictEqual(doc, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: ORG_REQUIRED_MESSAGE }] } });
  assert.match(doc.result.content[0].text, /organizationId/);
  assert.match(doc.result.content[0].text, /No organization is selected/);
}

test("the mapped code is the one in the checked-in schema file, which is valid against its schema", () => {
  const data = read("schemas", "org-required.json");
  const result = new Validator(read("schemas", "org-required.schema.json"), "2020-12", false).validate(data);
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  assert.strictEqual(data.placeholder, true, "the code is a test fixture until Cloud publishes the real one");
  assert.strictEqual(ORG_REQUIRED_CODE, data.code);
  assert.strictEqual(ORG_REQUIRED_MESSAGE, data.message);
  assert.strictEqual(CODE, data.code, "tests must use the schema file's code, not a second copy");
  assert.ok(!/[\u2013\u2014]/.test(data.message), "no dashes but the hyphen");
});

test("a Cloud 401 or 400 carrying the code, in any stable field, becomes a 200 tool error on a tools/call", async (t) => {
  const shapes = [
    { code: CODE, message: "ignored" },
    { error: CODE },
    { error: { code: CODE, message: "ignored" } },
    { data: { code: CODE } },
  ];
  for (const status of [401, 400]) {
    for (const shape of shapes) {
      mockFetch(t, cloud(status, shape, { ...JSON_TYPE, "WWW-Authenticate": 'Bearer realm="cloud"' }));
      const res = await worker.fetch(post(toolsCall(42)), ENV, {});
      await assertToolError(res, 42);
    }
  }
});

test("the same code on a Cloud 200 tools/call result is still a 200 tool error with the clear message", async (t) => {
  const shapes = [
    { jsonrpc: "2.0", id: 5, result: { isError: true, structuredContent: { code: CODE }, content: [{ type: "text", text: "x" }] } },
    { jsonrpc: "2.0", id: 5, result: { isError: true, structuredContent: { error: { code: CODE } }, content: [] } },
    { jsonrpc: "2.0", id: 5, result: { isError: true, code: CODE, content: [] } },
    { jsonrpc: "2.0", id: 5, result: { isError: true, data: { code: CODE }, content: [] } },
  ];
  for (const shape of shapes) {
    mockFetch(t, cloud(200, shape));
    await assertToolError(await worker.fetch(post(toolsCall(5)), ENV, {}), 5);
  }
});

test("the request's own id comes back, string or number; a missing id is null", async (t) => {
  mockFetch(t, cloud(400, { code: CODE }));
  for (const id of ["abc", 0, 9]) await assertToolError(await worker.fetch(post(toolsCall(id)), ENV, {}), id);
  const noId = toolsCall();
  delete noId.id;
  await assertToolError(await worker.fetch(post(noId), ENV, {}), null);
});

test("a token or audience 401 stays a 401 with the public challenge, and so does a 401 with an unrelated body or only the message", async (t) => {
  const challenge = 'Bearer error="invalid_token", resource_metadata="https://cloud.blowhorn.ai/.well-known/oauth-protected-resource/mcp"';
  const bodies = [
    { error: "invalid_token", error_description: "The access token expired" },
    { error: { code: "invalid_audience" } },
    { code: "token_expired" },
    { message: "Organization context not set" },
    "not json at all",
    "",
  ];
  for (const body of bodies) {
    mockFetch(t, cloud(401, body, { ...JSON_TYPE, "WWW-Authenticate": challenge }));
    const res = await worker.fetch(post(toolsCall()), ENV, {});
    assert.strictEqual(res.status, 401, JSON.stringify(body));
    assert.match(res.headers.get("WWW-Authenticate"), new RegExp(`resource_metadata="${PRM.replaceAll(".", "\\.")}"`));
    assert.strictEqual(await res.text(), typeof body === "string" ? body : JSON.stringify(body), "the body is returned unchanged");
  }
});

test("a 400 and a 200 without the code pass through unchanged", async (t) => {
  for (const [status, body] of [[400, { message: "Organization context not set" }], [400, { code: "bad_request" }], [200, { jsonrpc: "2.0", id: 42, result: { content: [{ type: "text", text: "ok" }] } }]]) {
    mockFetch(t, cloud(status, body));
    const res = await worker.fetch(post(toolsCall()), ENV, {});
    assert.strictEqual(res.status, status);
    assert.deepStrictEqual(await res.json(), body);
  }
});

test("a code-shaped answer to anything but a tools/call is not turned into a tool result", async (t) => {
  const others = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ];
  for (const status of [401, 400]) {
    for (const message of others) {
      mockFetch(t, cloud(status, { code: CODE }));
      const res = await worker.fetch(post(message), ENV, {});
      assert.strictEqual(res.status, status, message.method);
      assert.deepStrictEqual(await res.json(), { code: CODE });
      if (status === 401) assert.ok(res.headers.get("WWW-Authenticate"));
    }
  }
});

test("without a Bearer token the body is not read: Cloud's 401 stays a 401 even if it carries the code", async (t) => {
  mockFetch(t, cloud(401, { code: CODE }, { ...JSON_TYPE, "WWW-Authenticate": "Bearer" }));
  const res = await worker.fetch(post(toolsCall(), { Authorization: "" }), ENV, {});
  assert.strictEqual(res.status, 401);
  assert.ok(res.headers.get("WWW-Authenticate"));
});

test("an event-stream 200 and a 404 or 403 are never read: they stream through as Cloud sent them", async (t) => {
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 42, result: { isError: true, code: CODE } })}\n\n`;
  mockFetch(t, cloud(200, sse, { "Content-Type": "text/event-stream" }));
  const res = await worker.fetch(post(toolsCall()), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), sse);
  for (const status of [404, 403]) {
    mockFetch(t, cloud(status, { code: CODE }));
    const r = await worker.fetch(post(toolsCall()), ENV, {});
    assert.strictEqual(r.status, status);
    assert.deepStrictEqual(await r.json(), { code: CODE });
  }
});

test("an answer larger than the read bound is returned byte for byte, unclassified", async (t) => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 42, result: { content: [{ type: "text", text: "x".repeat(MAX_CLASSIFY_BYTES * 2) }] }, code: CODE });
  mockFetch(t, cloud(200, big));
  const res = await worker.fetch(post(toolsCall()), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), big);
});
