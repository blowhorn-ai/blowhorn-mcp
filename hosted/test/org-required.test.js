// SPDX-License-Identifier: Apache-2.0
/*
 * Cloud's organization-selection-required answer (HTTP 409, meshery/schemas
 * v1.3.126) is a tool error on a tools/call, never an HTTP 401. The code is
 * read from the JSON Schema generated from the vendored OpenAPI YAML
 * (schemas/generated/org-required.schema.json); there is no second copy here.
 * The mapping fires on the code only, never on message text, and only for a
 * tools/call. Every other 401 stays a 401 with the public challenge. Cloud is
 * a FAKE UPSTREAM (test/support/harness.js).
 */
import test from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { Validator } from "@cfworker/json-schema";
import worker from "../src/index.js";
import { ORG_REQUIRED_CODE, MAX_CLASSIFY_BYTES, orgRequiredBody } from "../src/orgrequired.js";
import { CODES } from "../src/errors.js";
import { TIMEOUT_MS } from "../src/proxy.js";
import { API_FILE, expected, generate } from "../scripts/org-required-schema.js";
import { VENDOR, vendored } from "../scripts/vendor.js";
import schema from "../schemas/generated/org-required.schema.json" with { type: "json" };
import { ACCEPT, ENV, MCP, PRM, deferred, mockFetch } from "./support/harness.js";

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

const ORG_A = "0b7a8f6e-6f0d-4c5e-9f57-1d3e2f9a1111";
const ORG_B = "5c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d2222";
const BODY = {
  code: CODE,
  message: "More than one organization qualifies; choose one.",
  choices: [
    { id: ORG_A, name: "Acme", description: "" },
    { id: ORG_B, name: "Globex", description: "Second org" },
  ],
};
const validator = () => new Validator(schema, "2020-12", false);

async function assertToolError(res, id, body = BODY) {
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("WWW-Authenticate"), null);
  assert.match(res.headers.get("Content-Type"), /^application\/json/);
  const doc = await res.json();
  assert.strictEqual(doc.jsonrpc, "2.0");
  assert.strictEqual(doc.id, id);
  assert.strictEqual(doc.result.isError, true);
  assert.deepStrictEqual(doc.result.structuredContent, body);
  const text = doc.result.content[0].text;
  assert.strictEqual(doc.result.content.length, 1);
  const expected = [body.message, ...body.choices.map((c) => `- ${c.id}: ${c.name}`), "Choose an organization and retry with organizationId set to one of these ids."].join("\n");
  assert.ok(text.startsWith(body.message), "Cloud's message leads");
  assert.strictEqual(text, expected);
  assert.match(text, /organizationId/);
  for (const c of body.choices) {
    assert.ok(text.includes(c.id), `text names ${c.id}`);
    assert.ok(text.includes(c.name), `text names ${c.name}`);
  }
}

test("the code is the published one, read from the schema generated from the vendored YAML, and the placeholder is gone", () => {
  assert.strictEqual(ORG_REQUIRED_CODE, "organization_selection_required");
  assert.strictEqual(CODE, schema.properties.code.enum[0]);
  assert.ok(!existsSync(new URL("../schemas/org-required.json", import.meta.url)));
  assert.ok(!existsSync(new URL("../schemas/org-required.schema.json", import.meta.url)));
  assert.ok(!JSON.stringify(schema).includes("placeholder"));
});

