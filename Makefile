# SPDX-License-Identifier: AGPL-3.0-only
# blowhorn-mcp: the npm launcher and every marketplace listing file.
# `make check` is what CI runs; run it before every PR.

REPO    := blowhorn-ai/blowhorn-mcp
VERSION := $(shell node -p "require('./package.json').version")
TAG     := v$(VERSION)

# Versions are plain X.Y.Z, never a prerelease, so nothing published can
# land on npm's `latest` tag by accident.
REQUIRE_PLAIN_VERSION = @printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "$@: version $(VERSION) in package.json is not plain X.Y.Z"; exit 1; }

.PHONY: install generate check check-drift validate check-copy check-skill check-facts check-logo test check-pack schemas-refresh release publish \
	hosted-install hosted-generate hosted-check hosted-schemas-refresh hosted-deploy

## install: dev tooling (Ajv) into tools/node_modules. The root package has
## "os": ["darwin"], which makes npm refuse any install at the root on other
## platforms, so the tooling lives in its own private package in tools/.
## Ajv and ajv-formats need no lifecycle scripts, so none run.
## hosted/ is its own package too (the interim gateway), so install covers it.
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

## hosted-install: the interim gateway's packages into hosted/node_modules.
hosted-install:
	npm ci --prefix hosted --ignore-scripts --no-audit --no-fund

hosted/node_modules/@modelcontextprotocol/sdk/package.json:
	$(MAKE) hosted-install

## hosted-generate: write hosted/src/catalog.generated.json from the vendored schemas.
hosted-generate: hosted/node_modules/@modelcontextprotocol/sdk/package.json
	node hosted/scripts/generate.js

## hosted-check: catalog and vendor drift, then the gateway's tests.
hosted-check: hosted/node_modules/@modelcontextprotocol/sdk/package.json
	node hosted/scripts/check-drift.js
	cd hosted && node --test test/*.test.js

## hosted-schemas-refresh: re-download hosted/schemas/vendor/ at the pinned commit (network).
hosted-schemas-refresh: hosted/node_modules/@modelcontextprotocol/sdk/package.json
	node hosted/scripts/schemas-refresh.js
	$(MAKE) hosted-generate

## hosted-deploy: deploy the interim gateway Worker. Run from the VM only; needs
## CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
hosted-deploy: hosted-check
	cd hosted && npx --yes wrangler@4.156.0 deploy

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
