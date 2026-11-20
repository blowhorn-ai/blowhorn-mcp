// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * wrangler.jsonc as an object: JSON with // and block comments, which are
 * dropped outside strings. A trailing comma fails the parse, loudly.
 */
export function readWranglerConfig() {
  const text = fs.readFileSync(path.join(HOSTED, "wrangler.jsonc"), "utf8");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      assert.ok(end > 0, "wrangler.jsonc: unclosed block comment");
      i = end + 1;
    } else out += c;
  }
  return JSON.parse(out);
}
