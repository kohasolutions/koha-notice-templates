#!/usr/bin/env bash
# The whole live proof in one run, written to test-run.txt (attached to each GitHub Release by tools/release.sh).
# Needs a TEST Koha (koha-testing-docker): e2e-install checks items out in it.
#   bash tools/test-live.sh
#   PLAYWRIGHT_FROM=/path/to/a/project   a project with Playwright and its Chromium (for the preview checks)
set -euo pipefail
cd "$(dirname "$0")/.."
{
  echo "koha-notice-templates $(git describe --tags --always --dirty) · $(git rev-parse HEAD)"
  echo "Run on $(date -u +%Y-%m-%dT%H:%M:%SZ), $(uname -sr), node $(node --version)"
  echo
  echo "== Unit tests"
  node --test tests/*.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'
  echo
  echo "== Layout"
  node tools/lint.mjs
  node tools/variables.mjs --check
  echo
  echo "== Every notice through Koha (tools/render.mjs)"
  node tools/render.mjs
  echo
  echo "== Previews checked against Koha's output (tools/preview.mjs --check)"
  node tools/preview.mjs --check
  echo
  echo "== Install, check out, restore (tools/e2e-install.mjs)"
  node tools/e2e-install.mjs --i-know-this-is-a-test-koha
  echo
  node tools/tested.mjs
  echo
  echo "RESULT: all passed"
} 2>&1 | tee test-run.txt
