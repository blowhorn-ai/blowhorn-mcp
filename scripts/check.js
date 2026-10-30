#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
/*
 * The repo's own checks, one per subcommand, each run by `make check`:
 *
 *   drift  every generated file equals what scripts/generate.js writes now
 *   copy   the copy rules hold in every tracked text file
 *   skill  every skills/<name>/SKILL.md has valid frontmatter
 *   facts  the docs name Blowhorn <minimumAppVersion> and carry listing.json's urls;
 *          package.json's version, homepage and repository agree with them
 *   logo   listing.json's logo.png is a 400x400 PNG
 *   pack   the npm tarball holds exactly the launcher's files
 *
 * The copy rules are written out below, and test/check.test.js feeds them
 * the phrases they forbid, so those two files are only held to the dash
 * rules; every other tracked file is held to all of them.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const generate = require("./generate.js");

const ROOT = path.join(__dirname, "..");
const RULE_FILES = [path.relative(ROOT, __filename), "test/check.test.js"];

function fail(lines) {
  process.stderr.write(`${[].concat(lines).join("\n")}\n`);
  process.exit(1);
}

function drift() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-mcp-generate-"));
  try {
    const stale = [];
    for (const file of generate.write(tmp)) {
      const want = fs.readFileSync(path.join(tmp, file), "utf8");
      const have = fs.existsSync(path.join(ROOT, file)) ? fs.readFileSync(path.join(ROOT, file), "utf8") : null;
      if (have === null) stale.push(`  ${file}: missing`);
      else if (have !== want) stale.push(`  ${file}: differs from what scripts/generate.js writes`);
    }
    if (stale.length) {
      fail(["Generated files are out of date with listing/listing.json and package.json:", ...stale, "Run `make generate` and commit the result. Never hand-edit a generated file."]);
    }
    process.stdout.write("ok generated files match listing/listing.json and package.json\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** [rule, RegExp] pairs every tracked text file is held to. */
const RULES = [
  ["no em dash (U+2014); use a hyphen", /\u2014/],
  ["no en dash (U+2013); use a hyphen", /\u2013/],
  ["never \"Layer5 Cloud\"", /Layer5 Cloud/i],
  ["no persona names", /\b(Alex|Casey|Riley|Jordan|Sam)\b/],
  ["no cloud.blowhorn.ai: the server runs locally", /cloud\.blowhorn\.ai/i],
  ["no hosted or remote server claims", /\b(hosted|remote|cloud)[- ](MCP )?(server|endpoint|version)\b/i],
  ["no OAuth claims", /\bOAuth\b/i],
  ["no Windows or Linux support claims: macOS only", /\b(Windows|Linux)\b/],
  ["no pricing", /\b(pricing|price[sd]?|per month|free trial|subscription)\b/i],
  ["npm availability is future tense", /\b(is|are|now) (available|published|live) on npm\b|\bnpm (install|i) (-g |--global )?blowhorn-mcp\b|npmjs\.com\/package\/blowhorn-mcp/i],
  ["no claims of existing marketplace listings", /\b(available|listed|published|find (us|it|Blowhorn)) (on|in) (the )?(Glama|Smithery|PulseMCP|mcp\.so|MCP Registry|Cline (MCP )?Marketplace|Cursor (Plugin )?(Marketplace|Directory)|Gemini (CLI )?Extensions? Gallery)\b/i],
];

/** Tracked and untracked-but-not-ignored files, minus the exempt ones. */
function textFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => f !== "LICENSE" && !f.startsWith("schemas/vendor/") && path.basename(f) !== "package-lock.json")
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .filter((f) => !fs.readFileSync(path.join(ROOT, f)).includes(0));
}

function copy() {
  const problems = [];
  for (const file of textFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
    const rules = RULE_FILES.includes(file) ? RULES.slice(0, 2) : RULES;
    lines.forEach((line, i) => {
      for (const [rule, re] of rules) {
        const m = line.match(re);
        if (m) problems.push(`  ${file}:${i + 1}: ${rule}: "${m[0]}"`);
      }
    });
  }
  if (problems.length) fail(["Copy rules broken:", ...problems]);
  process.stdout.write("ok copy rules\n");
}

/** The `key: value` pairs of a SKILL.md's leading `---` block, or null when there is none. */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

