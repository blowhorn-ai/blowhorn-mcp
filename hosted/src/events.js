// SPDX-License-Identifier: AGPL-3.0-only
/*
 * The Cloud activity event each tool call records. Blowhorn Cloud stores it
 * through its createEvent API (POST /api/events), so the caller sees the call
 * in their own activity. The path and schemas come from the generated
 * catalog's `events` entry, composed here: nothing is copied by hand.
 *
 * Recording is best effort. postEvent never throws and never retries, and
 * index.js hands it to ctx.waitUntil without awaiting it, so it runs alongside
 * the response and can neither delay nor change a tool result.
 */
import { Validator } from "@cfworker/json-schema";
import catalog from "./catalog.generated.json" with { type: "json" };
import { USER_AGENT, VERSION, scrub } from "./cloud.js";
import { redact } from "./redact.js";

export const CATEGORY = "mcp";
export const ACTION_TOOL_CALLED = "tool_called";
const GATEWAY = "blowhorn-mcp-hosted";
const POST_TIMEOUT_MS = 10_000;
const MAX_NAME_CHARS = 100;
const MAX_NAMES = 50;
const MAX_ERROR_CHARS = 1000;
/** Redacted arguments over this many bytes of JSON are recorded by name only, so the event stays small. */
const MAX_ARGUMENT_BYTES = 8 * 1024;
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const NAME_ONLY = ["invalid_arguments", "unknown_tool"];

const { path: ENDPOINT, payload, event, error } = catalog.events;
/** EventPayload, plus the fields createEvent persists that it leaves open: severity, operationId and metadata.error. */
const SCHEMA = {
  allOf: [
    payload,
    {
      properties: {
        severity: event.properties.severity,
        operationId: event.properties.operationId,
        metadata: { ...event.properties.metadata, properties: { error } },
      },
      required: ["category", "action", "description", "severity", "operationId", "metadata", "idempotencyKey"],
    },
  ],
};
const VALIDATOR = new Validator(SCHEMA, "2020-12", false);

/** The event level for each outcome: a caller's mistake or a refused call is a warning, a failure of Cloud or the path to it an error. */
const SEVERITY = Object.freeze({
  ok: "informational",
  invalid_arguments: "warning",
  unknown_tool: "warning",
  refused: "warning",
  cloud_rejected: "warning",
  cloud_failed: "error",
  timeout: "error",
  unreachable: "error",
  redirect: "error",
  too_large: "error",
  not_json: "error",
});

/*
 * One definition per failing outcome, in the shape of
 * internal/design/structured-error-codes.md in blowhorn-ai/blowhorn: a code
 * (`blowhorn-mcp-NNNN`) and probable causes that each carry their
 * own remediations, so a fix always names the cause it answers. The codes are
 * provisional until that design's registry (blowhorn-ai/blowhorn#1662)
 * allocates them. On the wire metadata.error is the released MeshKit shape
 * (meshery/schemas MeshkitError), whose flat probableCause and
 * suggestedRemediation lists are derived from these definitions until the
 * nested error instance (meshery/schemas#1334) ships. `reason` is the short
 * clause the description gives.
 */
const AGAIN = { id: "try-again", description: "Try again in a few minutes." };
const SUPPORT = { id: "contact-support", description: "If it keeps failing, contact Blowhorn support." };
const FAILURES = Object.freeze({
  unknown_tool: {
    code: "blowhorn-mcp-1000",
    reason: "the tool is not one this gateway offers.",
    causes: [
      { id: "tool-not-offered", description: "The client asked for a tool this gateway does not offer, or mistyped its name.", remediations: [{ id: "list-tools", description: "Ask for the tool list again and use one of the names it returns." }] },
    ],
  },
  invalid_arguments: {
    code: "blowhorn-mcp-1001",
    reason: "the arguments did not match the tool's input schema.",
    causes: [
      { id: "argument-mismatch", description: "An argument is missing, unknown, or of the wrong type or size.", remediations: [{ id: "fix-arguments", description: "Check the argument names and limits in the tool list, then send the call again." }] },
    ],
  },
  refused: {
    code: "blowhorn-mcp-1002",
    reason: "the gateway refused to send the request.",
    causes: [
      { id: "bad-path-value", description: "A path value is not a single valid segment.", remediations: [{ id: "one-resource", description: "Send a value that names one resource." }] },
      { id: "url-too-long", description: "The request URL would be over 8 KB.", remediations: [{ id: "shorter-arguments", description: "Send shorter arguments." }] },
    ],
  },
  cloud_rejected: {
    code: "blowhorn-mcp-1003",
    reason: "Cloud answered with a client error.",
    causes: [
      { id: "not-found", description: "The identifier does not exist.", remediations: [{ id: "check-identifiers", description: "Check the identifiers in the call." }] },
      { id: "no-access", description: "Your account cannot read it in the organization given.", remediations: [{ id: "check-organization", description: "Check organizationId, and that your account can access the resource there." }] },
    ],
  },
  cloud_failed: {
    code: "blowhorn-mcp-1004",
    reason: "Cloud answered with a server error.",
    causes: [{ id: "cloud-error", description: "Blowhorn Cloud had a problem handling the request.", remediations: [AGAIN, SUPPORT] }],
  },
  timeout: {
    code: "blowhorn-mcp-1005",
    reason: "Cloud did not answer in time.",
    causes: [
      { id: "cloud-slow", description: "Blowhorn Cloud was slow to answer.", remediations: [AGAIN] },
      { id: "call-too-big", description: "The call asked for too much at once.", remediations: [{ id: "smaller-page", description: "Ask for a smaller page of results." }] },
    ],
  },
  unreachable: {
    code: "blowhorn-mcp-1006",
    reason: "the gateway could not reach Cloud.",
    causes: [{ id: "cloud-unavailable", description: "Blowhorn Cloud or the network between it and the gateway was unavailable.", remediations: [AGAIN] }],
  },
  redirect: {
    code: "blowhorn-mcp-1007",
    reason: "Cloud answered with a redirect, which the gateway does not follow.",
    causes: [{ id: "endpoint-moved", description: "Blowhorn Cloud moved the endpoint, or a proxy in front of it redirected the call.", remediations: [AGAIN, SUPPORT] }],
  },
  too_large: {
    code: "blowhorn-mcp-1008",
    reason: "Cloud's answer was too large to return.",
    causes: [{ id: "too-much-data", description: "The call matched more data than the gateway returns in one answer.", remediations: [{ id: "narrow-call", description: "Ask for a smaller page of results, or add filters to narrow the call." }] }],
  },
  not_json: {
    code: "blowhorn-mcp-1009",
    reason: "Cloud's answer was not JSON.",
    causes: [{ id: "unexpected-body", description: "Blowhorn Cloud answered with an unexpected body, or a proxy answered in its place.", remediations: [AGAIN, SUPPORT] }],
  },
});

