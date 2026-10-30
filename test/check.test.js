// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pngSize, frontmatter, RULES } = require("../scripts/check.js");

const broken = (line) => RULES.filter(([, re]) => re.test(line)).map(([rule]) => rule);

test("pngSize reads width and height from the IHDR chunk, and null for anything else", () => {
  assert.deepStrictEqual(pngSize(fs.readFileSync(path.join(__dirname, "..", "assets", "blowhorn-logo-400.png"))), { width: 400, height: 400 });
  assert.strictEqual(pngSize(fs.readFileSync(path.join(__dirname, "..", "assets", "blowhorn-logo.svg"))), null);
  assert.strictEqual(pngSize(Buffer.alloc(10)), null);
});

test("frontmatter reads the leading --- block, and null when there is none", () => {
  assert.deepStrictEqual(frontmatter("---\nname: blowhorn\ndescription: \"Use it.\"\n---\n# Body\n"), { name: "blowhorn", description: "Use it." });
  assert.strictEqual(frontmatter("# No frontmatter\n"), null);
});

test("copy rules catch what they forbid and pass plain copy", () => {
  assert.ok(broken(`a ${String.fromCharCode(0x2014)} b`).length);
  assert.ok(broken(`a ${String.fromCharCode(0x2013)} b`).length);
  for (const line of ["Try our hosted server", "Sign in with OAuth", "Works on Windows", "See pricing", "blowhorn-mcp is now available on npm", "Blowhorn is listed on Glama"]) {
    assert.ok(broken(line).length, line);
  }
  for (const line of ["Blowhorn runs locally on your Mac over stdio.", "Once the npm package is published, npx -y blowhorn-mcp will work.", "runs-on: ubuntu-latest"]) {
    assert.deepStrictEqual(broken(line), [], line);
  }
});
