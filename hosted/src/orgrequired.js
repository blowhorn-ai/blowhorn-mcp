// SPDX-License-Identifier: Apache-2.0
/*
 * Cloud's "organization selection required" answer, mapped to a tools/call tool error.
 *
 * When a caller belongs to several organizations and names none, Cloud
 * answers HTTP 409 with the OrganizationSelectionRequiredError body
 * ({ code, message, choices }) published in meshery/schemas v1.3.126. A
 * missing organization is not an authentication failure (401 stays reserved
 * for token and audience failures): the caller is signed in and only has to
 * retry with one of the choices as the organizationId tool argument (Cloud
 * turns it into X-Current-Orgid; the Worker forwards the body untouched). A 409 tells an MCP client nothing useful, so on a
 * tools/call the Worker answers HTTP 200 with a JSON-RPC result whose isError
 * is true, whose structuredContent is Cloud's body unchanged, and whose text
 * lists each choice.
 *
 * The code is read from schemas/generated/org-required.schema.json, which
 * scripts/org-required-schema.js generates from the vendored OpenAPI document
 * (schemas/vendor/meshery/). It is never typed here. The match is on the code
 * only, never on message text.
 *
 * - 400, 401 or 409 whose JSON body carries the code: rewritten as above. A 401
 *   with the code is defensive only (Cloud does not send it); it must not
 *   become a sign-in loop. Every other 401 stays a 401.
 * - 200 JSON: Cloud's own MCP tool result already carries the same body in
 *   structuredContent, so it is passed through unchanged (it is read only to log).
 * - 403, 404 (a named org the caller does not belong to, or no qualifying org)
 *   and every other status, and a 409 with another code: unchanged.
 *
 * Only a tools/call is classified, and only a 400, 401, 409 or 200 JSON answer
 * is read (bounded). Everything else streams through untouched.
 */
import schema from "../schemas/generated/org-required.schema.json" with { type: "json" };

export const ORG_REQUIRED_CODE = schema.properties.code.enum[0];
/** The most of an answer that is read to look for the code; a larger answer is streamed on unread. */
export const MAX_CLASSIFY_BYTES = 64 * 1024;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Cloud's error body when `doc` is one carrying the code, else null. */
export function orgRequiredBody(doc) {
  return isObject(doc) && doc.code === ORG_REQUIRED_CODE ? doc : null;
}

/** Whether a parsed 200 JSON-RPC answer is a tool result whose structuredContent carries the code. */
export function isOrgRequiredResult(doc) {
  return isObject(doc) && isObject(doc.result) && orgRequiredBody(doc.result.structuredContent) !== null;
}

/** The JSON-RPC id of a request message, matched without case like isToolsCall. A missing id is null. */
export function messageId(message) {
  for (const [key, value] of Object.entries(message)) {
    if (key.toLowerCase() === "id" && (typeof value === "string" || typeof value === "number")) return value;
  }
  return null;
}

/** Whether an upstream answer might be the organization-required answer and so must be read: a 400, 401 or 409, or a 200 JSON body. */
export function worthReading(response) {
  const { status } = response;
  if (status === 400 || status === 401 || status === 409) return true;
  return status === 200 && /^application\/json\b/i.test(response.headers.get("Content-Type") ?? "");
}

/**
 * Reads up to `max` bytes of a response body. Resolves to `{ bytes, body }`:
 * `bytes` is the whole body when it fits, else null; `body` is always a
 * stream or buffer carrying the full original body, so the answer can still
 * be returned byte for byte.
 */
export async function peek(response, max = MAX_CLASSIFY_BYTES) {
  if (!response.body) return { bytes: new Uint8Array(0), body: null };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return { bytes, body: bytes };
    }
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      let i = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (i < chunks.length) return controller.enqueue(chunks[i++]);
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { bytes: null, body };
    }
  }
}

/** The parsed JSON document in `bytes`, or undefined when they are not UTF-8 JSON. */
export function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** The tool-result text for Cloud's error body: its message, each choice's id and name, and the retry instruction. */
export function orgRequiredText(body) {
  const message = typeof body.message === "string" && body.message ? body.message : "More than one organization is available and none was selected.";
  const choices = Array.isArray(body.choices) ? body.choices.filter(isObject) : [];
  const lines = choices.map((c) => `- ${c.id}: ${c.name}`);
  return [message, "Choose an organization, then call the tool again with organizationId set to the id of one of these organizations:", ...lines].join("\n");
}

/** The JSON-RPC tools/call result body for Cloud's error body: isError, the body as structuredContent, and text naming the choices. */
export function orgRequiredResult(id, body) {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: orgRequiredText(body) }], structuredContent: body } });
}
