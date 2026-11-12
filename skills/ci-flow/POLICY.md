# CI pipeline policy (every project, every agent)

The one source of these rules. `~/.claude/CLAUDE.md` and both `AGENTS.md`
files point here; nothing else restates them. The ci-flow skill (`SKILL.md`
beside this file) carries the reference design that implements §1, and
`scripts/audit.ts` checks a repository against §1 and its Dependabot rules.

**When this applies:** before any git or GitHub action that changes state:
commit, push, PR create / ready / merge, branch protection or rulesets, and any edit to
`.github/workflows/*`, `.github/dependabot.yml`,
`.github/required-checks.json` or `.github/ci-flow.json`. Read-only git (`status`, `log`, `diff`,
`fetch`) and read-only `gh api` GETs do not. Repository create / rename / transfer /
visibility / settings belong to repo-create (`~/.claude/skills/repo-create/POLICY.md`).

**Run first:**
- Before and after a CI change: `bun ~/.claude/skills/ci-flow/scripts/audit.ts <repo-path>`. It only reads; the fixes it prints are never run.

## 0. Owner decisions (2026-11-02)

- **Owner decisions on plan, account and budget:** repo-create's POLICY.md §0.
- **Add-ons are adopted per repo** and declared in `.github/ci-flow.json` (`{"addons": [...]}`):
  - `gated-expensive`
  - `classifier`
  - `local-stamps`
  - `deploy`
  - A repo without the file is audited against the full design.

## 1. CI/CD economy (GitHub Actions)