test("the generated schema is exactly what the vendored YAML derives, and its shape matches that YAML", () => {
  assert.strictEqual(readFileSync(new URL("../schemas/generated/org-required.schema.json", import.meta.url), "utf8"), expected());
  const yaml = readFileSync(vendored("meshery", API_FILE, VENDOR), "utf8");
  const api = parse(yaml).components.schemas;
  const err = api.OrganizationSelectionRequiredError;
  const choice = api.OrganizationSelectionChoice;
  assert.deepStrictEqual(schema.required, err.required);
  assert.deepStrictEqual(schema.required, ["code", "message", "choices"]);
  assert.strictEqual(schema.additionalProperties, false);
  assert.deepStrictEqual(schema.properties.code.enum, err.properties.code.enum);
  assert.strictEqual(schema.properties.choices.minItems, 2);
  assert.strictEqual(schema.properties.choices.minItems, err.properties.choices.minItems);
  assert.strictEqual(schema.properties.message.minLength, 1);
  const def = schema.$defs.OrganizationSelectionChoice;
  assert.deepStrictEqual(def.required, choice.required);
  assert.deepStrictEqual(def.required, ["id", "name", "description"]);
  assert.deepStrictEqual(Object.keys(def.properties), Object.keys(choice.properties));
  assert.strictEqual(def.properties.id.format, "uuid");
  assert.strictEqual(def.additionalProperties, false);
  assert.strictEqual(schema.properties.choices.items.$ref, "#/$defs/OrganizationSelectionChoice");
  assert.ok(!/"x-/.test(JSON.stringify(schema)), "no Go codegen extensions");
  assert.ok(!/[\u2013\u2014]/.test(JSON.stringify(schema)), "no dashes but the hyphen");
});

test("the generated schema accepts a legal body and rejects a one-choice, a missing-code and an extra-field body", () => {
  const ok = (b) => validator().validate(b).valid;
  assert.strictEqual(ok(BODY), true);
  assert.strictEqual(ok({ ...BODY, choices: [BODY.choices[0]] }), false, "one choice");
  const { code: _c, ...noCode } = BODY;
  assert.strictEqual(ok(noCode), false, "no code");
  assert.strictEqual(ok({ ...BODY, code: "other" }), false);
  assert.strictEqual(ok({ ...BODY, extra: 1 }), false);
  assert.strictEqual(ok({ ...BODY, message: "" }), false);
  assert.strictEqual(ok({ ...BODY, choices: [{ id: "not-a-uuid", name: "x", description: "" }, BODY.choices[1]] }), false);
  assert.strictEqual(ok({ ...BODY, choices: [{ id: ORG_A, name: "x" }, BODY.choices[1]] }), false, "description is required");
});

test("a Cloud 409 with the body becomes a 200 tool error carrying the body as structuredContent and the choices in the text", async (t) => {
  mockFetch(t, cloud(409, BODY, { ...JSON_TYPE, "WWW-Authenticate": 'Bearer realm="cloud"', "Retry-After": "3" }));
  const res = await worker.fetch(post(toolsCall(42)), ENV, {});
  await assertToolError(res, 42);
  assert.strictEqual(res.headers.get("Retry-After"), null);
});

test("the runtime shape check agrees with the generated schema on what is legal and what is not", () => {
  const { code: _c, message: _m, ...rest } = BODY;
  const cases = [
    BODY,
    { ...BODY, choices: [BODY.choices[0]] },
    { ...BODY, choices: [] },
    { ...BODY, code: "other" },
    { ...BODY, message: "" },
    { ...BODY, message: 5 },
    { ...rest, message: BODY.message },
    { code: CODE },
    { ...BODY, choices: [{ id: ORG_A, name: "x" }, BODY.choices[1]] },
    { ...BODY, choices: [{ id: ORG_A, name: 1, description: "" }, BODY.choices[1]] },
    { ...BODY, choices: "none" },
    [BODY],
    null,
  ];
  for (const doc of cases) {
    assert.strictEqual(orgRequiredBody(doc) !== null, validator().validate(doc).valid, JSON.stringify(doc));
  }
});

test("defensive: a Cloud 401 carrying the exact code is mapped the same way, so it cannot become a sign-in loop", async (t) => {
  mockFetch(t, cloud(401, BODY, { ...JSON_TYPE, "WWW-Authenticate": 'Bearer realm="cloud"' }));
  await assertToolError(await worker.fetch(post(toolsCall(8)), ENV, {}), 8);
});

test("the request's own id comes back, string or number; a missing id is null", async (t) => {
  mockFetch(t, cloud(409, BODY));
  for (const id of ["abc", 0, 9]) await assertToolError(await worker.fetch(post(toolsCall(id)), ENV, {}), id);
  const noId = toolsCall();
  delete noId.id;
  await assertToolError(await worker.fetch(post(noId), ENV, {}), null);
});

test("a 409 or 401 with the code but a non-conforming body passes through unchanged, with no invented message", async (t) => {
  const bad = [{ code: CODE }, { ...BODY, choices: [BODY.choices[0]] }, { ...BODY, message: "" }, { code: CODE, message: "pick one" }];
  for (const status of [409, 401]) {
    for (const body of bad) {
      mockFetch(t, cloud(status, body, { ...JSON_TYPE, "WWW-Authenticate": "Bearer" }));
      const res = await worker.fetch(post(toolsCall()), ENV, {});
      assert.strictEqual(res.status, status, JSON.stringify(body));
      assert.strictEqual(validator().validate(body).valid, false);
      assert.deepStrictEqual(await res.json(), body);
    }
  }
});

test("a Cloud 200 tool result carrying code, message and choices in structuredContent is returned unchanged, unread", async (t) => {
  const text = `${BODY.message}\n- ${ORG_A}: Acme\n- ${ORG_B}: Globex\nRetry with organizationId.`;
  const raw = JSON.stringify({ jsonrpc: "2.0", id: 42, result: { isError: true, content: [{ type: "text", text }], structuredContent: BODY } });
  assert.strictEqual(validator().validate(BODY).valid, true);
  mockFetch(t, cloud(200, raw));
  const res = await worker.fetch(post(toolsCall(42)), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /^application\/json/);
  assert.strictEqual(await res.text(), raw);
});

test("a token or audience 401 stays a 401 with the public challenge, and so does a 401 with an unrelated body or only the message", async (t) => {
  const challenge = 'Bearer error="invalid_token", resource_metadata="https://cloud.blowhorn.ai/.well-known/oauth-protected-resource/mcp"';
  const bodies = [
    { error: "invalid_token", error_description: "The access token expired" },
    { error: { code: "invalid_audience" } },
    { code: "token_expired" },
    { message: "Organization context not set" },
    { error: CODE },
    { error: { code: CODE } },
    { data: { code: CODE } },
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

test("a 400, 403 or 404 carrying the full body is not mapped: the published contract is 409", async (t) => {
  for (const status of [400, 403, 404]) {
    mockFetch(t, cloud(status, BODY));
    const res = await worker.fetch(post(toolsCall()), ENV, {});
    assert.strictEqual(res.status, status);
    assert.deepStrictEqual(await res.json(), BODY);
  }
});

test("a 409 with a different code, and a 400 or 200 without the code, pass through unchanged", async (t) => {
  const other = { code: "idempotency_key_in_flight", message: "still processing" };
  for (const [status, body] of [[409, other], [409, { message: "conflict" }], [400, { message: "Organization context not set" }], [400, { code: "bad_request" }], [200, { jsonrpc: "2.0", id: 42, result: { content: [{ type: "text", text: "ok" }] } }]]) {
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
  for (const status of [401, 400, 409]) {
    for (const message of others) {
      mockFetch(t, cloud(status, BODY));
      const res = await worker.fetch(post(message), ENV, {});
      assert.strictEqual(res.status, status, message.method);
      assert.deepStrictEqual(await res.json(), BODY);
      if (status === 401) assert.ok(res.headers.get("WWW-Authenticate"));
    }
  }
});

test("without a Bearer token the body is not read: Cloud's 401 and 409 stay as sent even if they carry the code", async (t) => {
  mockFetch(t, cloud(401, BODY, { ...JSON_TYPE, "WWW-Authenticate": "Bearer" }));
  const res = await worker.fetch(post(toolsCall(), { Authorization: "" }), ENV, {});
  assert.strictEqual(res.status, 401);
  assert.ok(res.headers.get("WWW-Authenticate"));
  mockFetch(t, cloud(409, BODY));
  const r = await worker.fetch(post(toolsCall(), { Authorization: "" }), ENV, {});
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), BODY);
});

/** A Cloud answer whose body yields a first chunk and then stalls or rejects.
 * A stall is cancellable. `onStall` fires once the second pull is waiting, so a
 * test can tick the read deadline only after peek has scheduled it. Waiting a
 * fixed number of event-loop turns is a race: if tick runs first, the remaining
 * timeout is a mocked timer, which does not keep the event loop alive, and the
 * never-settling stall leaves the test promise pending. Node then cancels it
 * (and the tests after it) with cancelledByParent. */
function brokenBody(status, mode, headers = JSON_TYPE, { onStall } = {}) {
  let sent = false;
  let rejectStall;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"code":'));
        return;
      }
      if (mode === "reject") return Promise.reject(new Error("socket reset"));
      onStall?.();
      return new Promise((_, reject) => {
        rejectStall = reject;
      });
    },
    cancel(reason) {
      rejectStall?.(reason ?? new DOMException("aborted", "AbortError"));
    },
  });
  return new Response(body, { status, headers });
}

