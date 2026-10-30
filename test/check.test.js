// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pngSize, frontmatter, factProblems, RULES } = require("../scripts/check.js");

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

test("factProblems passes docs that match the listing and names each mismatch", () => {
  const listing = {
    minimumAppVersion: "1.2.3",
    longDescription: "Requires Blowhorn 1.2.3 or later.",
    urls: { setup: "https://e.test/setup", privacy: "https://e.test/privacy", terms: "https://e.test/terms", support: "https://e.test/support", download: "https://e.test/download" },
  };
  const good = {
    "README.md": "Needs Blowhorn 1.2.3. https://e.test/setup https://e.test/privacy https://e.test/terms",
    "MAINTAINERS.md": "https://e.test/support https://e.test/download",
    "llms-install.md": "Install Blowhorn 1.2.3 or later",
    "skills/blowhorn/SKILL.md": "Blowhorn 1.2.3",
  };
  assert.deepStrictEqual(factProblems(listing, (f) => good[f]), []);
  const stale = { ...good, "llms-install.md": "Install Blowhorn 1.2.2 or later", "MAINTAINERS.md": "https://e.test/support" };
  const problems = factProblems({ ...listing, longDescription: "Requires Blowhorn." }, (f) => stale[f]);
  assert.strictEqual(problems.length, 3, problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("llms-install.md")));
  assert.ok(problems.some((p) => p.includes("longDescription")));
  assert.ok(problems.some((p) => p.includes("urls.download")));
});