Private-repo minutes are metered against the plan quota (Free 2,000; Pro and Team 3,000 Linux min/month, Team's shared by every repo in the org). When it runs out, CI stops unless a budget pays the excess. Every workflow you write or touch must follow the rules below.

**Triggers, skipping and gating**
- **Trigger once per change:** `push` only on the default branch; branches run via `pull_request`. Never both for one commit.
- **Cancel superseded runs:** workflow `concurrency` keyed on `github.ref` with `cancel-in-progress: true`. Deploy workflows keep the group but set `cancel-in-progress: false`.
- **Skip non-code changes at JOB level** (`if:` on the cheap job's output; when unknown, run). Never use workflow-level `paths-ignore` on a workflow that provides a REQUIRED check: a workflow that never starts leaves the check pending forever.
- **The docs/code decision is ONE tracked script** that CI, the pre-push hook and the local full run all call.
  - A file is docs only if nothing a test or build runs reads it.
  - That set is derived from the tree, never a hand list.
- **A docs-only merge does not deploy.** Judge it over the range from the commit LIVE in production to HEAD, never `HEAD^1..HEAD`. When the live commit cannot be read, deploy.
- **Gate expensive jobs (browser, e2e, integration)** with `github.event_name == 'pull_request' && !github.event.pull_request.draft` plus the scope condition:
  - add `ready_for_review` to the PR types;
  - add `needs:` on the cheap checks;
  - the `!draft` half alone is TRUE on a push.
- **The dependency audit and the range secret scan run in the ungated cheap job**, so drafts and docs-only changes get them too.
- **Do not rerun expensive jobs on the default-branch push only while strict protection requires them.** Without that protection the rerun is the only test of the merge result, so set the protection first.

**Local testing and PR flow**
- **Test locally before CI pays, and a PR goes ready only once** (owner, 2026-10-23):
  - open every PR as a draft;
  - the pre-push hook runs the fast tier on every push;
  - the full-run script replicates every job of a ready PR on the final head;
  - both fail CLOSED.
- **A full-run record is keyed by tree sha and hashes the suite's own files.**
  - Pushing to a ready PR, or marking it ready, is refused without one.
  - It is a local gate, never a reason for CI to skip anything.
- **Mark ready only when nothing more is coming, with the local results in the PR body.**
  - Docs and fix-ups go in while the PR is still a draft.
  - **Bring the PR up to date with the default branch BEFORE marking it ready** (owner, 2026-11-09); the mark-ready script refuses a head that does not contain `origin/<default>`. The one ready run is then the last unless the default branch moves. Updating after ready bought a second full run (kintag: 9 of 19 PRs ran the full suite twice, 5 of them from merging main after ready; ~23 billed min each).
  - Preview deploys come after this, never instead of it.
- **Release order, every change, every project (owner, 2026-11-07):**
  1. deploy the branch to preview;
  2. check that preview: the `preview-qa` status (deployed, smoke probes passed) and the local full run on the same head, which is the QA beyond the probes;
  3. merge only if both are green (a red or partial result blocks the merge);
  4. deploy to production;
  5. run smoke tests on production.
  - Report each step's result separately; a skipped step is reported as skipped.
- **A failed production smoke test restores the previous deployment automatically**, except after a migration. The run still exits 1. Mechanics: SKILL.md, Deploy.
  - **Migrations (DECIDED, owner, 2026-11-08):** when `<live>..HEAD` touches the migrations directory, or the range is unreadable or the scope job skipped, a failed production verify does NOT restore (the old build may not run against the new schema); it prints `::error::` with the manual steps and exits 1.
  - Manual production dispatches never auto-restore.
- **The preview result is a required check (owner, 2026-11-08; wording 2026-11-09):**
  - `preview-qa` certifies that the preview deployed and its smoke probes (alias, health, app probes) passed, NOT the full QA suite;
  - a commit status posted only by a successful preview deploy, never a job (a skipped job reports as passed);
  - listed in `required-checks.json` and applied with `--apply` right AFTER the merge that adds it (adding a check);
  - so every PR, docs-only and Dependabot's included, needs a preview dispatch before it can merge (owner, 2026-11-09: kept on every PR).

**Bounds and toolchain**
- **Bound every job:**
  - `timeout-minutes` on each job;
  - cache dependencies;
  - short `retention-days` on artifacts;
  - schedules at the lowest useful frequency.
- **Pin the toolchain CI runs exactly** (`bun-version`, `node-version`; never `latest` or a bare major) **in every job that runs it.** The local runner refuses a mismatch.
- **One runtime pin, three places:** CI, the local runner and the hosting platform change in one PR. Flip the platform setting before the preview, and confirm it from the preview's build log.

**Red runs**
- **Red CI is a defect, not noise.** Fix the cause; never re-run until green.
  - Check billing first: usage exactly at quota means Actions stopped.
  - Classify every red run and name the local tier that should have caught it.
  - A class no local tier can catch gets a CI-side fix, not a retry.
- **The one rerun allowed:** the same suite passes ≥3 times locally on the pinned toolchain. Then:
  - rerun only the failed job, once;
  - write the classification on the PR;
  - put the test's fix in the next code PR.
  - A second red of that kind is a defect.

**Plan limits and secrets**
- **Use only what the plan includes.** On Team, private repos have:
  - no environment wait timers or required reviewers;
  - no secret scanning or push protection (both paid add-ons).
  - So gate deploys on a passing CI job.
  - Confirm the plan includes any GitHub feature before relying on it; repo-create's audit plan rows say what each plan gives each visibility.
- **Every repo runs `gitleaks git --pre-commit --staged` before each commit, failing closed.**
  - Prove it with one blocked fake-secret commit before trusting it.
  - On this Mac the global hook is `~/.claude/git-hooks/pre-commit`, installed via `init.templateDir`.
  - A repo that sets `core.hooksPath` carries gitleaks in its own tracked hook, or chains to `.git/hooks/pre-commit`.
- **The cheap CI job scans the commit range with the pinned, sha256-checked gitleaks binary** (not `gitleaks-action`, which is paid for orgs). This is the backstop for `--no-verify`. Scan the range, never the full history.
- **No personal data reaches a repo, private included (owner, 2026-11-11).** The same hook, failing closed, blocks:
  - any email address except `*@users.noreply.github.com`, `noreply@github.com` and example.com / .org / .net / .invalid;
  - phone numbers, narrowly (`+` and 7–15 digits, `(ddd) ddd-dddd`, `ddd-ddd-dddd`), so versions, shas, timestamps and ids pass;
  - the owner's denylist: exact strings (full names, personal emails, postal address, phone), case-insensitive;
  - a commit whose author or committer email is not noreply, or whose name is on the denylist.
  - Allowed: the owner's real name on a line containing `Copyright` and in `LICENSE*`; the GitHub login everywhere. So the denylist holds full names, never a bare surname: the login contains it.
  - The denylist lives in `~/.config/pii-guard/denylist`, mode 0600, one string per line, and never enters a repo, PR body, commit message, fixture or report. Missing, unreadable, empty or wider than 0600: the commit is refused.
  - Email and phone rules: gitleaks `[extend] useDefault = true` plus PII rules, in `~/.claude/git-hooks/pii-gitleaks.toml` and, for CI, a tracked `.gitleaks.toml` at the repo root.
  - Prove it with one blocked fake-email commit before trusting it. Tests use invented names in a temp denylist (`PII_GUARD_DENYLIST`). Report hits as file:line and counts, never the value.
- **The cheap CI job is the PII backstop over the same range:** the scan loads `.gitleaks.toml` (email, phone), and a step refuses any author or committer email in the range that is not noreply. CI cannot see the denylist.

**Protection and budget**
- **Protect the default branch as soon as CI gates anything, in the same change:**
  - required checks = the CI job names pinned to `app_id` 15368, plus any deploy-posted commit status (`preview-qa`, above);
  - `strict: true`, admins included;
  - no force-push, no deletion;
  - set by one PUT that restates every setting, then read back.
  - Tell the owner: with admins included, a billing stop blocks every merge.
  - A repo with no gating CI needs none of this yet.
- **Budget before adding a job:**
  - minutes per PR by job (measured from green runs) × PRs per month;
  - summed over every repo on the same quota;
  - converted to dollars (about US$0.006 per Linux minute beyond the quota);
  - weighed against the budget.
  - Verify with `gh api orgs/<org>/settings/billing/usage` or `users/<user>/settings/billing/usage`.
  - ci-flow's audit prints the measured minutes per run; repo-create's `plan-minutes` check warns past 80%.

## 2. Repository configuration

Moved to repo-create: `~/.claude/skills/repo-create/POLICY.md` §1 (visibility and names, plans and privilege, always-on settings, licensing, people and data, one-way doors). ci-flow's audit still checks the Dependabot rows.
