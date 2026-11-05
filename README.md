# ci-flow

A Claude Code skill that keeps GitHub Actions CI consistent and
minute-efficient across projects: one reference design, the failures that
shaped it, a porting guide, and a read-only audit that checks a repository
against the design.

## Install

Symlink the skill directory (this folder is the single source of truth; there
is no second copy):

```sh
ln -s "$PWD/skills/ci-flow" ~/.claude/skills/ci-flow
```

## File map

| Path | Role |
|---|---|
| `skills/ci-flow/POLICY.md` | the rules (CI economy, repository security), the one source CLAUDE.md and AGENTS.md point to |
| `skills/ci-flow/SKILL.md` | the design checklist (with audit check ids), add-ons, budget arithmetic, procedure |
| `skills/ci-flow/hooks/trigger.sh` | PreToolUse reminder: state-changing git/gh actions and `.github` edits → POLICY.md + the audit, once per session per repo |
| `skills/ci-flow/references/lessons.md` | every failure found so far: symptom, cause, guard |
| `skills/ci-flow/references/porting.md` | files, renames, order and verification for a new repo |
| `skills/ci-flow/scripts/audit.ts` | the audit (`bun`) |
| `skills/ci-flow/scripts/lib/` | its parts: `gh.ts` (process and `gh api` GETs, fetched in parallel), `plans.ts` (what each GitHub plan gives a repo, minutes), `owner.ts` (`--owner`) |
| `tests/audit.test.ts` | falsification suite: a fixture that passes every check, one mutation per check that must fail it |
| `tests/ci-workflow.test.ts` | this repo's own `ci.yml` keeps the rules the audit checks (each with a negative control) |
| `tests/trigger.test.ts` | the hook fires on real state-changing commands and stays silent on read-only ones |

## Audit

```sh
bun skills/ci-flow/scripts/audit.ts <repo-path> [--ref origin/main] [--repo owner/name] [--strict] [--config-only]
bun skills/ci-flow/scripts/audit.ts --owner <login>    # before creating a repo
```

Reads the tree at `--ref` through `git show`, the local clone's pre-commit
hook, and the live protection, repository/org settings, plan, billing and
recent runs through `gh api` GETs; writes nothing. Prints two tables (CI
design; repository configuration, judged by plan × visibility × what the
project needs), a "Hardening" list of suggested commands (never run), and the
billed minutes of the latest green full PR run, main push and deploy. Statuses:
pass, FAIL, blocked (the plan lacks a feature the project needs — an owner
decision), n.a. Unknown is FAIL. Exit 0 unless `--strict` and something
FAILED. Billing and a user account's plan need `gh auth refresh -s user`.

Inside a sandbox that intercepts TLS, `gh` cannot verify GitHub's
certificate; run the audit outside it.

## Tests

```sh
bun test tests/
```

Every check the baseline reports must have a mutation that flips it to FAIL;
the suite fails if a new check is added without one.
