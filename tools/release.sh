#!/usr/bin/env bash
# Publishes a release: refuses unless the live proof of this exact commit passed, then tags it and attaches the run
# log as test-run-v<version>.txt (the proof kohasolutions.com links to).
#   bash tools/test-live.sh && git commit … && bash tools/release.sh 1.0.0
set -euo pipefail
cd "$(dirname "$0")/.."
V=${1:?usage: tools/release.sh <version>}
TAG="v$V"
[ -z "$(git status --porcelain)" ] || { echo "Commit everything first."; exit 1; }
[ -f test-run.txt ] || { echo "No test-run.txt: run bash tools/test-live.sh first."; exit 1; }
tail -1 test-run.txt | grep -q '^RESULT: all passed$' || { echo "test-run.txt does not show a passing run."; exit 1; }
tested=$(git log -1 --format=%H -- test-run.txt)
changed=$(git diff --name-only "$tested" HEAD -- notices tools/render.mjs tools/koha-render.pl | grep -v '/preview-' || true)
[ -z "$changed" ] || { echo "Changed after the live run, run tools/test-live.sh again:"; echo "$changed"; exit 1; }
grep -q "^## $V " CHANGELOG.md || { echo "CHANGELOG.md has no '## $V' entry."; exit 1; }
cp test-run.txt "/tmp/test-run-$TAG.txt"
notes=$(awk -v v="## $V " 'index($0, v) == 1 { on = 1; next } /^## / && on { exit } on' CHANGELOG.md)
git tag -a "$TAG" -m "koha-notice-templates $V"
git push origin main "$TAG"
gh release create "$TAG" "/tmp/test-run-$TAG.txt" --title "koha-notice-templates $V" --notes "$notes"
echo "Released $TAG"
