#!/bin/sh
# Fails when the intranet patch surface outgrows its budget.
# Usage, from the fork root: sh scripts/intranet-patch-budget.sh [base-ref] [budget]
# Only product source under apps/ and packages/ counts; tests, fixtures and docs do not.
set -eu

base="${1:-intranet/base}"
budget="${2:-6}"

git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || {
  echo "intranet-patch-budget: base ref '$base' does not resolve" >&2
  exit 1
}
names=$(git diff --name-only "$base"...HEAD -- apps packages) || {
  echo "intranet-patch-budget: git diff against '$base' failed" >&2
  exit 1
}
changed=$(printf '%s\n' "$names" | grep -Ev '\.(test|spec)\.(ts|tsx)$|\.json$|\.md$' | grep -c . || true)

echo "intranet source patch surface: $changed file(s) against $base (budget $budget)"
[ "$changed" -le "$budget" ]
