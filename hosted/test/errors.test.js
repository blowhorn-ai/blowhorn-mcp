// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registry from "../errors/mcp.json" with { type: "json" };
import { CODES, RETIRED, definition } from "../src/errors.js";
import { errorDefinitionValidator, registryProblems } from "../scripts/registry.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A deep copy of the registry for a test to break. */
function copy() {
  return structuredClone(registry);
}

test("every definition validates against the vendored ErrorDefinition construct", () => {
  const validator = errorDefinitionValidator();
  for (const d of registry.definitions) {
    const { valid, errors } = validator.validate(d);
    assert.ok(valid, `${d.code}: ${errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; ")}`);
  }
  assert.deepStrictEqual(registryProblems(), []);
});

test("every outcome the gateway reports maps to a definition, and every definition is mapped or a retired tombstone, never both", () => {
  for (const [outcome, code] of Object.entries(CODES)) assert.strictEqual(definition(outcome).code, code, outcome);
  const mapped = Object.values(CODES);
  assert.deepStrictEqual([...mapped, ...RETIRED].sort(), registry.definitions.map((d) => d.code).sort());
  assert.deepStrictEqual(mapped.filter((c) => RETIRED.includes(c)), []);
  assert.throws(() => definition("ok"), /no error code for outcome ok/);
  assert.throws(() => definition("unknown_tool"), /no error code for outcome unknown_tool/, "a retired outcome reports nothing");
});

test("the retired codes 1000-1009 stay as tombstones that say so, and nextErrorCode is past the newest, so no number is reused", () => {
  assert.deepStrictEqual(RETIRED, Array.from({ length: 10 }, (_, i) => `blowhorn-mcp-${1000 + i}`));
  for (const code of RETIRED) {
    const d = registry.definitions.find((x) => x.code === code);
    assert.match(d.longDescription, /^Retired: the gateway 0\.2\.0 no longer runs tools/, code);
    assert.ok(d.moniker && d.probableCauses.length, code);
  }
  for (const d of registry.definitions.filter((x) => !RETIRED.includes(x.code))) assert.doesNotMatch(d.longDescription, /^Retired/, d.code);
  assert.strictEqual(registry.nextErrorCode, 1015);
  assert.strictEqual(Math.max(...registry.definitions.map((d) => Number(d.code.slice(-4)))), 1014);
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
    "blowhorn-mcp-1011": [["cloud-unavailable", ["try-again", "contact-support"]]],
    "blowhorn-mcp-1012": [["cloud-slow", ["try-again"]]],
    "blowhorn-mcp-1013": [["endpoint-moved", ["try-again", "contact-support"]]],
    "blowhorn-mcp-1014": [["slow-client", ["send-again"]]],
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

test("the upstream codes are errors named for what happened, and none of their remediations is an action", () => {
  assert.deepStrictEqual(
    ["upstream_unreachable", "upstream_timeout", "upstream_redirect", "request_timeout"].map((o) => [definition(o).code, definition(o).moniker, definition(o).severity]),
    [
      ["blowhorn-mcp-1011", "ErrUpstreamUnreachable", "error"],
      ["blowhorn-mcp-1012", "ErrUpstreamTimeout", "error"],
      ["blowhorn-mcp-1013", "ErrUpstreamRedirect", "error"],
      ["blowhorn-mcp-1014", "ErrRequestBodyTimeout", "warning"],
    ],
  );
  for (const o of ["upstream_unreachable", "upstream_timeout", "upstream_redirect", "request_timeout"]) {
    for (const r of definition(o).probableCauses.flatMap((c) => c.remediations)) assert.strictEqual(r.action, undefined, r.id);
  }
});

test("registryProblems names what the construct and the gateway's own rules refuse", () => {
  const cases = [
    [(r) => (r.definitions[0].reason = "a gateway-only clause."), /definitions\[0\] blowhorn-mcp-1000 \/: Property "reason" does not match additional properties schema/],
    [(r) => (r.definitions[1].code = "blowhorn-mcp-1000"), /definitions\[1\] blowhorn-mcp-1000: code is used twice/],
    [(r) => (r.nextErrorCode = 1014), /blowhorn-mcp-1014: number is not below nextErrorCode 1014/],
    [(r) => (r.definitions[6].component = { type: "blowhorn", name: "engine" }), /blowhorn-mcp-1006: component is not blowhorn\/mcp/],
    [(r) => (r.component = { type: "blowhorn", name: "engine" }), /component is not \{"type": "blowhorn", "name": "mcp"\}/],
    [(r) => r.definitions.splice(10, 1), /outcome rate_limited: no definition for blowhorn-mcp-1010/],
    [(r) => r.definitions.splice(0, 1), /retired blowhorn-mcp-1000: no definition, so its number could be reused/],
    [(r) => (r.extra = true), /keys are \$comment, component, definitions, extra, nextErrorCode/],
    [(r) => (r.nextErrorCode = 1016), /nextErrorCode is 1016; want 1015, one past the highest code/],
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

test("a retired code cannot be reported again, and a definition nothing maps and nobody retired is refused", () => {
  const schema = undefined;
  const reuse = registryProblems(copy(), schema, { ...CODES, revived: "blowhorn-mcp-1003" });
  assert.match(reuse.join("\n"), /outcome revived: blowhorn-mcp-1003 is retired/);
  const orphan = registryProblems(copy(), schema, CODES, RETIRED.slice(1));
  assert.match(orphan.join("\n"), /blowhorn-mcp-1000: no outcome maps to it and it is not retired/);
});

/** README.md's Error codes table, as [code, moniker, outcome] rows: each cell's first `code span`. */
function readmeCodes() {
  const readme = fs.readFileSync(path.join(HOSTED, "README.md"), "utf8");
  const from = readme.indexOf("\n## Error codes\n");
  assert.ok(from > 0, "README.md has an Error codes section");
  const section = readme.slice(from, readme.indexOf("\n## ", from + 1));
  return [...section.matchAll(/^\| `(blowhorn-mcp-\d{4})` \| `(\w+)` \| `(\w+)`[^|\n]* \|$/gm)].map(([, code, moniker, outcome]) => [code, moniker, outcome]);
}

test("README.md's Error codes table lists every definition, its moniker and its outcome (or retired), and nothing else", () => {
  const rows = readmeCodes();
  const outcomeOf = Object.fromEntries(Object.entries(CODES).map(([outcome, code]) => [code, outcome]));
  assert.deepStrictEqual(rows, registry.definitions.map((d) => [d.code, d.moniker, outcomeOf[d.code] ?? "retired"]));
  assert.deepStrictEqual(Object.fromEntries(rows.filter(([, , o]) => o !== "retired").map(([code, , outcome]) => [outcome, code])), { ...CODES });
  assert.deepStrictEqual(rows.filter(([, , o]) => o === "retired").map(([code]) => code), [...RETIRED]);
});

test("the drift check runs the registry check", () => {
  const out = execFileSync(process.execPath, [path.join(HOSTED, "scripts", "check-drift.js")], { encoding: "utf8" });
  assert.match(out, /^ok hosted error registry validates against ErrorDefinition$/m);
  assert.match(out, /^ok hosted vendored schemas match SOURCES\.json$/m);
});
