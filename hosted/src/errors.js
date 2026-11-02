// SPDX-License-Identifier: AGPL-3.0-only
/*
 * The gateway's error codes. The definitions are data, hosted/errors/mcp.json,
 * in the shape of blowhorn-ai/blowhorn's error code registry; every one
 * validates against the vendored ErrorDefinition construct
 * (scripts/registry.js, run by `make check`). This module only maps each
 * failing outcome the gateway reports to its code; the same check fails when
 * one has no definition, so a Worker missing one does not deploy.
 */
import registry from "../errors/mcp.json" with { type: "json" };

/** Each failing outcome, the tool call events' (src/events.js) and the rate limit's, and its code. */
export const CODES = Object.freeze({
  unknown_tool: "blowhorn-mcp-1000",
  invalid_arguments: "blowhorn-mcp-1001",
  refused: "blowhorn-mcp-1002",
  cloud_rejected: "blowhorn-mcp-1003",
  cloud_failed: "blowhorn-mcp-1004",
  timeout: "blowhorn-mcp-1005",
  unreachable: "blowhorn-mcp-1006",
  redirect: "blowhorn-mcp-1007",
  too_large: "blowhorn-mcp-1008",
  not_json: "blowhorn-mcp-1009",
  rate_limited: "blowhorn-mcp-1010",
});

const BY_CODE = new Map(registry.definitions.map((d) => [d.code, d]));

/** The registry definition for a failing `outcome`; throws for an outcome with no code. */
export function definition(outcome) {
  const code = CODES[outcome];
  if (!code) throw new Error(`no error code for outcome ${outcome}`);
  return BY_CODE.get(code);
}
