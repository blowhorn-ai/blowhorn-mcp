// SPDX-License-Identifier: Apache-2.0
/*
 * The gateway's error codes. The definitions are data, hosted/errors/mcp.json,
 * in the shape of blowhorn-ai/blowhorn's error code registry; every one
 * validates against the vendored ErrorDefinition construct
 * (scripts/registry.js, run by `make check`). This module only maps each
 * failing outcome the gateway reports to its code; the same check fails when
 * one has no definition, so a Worker missing one does not deploy.
 */
import registry from "../errors/mcp.json" with { type: "json" };

/** Each failing outcome the gateway itself reports, and its code. */
export const CODES = Object.freeze({
  rate_limited: "blowhorn-mcp-1010",
  upstream_unreachable: "blowhorn-mcp-1011",
  upstream_timeout: "blowhorn-mcp-1012",
  upstream_redirect: "blowhorn-mcp-1013",
});

/**
 * Tombstones: codes the gateway reported through 0.1.x, when it ran the tools
 * itself. Blowhorn Cloud's /mcp does that now, so no outcome maps to them and
 * nothing emits them. Their definitions stay in errors/mcp.json, so the
 * numbers are never reused and old references still resolve.
 */
export const RETIRED = Object.freeze([
  "blowhorn-mcp-1000",
  "blowhorn-mcp-1001",
  "blowhorn-mcp-1002",
  "blowhorn-mcp-1003",
  "blowhorn-mcp-1004",
  "blowhorn-mcp-1005",
  "blowhorn-mcp-1006",
  "blowhorn-mcp-1007",
  "blowhorn-mcp-1008",
  "blowhorn-mcp-1009",
]);

const BY_CODE = new Map(registry.definitions.map((d) => [d.code, d]));

/** The registry definition for a failing `outcome`; throws for an outcome with no code. */
export function definition(outcome) {
  const code = CODES[outcome];
  if (!code) throw new Error(`no error code for outcome ${outcome}`);
  return BY_CODE.get(code);
}