test("a 409 tools/call whose body stalls is cut off at the 20 s budget: 504 blowhorn-mcp-1012 with CORS, not a bare 500", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferred();
  mockFetch(t, () => brokenBody(409, "stall", JSON_TYPE, { onStall: started.resolve }));
  const pending = worker.fetch(post(toolsCall(), { Origin: "https://app.example.test" }), ENV, {});
  await started.promise;
  t.mock.timers.tick(TIMEOUT_MS);
  const res = await pending;
  assert.strictEqual(res.status, 504);
  assert.strictEqual((await res.json()).error.data.code, CODES.upstream_timeout);
  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("a 409 tools/call whose body read fails is 502 blowhorn-mcp-1011 with CORS, not a bare 500", async (t) => {
  mockFetch(t, () => brokenBody(409, "reject"));
  const res = await worker.fetch(post(toolsCall(), { Origin: "https://app.example.test" }), ENV, {});
  assert.strictEqual(res.status, 502);
  assert.strictEqual((await res.json()).error.data.code, CODES.upstream_unreachable);
  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("a 401 tools/call whose body stalls or fails still stays a 401 with the public challenge", async (t) => {
  const challenge = 'Bearer error="invalid_token", resource_metadata="https://cloud.blowhorn.ai/.well-known/oauth-protected-resource/mcp"';
  const headers = { ...JSON_TYPE, "WWW-Authenticate": challenge };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  mockFetch(t, () => brokenBody(401, "reject", headers));
  const rejected = await worker.fetch(post(toolsCall(), { Origin: "https://app.example.test" }), ENV, {});
  assert.strictEqual(rejected.status, 401);
  assert.match(rejected.headers.get("WWW-Authenticate"), new RegExp(`resource_metadata="${PRM.replaceAll(".", "\\.")}"`));
  assert.strictEqual(rejected.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.strictEqual(await rejected.text(), "");

  const started = deferred();
  mockFetch(t, () => brokenBody(401, "stall", headers, { onStall: started.resolve }));
  const pending = worker.fetch(post(toolsCall(), { Origin: "https://app.example.test" }), ENV, {});
  await started.promise;
  t.mock.timers.tick(TIMEOUT_MS);
  const stalled = await pending;
  assert.strictEqual(stalled.status, 401);
  assert.match(stalled.headers.get("WWW-Authenticate"), new RegExp(`resource_metadata="${PRM.replaceAll(".", "\\.")}"`));
  assert.strictEqual(await stalled.text(), "");
});

test("an event-stream 200 and a 404 or 403 are never rewritten: they stream through as Cloud sent them", async (t) => {
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 42, result: { isError: true, structuredContent: BODY } })}\n\n`;
  mockFetch(t, cloud(200, sse, { "Content-Type": "text/event-stream" }));
  const res = await worker.fetch(post(toolsCall()), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), sse);
  for (const status of [404, 403]) {
    mockFetch(t, cloud(status, BODY));
    const r = await worker.fetch(post(toolsCall()), ENV, {});
    assert.strictEqual(r.status, status);
    assert.deepStrictEqual(await r.json(), BODY);
  }
});

test("an answer larger than the read bound is returned byte for byte, unclassified", async (t) => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 42, result: { content: [{ type: "text", text: "x".repeat(MAX_CLASSIFY_BYTES * 2) }] }, code: CODE });
  mockFetch(t, cloud(200, big));
  const res = await worker.fetch(post(toolsCall()), ENV, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), big);
  const bigConflict = JSON.stringify({ ...BODY, message: "x".repeat(MAX_CLASSIFY_BYTES * 2) });
  mockFetch(t, cloud(409, bigConflict));
  const r = await worker.fetch(post(toolsCall()), ENV, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(await r.text(), bigConflict);
});
