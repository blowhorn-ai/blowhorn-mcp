// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert";
import { definition } from "../src/errors.js";
import { eventProblems, operationId, postEvent, toolEvent } from "../src/events.js";

const TOKEN = "events-test-token-0123456789";
const BASE = "https://cloud.blowhorn.ai";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACE_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";
const REQUEST_ID = "0c8b1f6e-2a7d-4e3b-9f10-5d6c7b8a9e0f";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEVERITY = {
  ok: "informational",
  invalid_arguments: "warning",
  unknown_tool: "warning",
  refused: "warning",
  cloud_rejected: "warning",
  cloud_failed: "error",
  timeout: "error",
  unreachable: "error",
  redirect: "error",
  too_large: "error",
  not_json: "error",
};

/** One event for `outcome`, built the way the worker builds it; `extra` overrides any field. */
function eventFor(outcome, extra = {}) {
  return toolEvent({
    tool: "getEvents",
    outcome,
    httpStatus: outcome === "cloud_failed" ? 500 : outcome === "cloud_rejected" ? 404 : 0,
    durationMs: 182,
    requestId: REQUEST_ID,
    operationId: TRACE_UUID,
    args: { page: 2 },
    rpcId: 1,
    message: outcome === "ok" ? undefined : `The sentence shown for ${outcome}.`,
    token: TOKEN,
    ...extra,
  });
}

/** Captures console.log for the test's duration; the returned array holds the lines. */
function captureLogs(t) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  t.after(() => {
    console.log = original;
  });
  return lines;
}

