// SPDX-License-Identifier: AGPL-3.0-only
const stub = new URL("./cloudflare-workers.js", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
