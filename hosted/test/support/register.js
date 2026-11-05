// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Node module register hook. `make hosted-check` loads this with --import
 * before the tests, so `import { DurableObject } from "cloudflare:workers"`
 * resolves under plain Node. The resolve hook lives in its own file:
 * register() loads that file on the hooks thread, and a module must not
 * register itself.
 */
import { register } from "node:module";

register("./resolve-cloudflare-workers.js", import.meta.url);
