# CI and repository policy (every project, every agent)

The one source of these rules. `~/.claude/CLAUDE.md` and both `AGENTS.md`
files point here; nothing else restates them. The ci-flow skill (`SKILL.md`
beside this file) carries the reference design that implements §1, and
`scripts/audit.ts` checks a repository against both sections.

**When this applies:** before any git or GitHub action that changes state:
commit, push, PR create / ready / merge, repo create / rename / transfer /
visibility / settings, branch protection or rulesets, and any edit to
`.github/workflows/*`, `.github/dependabot.yml` or
`.github/required-checks.json`. Read-only git (`status`, `log`, `diff`,
`fetch`) and read-only `gh api` GETs do not.

**Run first:**
- Before `gh repo create`: `bun ~/.claude/skills/ci-flow/scripts/audit.ts --owner <login>`. It shows the plan, what a new private or public repo gets, the repo counts, this month's minutes and a random development name.
- Before and after a CI or settings change: `bun ~/.claude/skills/ci-flow/scripts/audit.ts <repo-path>` (`--config-only` for a repo with no CI). It only reads; the fixes it prints are never run.

## 0. Owner decisions (2026-11-02)

- **The personal account stays on Free.** Its private repos run CI without enforced protection.
- **A private repo moves to the Team org** when it gains a deploy credential or an expensive required job. The owner decides each move.
- **Team org Actions budget: US$20/month, "Stop usage" on.** Overrun is paid up to that, then Actions stops. An excess Linux minute costs about US$0.006, so October's 2,612-minute overrun was about US$16.
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
  - Update from the default branch once, right before merging.
  - Preview deploys come after this, never instead of it.

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
  - Confirm the plan includes any GitHub feature before relying on it; the audit's plan rows say what each plan gives each visibility.
- **Every repo runs `gitleaks git --pre-commit --staged` before each commit, failing closed.**
  - Prove it with one blocked fake-secret commit before trusting it.
  - On this Mac the global hook is `~/.claude/git-hooks/pre-commit`, installed via `init.templateDir`.
  - A repo that sets `core.hooksPath` carries gitleaks in its own tracked hook, or chains to `.git/hooks/pre-commit`.
- **The cheap CI job scans the commit range with the pinned, sha256-checked gitleaks binary** (not `gitleaks-action`, which is paid for orgs). This is the backstop for `--no-verify`. Scan the range, never the full history.

**Protection and budget**
- **Protect the default branch as soon as CI gates anything, in the same change:**
  - required checks = the CI job names pinned to `app_id` 15368;
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
  - The audit's minutes line does this and warns past 80%.

## 2. Repository configuration: security and privacy

Repo settings live outside the tree, so nothing reviews them unless a rule names them.
- **Check them** when a repo is created, transferred, changes plan or changes visibility. Run `audit.ts`.
- **Read back each one** with `gh api` rather than trusting the PUT.
- **Re-read a setting whenever a document claims it.** On 2026-10-31 a repo's CLAUDE.md named nine required checks on its default branch, while the live rule had none.

**Visibility and names**
- **Visibility is a one-way door.** Private by default.
  - Going public publishes the full history: every commit, deleted file and old secret.
  - Clones and forks survive switching back.
  - Before any switch to public:
    - a full-history `gitleaks git` scan with zero findings, or each finding rotated;
    - no client or personal data in history;
    - the owner's explicit decision.
- **A secret that ever reached a commit is rotated, not just deleted.** Rewriting history does not un-leak it: forks, clones, caches and PR refs keep it.
- **Names leak too.** A private repo under development gets a random name unrelated to the product, client or folder (`audit.ts --owner` suggests one). Once it goes public the product name is out anyway, so the repo is renamed to it, and `git remote set-url` runs in every clone.
- **Folder prefixes are the owner's private labels, never repo content.**
  - The owner keeps the list in a local config (`~/.config/ci-flow/private-prefixes`), never in a repo.
  - They never appear in a repo's name, README, package names, docs, commit messages or URLs.
  - Derive names from the project, never from the folder. This applies at creation and to every file written later.

**Plans and privilege**
- **Know what the plan gives each visibility.**
  - Public repos get secret scanning, push protection, wait timers and required reviewers free.
  - Private repos on Free, Pro and Team get none of them; §1 gitleaks covers the gap.
  - Branch protection, rulesets and environments on private repos need Pro or Team or above.
  - Re-check after any plan or org change: protection that silently stops applying looks exactly like protection that works.
