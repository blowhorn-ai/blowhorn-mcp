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
 * turns it into X-Current-Orgid; the Worker forwards the body untouched). A
 * 409 tells an MCP client nothing useful, so on a tools/call the Worker
 * answers HTTP 200 with a JSON-RPC result whose isError is true, whose
 * structuredContent is Cloud's body unchanged, and whose text is Cloud's
 * message, each choice's id and name, and a line telling the caller to
 * retry with organizationId.
 *
 * The code is read from schemas/generated/org-required.schema.json, which
 * scripts/org-required-schema.js generates from the vendored OpenAPI document
 * (schemas/vendor/meshery/). It is never typed here. The match is on the
 * code and the schema's required shape only, never on message text.
 *
 * - 409 whose JSON body conforms: rewritten as above. A 401 whose body
 *   conforms is mapped the same way, defensively (Cloud does not send it; it
 *   must not become a sign-in loop). Every other 401 stays a 401.
 * - A 409 or 401 with the code but a non-conforming body, and every other
 *   status (200 tool results included, which stream through unread; 400, 403,
 *   404): unchanged.
 *
 * Only a tools/call is classified, and only a 409 or 401 answer is read
 * (bounded, with a deadline). Everything else streams through untouched.
 */
import schema from "../schemas/generated/org-required.schema.json" with { type: "json" };
import { BodyTimeoutError, TIMEOUT_MS } from "./proxy.js";

export const ORG_REQUIRED_CODE = schema.properties.code.enum[0];
/** The most of an answer that is read to look for the code; a larger answer is streamed on unread. */
export const MAX_CLASSIFY_BYTES = 64 * 1024;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const nonEmptyString = (v) => typeof v === "string" && v.length > 0;
const isChoice = (c) => isObject(c) && typeof c.id === "string" && typeof c.name === "string" && typeof c.description === "string";

/**
 * Cloud's error body when `doc` has the schema's required shape (the published code, a non-empty
 * message, at least 2 choices each with string id, name and description), else null. The generated
 * schema is the source of truth in tests; this is the small runtime check.
 */
export function orgRequiredBody(doc) {
  if (!isObject(doc) || doc.code !== ORG_REQUIRED_CODE || !nonEmptyString(doc.message)) return null;
  const min = schema.properties.choices.minItems;
  return Array.isArray(doc.choices) && doc.choices.length >= min && doc.choices.every(isChoice) ? doc : null;
}

/** The JSON-RPC id of a request message, matched without case like isToolsCall. A missing id is null. */
export function messageId(message) {
  for (const [key, value] of Object.entries(message)) {
    if (key.toLowerCase() === "id" && (typeof value === "string" || typeof value === "number")) return value;
  }
  return null;
}

/** Whether an upstream answer might be the organization-required answer and so must be read: a 409, or a 401 (defensive path only). */
export function worthReading(response) {
  return response.status === 409 || response.status === 401;
}

/**
 * Reads up to `max` bytes of a response body. Resolves to `{ bytes, body }`:
 * `bytes` is the whole body when it fits, else null; `body` is always a
 * stream or buffer carrying the full original body, so the answer can still
 * be returned byte for byte. The read has `timeoutMs` (the same budget as the
 * trip to Cloud); past it the body is cancelled and a BodyTimeoutError is
 * thrown. Any other read error is cancelled and rethrown.
 */
export async function peek(response, max = MAX_CLASSIFY_BYTES, timeoutMs = TIMEOUT_MS) {
  if (!response.body) return { bytes: new Uint8Array(0), body: null };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeoutError("upstream body read timed out")), timeoutMs);
  });
  expired.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
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
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
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

/** The tool-result text for Cloud's error body: its message, each choice's id and name, and a retry instruction naming organizationId. */
export function orgRequiredText(body) {
  const lines = [body.message, ...body.choices.map((c) => `- ${c.id}: ${c.name}`), "Choose an organization and retry with organizationId set to one of these ids."];
  return lines.join("\n");
}

/** The JSON-RPC tools/call result body for Cloud's error body: isError, the body as structuredContent, and text naming the choices. */
export function orgRequiredResult(id, body) {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: orgRequiredText(body) }], structuredContent: body } });
}
