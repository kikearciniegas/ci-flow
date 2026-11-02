---
name: ci-flow
description: Keep GitHub Actions CI consistent and minute-efficient, and repository configuration hardened, across projects, with a read-only audit script that knows what each GitHub plan (Free, Pro, Team) gives public and private repos. Use when writing or changing a workflow (.github/workflows/*.yml), adding a CI job or a required status check, setting up CI on a new repository, CREATING a repository, renaming one or changing its visibility, changing repository or organization settings, a red or failing CI run, a minutes / billing / Actions quota question, porting CI from one project to another, branch protection for the default branch, the pre-push hook or local CI tiers, deploy workflows, and Dependabot bumps of the deploy CLI or of GitHub Actions.
---

# ci-flow — CI that reports every check and bills only what it must

Internal skill. The rules live in `POLICY.md` beside this file (the one
source; CLAUDE.md and AGENTS.md point to it): read it first. This file
carries the reference design that implements them, the procedure, and the
audit. Two production repositories run this
design (called project A and project B below); the audit's test fixture
(`../../tests/audit.test.ts` from this directory, `BASE`) is the smallest
complete example of it.

## Before anything else

1. **Run the audit first, and again last.**
   `bun ~/.claude/skills/ci-flow/scripts/audit.ts <repo-path>` — reads
   `origin/main` via `git show` (never the working tree) plus `gh api` GETs.
   It writes nothing. In a sandboxed shell `gh` fails TLS verification; re-run
   that one command outside the sandbox (it is read-only). `--strict` exits 1
   on any FAIL; `--ref <ref>` audits another commit; `--repo <owner/name>`
   when origin is not a github.com URL. An unknown answer is FAIL, never PASS.
   `--config-only` runs the repository-configuration section alone (repos
   with no CI). **Before `gh repo create`:** `bun … audit.ts --owner <login>`
   prints the plan, what a new private vs public repo gets, repo counts,
   this month's minutes and a random development name. Every FAIL row prints
   a hardening command under "Hardening"; the audit never runs one.
2. **Load `references/lessons.md` before changing a hook, a stamp, a gate, the
   deploy workflow or a test that spawns git, and whenever a CI run is red.**
   Every entry there is a failure that already happened once.
3. **Load `references/porting.md` before setting up CI on a repo that has
   none, or copying any piece of this design between repos.** It has the file
   list, the renames and the order (protection comes AFTER the gates exist).

## Add-ons: adopt each only where it pays

The cheap job, triggers, bounds, privilege, toolchain pins, required checks,
Dependabot and red-run rules below apply to every repo with CI. Four parts
are add-ons, declared per repo in `.github/ci-flow.json`
(`{"addons": ["gated-expensive", "classifier", "local-stamps", "deploy"]}`):
- `gated-expensive` — [ready-for-review] [expensive-gated] [browser-job] [matrix-aggregate] [gate-tests]: when a job costs more than ~2 min or needs a browser.
- `classifier` — [classifier-tracked] [classifier-shared]: when docs-only PRs are common enough to skip expensive jobs.
- `local-stamps` — [hook-tiers] [mark-ready-gate] [stamp-covers-suite] [hook-strips-git-env] [local-refuses-bun] [local-refuses-node]: when ready runs are expensive enough to gate locally.
- `deploy` — every `deploy-*` check: when a workflow deploys.

A check of an add-on the file does not list reports n.a.; [addons-declared]
fails on an unknown add-on name, and on a repo whose tree needs an add-on it
did not declare (a browser/e2e or draft-gated job without `gated-expensive`,
a deploy workflow without `deploy`) — the declaration never hides a job that
is there. No file = the full design is audited.

## The reference design (audit check ids in brackets)

Each line: the rule, then why. A change that breaks a line needs the owner's
decision, written beside the change.

**Triggers and concurrency**
- `push` on the default branch only, `pull_request` for branches [trigger-once] — both on one commit bills it twice.
- `ready_for_review` in `pull_request.types` [ready-for-review] — otherwise marking a draft ready runs no expensive job at all.
- Workflow `concurrency` on `github.ref`, `cancel-in-progress: true` (or `== 'pull_request'`) [concurrency-ci]; deploy keeps the group with `false` [concurrency-deploy] — a cancelled deploy is half a deploy.
- No `paths` / `paths-ignore` at workflow level on the workflow holding required checks [no-workflow-paths-filter] — a workflow that never starts leaves a required check pending forever.

**Bounds and privilege**
- `timeout-minutes` on every job [timeouts] — a hang otherwise bills to GitHub's 6-hour ceiling.
- Top-level `permissions: contents: read`, widened per job [permissions-top]; every action pinned to a 40-char sha with the version in a comment [actions-sha-pinned] — a moved tag runs foreign code beside your secrets.

**One classifier**
- One tracked script decides `docs` vs `code` (and browser yes/no), invoked by CI's cheap job into `$GITHUB_OUTPUT`, by the pre-push hook and by the full local run [classifier-tracked, classifier-shared] — two classifiers drift, and the drift skips a suite.
- `docs` = every changed path is documentation AND no skipped suite reads it, DERIVED by scanning the suites' code (comment lines dropped), never a hand list. A deleted doc, an empty or unreadable range, an all-zero sha, any error → `code`. A wrong `docs` skips coverage; a wrong `code` costs minutes.

**Cheap job vs expensive jobs**
- The cheap job runs on every event, drafts and docs included: range gitleaks (`--log-opts=<range>`, pinned release, `sha256sum -c`) [cheap-secret-scan] and the dependency audit with no `if:` [audit-ungated] — a draft must hear about a leaked secret or a new advisory, and gitleaks-action needs a paid licence for orgs. The range, never full history: old test fixtures would red every run.
- Expensive jobs gate on `github.event_name == 'pull_request' && !github.event.pull_request.draft && needs.<cheap>.outputs.<scope> …` and `needs:` the cheap job [expensive-gated] — `!draft` alone is TRUE on a push, so they reran after every merge (a sibling repo, 2026-10: ~45% of its minutes).
- No rerun on the default-branch push ONLY while protection is `strict` with those jobs required — then the merged tree is the tree the PR tested. Lift strict and the gate must widen again.
- Skip at JOB level, never step level, in an expensive job — a job whose steps all skip still bills a runner.
- A matrix job with an `if:` is never a required check; an aggregate job (`needs` it, `if: always() && needs.<m>.result != 'skipped'`, fails unless every leg succeeded) is [matrix-aggregate] — a skipped matrix reports ONE check under its unexpanded name.
- Browser job: PR-only, path-scoped, browsers cached on the playwright version [browser-job]; every `bun install` job caches `~/.bun/install/cache` [install-cache].
- Browser tests wait for the CONDITION, never a proxy: no `networkidle`, no `waitForTimeout(n)` [browser-wait-proxy]. A hydration gate waits for the framework's own marker and is proven by a scripts-off page on which it must time out.

**Required checks**
- Declared in the tree: `.github/required-checks.json`, a JSON array of CI job names [required-declared], and a test proves each reports on every event kind.
- Applied by a protect script: dry-run diff by default, `--apply` PUTs restating EVERY setting (a PUT replaces the rule), reads back, exits 1 on any difference [protect-script].
- **When to apply, by direction:** REMOVING or renaming a check → `--apply` from the PR's tree BEFORE the merge (the PR cannot report a check its own branch deleted, so it stays BLOCKED); ADDING a check → `--apply` right AFTER the merge (before it, every other open PR waits on a job its branch lacks). Never `--admin` past it.
- Live rule: strict, admins included, a PR required (0 approvals is fine), no force-push, no deletion, every check pinned to app_id 15368 (GitHub Actions; confirm it from the repo's own check runs) [protection-live], equal to the declared list [protection-matches-declared]. Tell the owner: with admins included, a billing stop blocks every merge until the rule is lifted.

**Toolchain**
- One exact bun and one exact node (`x.y.z`), everywhere [toolchain-exact]; a test refuses `latest`, a bare major and two different pins [toolchain-guard-test] — `latest` turns CI red on a release with no change in the tree.
- EVERY job that runs node/npm/npx (or bun) sets that pin [toolchain-every-job] — one exact pin in one job passes toolchain-exact while the other jobs run the runner image's node, which moves when GitHub updates it. The deploy job counts.
- The hosting platform's runtime is the same pin, changed in the same PR: flip the platform setting BEFORE the preview (it builds remotely from that setting), then read the build log for "version changed from X to Y".
- The local runner reads the pins from the workflow and REFUSES a mismatch, bun AND node [local-refuses-bun, local-refuses-node] — a green run under another engine is not CI's green.

**Local tiers**
- Pre-push hook: no PR or a draft → run the fast tier (scan, install, audit, typecheck, lint, unit; ~2 min) in a throwaway worktree of the pushed sha; a READY PR → require a full-run stamp, run nothing [hook-tiers]. `gh` missing or any gh error except "no pull requests found" → treat as READY (fail closed).
- Stamp = file `<tree sha>.<mode>` under `git rev-parse --git-common-dir`, content = hash of the suite AT THAT COMMIT: runner, workflow, classifier, hook, stamp script itself [stamp-covers-suite]. Modes nest (code ⊇ fast ⊇ docs). A dirty tree runs but is not stamped.
- Mark-ready script refuses `gh pr ready` without a `code` stamp on the PR head [mark-ready-gate].
- The hook runs `unset $(git rev-parse --local-env-vars)` before any git call [hook-strips-git-env]; every test that spawns git strips `GIT_*` and isolates config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) and builds PATH from a private bin, not `x:/usr/bin:/bin` [tests-hermetic-git].
- Tests parse the workflow and assert the gates, the PR types, the ungated audit and the required list, each with a negative control [gate-tests].
- The full run replicates EVERY job a ready PR runs (integration, browsers) on free ports and private dirs it picks itself, on the final head after the one update from the default branch; both tiers fail CLOSED (a missing tool refuses, never skips).
- Not a security boundary: a stamp is a file anyone can write and `--no-verify` skips the hook. It is a local gate, never a reason for CI to skip anything: a required check is accepted only from GitHub Actions. A local pass on macOS lowers, never removes, the risk of a red Linux run.

**Deploy**
- Three jobs [deploy-split]: a token job (`permissions: {}`, no checkout, runs no repo code) reads the live production sha; a scope job with NO secret and NO environment (`fetch-depth: 0`, `persist-credentials: false`) classifies `<live sha>..HEAD`; the deploy job skips only on a SUCCESSFUL scope job answering `skip` — `env -u TOKEN` around repo code on the token's runner does not isolate it.
- Never judge `HEAD^1..HEAD` [deploy-live-range] — the deploy concurrency group REPLACES a pending run, and a failed code deploy is not retried, so a docs merge right after a code merge would keep that code off production. Unreadable live sha, non-ancestor, shallow history → deploy.
- Deploy CLI from a committed lockfile dir, `npm ci --ignore-scripts`, after a check that every `resolved` is `https://registry.npmjs.org/` with an `integrity` [deploy-cli-locked]; never `npx <cli>@<version>` beside the token (the transitives float).
- Every deploy records `--meta <name>Sha=<sha>` [deploy-sha-meta]; `workflow_dispatch` with `target: preview` exists [deploy-preview]; preview → QA → production; deploy through GitHub while Actions works, not local scripts.

**Dependabot**
- Ecosystems: `bun` (version drift only: `bun.lock` gets NO security updates), `npm` for the deploy-CLI lock dir, `github-actions` [dependabot-ecosystems]; github-actions GROUPED [dependabot-actions-grouped] — one full CI run per batch, not per action.
- A `bun audit --prod` (or the repo's scoped equivalent) in the cheap job is what actually reads resolved versions.
- An alert in a vendored tool's tree (the deploy CLI): `overrides` keyed `name@^major` to the patched version inside that major; an alert needing a major jump inside the vendor's own packages is dismissed with the reason written on the alert [alert-dismissal-reason]; both revisited on every bump of the tool, and an override the new tree satisfies is deleted.

**Red runs**
- Never re-run until green. The one exception: the same suite passes N≥3 times locally on the pinned toolchain → rerun ONLY the failed job, ONCE; write the classification on the PR (symptom, evidence, why no local tier catches it); the fix to the test lands in the next code PR. A second red of the same kind is a defect, not a flake.

**Health**
- More than 3 failures in the last 20 completed runs [ci-red-rate] is a defect to fix (flake, quota stop, broken step), never to re-run until green. Check billing first: usage exactly at quota means Actions stopped.
- Classify every red run — billing stop, runner infra, toolchain drift, real defect, OS-only difference — and name the local tier that should have caught it. A class no local tier can catch gets a CI-side fix, not a retry. (Measured 2026-10 on one org: 171 of 177 red runs were billing stops, 6 real defects.)

## Repository configuration (audit section 2; POLICY.md §2)

Judged against what the owner's plan gives a repo of this visibility, and
what the project needs (read from its tree: a PR workflow → it needs
protection; a deploy workflow or a deploy-like secret → it needs
environments). Plan facts checked against GitHub docs 2026-11-02:

| A repo gets | Private, Free | Private, Pro | Private, Team org | Public, any plan |
|---|---|---|---|---|
| Repositories / collaborators | unlimited | unlimited | unlimited | unlimited |
| Branch protection, rulesets | no | yes | yes | yes |
| Environments, env secrets, branch policies | no | yes | yes | yes |
| Env required reviewers / wait timers | no | no | no | yes |
| Secret scanning + push protection | no | no | paid add-on | yes |
| CodeQL | no | no | paid add-on | yes |
| Private vulnerability reporting | no | no | no | yes |
| Actions (standard Linux) | 2,000 min | 3,000 min | 3,000 min, org-shared | free |

- Plan lacks it AND the project needs it → `blocked`, with the options (move to the Team org, Pro, go public, accept the named risk). Lacks it, not needed → n.a. Available but off → FAIL with the fix. `--strict` ignores `blocked`: it is an owner decision. Owner rule (2026-11-02): a personal private repo moves to the Team org when it gains a deploy credential or an expensive required job.
- Plan: read from GitHub (an org always; a user only with the `user` scope), else inferred — a private repo refused protection "with an upgrade message" is on Free.
- Checks: [plan-detected] [plan-protection] [plan-environments] [plan-minutes] [repo-name] [merge-hygiene] [dependabot-alerts] [dependabot-security-updates] [actions-token] [actions-policy] (allow-list + full-SHA pinning; org-wide for org repos, so pin every repo first) [fork-pr-policy] [secret-scanning] [private-vuln-reporting] [security-policy] [branch-baseline] (config-only; protection-live judges CI repos) [deploy-keys] [webhooks] [collaborators] [deploy-credential-scope] [log-retention] (≤ 30 days) [commit-email-noreply] [gitleaks-precommit] (the local clone's hook, present — not proven by a blocked commit) [org-baseline] [account-2fa].
- **Naming lifecycle:** private and in development → a random name unrelated to product, client or folder (`adjective-noun-NNN`; the audit suggests one). At launch, when the repo goes public, rename it to the product name (`gh repo rename`, then `git remote set-url` in every clone; GitHub's redirect is not to be relied on).
- **Minutes:** [plan-minutes] reports this month's usage of the owner (SKU `Actions Linux` only — storage is not minutes); from 80% of the included minutes the report prints a bold line: used, limit, remaining until the reset, month-end projection, and the budget left before Actions stops. Past 80% with no budget is a FAIL (Actions stops at the quota).

## Budget arithmetic (do it before adding or widening a job)

- Billed minutes = per job, rounded UP to a whole minute; skipped jobs bill 0. A 20 s job bills 1. Matrix legs each bill their own setup.
- Per code PR lifecycle ≈ draft pushes × cheap jobs + 1 full ready run + main push + deploy. The audit prints the measured full-PR and main-push figures from the latest green runs.
- The expensive jobs are a fixed cost per PR, so PR COUNT is the budget: batch small code changes into one PR. Local tiers save the red runs and reruns, not the one green run a required check still costs.
- Plan limits (GitHub Team, private repos): no environment wait timers or required reviewers (Enterprise-only), no secret scanning or push protection (paid Advanced Security) — hence deploys gated on CI jobs and gitleaks in hook + CI.
- Monthly ≈ (code PRs/month × lifecycle) + (docs PRs × cheap) + schedules, summed over EVERY repo on the same quota. Compare with the quota (Team: 3,000 Linux min/month, shared across the ORG), then verify with `gh api orgs/<org>/settings/billing/usage`.
- Then convert to dollars: an excess standard Linux minute costs about US$0.006 (included compute: $12 Free, $18 Pro/Team). October 2026's 2,612-minute overrun ≈ US$16, so a budget with "Stop usage" on (e.g. US$20) is cheaper than engineering time spent batching PRs. Minutes decide whether CI stops; dollars decide whether an optimisation is worth doing.
- Measured 2026-11-01: project A 22 min per full PR, 4 per main push, 4 per deploy; project B 27 / 1 / 2. Measured 2026-10: one repo burned ~5,800 min/month, 84% of it one browser-test job, and 60% of its runs "failed" only because the quota ran out; the org used 5,612 Linux minutes of its 3,000 for October (2026-11-01 read; the 5,786 total of that reply adds 174 GB-hours of Actions STORAGE — sum the `actions_linux` SKU only when counting minutes).

## Procedure for a CI change

1. Audit (above). Note the FAILs you are not fixing and why.
2. Make the change in a fresh worktree off the default branch (CLAUDE.md §3). Open the PR as a DRAFT.
3. Locally: the repo's fast tier, then its full run on the clean tree (writes the stamp). Behavioural tests for anything in the hook / stamp / classifier / deploy-scope, each with a negative control seen to fail.
4. Push the draft (cheap jobs only). Then mark ready ONCE via the mark-ready script; the ready run is the full one. Put the local results in the PR body.
5. A deploy-workflow or deploy-CLI change: one `workflow_dispatch target=preview` on the PR branch before merging, health checked. A runtime-version change: flip the hosting platform's setting first, read it back, then the preview, and confirm the version from its build log.
6. A required-check change: edit `required-checks.json` and run the protect script's dry-run; then apply by DIRECTION (see "When to apply" above) — removing or renaming a check: `--apply` from the PR's tree BEFORE the merge; adding one: `--apply` right AFTER the PR that makes the new job report has merged. Keep an old check required until its replacement reports. Read back.
7. Re-run the audit. Pre-flight: re-read the design list above against the diff; every FAIL is fixed or recorded with the owner's decision.
