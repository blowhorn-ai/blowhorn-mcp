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
import { CODES, definition } from "./errors.js";
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

/*
 * Each failing outcome's definition is in errors/mcp.json (src/errors.js): a
 * code (`blowhorn-mcp-NNNN`), a severity, and probable causes that each carry
 * their own remediations, so a fix always names the cause it answers. On the
 * wire metadata.error is the released MeshKit shape (meshery/schemas
 * MeshkitError), whose flat probableCause and suggestedRemediation lists are
 * derived from the definition until the nested error instance
 * (meshery/schemas#1334) ships. A failure's description gives its
 * definition's shortDescription as the reason, so each text has one copy.
 *
 * FAILURES are the failing outcomes a tool call event can record: every
 * outcome with a code but rate_limited, a refused request, which is not a
 * tool call (src/ratelimit.js).
 */
const FAILURES = Object.freeze(Object.keys(CODES).filter((outcome) => outcome !== "rate_limited"));

/** The event level for each outcome: informational on success, else its definition's severity (a caller's mistake or a refused call is a warning, a failure of Cloud or the path to it an error). */
const SEVERITY = Object.freeze({
  ok: "informational",
  ...Object.fromEntries(FAILURES.map((outcome) => [outcome, definition(outcome).severity])),
});

/** The MeshkitError for a failing outcome's definition: the flat MeshKit lists derived from its causes and their remediations. */
function meshkitError(failure, message) {
  const remediations = failure.probableCauses.flatMap((c) => c.remediations.map((r) => r.description));
  return {
    error: message,
    code: failure.code,
    probableCause: failure.probableCauses.map((c) => c.description),
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

/**
 * The description: for a success one sentence with the duration; for a
 * failure one saying so (with Cloud's HTTP status when Cloud answered with an
 * error), then the definition's shortDescription.
 */
function describe(tool, outcome, httpStatus, durationMs) {
  if (outcome === "ok") return `Called ${tool} through the hosted MCP server in ${durationMs} ms.`;
  const status = outcome === "cloud_rejected" || outcome === "cloud_failed" ? ` with HTTP ${httpStatus}` : "";
  return `${tool} through the hosted MCP server failed${status}. ${definition(outcome).shortDescription}`;
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
    if (!FAILURES.includes(outcome)) throw new Error(`no tool call event for outcome ${outcome}`);
    const failure = definition(outcome);
    metadata.error = meshkitError(failure, String(message || failure.shortDescription).slice(0, MAX_ERROR_CHARS));
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
