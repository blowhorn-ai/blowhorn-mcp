// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => path.join(HOSTED, "scripts", name);
const fixture = (name) => path.join(HOSTED, "test", "fixtures", name, "api.yml");

function generateTo(...extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-hosted-"));
  const out = path.join(dir, "catalog.json");
  const run = spawnSync(process.execPath, [script("generate.js"), "--out", out, ...extra], { encoding: "utf8" });
  const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...run, text };
}

test("the catalog drift check passes on the checked-in catalog", () => {
  const out = execFileSync(process.execPath, [script("check-drift.js")], { encoding: "utf8" });
  assert.match(out, /^ok /);
});

test("the generator writes exactly the checked-in catalog, and it holds the four pinned tools", () => {
  const { status, text, stderr } = generateTo();
  assert.strictEqual(status, 0, stderr);
  assert.strictEqual(text, fs.readFileSync(path.join(HOSTED, "src", "catalog.generated.json"), "utf8"));
  assert.ok(text.endsWith("}\n"));
  const catalog = JSON.parse(text);
  assert.match(catalog._generated, /7582dec49ba1227f34371341103e8374228d4b0d/);
  assert.match(catalog._generated, /do not edit; run make hosted-generate/);
  assert.deepStrictEqual(catalog.tools.map((t) => t.name).sort(), ["getConnections", "getContentItem", "getEvents", "listContentItems"]);
});

test("every generated tool is a read-only GET with a closed, ref-free input schema and a wire map", () => {
  const catalog = JSON.parse(generateTo().text);
  for (const t of catalog.tools) {
    assert.strictEqual(t.method, "GET", t.name);
    assert.deepStrictEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.strictEqual(t.inputSchema.type, "object");
    assert.strictEqual(t.inputSchema.additionalProperties, false);
    assert.ok(t.scope, t.name);
    const serialized = JSON.stringify(t.inputSchema);
    assert.ok(!serialized.includes("$ref"), `${t.name} still has a $ref`);
    assert.ok(!/"x-/.test(serialized), `${t.name} still has an x- key`);
    assert.deepStrictEqual(Object.keys(t.wire).sort(), Object.keys(t.inputSchema.properties).sort());
    assert.deepStrictEqual(t.wire.organizationId, { in: "header", name: "X-Current-Orgid" }, t.name);
    for (const [arg, w] of Object.entries(t.wire)) if (w.in === "path") assert.ok(t.inputSchema.required.includes(arg));
  }
  const get = catalog.tools.find((t) => t.name === "getContentItem");
  assert.strictEqual(get.path, "/api/content-items/{contentItemId}");
  assert.deepStrictEqual(get.wire.contentItemId, { in: "path", name: "contentItemId" });
  assert.strictEqual(get.inputSchema.properties.contentItemId.format, "uuid");
});

test("the generator refuses an exposed operation that is not a GET", () => {
  const { status, stderr, text } = generateTo("--api", fixture("non-get"));
  assert.strictEqual(status, 1);
  assert.match(stderr, /createThing.*not a GET/);
  assert.strictEqual(text, null);
});

test("the generator refuses an unresolvable $ref", () => {
  const { status, stderr } = generateTo("--api", fixture("bad-ref"));
  assert.strictEqual(status, 1);
  assert.match(stderr, /unresolvable \$ref/);
});

test("the vendor check fails on a file SOURCES.json does not list, and on an edited one", async () => {
  const { VENDOR, vendorProblems } = await import("../scripts/catalog.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-vendor-"));
  try {
    fs.cpSync(VENDOR, dir, { recursive: true });
    assert.deepStrictEqual(vendorProblems(dir), []);
    const root = path.join(dir, "meshery-schemas", "schemas");
    fs.writeFileSync(path.join(root, "extra.yaml"), "type: string\n");
    const edited = path.join(root, "extensions", "mcp-operation.yaml");
    fs.appendFileSync(edited, "\n");
    const problems = vendorProblems(dir).join("\n");
    assert.match(problems, /schemas\/extra\.yaml: not listed in SOURCES\.json/);
    assert.match(problems, /schemas\/extensions\/mcp-operation\.yaml: sha256/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source bounds are kept and missing ones get the defaults", () => {
  const props = (name) => JSON.parse(generateTo().text).tools.find((t) => t.name === name).inputSchema.properties;
  const connections = props("getConnections");
  assert.strictEqual(connections.search.maxLength, 500);
  assert.strictEqual(connections.kind.maxItems, 50);
  assert.strictEqual(connections.kind.items.maxLength, 255);
  assert.strictEqual(connections.status.items.maxLength, undefined, "an enum needs no maxLength");
  assert.strictEqual(connections.orgId.maxLength, undefined, "a format needs no maxLength");
  const events = props("getEvents");
  assert.strictEqual(events.search.maxLength, 1000);
  assert.strictEqual(events.pagesize.maximum, 1000000);
  assert.strictEqual(events.organizationId.maxLength, 36);
});

test("the catalog's events schemas are the vendored ones, with every $ref inlined and every x- key dropped", () => {
  const catalog = JSON.parse(generateTo().text);
  const vendor = path.join(HOSTED, "schemas", "vendor", "meshery-schemas", "schemas", "constructs");
  const events = yaml.load(fs.readFileSync(path.join(vendor, "v1beta3", "event", "api.yml"), "utf8")).components.schemas;
  const core = yaml.load(fs.readFileSync(path.join(vendor, "v1beta2", "core", "api.yml"), "utf8")).components.schemas;
  assert.deepStrictEqual(Object.keys(catalog.events).sort(), ["error", "event", "payload"]);
  assert.strictEqual(catalog.events.payload.description, events.EventPayload.description);
  assert.deepStrictEqual(Object.keys(catalog.events.payload.properties).sort(), Object.keys(events.EventPayload.properties).sort());
  assert.deepStrictEqual(catalog.events.payload.properties.category, { type: "string", description: "The category of the event.", maxLength: 500 });
  assert.deepStrictEqual(catalog.events.event.properties.operationId, { type: "string", format: "uuid", description: events.Event.properties.operationId.description });
  assert.deepStrictEqual(Object.keys(catalog.events.event.properties).sort(), ["metadata", "operationId", "severity"]);
  assert.deepStrictEqual(catalog.events.error.required, core.MeshkitError.required);
  assert.deepStrictEqual(Object.keys(catalog.events.error.properties).sort(), Object.keys(core.MeshkitError.properties).sort());
  assert.deepStrictEqual(catalog.events.error.properties.error, { type: "string", minLength: 1, description: core.MeshkitError.properties.error.description });
  assert.ok(!/"\$ref"|"x-[^"]*":/.test(JSON.stringify(catalog.events)));
});

test("a vendored tree without EventPayload or MeshkitError is a CatalogError", async () => {
  const { VENDOR, CatalogError, buildCatalog } = await import("../scripts/catalog.js");
  const cases = [
    ["v1beta3/event/api.yml", "EventPayload"],
    ["v1beta2/core/api.yml", "MeshkitError"],
  ];
  for (const [rel, name] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-vendor-"));
    try {
      fs.cpSync(VENDOR, dir, { recursive: true });
      const file = path.join(dir, "meshery-schemas", "schemas", "constructs", rel);
      const text = fs.readFileSync(file, "utf8");
      assert.ok(text.includes(`\n    ${name}:\n`), `${rel} has ${name}`);
      fs.writeFileSync(file, text.replace(`\n    ${name}:\n`, `\n    ${name}Renamed:\n`));
      assert.throws(() => buildCatalog({ vendor: dir }), (err) => err instanceof CatalogError && err.message.includes(`components.schemas.${name} is missing`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
