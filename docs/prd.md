# Product Requirements: ci-flow

> [!NOTE]
> The rules themselves live in [`skills/ci-flow/POLICY.md`](../skills/ci-flow/POLICY.md). This document says what the product is and why; it never restates a rule.

## What it is

A Claude Code skill that keeps GitHub Actions CI **consistent** and **minute-efficient** across one owner's repositories, and keeps each repository's configuration hardened. It ships:

- one written policy (`POLICY.md`) that every agent instruction file points to;
- a reference design with audit check ids (`SKILL.md`);
- a **read-only audit** (`scripts/audit.ts`) that compares a repository with the design and with what its GitHub plan allows;
- a **reminder hook** (`hooks/trigger.sh`) that points an agent at the policy before any state-changing git or GitHub action;
- the failures that shaped the design (`references/lessons.md`) and a porting guide (`references/porting.md`).

## For whom

| User | Need |
|---|---|
| The owner (a solo developer with personal and Team-org repos) | One place for CI and repo-security rules; a quick answer to "is this repo set up right?" |
| AI coding agents (Claude Code, Codex) working in those repos | A rule to read before committing, pushing or changing settings, and a check to run before and after |

## Why

- CI minutes are a fixed budget shared across repos; an ungated expensive job or a rerun habit spends it twice.
- Each repo drifted on its own: copied workflows, different pins, missing protection.
- Agent instructions repeated the rules in several files, which then disagreed.

## Scope

DONE:
- Policy, design checklist, audit (CI design + repository configuration), reminder hook, tests.
- Plan-aware judgement: a feature the plan lacks is `blocked` (an owner decision), not a silent pass.

## Success measures

- The audit of a compliant repo reports no FAIL; every check has a test mutation that flips it to FAIL (enforced by `tests/audit.test.ts`).
- No CI rule is restated outside `POLICY.md`.
- Monthly Actions spend stays inside the owner's budget. TBD: no measured baseline after rollout yet.

## Non-goals

- **Enforcement.** The hook only reminds; enforcement is server-side (branch protection, rulesets, Actions policy).
- Writing settings. The audit prints fixes and never runs them.
- CI systems other than GitHub Actions.
- A general-purpose tool for other people's org structures (it is published under MIT, but shaped for one owner).
