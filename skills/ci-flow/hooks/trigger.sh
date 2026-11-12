#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Rafael Arciniegas
# ci-flow trigger — PreToolUse hook (Bash, Write, Edit, MultiEdit).
# A REMINDER, not enforcement: enforcement is server-side (protection, rulesets,
# Actions policy). Before a git/GitHub action that changes state, it injects one
# line pointing at POLICY.md and the audit, once per session per repository.
# Read-only git and gh api GETs never fire it; repository settings (gh repo, other
# gh api writes) are repo-create's hook. It never blocks: every path exits 0.
set -u
in=$(cat)
# Fast path: one jq for the tool and its command or path (NUL-terminated: a
# command may span lines). Everything else is read only once the hook must fire.
tool="" arg=""
{ IFS= read -r tool; IFS= read -r -d '' arg; } < <(printf '%s' "$in" |
  jq -j '(.tool_name // ""), "\n", (.tool_input.command // .tool_input.file_path // ""), "\u0000"' 2>/dev/null)
dir="" what=""

case "$tool" in
  Bash)
    cmd=$arg
    # git, optionally via a path and with -C/-c options, then a state-changing verb
    git_re='(^|[[:space:];&|(`])([^[:space:];&|]*/)?git([[:space:]]+-(C|c)[[:space:]]+[^[:space:]]+)*[[:space:]]+(commit|push)([[:space:]]|$)'
    gh_re='(^|[[:space:];&|(`])gh[[:space:]]+(pr[[:space:]]+(create|ready|merge))([[:space:]]|$)'
    # `gh api` as a command word; after a quote too, so `sh -c 'gh api …'` fires (ruling S5, as in repo-create).
    api='(^|[[:space:];&|(`"'"'"'])gh[[:space:]]+api[[:space:]]'
    # gh api that writes (an explicit non-GET method, or fields/input; attached, -XPUT, --method=PUT, -fa=b,
    # --field=a=b, or as the first argument too) to branch protection or rulesets
    api_w="$api"'.*(-X|--method)[[:space:]=]*(PUT|POST|PATCH|DELETE)'
    api_f="$api"'(.*[[:space:]])?(-[fF][^[:space:]]|(-f|-F|--field|--raw-field|--input)[[:space:]=])'
    # shortcut: the path and the write flag may sit in different chained segments, and a path named inside a
    # value counts (`-f description='see /rulesets'`): over-fires, never misses.
    api_p="$api"'[^;&|]*/(branches/[^/[:space:]]+/protection|rulesets?)([/?[:space:]"'"'"']|$)'
    # a graphql mutation after any flags, or a query read from a file (it may be a mutation: fail closed)
    api_g="$api"'(.*[[:space:]])?graphql([[:space:]].*)?(mutation|=@)'
    if [[ $cmd =~ $git_re ]]; then
      what="git ${BASH_REMATCH[5]}"
      [[ $cmd =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]] && dir=${BASH_REMATCH[1]}
    elif [[ $cmd =~ $gh_re ]]; then what="gh ${BASH_REMATCH[2]}"
    elif [[ ( $cmd =~ $api_w || $cmd =~ $api_f ) && $cmd =~ $api_p ]] || [[ $cmd =~ $api_g ]]; then what="a branch protection, ruleset or graphql write (gh api)"
    fi
    # `cd <dir> && …` runs the action in <dir>, not in the session's cwd.
    [ -z "$dir" ] && [[ $cmd =~ ^[[:space:]]*cd[[:space:]]+([^[:space:];&|]+) ]] && dir=${BASH_REMATCH[1]}
    dir=${dir/#\~/$HOME}
    ;;
  Write|Edit|MultiEdit)
    f=$arg
    if [[ $f =~ /\.github/(workflows/[^/]+\.ya?ml|dependabot\.ya?ml|required-checks\.json|ci-flow\.json)$ ]]; then
      what="an edit to .github/${BASH_REMATCH[1]}"; dir=${f%/*}
    fi
    ;;
esac
[ -n "$what" ] || exit 0
sid="" cwd=""
{ IFS= read -r sid; IFS= read -r cwd; } < <(printf '%s' "$in" | jq -r '(.session_id // ""), (.cwd // "")' 2>/dev/null)
[ -n "$cwd" ] || cwd=$PWD
[ -n "$dir" ] || dir=$cwd
[ "${dir:0:1}" = / ] || dir="$cwd/$dir"
# A Write may create the directory it targets: ask git from the nearest one that exists.
while [ ! -d "$dir" ] && [ "$dir" != / ]; do up=${dir%/*}; [ "$up" = "$dir" ] && break; dir=${up:-/}; done
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$dir")

# Once per session per repository.
# Markers live in a directory only this user owns (never a shared /tmp), and
# the session id is reduced to safe characters so it cannot leave that directory.
base="${TMPDIR:-$HOME/.cache}/ci-flow-trigger"
sid=$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9_-'); sid=${sid:-nosession}
# A checksum of the root: fixed length, so no collisions from / vs _ and no over-long names.
read -r crc len < <(printf '%s' "$root" | cksum); key="$crc-$len"
(umask 077; mkdir -p "$base/$sid") 2>/dev/null
# A symlinked or foreign-owned directory: remind every time rather than write through it.
if [ ! -L "$base" ] && [ -O "$base" ] && [ ! -L "$base/$sid" ] && [ -O "$base/$sid" ]; then
  [ -e "$base/$sid/$key" ] && exit 0
  { : > "$base/$sid/$key"; } 2>/dev/null
fi

msg="ci-flow applies ($what in $root): load the ci-flow skill and follow ~/.claude/skills/ci-flow/POLICY.md. Audit before and after: bun ~/.claude/skills/ci-flow/scripts/audit.ts $root."
jq -n --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $m}}'
exit 0
