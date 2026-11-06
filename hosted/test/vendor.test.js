// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SOURCES, refTargets } from "../scripts/schemas-refresh.js";
import { VENDOR, VendorError, readSources, source, vendorProblems, vendored } from "../scripts/vendor.js";

test("the vendored tree matches SOURCES.json and holds only the ErrorDefinition construct", () => {
  assert.deepStrictEqual(vendorProblems(), []);
  const sources = readSources();
  assert.deepStrictEqual(sources.sources.map((s) => s.dir), ["blowhorn"]);
  assert.deepStrictEqual(sources.sources[0].files.map((f) => f.path), ["schemas/dist/ErrorDefinition.schema.json"]);
  assert.ok(fs.existsSync(vendored("blowhorn", "schemas/dist/ErrorDefinition.schema.json")));
  assert.throws(() => source(sources, "meshery-schemas"), VendorError);
});

test("the vendor check fails on a file SOURCES.json does not list, on an edited one, on a missing one and on a stray folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-vendor-"));
  try {
    fs.cpSync(VENDOR, dir, { recursive: true });
    assert.deepStrictEqual(vendorProblems(dir), []);
    fs.writeFileSync(path.join(dir, "blowhorn", "schemas", "extra.yaml"), "type: string\n");
    fs.appendFileSync(path.join(dir, "blowhorn", "schemas", "dist", "ErrorDefinition.schema.json"), "\n");
    fs.mkdirSync(path.join(dir, "stray"));
    const problems = vendorProblems(dir).join("\n");
    assert.match(problems, /blowhorn\/schemas\/extra\.yaml: not listed in SOURCES\.json/);
    assert.match(problems, /blowhorn\/schemas\/dist\/ErrorDefinition\.schema\.json: sha256/);
    assert.match(problems, /stray: not a source folder in SOURCES\.json/);
    fs.rmSync(path.join(dir, "blowhorn", "schemas", "dist", "ErrorDefinition.schema.json"));
    assert.match(vendorProblems(dir).join("\n"), /ErrorDefinition\.schema\.json: missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the refresh script pins exactly what SOURCES.json records, and follows only relative refs", () => {
  const recorded = readSources().sources;
  assert.deepStrictEqual(
    SOURCES.map(({ repo, ref, sourcePr, dir }) => ({ repo, ref, sourcePr, dir })),
    recorded.map(({ repo, ref, sourcePr, dir }) => ({ repo, ref, sourcePr, dir })),
  );
  assert.deepStrictEqual(SOURCES.map((s) => s.roots), recorded.map((s) => s.files.map((f) => f.path)));
  const doc = { a: { $ref: "../b/c.json#/x" }, d: [{ $ref: "https://example.test/remote.json" }, { $ref: "#/local" }, { $ref: "e.json" }] };
  assert.deepStrictEqual(refTargets(doc, "schemas/dist/f.json").sort(), ["schemas/b/c.json", "schemas/dist/e.json"]);
});
