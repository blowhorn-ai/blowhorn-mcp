#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
/*
 * Validates every generated listing file, listing/listing.json and
 * schemas/vendor/SOURCES.json against its JSON Schema, and checks that each
 * vendored schema still has the sha256 SOURCES.json records for it.
 *
 *   node scripts/validate.js             validate the files in the repo
 *   node scripts/validate.js --root DIR  validate the generated files under DIR
 *
 * Ajv comes from tools/node_modules (`make install`): the root package's
 * "os": ["darwin"] stops npm installing anything at the root elsewhere.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.join(__dirname, "..");
const toolRequire = createRequire(path.join(ROOT, "tools", "package.json"));

/** Each file and the schema it must satisfy, relative to the repo root. */
const SCHEMAS = {
  "listing/listing.json": "schemas/listing.schema.json",
  "server.json": "schemas/vendor/mcp-server.schema.json",
  ".claude-plugin/plugin.json": "schemas/vendor/claude-code-plugin-manifest.schema.json",
  ".claude-plugin/marketplace.json": "schemas/vendor/claude-code-marketplace.schema.json",
  ".mcp.json": "schemas/mcp-config.schema.json",
  ".cursor-plugin/plugin.json": "schemas/cursor-plugin.schema.json",
  "mcp.json": "schemas/mcp-config.schema.json",
  "gemini-extension.json": "schemas/gemini-extension.schema.json",
  "glama.json": "schemas/vendor/glama-server.schema.json",
  "schemas/vendor/SOURCES.json": "schemas/sources.schema.json",
};

const compiled = new Map();

/** A compiled validator for the schema at `schemaPath` (relative to the repo root). */
function validatorFor(schemaPath) {
  if (compiled.has(schemaPath)) return compiled.get(schemaPath);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, schemaPath), "utf8"));
  const is2020 = String(schema.$schema).includes("2020-12");
  const Ajv = is2020 ? toolRequire("ajv/dist/2020").default : toolRequire("ajv").default;
  const addFormats = toolRequire("ajv-formats").default;
  // Vendored schemas use annotations such as "example" that Ajv's strict mode rejects; ours are strict,
  // except that an anyOf branch may require a property its parent declares.
  const ajv = new Ajv({ allErrors: true, strict: !schemaPath.startsWith("schemas/vendor/"), strictRequired: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  compiled.set(schemaPath, validate);
  return validate;
}

/** Error strings for `doc`, checked against the schema registered for `relPath`; [] when valid. */
function validateDoc(doc, relPath) {
  const schemaPath = SCHEMAS[relPath];
  if (!schemaPath) throw new Error(`no schema registered for ${relPath}`);
  const validate = validatorFor(schemaPath);
  if (validate(doc)) return [];
  return validate.errors.map((e) => `${relPath}${e.instancePath || ""}: ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""}`);
}

/** Error strings for the JSON file at `file`, validated as `relPath`. */
function validateFile(file, relPath) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return [`${relPath}: ${err.message}`];
  }
  return validateDoc(doc, relPath);
}

/** Error strings for vendored schemas whose bytes no longer match SOURCES.json. */
function checkVendorHashes() {
  const vendorDir = path.join(ROOT, "schemas", "vendor");
  const sources = JSON.parse(fs.readFileSync(path.join(vendorDir, "SOURCES.json"), "utf8"));
  const listed = new Set(sources.files.map((f) => f.file));
  const errors = [];
  for (const { file, sha256 } of sources.files) {
    const p = path.join(vendorDir, file);
    if (!fs.existsSync(p)) {
      errors.push(`schemas/vendor/${file}: listed in SOURCES.json but missing`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    if (actual !== sha256) errors.push(`schemas/vendor/${file}: sha256 ${actual} does not match SOURCES.json (${sha256}); vendored schemas stay byte for byte, refresh them with make schemas-refresh`);
  }
  for (const file of fs.readdirSync(vendorDir)) {
    if (file !== "SOURCES.json" && !listed.has(file)) errors.push(`schemas/vendor/${file}: not listed in SOURCES.json`);
  }
  return errors;
}

module.exports = { SCHEMAS, validateDoc, validateFile, checkVendorHashes };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = at === -1 ? ROOT : path.resolve(args[at + 1]);
  const errors = [];
  for (const relPath of Object.keys(SCHEMAS)) {
    // listing.json and SOURCES.json are sources, so they are always read from the repo.
    const base = relPath === "listing/listing.json" || relPath.startsWith("schemas/") ? ROOT : root;
    const found = validateFile(path.join(base, relPath), relPath);
    errors.push(...found);
    if (!found.length) process.stdout.write(`ok ${relPath} (${SCHEMAS[relPath]})\n`);
  }
  errors.push(...checkVendorHashes());
  if (errors.length) {
    process.stderr.write(`validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("ok schemas/vendor/* match SOURCES.json\n");
}
