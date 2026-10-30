// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateDoc } = require("../scripts/validate.js");

const ROOT = path.join(__dirname, "..");
const PKG = require("../package.json");
const LISTING = require("../listing/listing.json");

/** Run scripts/generate.js into a fresh temp dir and return that dir. */
function generated() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-listing-"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "generate.js"), "--out", out], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  return out;
}

const OUT = generated();
const read = (file) => JSON.parse(fs.readFileSync(path.join(OUT, file), "utf8"));
const MANIFESTS = ["server.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", "gemini-extension.json"];

/** Expand ${VAR} from `vars`; an unknown variable stays as written. */
function expand(text, vars) {
  return text.replace(/\$\{([^}]+)\}/g, (whole, name) => (name in vars ? vars[name] : whole));
}

test("every generated file is stable 2-space JSON with a trailing newline, and validates against its schema", () => {
  for (const file of [...MANIFESTS, ".mcp.json", "mcp.json", "glama.json"]) {
    const text = fs.readFileSync(path.join(OUT, file), "utf8");
    assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2) + "\n", file);
    assert.deepStrictEqual(validateDoc(JSON.parse(text), file), [], file);
  }
});

test("generating twice writes the same bytes", () => {
  const again = generated();
  for (const file of [...MANIFESTS, ".mcp.json", "mcp.json", "glama.json"]) {
    assert.strictEqual(fs.readFileSync(path.join(again, file), "utf8"), fs.readFileSync(path.join(OUT, file), "utf8"), file);
  }
});

test("server.json: name, version and its one npm package follow package.json", () => {
  const server = read("server.json");
  assert.strictEqual(server.name, PKG.mcpName);
  assert.strictEqual(server.version, PKG.version);
  assert.strictEqual(server.description, LISTING.registryDescription);
  assert.deepStrictEqual(server.repository, { url: "https://github.com/blowhorn-ai/blowhorn-mcp", source: "github" });
  assert.strictEqual(server.packages.length, 1);
  const [npm] = server.packages;
  assert.strictEqual(npm.registryType, "npm");
  assert.strictEqual(npm.identifier, PKG.name);
  assert.strictEqual(npm.version, PKG.version);
  assert.strictEqual(npm.registryBaseUrl, "https://registry.npmjs.org");
  assert.deepStrictEqual(npm.transport, { type: "stdio" });
});

test("every manifest's version equals the package version", () => {
  for (const file of MANIFESTS) {
    const doc = read(file);
    // A Claude Code marketplace carries its own version in metadata.
    assert.strictEqual(file.endsWith("marketplace.json") ? doc.metadata.version : doc.version, PKG.version, file);
  }
  for (const plugin of read(".claude-plugin/marketplace.json").plugins) assert.strictEqual(plugin.version, PKG.version);
});

test("Claude Code plugin: .mcp.json's command expands to $HOME/.local/bin/blowhorn-mcp", () => {
  const home = "/Users/someone";
  const { command } = read(".mcp.json").mcpServers.blowhorn;
  assert.strictEqual(expand(command, { HOME: home }), path.posix.join(home, ".local", "bin", "blowhorn-mcp"));
});

test("Claude Code marketplace: plugin blowhorn sourced from this repo's root, named like the plugin manifest", () => {
  const market = read(".claude-plugin/marketplace.json");
  assert.strictEqual(market.name, "blowhorn");
  assert.strictEqual(market.plugins.length, 1);
  assert.strictEqual(market.plugins[0].name, read(".claude-plugin/plugin.json").name);
  assert.ok(fs.existsSync(path.join(ROOT, market.plugins[0].source, ".claude-plugin", "plugin.json")));
});

test("Cursor plugin: mcp.json uses ${userHome}, which Cursor interpolates, and never ${HOME}", () => {
  const { command } = read("mcp.json").mcpServers.blowhorn;
  assert.strictEqual(expand(command, { userHome: "/Users/someone" }), "/Users/someone/.local/bin/blowhorn-mcp");
  assert.ok(!command.includes("${HOME}"), command);
});

test("Cursor plugin: the manifest points at the ${userHome} mcp.json, never at .mcp.json", () => {
  const ref = read(".cursor-plugin/plugin.json").mcpServers;
  assert.strictEqual(typeof ref, "string");
  const file = path.posix.normalize(ref);
  assert.strictEqual(file, "mcp.json");
  assert.notStrictEqual(file, ".mcp.json");
  const { command } = read(file).mcpServers.blowhorn;
  assert.ok(command.includes("${userHome}"), command);
});

test("Gemini extension: node runs this repo's launcher once ${extensionPath} and ${/} are substituted", () => {
  const server = read("gemini-extension.json").mcpServers.blowhorn;
  assert.strictEqual(server.command, "node");
  assert.strictEqual(server.args.length, 1);
  const script = expand(server.args[0], { extensionPath: ROOT, "/": path.sep });
  assert.strictEqual(script, path.join(ROOT, "bin", "blowhorn-mcp.js"));
  assert.ok(fs.statSync(script).isFile());
  const r = spawnSync(process.execPath, [script, "--launcher-version"], { encoding: "utf8" });
  assert.strictEqual(r.stdout, `${PKG.version}\n`);
});

test("plugin and listing logo paths exist", () => {
  const logos = [read(".cursor-plugin/plugin.json").logo, LISTING.logo.svg, LISTING.logo.png];
  for (const logo of logos) assert.ok(fs.statSync(path.join(ROOT, logo)).isFile(), logo);
});

test("glama.json lists the maintainers", () => {
  assert.deepStrictEqual(read("glama.json").maintainers, LISTING.maintainers);
});

test("validation rejects a broken manifest", () => {
  const server = read("server.json");
  assert.deepStrictEqual(validateDoc(server, "server.json"), []);
  const errors = validateDoc({ ...server, description: "x".repeat(101) }, "server.json");
  assert.ok(errors.some((e) => e.startsWith("server.json/description:")), errors.join("\n"));
  assert.notDeepStrictEqual(validateDoc({ ...read(".cursor-plugin/plugin.json"), name: "Blowhorn App" }, ".cursor-plugin/plugin.json"), []);
  assert.notDeepStrictEqual(validateDoc({ ...read(".cursor-plugin/plugin.json"), logo: "../outside.svg" }, ".cursor-plugin/plugin.json"), []);
  assert.notDeepStrictEqual(validateDoc({ mcpServers: { blowhorn: {} } }, "mcp.json"), []);
});

test("generate.js refuses a listing whose registry description is over 100 characters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-listing-root-"));
  for (const dir of ["scripts", "schemas", "listing"]) fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(ROOT, "tools"), path.join(root, "tools"));
  const broken = { ...LISTING, registryDescription: "x".repeat(101) };
  fs.writeFileSync(path.join(root, "listing", "listing.json"), JSON.stringify(broken));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-listing-"));
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "generate.js"), "--out", out], { encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /listing\/listing\.json is invalid:\n.*registryDescription/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});