function skill() {
  const dir = path.join(ROOT, "skills");
  const problems = [];
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()) : [];
  if (!names.length) problems.push("  skills/: no skill folders");
  for (const name of names) {
    const file = path.join("skills", name, "SKILL.md");
    if (!fs.existsSync(path.join(ROOT, file))) {
      problems.push(`  ${file}: missing`);
      continue;
    }
    const fm = frontmatter(fs.readFileSync(path.join(ROOT, file), "utf8"));
    if (!fm) {
      problems.push(`  ${file}: no --- frontmatter block at the top`);
      continue;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name || "")) problems.push(`  ${file}: name "${fm.name || ""}" is not lowercase kebab-case`);
    if (fm.name !== name) problems.push(`  ${file}: name "${fm.name || ""}" does not match its folder "${name}"`);
    if (!fm.description) problems.push(`  ${file}: description is missing`);
    else if (fm.description.length > 1024) problems.push(`  ${file}: description is ${fm.description.length} characters; the limit is 1024`);
  }
  if (problems.length) fail(["Skill frontmatter invalid:", ...problems]);
  process.stdout.write(`ok skills: ${names.join(", ")}\n`);
}

/** Files that must name `Blowhorn <minimumAppVersion>`, and files one of which must carry each URL. */
const VERSION_DOCS = ["README.md", "llms-install.md", "skills/blowhorn/SKILL.md"];
const URL_DOCS = ["README.md", "MAINTAINERS.md"];
const DOC_URLS = ["setup", "privacy", "terms", "support", "download"];
const REPOSITORY = "https://github.com/blowhorn-ai/blowhorn-mcp";

/**
 * Problem strings for `listing` and `pkg` (package.json) against the docs, read by
 * `readDoc(file)`; [] when they agree. longDescription and urls are copy maintainers
 * paste into marketplace forms, so they must say what the docs say. The version is
 * plain X.Y.Z, never a prerelease, so a publish can never make one npm's `latest`.
 */
function factProblems(listing, pkg, readDoc) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) problems.push(`  package.json: version "${pkg.version}" is not plain X.Y.Z`);
  if (pkg.homepage !== listing.urls.docs) problems.push(`  package.json: homepage "${pkg.homepage}" is not urls.docs ${listing.urls.docs}`);
  const repo = pkg.repository && generate.repoUrl(pkg);
  if (repo !== REPOSITORY) problems.push(`  package.json: repository.url points at "${repo}", not ${REPOSITORY}`);
  const want = `Blowhorn ${listing.minimumAppVersion}`;
  for (const file of VERSION_DOCS) {
    if (!readDoc(file).includes(want)) problems.push(`  ${file}: does not mention "${want}" (minimumAppVersion in listing/listing.json)`);
  }
  if (!listing.longDescription.includes(want)) problems.push(`  listing/listing.json: longDescription does not mention "${want}"`);
  const docs = URL_DOCS.map(readDoc);
  for (const key of DOC_URLS) {
    const url = listing.urls[key];
    if (!docs.some((text) => text.includes(url))) problems.push(`  urls.${key} ${url}: in neither ${URL_DOCS.join(" nor ")}`);
  }
  return problems;
}

function facts() {
  const { listing, pkg } = generate.readSources();
  const problems = factProblems(listing, pkg, (file) => fs.readFileSync(path.join(ROOT, file), "utf8"));
  if (problems.length) fail(["The docs and package.json disagree with listing/listing.json:", ...problems]);
  process.stdout.write("ok docs and package.json match listing/listing.json's minimumAppVersion and urls\n");
}

/** { width, height } from a PNG's signature and IHDR chunk, or null when `buf` is not a PNG. */
function pngSize(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function logo() {
  const file = generate.readSources().listing.logo.png;
  const size = pngSize(fs.readFileSync(path.join(ROOT, file)));
  if (!size) fail(`${file}: not a PNG`);
  if (size.width !== 400 || size.height !== 400) fail(`${file}: ${size.width}x${size.height}, want 400x400`);
  process.stdout.write(`ok ${file} is a 400x400 PNG\n`);
}

const TARBALL = ["LICENSE", "README.md", "bin/blowhorn-mcp.js", "lib/launcher-common.js", "package.json"];

function pack() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const files = JSON.parse(out)[0].files.map((f) => f.path).sort();
  const extra = files.filter((f) => !TARBALL.includes(f));
  const missing = TARBALL.filter((f) => !files.includes(f));
  if (extra.length || missing.length) {
    fail([
      "npm pack would publish the wrong files:",
      ...extra.map((f) => `  unexpected: ${f}`),
      ...missing.map((f) => `  missing: ${f}`),
      'Fix "files" in package.json.',
    ]);
  }
  process.stdout.write(`ok npm tarball: ${files.join(", ")}\n`);
}

const CHECKS = { drift, copy, skill, facts, logo, pack };

module.exports = { pngSize, frontmatter, factProblems, RULES };

if (require.main === module) {
  const names = process.argv.slice(2);
  if (!names.length || names.some((n) => !CHECKS[n])) fail(`usage: check.js ${Object.keys(CHECKS).join("|")} ...`);
  for (const n of names) CHECKS[n]();
}
