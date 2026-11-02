// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";
import registry from "../errors/mcp.json" with { type: "json" };
import { CODES, definition } from "../src/errors.js";
import { toolEvent } from "../src/events.js";
import { errorDefinitionSchema, registryProblems } from "../scripts/registry.js";

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
  const validator = new Validator(errorDefinitionSchema(), "2020-12", false);
  for (const d of registry.definitions) {
    const { valid, errors } = validator.validate(d);
    assert.ok(valid, `${d.code}: ${errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; ")}`);
  }
  assert.deepStrictEqual(registryProblems(), []);
});

test("the registry has the engine registry's shape, and its codes are unique and below nextErrorCode", () => {
  assert.deepStrictEqual(Object.keys(registry).sort(), ["$comment", "component", "definitions", "nextErrorCode"]);
  assert.deepStrictEqual(registry.component, { type: "blowhorn", name: "mcp" });
  assert.match(registry.$comment, /provisional until the registry \(blowhorn-ai\/blowhorn#1662\)/);
  const numbers = registry.definitions.map((d) => Number(d.code.match(/^blowhorn-mcp-(\d{4})$/)[1]));
  assert.strictEqual(new Set(numbers).size, numbers.length);
  assert.ok(numbers.every((n) => n < registry.nextErrorCode));
  assert.strictEqual(registry.nextErrorCode, Math.max(...numbers) + 1);
  assert.strictEqual(new Set(registry.definitions.map((d) => d.moniker)).size, numbers.length);
  for (const d of registry.definitions) {
    assert.deepStrictEqual(d.component, registry.component, d.code);
    assert.strictEqual(d.referenceUrl, `https://blowhorn.ai/docs/reference/error-codes/${d.code}/`);
  }
});

test("every outcome the gateway reports maps to a definition, and every definition is used", () => {
  for (const [outcome, code] of Object.entries(CODES)) assert.strictEqual(definition(outcome).code, code, outcome);
  assert.deepStrictEqual(Object.values(CODES).sort(), registry.definitions.filter((d) => !d.retired).map((d) => d.code).sort());
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
    "blowhorn-mcp-1010": [["too-many-calls", ["wait-retry-after", "batch-calls"]], ["shared-address", ["authenticate", "wait-retry-after"]]],
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

test("registryProblems names what the construct and the registry's own rules refuse", () => {
  const cases = [
    [(r) => (r.definitions[0].reason = "a gateway-only clause."), /definitions\[0\] blowhorn-mcp-1000 \/: Property "reason" does not match additional properties schema/],
    [(r) => (r.definitions[1].code = "blowhorn-mcp-1000"), /definitions\[1\] blowhorn-mcp-1000: code is used twice/],
    [(r) => (r.nextErrorCode = 1010), /blowhorn-mcp-1010: number is not below nextErrorCode 1010/],
    [(r) => (r.definitions[2].referenceUrl = "https://blowhorn.ai/docs/reference/error-codes/other/"), /blowhorn-mcp-1002: referenceUrl is not/],
    [(r) => (r.definitions[3].probableCauses = []), /blowhorn-mcp-1003: no probable causes/],
    [(r) => (r.definitions[4].probableCauses[0].remediations[0].approvalPolicy = "required"), /remediation try-again has an approvalPolicy but no action/],
    [(r) => (r.definitions[10].probableCauses[1].remediations[1].description = "Wait."), /blowhorn-mcp-1010: remediation wait-retry-after differs between causes/],
    [(r) => (r.definitions[5].moniker = "ErrUnknownTool"), /moniker ErrUnknownTool is used twice/],
    [(r) => (r.definitions[6].component = { type: "blowhorn", name: "engine" }), /blowhorn-mcp-1006: component differs/],
    [(r) => (r.extra = true), /keys are \$comment, component, definitions, extra, nextErrorCode/],
  ];
  for (const [mutate, want] of cases) {
    const broken = copy();
    mutate(broken);
    assert.match(registryProblems(broken).join("\n"), want);
  }
});

test("the drift check runs the registry check", () => {
  const out = execFileSync(process.execPath, [path.join(HOSTED, "scripts", "check-drift.js")], { encoding: "utf8" });
  assert.match(out, /^ok hosted error registry validates against ErrorDefinition$/m);
});
