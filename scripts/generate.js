#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
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
      packages: [
        {
          registryType: "npm",
          registryBaseUrl: "https://registry.npmjs.org",
          identifier: pkg.name,
          version,
          runtimeHint: "npx",
          transport: { type: "stdio" },
        },
      ],
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

    // Cursor plugin. Cursor interpolates ${userHome} in mcp.json; it does not expand ${HOME}.
    ".cursor-plugin/plugin.json": {
      name: listing.slug,
      description: listing.shortDescription,
      version,
      author: { name: listing.author.name },
      homepage: docs,
      repository,
      license,
      keywords: listing.keywords,
      logo: listing.logo.svg,
    },
    "mcp.json": {
      mcpServers: { [listing.slug]: listing.commands.cursorPlugin },
    },

    // Gemini CLI extension; its version must equal the GitHub release tag.
    // Gemini CLI hydrates only ${extensionPath}, ${workspacePath} and ${/} in
    // an extension manifest (packages/cli/src/config/extension-manager.ts),
    // never ${HOME}, so the extension runs this repo's own launcher with node
    // (Gemini CLI itself runs on Node), and that execs ~/.local/bin/blowhorn-mcp.
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

module.exports = { outputs, render, write, repoUrl, serialize, ROOT };

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
