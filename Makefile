# SPDX-License-Identifier: Apache-2.0
# blowhorn-mcp: the npm launcher and every marketplace listing file.
# `make check` is what CI runs; run it before every PR.

REPO    := blowhorn-ai/blowhorn-mcp
VERSION := $(shell node -p "require('./package.json').version")
TAG     := v$(VERSION)

# Versions are plain X.Y.Z, never a prerelease, so nothing published can
# land on npm's `latest` tag by accident.
REQUIRE_PLAIN_VERSION = @printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "$@: version $(VERSION) in package.json is not plain X.Y.Z"; exit 1; }

.PHONY: install generate check check-drift validate check-copy check-skill check-facts check-logo test check-pack schemas-refresh release publish \
	hosted-install hosted-check hosted-smoke hosted-schemas-refresh hosted-require-node hosted-deploy

## install: dev tooling (Ajv) into tools/node_modules. The root package has
## "os": ["darwin"], which makes npm refuse any install at the root on other
## platforms, so the tooling lives in its own private package in tools/.
## Ajv and ajv-formats need no lifecycle scripts, so none run.
## hosted/ is its own package too (the interim transport proxy), so install covers it.
install: hosted-install
	npm ci --prefix tools --ignore-scripts --no-audit --no-fund

tools/node_modules/ajv/package.json:
	$(MAKE) install

## generate: write every listing file from listing/listing.json and package.json.
generate: tools/node_modules/ajv/package.json
	node scripts/generate.js

## check: everything CI checks.
check: check-drift validate check-copy check-skill check-facts check-logo test check-pack hosted-check
	@echo "make check: all checks passed"

check-drift: tools/node_modules/ajv/package.json
	node scripts/check.js drift

validate: tools/node_modules/ajv/package.json
	node scripts/validate.js

check-copy:
	node scripts/check.js copy

check-skill:
	node scripts/check.js skill

check-facts:
	node scripts/check.js facts

check-logo:
	node scripts/check.js logo

test: tools/node_modules/ajv/package.json
	npm test --silent

check-pack:
	node scripts/check.js pack

## schemas-refresh: re-download schemas/vendor/* and rewrite SOURCES.json (network).
schemas-refresh:
	node scripts/schemas-refresh.js
	$(MAKE) validate

## hosted-install: the interim gateway's packages into hosted/node_modules,
## wrangler included, at the versions in hosted/package-lock.json.
## No lifecycle scripts run. The only ones in the tree are esbuild's and
## workerd's postinstall, which check that the locked platform binary package
## (@esbuild/<platform>, @cloudflare/workerd-<platform>) is there, fetch one
## unlocked from npm if it is not, and swap the JS shim for the binary as a
## speedup; npm ci already installs the locked one, and both packages find it
## at run time. The third, fsevents (macOS only, for file watching), ships
## fsevents.node prebuilt; its install script only rebuilds it.
## Engines stay a warning, never an error, even if your npm config says
## otherwise: wrangler and two of its dependencies want Node 22, but only
## the deploy targets run them, and the Worker tests run on Node 20 (CI has a Node 20 leg).
hosted-install:
	npm ci --prefix hosted --ignore-scripts --engine-strict=false --no-audit --no-fund

hosted/node_modules/@modelcontextprotocol/sdk/package.json:
	$(MAKE) hosted-install

## hosted-check: vendored schema and error registry drift, then the proxy's tests.
hosted-check: hosted/node_modules/@modelcontextprotocol/sdk/package.json
	node hosted/scripts/check-drift.js
	cd hosted && node --import ./test/support/register.js --test test/*.test.js

## hosted-smoke: the opt-in live smoke of the deployed origin (network). Not part
## of check or hosted-check. Each run registers one OAuth client named
## blowhorn-mcp-hosted-smoke <UTC time>. Signed-in checks need a token in the
## environment and are skipped without one; see hosted/README.md.
## Point it elsewhere with SMOKE_HOSTED_BASE=<url>.
hosted-smoke: hosted/node_modules/@modelcontextprotocol/sdk/package.json
	cd hosted && node scripts/smoke-hosted.js

## hosted-schemas-refresh: re-download hosted/schemas/vendor/ at the pinned commit (network).
## blowhorn-ai/blowhorn is private: run it with GITHUB_TOKEN=$(gh auth token).
hosted-schemas-refresh: hosted/node_modules/@modelcontextprotocol/sdk/package.json
	node hosted/scripts/schemas-refresh.js

## hosted-require-node: refuse unless Node is at least the major in
## hosted/.nvmrc, which is what the locked wrangler needs. Every target that
## runs wrangler depends on it first. The logic is hosted/scripts/require-node.js.
hosted-require-node:
	@node hosted/scripts/require-node.js

## hosted-deploy: deploy the interim transport proxy Worker with the locked wrangler in
## hosted/node_modules, never a download. It always reinstalls from
## hosted/package-lock.json first, so a node_modules left from before a lock
## bump never deploys another wrangler. Run from the VM only; needs
## CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
hosted-deploy: hosted-require-node
	$(MAKE) hosted-install
	$(MAKE) hosted-check
	cd hosted && ./node_modules/.bin/wrangler deploy

## release: tag $(TAG) on master and create its GitHub release. The Gemini
## extensions gallery reads releases, and the tag must equal gemini-extension.json's version.
release: check
	$(REQUIRE_PLAIN_VERSION)
	@test -z "$$(git status --porcelain)" || { echo "release: the working tree is not clean"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = master || { echo "release: check out master first"; exit 1; }
	@git fetch --quiet origin master --tags
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/master)" || { echo "release: local master is not origin/master; pull or push first"; exit 1; }
	@! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { echo "release: tag $(TAG) already exists; bump the version in package.json and run make generate"; exit 1; }
	gh release create "$(TAG)" --repo $(REPO) --target "$$(git rev-parse HEAD)" --title "$(TAG)" --generate-notes

## publish: run the npm publish workflow for $(VERSION) (needs the $(TAG) release).
publish:
	$(REQUIRE_PLAIN_VERSION)
	gh workflow run publish.yml --repo $(REPO) --ref master -f version=$(VERSION)
	@echo "publish: started; follow it with: gh run watch --repo $(REPO)"