/** Replaces globalThis.fetch for the test; returns the calls it saw. */
function mockFetch(t, respond) {
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

test("operationId is the valid traceparent's trace id as a UUID", () => {
  const request = new Request("https://mcp.blowhorn.ai/mcp", { headers: { traceparent: `00-${TRACE}-00f067aa0ba902b7-01` } });
  assert.strictEqual(operationId(request), TRACE_UUID);
});

test("an invalid traceparent falls back to a random UUID", () => {
  const zero = "0".repeat(32);
  const cases = [
    undefined,
    `ff-${TRACE}-00f067aa0ba902b7-01`,
    `00-${zero}-00f067aa0ba902b7-01`,
    `00-${TRACE.toUpperCase()}-00f067aa0ba902b7-01`,
    `00-${TRACE.slice(2)}-00f067aa0ba902b7-01`,
    `00-${TRACE}-00f067aa0ba902b7`,
    `00-${TRACE}-00f067aa0ba902b7-01, 00-${TRACE}-00f067aa0ba902b7-01`,
  ];
  for (const value of cases) {
    const headers = value === undefined ? [] : [["traceparent", value]];
    const id = operationId(new Request("https://mcp.blowhorn.ai/mcp", { headers }));
    assert.match(id, UUID, String(value));
    assert.notStrictEqual(id, TRACE_UUID, String(value));
  }
  const again = operationId(new Request("https://mcp.blowhorn.ai/mcp"));
  assert.notStrictEqual(again, operationId(new Request("https://mcp.blowhorn.ai/mcp")));
});

test("every outcome builds a valid payload with the mapped severity and no value that is not its own", () => {
  for (const outcome of Object.keys(SEVERITY)) {
    const event = eventFor(outcome);
    assert.deepStrictEqual(eventProblems(event), [], outcome);
    assert.strictEqual(event.category, "mcp");
    assert.strictEqual(event.action, "tool_called");
    assert.strictEqual(event.severity, SEVERITY[outcome], outcome);
    assert.strictEqual(event.operationId, TRACE_UUID);
    assert.strictEqual(event.idempotencyKey, `mcp-hosted:${REQUEST_ID}`);
    assert.ok(event.description.length < 5000);
    assert.match(event.description, /^[^\n]+\.$/, outcome);
    assert.strictEqual(event.metadata.outcome, outcome);
    assert.strictEqual(event.metadata.tool, "getEvents");
    assert.strictEqual(event.metadata.gateway, "blowhorn-mcp-hosted");
    assert.strictEqual(event.metadata.rpcId, 1);
    assert.strictEqual(event.metadata.durationMs, 182);
  }
});

test("a success is described by its duration and has no error object", () => {
  const event = eventFor("ok");
  assert.strictEqual(event.description, "Called getEvents through the hosted MCP server in 182 ms.");
  assert.strictEqual(event.metadata.error, undefined);
  assert.deepStrictEqual(event.metadata.arguments, { page: 2 });
});

test("a failure carries a MeshkitError-shaped error, and its text stays out of the description", () => {
  for (const outcome of Object.keys(SEVERITY).filter((o) => o !== "ok")) {
    const event = eventFor(outcome);
    const { error } = event.metadata;
    assert.strictEqual(error.error, `The sentence shown for ${outcome}.`, outcome);
    assert.match(error.code, /^blowhorn-mcp-1\d{3}$/, outcome);
    assert.ok(error.probableCause.length >= 1 && error.probableCause.length <= 3, outcome);
    assert.ok(error.suggestedRemediation.length >= 1 && error.suggestedRemediation.length <= 3, outcome);
    assert.ok(!("severity" in error), outcome);
    assert.ok(!event.description.includes(error.error), outcome);
    assert.ok(!event.description.includes(error.probableCause[0]), outcome);
  }
  assert.strictEqual(eventFor("cloud_failed").description, "getEvents through the hosted MCP server failed with HTTP 500. Blowhorn Cloud answered with a server error.");
  assert.strictEqual(eventFor("cloud_rejected").description, "getEvents through the hosted MCP server failed with HTTP 404. Blowhorn Cloud answered with a client error.");
  assert.strictEqual(eventFor("timeout").description, "getEvents through the hosted MCP server failed. Blowhorn Cloud did not answer in time.");
});

test("a failure's description gives its code's shortDescription as the reason, and a missing message falls back to it", () => {
  for (const outcome of Object.keys(SEVERITY).filter((o) => o !== "ok")) {
    const { shortDescription } = definition(outcome);
    const { description, metadata } = eventFor(outcome);
    const status = metadata.httpStatus ? ` with HTTP ${metadata.httpStatus}` : "";
    assert.strictEqual(description, `getEvents through the hosted MCP server failed${status}. ${shortDescription}`, outcome);
    assert.strictEqual(eventFor(outcome, { message: "" }).metadata.error.error, shortDescription, outcome);
  }
});

test("the error codes are distinct, one per failing outcome", () => {
  const codes = Object.keys(SEVERITY)
    .filter((o) => o !== "ok")
    .map((o) => eventFor(o).metadata.error.code);
  assert.strictEqual(new Set(codes).size, codes.length);
});

test("argument values are redacted under secret-named keys; for invalid arguments or an unknown tool only the names are kept", () => {
  const redacted = eventFor("ok", { args: { search: "launch", apiKey: "k-123", nested: { password: "p-456" } } });
  assert.strictEqual(redacted.metadata.arguments.search, "launch");
  assert.strictEqual(redacted.metadata.arguments.apiKey, "[redacted]");
  assert.strictEqual(redacted.metadata.arguments.nested.password, "[redacted]");
  assert.ok(!JSON.stringify(redacted).includes("p-456"));

  const args = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`${"k".repeat(120)}${i}`, "SENTINEL-VALUE"]));
  for (const outcome of ["invalid_arguments", "unknown_tool"]) {
    const event = eventFor(outcome, { args, message: "Invalid arguments." });
    assert.strictEqual(event.metadata.arguments, undefined, outcome);
    assert.strictEqual(event.metadata.argumentNames.length, 50, outcome);
    assert.ok(event.metadata.argumentNames.every((n) => n.length === 100), outcome);
    assert.ok(!JSON.stringify(event).includes("SENTINEL-VALUE"), outcome);
  }
});

test("a caller-supplied tool name is cut to 100 characters", () => {
  const event = eventFor("unknown_tool", { tool: "t".repeat(300), message: "Unknown tool." });
  assert.strictEqual(event.metadata.tool.length, 100);
  assert.ok(event.description.length < 300);
  assert.deepStrictEqual(eventProblems(event), []);
});

test("the token is replaced everywhere in the payload, in arguments and in the error text", () => {
  const event = eventFor("cloud_rejected", { args: { search: `find ${TOKEN}` }, message: `Cloud echoed ${TOKEN}.` });
  const text = JSON.stringify(event);
  assert.ok(!text.includes(TOKEN));
  assert.strictEqual(event.metadata.arguments.search, "find [redacted]");
  assert.strictEqual(event.metadata.error.error, "Cloud echoed [redacted].");
});

