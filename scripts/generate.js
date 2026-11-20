#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
"use strict";
/*
 * Writes every marketplace listing file from listing/listing.json and
 * package.json, the only two places those facts live. Never hand-edit an
 * output: change a source and run `make generate`; `make check` fails when
 * an output drifts from what this script writes.
 *
 *   node scripts/generate.js            write the outputs into the repo
 *   node scripts/generate.js --out DIR  write them under DIR instead
 *
 * Every output is stable 2-space JSON with a trailing newline, so running
 * it twice changes nothing.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/** https://github.com/owner/repo from package.json's "git+https://...git" repository url. */
function repoUrl(pkg) {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** { relativePath: object } for every generated file. */
function outputs(listing, pkg) {
  const repository = repoUrl(pkg);
  const { version, license } = pkg;
  const docs = listing.urls.docs;
  const author = { name: listing.author.name, url: listing.author.url };
  return {
    // MCP Registry. Its version is this npm launcher's version, not the
    // desktop app's: every registry publish pairs with an npm publish, and
    // the launcher works with any Blowhorn from minimumAppVersion on.
    "server.json": {
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: pkg.mcpName,
      title: listing.title,
      description: listing.registryDescription,
      repository: { url: repository, source: "github" },
      websiteUrl: docs,
      version,
      remotes: listing.remotes,
    },

    // Claude Code plugin; this repo's root is the plugin root.
    ".claude-plugin/plugin.json": {
      $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
      name: listing.slug,
      version,
      description: listing.shortDescription,
      author,
      homepage: docs,
      repository,
      license,
      keywords: listing.keywords,
    },
    // Claude Code expands ${VAR} environment variables in a plugin's .mcp.json.
    ".mcp.json": {
      mcpServers: { [listing.slug]: listing.commands.claudePlugin },
    },
    // A self-hosted marketplace: /plugin marketplace add blowhorn-ai/blowhorn-mcp.
    ".claude-plugin/marketplace.json": {
      $schema: "https://json.schemastore.org/claude-code-marketplace.json",
      name: listing.slug,
      owner: { name: listing.author.name, url: listing.author.url },
      metadata: { description: listing.shortDescription, version },
      plugins: [
        {
          name: listing.slug,
          source: "./",
          description: listing.shortDescription,
          version,
          author,
          homepage: docs,
          repository,
          license,
          keywords: listing.keywords,
        },
      ],
    },

    // Cursor plugin. Cursor interpolates ${userHome} in .cursor-plugin/mcp.json
    // and leaves ${HOME} unexpanded. The manifest names that file, so Cursor
    // reads neither .mcp.json (Claude Code, ${HOME}) nor root mcp.json
    // (Agent Plugins). Cursor's documented form has no $schema and no "type".
    ".cursor-plugin/plugin.json": {
      name: listing.slug,
      description: listing.shortDescription,
      version,
      author: { name: listing.author.maintainerName, email: listing.author.email },
      homepage: docs,
      repository,
      license,
      keywords: listing.keywords,
      logo: listing.logo.png,
      mcpServers: "./.cursor-plugin/mcp.json",
    },
    ".cursor-plugin/mcp.json": {
      mcpServers: { [listing.slug]: listing.commands.cursorPlugin },
    },

    // Agent Plugins 1.0 MCP config, which GitHub Copilot CLI reads from the
    // plugin root. $schema is required. type streamable-http is the hosted
    // server (Agent Plugins MCP schema), not a local stdio command.
    "mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [listing.slug]: listing.commands.copilotPlugin },
    },

    // Agent Plugins 1.0, which GitHub Copilot CLI installs. plugin.json at the
    // repo root takes precedence over .claude-plugin/plugin.json. Skills stay
    // at skills/<name>/SKILL.md. No agents, hooks, or other Copilot-only components.
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: listing.slug,
      version,
      description: listing.shortDescription,
      author,
      homepage: docs,
      repository,
      license,
      keywords: listing.keywords,
    },
    // Copilot CLI marketplace, separate from .claude-plugin/marketplace.json:
    // copilot plugin marketplace add blowhorn-ai/blowhorn-mcp
    // copilot plugin install blowhorn@blowhorn
    ".github/plugin/marketplace.json": {
      name: listing.slug,
      owner: { name: listing.author.name },
      metadata: { description: listing.shortDescription, version },
      plugins: [
        {
          name: listing.slug,
          source: "./",
          description: listing.shortDescription,
          version,
          author,
          homepage: docs,
          repository,
          license,
          keywords: listing.keywords,
        },
      ],
    },

    // Gemini CLI extension; its version must equal the GitHub release tag.
    // The extension connects to the hosted server by url. Gemini CLI does not
    // start a local process for that entry.
    "gemini-extension.json": {
      name: listing.slug,
      version,
      description: listing.shortDescription,
      mcpServers: { [listing.slug]: listing.commands.geminiExtension },
    },

    // Glama.
    "glama.json": {
      $schema: "https://glama.ai/mcp/schemas/server.json",
      maintainers: listing.maintainers,
    },
  };
}

function serialize(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

function readSources(root = ROOT) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return { listing: read("listing/listing.json"), pkg: read("package.json") };
}

/** { relativePath: text } for every generated file, from the sources under `root`. */
function render(root = ROOT) {
  const { listing, pkg } = readSources(root);
  const out = {};
  for (const [file, doc] of Object.entries(outputs(listing, pkg))) out[file] = serialize(doc);
  return out;
}

/** Write every output under `outDir`; returns the relative paths written. */
function write(outDir, root = ROOT) {
  const files = render(root);
  for (const [file, text] of Object.entries(files)) {
    const dest = path.join(outDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  return Object.keys(files);
}

module.exports = { outputs, render, write, readSources, repoUrl, serialize, ROOT };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  const outDir = at === -1 ? ROOT : path.resolve(args[at + 1] || "");
  if (at !== -1 && !args[at + 1]) {
    process.stderr.write("usage: generate.js [--out DIR]\n");
    process.exit(2);
  }
  // Refuse to write from a listing.json its own schema rejects.
  const { validateFile } = require("./validate.js");
  const errors = validateFile(path.join(ROOT, "listing/listing.json"), "listing/listing.json");
  if (errors.length) {
    process.stderr.write(`listing/listing.json is invalid:\n${errors.map((e) => `  ${e}`).join("\n")}\n`);
    process.exit(1);
  }
  for (const file of write(outDir)) process.stdout.write(`wrote ${path.relative(process.cwd(), path.join(outDir, file)) || file}\n`);
}
