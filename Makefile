# SPDX-License-Identifier: AGPL-3.0-only
# blowhorn-mcp: the npm launcher and every marketplace listing file.
# `make check` is what CI runs; run it before every PR.

REPO    := blowhorn-ai/blowhorn-mcp
VERSION := $(shell node -p "require('./package.json').version")
TAG     := v$(VERSION)

.PHONY: install generate check check-drift validate check-copy check-skill check-logo test check-pack schemas-refresh release publish

## install: dev tooling (Ajv) into tools/node_modules. The root package has
## "os": ["darwin"], which makes npm refuse any install at the root on other
## platforms, so the tooling lives in its own private package in tools/.
install:
	npm ci --prefix tools --no-audit --no-fund

tools/node_modules/ajv/package.json:
	$(MAKE) install

## generate: write every listing file from listing/listing.json and package.json.
generate: tools/node_modules/ajv/package.json
	node scripts/generate.js

## check: everything CI checks.
check: check-drift validate check-copy check-skill check-logo test check-pack
	@echo "make check: all checks passed"

check-drift: tools/node_modules/ajv/package.json
	node scripts/check.js drift

validate: tools/node_modules/ajv/package.json
	node scripts/validate.js

check-copy:
	node scripts/check.js copy

check-skill:
	node scripts/check.js skill

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

## release: tag $(TAG) on master and create its GitHub release. The Gemini
## extensions gallery reads releases, and the tag must equal gemini-extension.json's version.
release: check
	@test -z "$$(git status --porcelain)" || { echo "release: the working tree is not clean"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = master || { echo "release: check out master first"; exit 1; }
	@git fetch --quiet origin master --tags
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/master)" || { echo "release: local master is not origin/master; pull or push first"; exit 1; }
	@! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { echo "release: tag $(TAG) already exists; bump the version in package.json and run make generate"; exit 1; }
	gh release create "$(TAG)" --repo $(REPO) --target "$$(git rev-parse HEAD)" --title "$(TAG)" --generate-notes

## publish: run the npm publish workflow for $(VERSION) (needs the $(TAG) release).
publish:
	gh workflow run publish.yml --repo $(REPO) --ref master -f version=$(VERSION)
	@echo "publish: started; follow it with: gh run watch --repo $(REPO)"