test("eventProblems accepts valid payloads and names locations, never values, for invalid ones", () => {
  const good = eventFor("cloud_failed");
  const badId = eventProblems({ ...good, operationId: "not-a-uuid" });
  assert.ok(badId.some((p) => p.startsWith("/operationId:") && p.includes('format "uuid"')), badId.join("\n"));
  assert.ok(!badId.join("\n").includes("not-a-uuid"));

  const { category, ...noCategory } = good;
  assert.ok(eventProblems(noCategory).some((p) => p.includes('required property "category"')));

  const noErrorText = { ...good, metadata: { ...good.metadata, error: { code: "blowhorn-mcp-1004", probableCause: [], suggestedRemediation: [] } } };
  assert.ok(eventProblems(noErrorText).some((p) => p === '/metadata/error: Instance does not have required property "error".'));
});

test("postEvent POSTs the payload once, as the caller, and sends X-Current-Orgid only when given", async (t) => {
  const logs = captureLogs(t);
  const calls = mockFetch(t, () => new Response(null, { status: 201 }));
  const event = eventFor("ok");
  await postEvent(event, { base: BASE, token: TOKEN, orgId: "11111111-2222-4333-8444-555555555555" });
  await postEvent(event, { base: BASE, token: TOKEN });
  assert.strictEqual(calls.length, 2);
  const [first, second] = calls;
  assert.strictEqual(first.url, `${BASE}/api/events`);
  assert.strictEqual(first.init.method, "POST");
  assert.strictEqual(first.init.redirect, "manual");
  assert.ok(first.init.signal instanceof AbortSignal);
  assert.deepStrictEqual(first.init.headers, {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "blowhorn-mcp-hosted/0.1.0",
    "X-Current-Orgid": "11111111-2222-4333-8444-555555555555",
  });
  assert.strictEqual(first.init.body, JSON.stringify(event));
  assert.ok(!("X-Current-Orgid" in second.init.headers));
  assert.deepStrictEqual(logs, []);
});

test("a failed or refused POST logs one line with the status or error name, and never throws", async (t) => {
  const logs = captureLogs(t);
  mockFetch(t, () => new Response("{}", { status: 500 }));
  await postEvent(eventFor("ok"), { base: BASE, token: TOKEN });
  mockFetch(t, () => Promise.reject(new TypeError(`socket closed ${TOKEN}`)));
  await postEvent(eventFor("ok"), { base: BASE, token: TOKEN });
  assert.deepStrictEqual(logs.map((l) => JSON.parse(l)), [
    { event: "event_post_failed", tool: "getEvents", status: 500 },
    { event: "event_post_failed", tool: "getEvents", error: "TypeError" },
  ]);
  assert.ok(!logs.join("\n").includes(TOKEN));
});

test("an invalid payload is never sent; the log line names problems, not values", async (t) => {
  const logs = captureLogs(t);
  const calls = mockFetch(t, () => assert.fail("fetch was called"));
  await postEvent({ ...eventFor("ok"), operationId: "SENTINEL-NOT-A-UUID" }, { base: BASE, token: TOKEN });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(logs.length, 1);
  const line = JSON.parse(logs[0]);
  assert.strictEqual(line.event, "event_invalid");
  assert.ok(line.problems.length > 0);
  assert.ok(!logs[0].includes("SENTINEL-NOT-A-UUID"));
});

test("every failing outcome has its own blowhorn-mcp code, and every listed remediation answers a listed cause", () => {
  const failing = Object.keys(SEVERITY).filter((o) => o !== "ok");
  const codes = failing.map((o) => eventFor(o).metadata.error.code);
  assert.strictEqual(new Set(codes).size, failing.length);
  for (const outcome of failing) {
    const { error } = eventFor(outcome).metadata;
    assert.strictEqual(new Set(error.suggestedRemediation).size, error.suggestedRemediation.length, outcome);
  }
});

test("arguments too large to record are recorded by name only, and the event still validates", () => {
  const event = eventFor("refused", { args: { search: "x".repeat(9000), page: 1 } });
  assert.strictEqual(event.metadata.arguments, undefined);
  assert.deepStrictEqual(event.metadata.argumentNames, ["search", "page"]);
  assert.deepStrictEqual(eventProblems(event), []);
});
