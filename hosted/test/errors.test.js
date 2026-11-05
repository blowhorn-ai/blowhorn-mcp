// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registry from "../errors/mcp.json" with { type: "json" };
import { CODES, definition } from "../src/errors.js";
import { toolEvent } from "../src/events.js";
import { errorDefinitionValidator, registryProblems } from "../scripts/registry.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVENT_OUTCOMES = Object.keys(CODES).filter((o) => o !== "rate_limited");

/** A deep copy of the registry for a test to break. */
function copy() {
  return structuredClone(registry);
}

function eventFor(outcome) {
  return toolEvent({ tool: "getEvents", outcome, httpStatus: 500, durationMs: 1, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), args: {}, rpcId: 1, message: "Shown.", token: "errors-test-token-0123456789" });
}

test("every definition validates against the vendored ErrorDefinition construct", () => {
  const validator = errorDefinitionValidator();
  for (const d of registry.definitions) {
    const { valid, errors } = validator.validate(d);
    assert.ok(valid, `${d.code}: ${errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; ")}`);
  }
  assert.deepStrictEqual(registryProblems(), []);
});

test("every outcome the gateway reports maps to a definition, and every definition is used", () => {
  for (const [outcome, code] of Object.entries(CODES)) assert.strictEqual(definition(outcome).code, code, outcome);
  assert.deepStrictEqual(Object.values(CODES).sort(), registry.definitions.map((d) => d.code).sort());
  for (const outcome of EVENT_OUTCOMES) {
    const { error } = eventFor(outcome).metadata;
    const d = definition(outcome);
    assert.strictEqual(error.code, d.code, outcome);
    assert.deepStrictEqual(error.probableCause, d.probableCauses.map((c) => c.description), outcome);
    assert.strictEqual(eventFor(outcome).severity, d.severity, outcome);
  }
  assert.throws(() => definition("ok"), /no error code for outcome ok/);
});

test("a refused request is not a tool call, so it has no tool call event", () => {
  assert.throws(() => eventFor("rate_limited"), /no tool call event for outcome rate_limited/);
});

test("the codes, causes and remediation ids that predate the registry file are kept", () => {
  const shape = Object.fromEntries(registry.definitions.map((d) => [d.code, d.probableCauses.map((c) => [c.id, c.remediations.map((r) => r.id)])]));
  assert.deepStrictEqual(shape, {
    "blowhorn-mcp-1000": [["tool-not-offered", ["list-tools"]]],
    "blowhorn-mcp-1001": [["argument-mismatch", ["fix-arguments"]]],
    "blowhorn-mcp-1002": [["bad-path-value", ["one-resource"]], ["url-too-long", ["shorter-arguments"]]],
    "blowhorn-mcp-1003": [["not-found", ["check-identifiers"]], ["no-access", ["check-organization"]]],
    "blowhorn-mcp-1004": [["cloud-error", ["try-again", "contact-support"]]],
    "blowhorn-mcp-1005": [["cloud-slow", ["try-again"]], ["call-too-big", ["smaller-page"]]],
    "blowhorn-mcp-1006": [["cloud-unavailable", ["try-again"]]],
    "blowhorn-mcp-1007": [["endpoint-moved", ["try-again", "contact-support"]]],
    "blowhorn-mcp-1008": [["too-much-data", ["narrow-call"]]],
    "blowhorn-mcp-1009": [["unexpected-body", ["try-again", "contact-support"]]],
    "blowhorn-mcp-1010": [["too-many-calls", ["wait-retry-after", "batch-calls"]], ["shared-address", ["wait-retry-after", "fewer-requests-from-address"]]],
  });
});

test("blowhorn-mcp-1010 is ErrRateLimited, a warning, and none of its remediations is an action", () => {
  const d = definition("rate_limited");
  assert.strictEqual(d.moniker, "ErrRateLimited");
  assert.strictEqual(d.severity, "warning");
  for (const r of d.probableCauses.flatMap((c) => c.remediations)) {
    assert.strictEqual(r.action, undefined, r.id);
    assert.strictEqual(r.approvalPolicy, undefined, r.id);
  }
});

test("registryProblems names what the construct and the gateway's own rules refuse", () => {
  const cases = [
    [(r) => (r.definitions[0].reason = "a gateway-only clause."), /definitions\[0\] blowhorn-mcp-1000 \/: Property "reason" does not match additional properties schema/],
    [(r) => (r.definitions[1].code = "blowhorn-mcp-1000"), /definitions\[1\] blowhorn-mcp-1000: code is used twice/],
    [(r) => (r.nextErrorCode = 1010), /blowhorn-mcp-1010: number is not below nextErrorCode 1010/],
    [(r) => (r.definitions[6].component = { type: "blowhorn", name: "engine" }), /blowhorn-mcp-1006: component is not blowhorn\/mcp/],
    [(r) => (r.component = { type: "blowhorn", name: "engine" }), /component is not \{"type": "blowhorn", "name": "mcp"\}/],
    [(r) => r.definitions.splice(9, 1), /outcome not_json: no definition for blowhorn-mcp-1009/],
    [(r) => (r.extra = true), /keys are \$comment, component, definitions, extra, nextErrorCode/],
    [(r) => (r.nextErrorCode = 1012), /nextErrorCode is 1012; want 1011, one past the highest code/],
    [(r) => (r.definitions[3].probableCauses = []), /definitions\[3\] blowhorn-mcp-1003: no probable cause/],
    [(r) => (r.definitions[5].probableCauses[1].remediations = []), /definitions\[5\] blowhorn-mcp-1005: cause call-too-big has no remediation/],
    [(r) => (r.definitions[2].moniker = "ErrUnknownTool"), /definitions\[2\] blowhorn-mcp-1002: moniker ErrUnknownTool is used twice/],
  ];
  for (const [mutate, want] of cases) {
    const broken = copy();
    mutate(broken);
    assert.match(registryProblems(broken).join("\n"), want);
  }
});

/** README.md's Error codes table, as [code, moniker, outcome] rows: each cell's first `code span`. */
function readmeCodes() {
  const readme = fs.readFileSync(path.join(HOSTED, "README.md"), "utf8");
  const from = readme.indexOf("\n## Error codes\n");
  assert.ok(from > 0, "README.md has an Error codes section");
  const section = readme.slice(from, readme.indexOf("\n## ", from + 1));
  return [...section.matchAll(/^\| `(blowhorn-mcp-\d{4})` \| `(\w+)` \| `(\w+)`[^|\n]* \|$/gm)].map(([, code, moniker, outcome]) => [code, moniker, outcome]);
}

test("README.md's Error codes table lists every definition, its moniker and its outcome, and nothing else", () => {
  const rows = readmeCodes();
  const outcomeOf = Object.fromEntries(Object.entries(CODES).map(([outcome, code]) => [code, outcome]));
  assert.deepStrictEqual(rows, registry.definitions.map((d) => [d.code, d.moniker, outcomeOf[d.code]]));
  assert.deepStrictEqual(Object.fromEntries(rows.map(([code, , outcome]) => [outcome, code])), { ...CODES });
});

test("the drift check runs the registry check", () => {
  const out = execFileSync(process.execPath, [path.join(HOSTED, "scripts", "check-drift.js")], { encoding: "utf8" });
  assert.match(out, /^ok hosted error registry validates against ErrorDefinition$/m);
});