/** The MeshkitError for a failing outcome: the flat MeshKit lists derived from its causes and their remediations. */
function meshkitError(failure, message) {
  const remediations = failure.causes.flatMap((c) => c.remediations.map((r) => r.description));
  return {
    error: message,
    code: failure.code,
    probableCause: failure.causes.map((c) => c.description),
    suggestedRemediation: [...new Set(remediations)],
  };
}

/** A W3C trace id as a UUID string, 8-4-4-4-12. */
function uuidOf(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The operationId of one HTTP request: its valid W3C traceparent's trace id as a UUID, else a random UUID. */
export function operationId(request) {
  const m = TRACEPARENT.exec(request.headers.get("traceparent") ?? "");
  if (m && m[1] !== "ff" && m[2] !== "0".repeat(32)) return uuidOf(m[2]);
  return crypto.randomUUID();
}

/** The description: one plain sentence, with the short reason only for a failure. */
function describe(tool, outcome, httpStatus, durationMs) {
  if (outcome === "ok") return `Called ${tool} through the hosted MCP server in ${durationMs} ms.`;
  const reason = outcome === "cloud_rejected" || outcome === "cloud_failed" ? `Cloud answered ${httpStatus}.` : FAILURES[outcome].reason;
  return `${tool} through the hosted MCP server failed: ${reason}`;
}

/** `value` with every string, key included, that holds `token` cleaned, so the caller's token is never recorded. */
function scrubDeep(value, token) {
  if (typeof value === "string") return scrub(value, token);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k, token), scrubDeep(v, token)]));
  return value;
}

/**
 * The createEvent payload for one tool call. `args` are the call's arguments;
 * for an unknown tool or arguments the schema refused, only their names are
 * recorded. `message` is the sentence the caller was shown, for a failure.
 */
export function toolEvent({ tool, outcome, httpStatus = 0, durationMs, requestId, operationId: opId, args = {}, rpcId, message, token }) {
  const name = String(tool ?? "").slice(0, MAX_NAME_CHARS);
  const metadata = {
    gateway: GATEWAY,
    version: VERSION,
    tool: name,
    outcome,
    httpStatus,
    durationMs,
    requestId,
    rpcId: typeof rpcId === "string" || typeof rpcId === "number" ? rpcId : null,
  };
  const redacted = NAME_ONLY.includes(outcome) ? null : redact(args);
  if (redacted && new TextEncoder().encode(JSON.stringify(redacted)).length <= MAX_ARGUMENT_BYTES) {
    metadata.arguments = redacted;
  } else {
    metadata.argumentNames = Object.keys(args).slice(0, MAX_NAMES).map((k) => k.slice(0, MAX_NAME_CHARS));
  }
  if (outcome !== "ok") {
    const failure = FAILURES[outcome];
    metadata.error = meshkitError(failure, String(message || failure.reason).slice(0, MAX_ERROR_CHARS));
  }
  return scrubDeep(
    {
      category: CATEGORY,
      action: ACTION_TOOL_CALLED,
      operationId: opId,
      idempotencyKey: `mcp-hosted:${requestId}`,
      severity: SEVERITY[outcome],
      description: describe(name, outcome, httpStatus, durationMs),
      metadata,
    },
    token,
  );
}

/** Problems with `payload` against the event schema, as locations and messages, never values; [] when it is valid. */
export function eventProblems(payload) {
  const { valid, errors } = VALIDATOR.validate(payload);
  if (valid) return [];
  return errors.map((e) => `${e.instanceLocation.replace(/^#/, "") || "/"}: ${e.error}`);
}

/**
 * Posts `payload` to Cloud as the owner of `token`, in `orgId` when given. An
 * invalid payload is never sent. Never throws, never retries, and logs one line
 * only on failure, with no token, body or argument in it.
 */
export async function postEvent(payload, { base, token, orgId }) {
  const problems = eventProblems(payload);
  if (problems.length) {
    console.log(JSON.stringify({ event: "event_invalid", problems }));
    return;
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT };
  if (orgId) headers["X-Current-Orgid"] = orgId;
  const tool = payload.metadata.tool;
  try {
    const res = await fetch(`${base}${ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status === 200 || res.status === 201) return;
    console.log(JSON.stringify({ event: "event_post_failed", tool, status: res.status }));
  } catch (err) {
    console.log(JSON.stringify({ event: "event_post_failed", tool, error: err?.name ?? "Error" }));
  }
}