- **Least privilege everywhere:**
  - Workflows declare `permissions: contents: read` at the top and widen per job only where needed.
  - Deploy credentials are ENVIRONMENT secrets, on an environment whose branch policy allows the default branch only.
  - **A job that holds a deploy token runs no repository code.** A decision that needs the code runs in its own job with no secrets, and hands the token jobs an output. Unsetting the token for one subprocess is not isolation.
  - Pin third-party actions to a full commit SHA with the version in a comment, and enforce SHA pinning in the Actions policy once every workflow is pinned.
  - Never use `pull_request_target` with a checkout of the PR head.
  - Pass untrusted `${{ github.event.* }}` text to `run:` through `env:`, never inline.
  - Fork PRs get no write token and no secrets.

**Always on**
- **Public-repo extras:**
  - require approval before workflows run for outside contributors;
  - a `SECURITY.md` with a private reporting channel;
  - private vulnerability reporting enabled.
- **Always on, any visibility:**
  - Dependabot alerts and security updates;
  - a dependency audit in the cheap CI job with no severity threshold (exemptions only by advisory id, with a reason);
  - `.github/dependabot.yml` for the ecosystems in use, plus `github-actions` grouped;
  - artifact and log retention ≤ 30 days.
- **An alert inside a vendored tool's tree** (a deploy CLI):
  - `overrides` to the patched version inside the same major;
  - one that needs a major jump inside the vendor's packages is dismissed with the reason written on the alert;
  - both are revisited on every bump of that tool.
- **Default-branch hygiene:**
  - no force-push and no deletion on the default branch;
  - merged branches deleted automatically;
  - one merge method per repo.

**People and data**
- **Collaborators, apps and keys:**
  - the fewest members, apps and OAuth grants the work needs; remove any that finished their job;
  - deploy keys read-only;
  - webhooks on https with a secret;
  - a token is scoped to one repo and the narrowest permission, and lives in 1Password, never in the tree.
- **Org baseline:**
  - 2FA required;
  - members cannot create public repositories;
  - base permission `read`;
  - fine-grained PATs only, with a maximum lifetime;
  - one owner reads the org audit log monthly.
- **Privacy of the content:**
  - no real personal data in fixtures, seeds, screenshots or logs committed to any repo, private included;
  - commit author email is the GitHub noreply address.

**One-way doors**
- **Recreating a repo clean (delete + recreate) is a one-way door.** The owner confirms it in that project's session, after seeing the inventory. Steps, in order:
  1. **Land or close every open PR.** Deletion takes issues, PRs, Actions history and stars with it.
  2. **Inventory what lives outside the tree** with `gh api`, saved to `~/.claude-backups/<repo>-settings-<date>.md`:
     - environments and their branch policies;
     - secret NAMES and variables (values cannot be read back; confirm each is in 1Password first);
     - branch protection, Dependabot and security settings, Actions permissions;
     - webhooks, deploy keys, collaborators, linked apps.
  3. **Mirror backup:** `git clone --mirror` (plus `git lfs fetch --all` if the repo uses LFS) to `~/.claude-backups/<repo>-mirror-<date>/`, then `stat` it.
  4. **Clean the tree:** take out prefixes and leaked names, move large media to the NAS and `.gitignore` it, then run a full `gitleaks dir .` with zero findings.
  5. **New history:** a fresh single initial commit from the cleaned tree by default. Use `git filter-repo` only if the owner wants history kept, and then run gitleaks over the rewritten history too.
  6. **Delete, then recreate private** under a neutral name (needs `gh auth refresh -s delete_repo`):
     - push;
     - re-apply every setting and read each back;
     - re-link integrations;
     - run CI and verify a deploy.
  7. **Delete and re-clone every old clone and worktree.**
- **Transfers:** after moving a repo between owners:
  - re-check environments, secrets, branch protection, Dependabot, Actions permissions, webhooks and linked apps (a hosting platform's Git link may need the new owner's app install);
  - `git remote set-url` in every clone (never rely on the old URL's redirect);
  - run `audit.ts`, because the new owner's plan and policies now apply.
