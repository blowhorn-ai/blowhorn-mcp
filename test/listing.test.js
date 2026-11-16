// SPDX-License-Identifier: Apache-2.0
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
const MANIFESTS = ["server.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", "plugin.json", ".github/plugin/marketplace.json", "gemini-extension.json"];
const GENERATED = [...MANIFESTS, ".mcp.json", ".cursor-plugin/mcp.json", "mcp.json", "glama.json"];

/** Expand ${VAR} from `vars`; an unknown variable stays as written. */
function expand(text, vars) {
  return text.replace(/\$\{([^}]+)\}/g, (whole, name) => (name in vars ? vars[name] : whole));
}

test("every generated file is stable 2-space JSON with a trailing newline, and validates against its schema", () => {
  for (const file of GENERATED) {
    const text = fs.readFileSync(path.join(OUT, file), "utf8");
    assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2) + "\n", file);
    assert.deepStrictEqual(validateDoc(JSON.parse(text), file), [], file);
  }
});

test("generating twice writes the same bytes", () => {
  const again = generated();
  for (const file of GENERATED) {
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

test("server.json: title and remotes come from the listing, and remotes validate", () => {
  const server = read("server.json");
  assert.strictEqual(server.title, LISTING.title);
  assert.deepStrictEqual(server.remotes, LISTING.remotes);
  assert.deepStrictEqual(server.remotes, [{ type: "streamable-http", url: "https://mcp.blowhorn.ai/mcp" }]);
  assert.deepStrictEqual(validateDoc(server, "server.json"), []);
  const bad = validateDoc({ ...server, remotes: [{ type: "streamable-http" }] }, "server.json");
  assert.ok(bad.length, "a remote without a url must fail");
});

test("every manifest's version equals the package version", () => {
  for (const file of MANIFESTS) {
    const doc = read(file);
    // A marketplace catalog carries its own version in metadata.
    assert.strictEqual(file.endsWith("marketplace.json") ? doc.metadata.version : doc.version, PKG.version, file);
  }
  for (const file of [".claude-plugin/marketplace.json", ".github/plugin/marketplace.json"]) {
    for (const plugin of read(file).plugins) assert.strictEqual(plugin.version, PKG.version, file);
  }
});

test("Claude Code plugin: .mcp.json's command expands to $HOME/.local/bin/blowhorn-mcp", () => {
  const home = "/Users/someone";
  const doc = read(".mcp.json");
  assert.strictEqual(doc.$schema, undefined);
  const server = doc.mcpServers.blowhorn;
  assert.deepStrictEqual(Object.keys(server), ["command"]);
  assert.strictEqual(server.type, undefined);
  assert.strictEqual(expand(server.command, { HOME: home }), path.posix.join(home, ".local", "bin", "blowhorn-mcp"));
});

test("Claude Code marketplace: plugin blowhorn sourced from this repo's root, named like the plugin manifest", () => {
  const market = read(".claude-plugin/marketplace.json");
  assert.strictEqual(market.name, "blowhorn");
  assert.strictEqual(market.plugins.length, 1);
  assert.strictEqual(market.plugins[0].name, read(".claude-plugin/plugin.json").name);
  assert.ok(fs.existsSync(path.join(ROOT, market.plugins[0].source, ".claude-plugin", "plugin.json")));
});

test("Cursor plugin: .cursor-plugin/mcp.json uses ${userHome}, which Cursor interpolates, and never ${HOME}", () => {
  const doc = read(".cursor-plugin/mcp.json");
  assert.strictEqual(doc.$schema, undefined);
  const server = doc.mcpServers.blowhorn;
  assert.deepStrictEqual(Object.keys(server), ["command"]);
  assert.strictEqual(server.type, undefined);
  const raw = JSON.stringify(doc);
  assert.ok(!raw.includes("${HOME}"), raw);
  assert.ok(!raw.includes("${PLUGIN_ROOT}"), raw);
  assert.ok(!raw.includes("npx"), raw);
  assert.strictEqual(expand(server.command, { userHome: "/Users/someone" }), "/Users/someone/.local/bin/blowhorn-mcp");
  assert.deepStrictEqual(validateDoc(doc, ".cursor-plugin/mcp.json"), []);
});

test("Agent Plugins mcp.json: node runs this repo's launcher once ${PLUGIN_ROOT} is substituted", () => {
  const doc = read("mcp.json");
  assert.strictEqual(doc.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  const server = doc.mcpServers.blowhorn;
  assert.strictEqual(server.type, "stdio");
  assert.strictEqual(server.command, "node");
  assert.strictEqual(server.args.length, 1);
  const raw = JSON.stringify(server);
  assert.ok(!raw.includes("${userHome}"), raw);
  assert.ok(!raw.includes("${HOME}"), raw);
  const script = expand(server.args[0], { PLUGIN_ROOT: ROOT });
  assert.strictEqual(script, path.join(ROOT, "bin", "blowhorn-mcp.js"));
  assert.ok(fs.statSync(script).isFile());
  const r = spawnSync(process.execPath, [script, "--launcher-version"], { encoding: "utf8" });
  assert.strictEqual(r.stdout, `${PKG.version}\n`);
  assert.deepStrictEqual(validateDoc(doc, "mcp.json"), []);
});

test("Agent Plugins plugin.json declares the 1.0 schema and matches the other manifests", () => {
  const plugin = read("plugin.json");
  const claude = read(".claude-plugin/plugin.json");
  assert.strictEqual(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.strictEqual(plugin.name, LISTING.slug);
  assert.strictEqual(plugin.name, claude.name);
  assert.strictEqual(plugin.version, PKG.version);
  assert.strictEqual(plugin.description, LISTING.shortDescription);
  assert.strictEqual(plugin.description, claude.description);
  assert.deepStrictEqual(plugin.author, { name: LISTING.author.name, url: LISTING.author.url });
  assert.strictEqual(plugin.homepage, LISTING.urls.docs);
  assert.strictEqual(plugin.repository, "https://github.com/blowhorn-ai/blowhorn-mcp");
  assert.strictEqual(plugin.license, PKG.license);
  assert.deepStrictEqual(plugin.keywords, LISTING.keywords);
  assert.strictEqual(plugin.agents, undefined);
  assert.strictEqual(plugin.hooks, undefined);
  assert.deepStrictEqual(validateDoc(plugin, "plugin.json"), []);
});

test("Copilot marketplace: plugin blowhorn sourced from this repo's root plugin.json", () => {
  const market = read(".github/plugin/marketplace.json");
  assert.strictEqual(market.name, LISTING.slug);
  assert.strictEqual(market.owner.name, LISTING.author.name);
  assert.strictEqual(market.plugins.length, 1);
  const entry = market.plugins[0];
  assert.strictEqual(entry.name, read("plugin.json").name);
  assert.strictEqual(entry.description, LISTING.shortDescription);
  assert.strictEqual(entry.source, "./");
  const pluginPath = path.join(OUT, entry.source, "plugin.json");
  assert.ok(fs.existsSync(pluginPath), pluginPath);
  const resolved = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
  assert.strictEqual(resolved.name, entry.name);
  assert.strictEqual(resolved.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.strictEqual(path.posix.normalize(path.posix.join(entry.source, "plugin.json")), "plugin.json");
});

test("Cursor plugin: the manifest points at the Cursor-only mcp.json, never at mcp.json or .mcp.json", () => {
  const ref = read(".cursor-plugin/plugin.json").mcpServers;
  assert.strictEqual(typeof ref, "string");
  const file = path.posix.normalize(ref);
  assert.strictEqual(file, ".cursor-plugin/mcp.json");
  assert.notStrictEqual(file, "mcp.json");
  assert.notStrictEqual(file, ".mcp.json");
  const { command } = read(file).mcpServers.blowhorn;
  assert.ok(command.includes("${userHome}"), command);
  assert.ok(!command.includes("${HOME}"), command);
  assert.ok(!command.includes("${PLUGIN_ROOT}"), command);
  assert.ok(!command.includes("npx"), command);
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
