#!/usr/bin/env bash
# Branch protection on `main`, built from the tree:
#
#   scripts/protect-main.sh [--dry-run]   print the PUT body and diff it against the live rule (default)
#   scripts/protect-main.sh --apply       PUT it, read it back, exit 1 unless the read-back matches
#
# The required checks come from .github/required-checks.json, the one list
# (tests/ci-workflow.test.ts proves none of them has an if:, so each reports on every run),
# pinned to GitHub Actions (app 15368) so no other app can post a pass. Every
# other setting is restated, because a PUT REPLACES the whole rule: strict
# (up to date before merge), admins included, a pull request required with 0
# approvals, linear history, conversations resolved, no force-push, no deletion. Trade-off for the owner: with admins
# included, a billing stop blocks every merge until the rule is lifted.
#
# Not covered by this PUT: `required_signatures` (its own endpoint) and
# `block_creations`; both read false today and the diff ignores them.
set -euo pipefail

REPO=kikearciniegas/ci-flow
BRANCH=main
APP=15368
mode=dry-run
case "${1:---dry-run}" in
  --dry-run) ;;
  --apply) mode=apply ;;
  *) echo "usage: scripts/protect-main.sh [--dry-run|--apply]" >&2; exit 2 ;;
esac
for c in gh jq; do command -v "$c" >/dev/null || { echo "REFUSED: '$c' is not on PATH" >&2; exit 2; }; done
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api="repos/$REPO/branches/$BRANCH/protection"

body() {
  jq --argjson app "$APP" '{
    required_status_checks: { strict: true, checks: [ .[] | { context: ., app_id: $app } ] },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: false, require_code_owner_reviews: false,
      require_last_push_approval: false, required_approving_review_count: 0 },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: false }' "$root/.github/required-checks.json"
}

# The GET shape, reduced to the PUT shape; checks as sorted "name @app" lines, so
# order is not a difference and a changed app id is.
normalize() {
  jq '{
    required_status_checks: { strict: .required_status_checks.strict,
      checks: ([ .required_status_checks.checks[]? | "\(.context) @\(.app_id)" ] | sort) },
    enforce_admins: (.enforce_admins | if type == "object" then .enabled else . end),
    required_pull_request_reviews: (.required_pull_request_reviews | if . == null then null else
      { dismiss_stale_reviews, require_code_owner_reviews, require_last_push_approval, required_approving_review_count } end),
    restrictions: .restrictions,
    required_linear_history: (.required_linear_history | if type == "object" then .enabled else . end),
    allow_force_pushes: (.allow_force_pushes | if type == "object" then .enabled else . end),
    allow_deletions: (.allow_deletions | if type == "object" then .enabled else . end),
    required_conversation_resolution: (.required_conversation_resolution | if type == "object" then .enabled else . end),
    lock_branch: (.lock_branch | if type == "object" then .enabled else . end),
    allow_fork_syncing: (.allow_fork_syncing | if type == "object" then .enabled else . end) }'
}

want="$(body)"
[ "$(jq '.required_status_checks.checks | length' <<<"$want")" -gt 0 ] || { echo "REFUSED: no required checks in .github/required-checks.json" >&2; exit 1; }
live="$(gh api "$api" | normalize)" || { echo "REFUSED: could not read the live rule for $REPO $BRANCH" >&2; exit 1; }
want_n="$(normalize <<<"$want")"

if [ "$mode" = dry-run ]; then
  echo "=== PUT body"; echo "$want"
  echo "=== live -> body"
  if [ "$live" = "$want_n" ]; then echo "(no difference)"
  else diff -u <(echo "$live") <(echo "$want_n") | tail -n +3 || true
  fi
  exit 0
fi

gh api -X PUT "$api" --input - <<<"$want" >/dev/null
back="$(gh api "$api" | normalize)" || { echo "FAILED: PUT sent, read-back failed — check the rule by hand" >&2; exit 1; }
if [ "$back" != "$want_n" ]; then
  echo "FAILED: the read-back differs from what was sent:" >&2
  diff -u <(echo "$want_n") <(echo "$back") | tail -n +3 >&2
  exit 1
fi
echo "applied and read back: $(jq -r '.required_status_checks.checks | join(", ")' <<<"$back")"
