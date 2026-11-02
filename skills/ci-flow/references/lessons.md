# ci-flow lessons — every failure found 2026-10-31 … 2026-11-01

Load before changing a hook, a stamp, a gate, a deploy workflow or a test that
spawns git, and whenever a CI run is red. Each entry: symptom, cause, the
guard that now catches it. "Project A" and "project B" are the two repos the
design was built in. Where a guard is named by shape rather than file, the
repo you are in may call it something else — find it, or add it.

## Gates and required checks

**1. A required matrix job made docs and draft runs unmergeable.**
- Symptom: a docs-only PR waited forever on `engine (source, comparator)` and three siblings.
- Cause: a matrix job skipped by its job-level `if:` reports ONE check under its unexpanded name (`engine (${{ matrix.code }}, …)`), never the expanded leg names, so a required leg name never reports.
- Guard: legs are not required; an aggregate job (`needs` the matrix, `if: always() && needs.<m>.result != 'skipped'`, fails unless every leg succeeded) is. A test replays the job graph per event and asserts every required name reports. Audit: `matrix-aggregate`.

**2. `!github.event.pull_request.draft` alone reran every expensive job after each merge.**
- Symptom: ~11 of ~25 billed minutes per PR spent again on the push to main.
- Cause: on a `push` event there is no `pull_request`, so `!…draft` is `!null` = true.
- Guard: the gate is `github.event_name == 'pull_request' && !github.event.pull_request.draft && <scope>`; a test parses the workflow and asserts both halves, with a negative control. Safe only with strict protection (the PR tested the merged tree). Audit: `expensive-gated`, `gate-tests`.

**3. A restore file with `required_pull_request_reviews: null` dropped the PR requirement.**
- Symptom: after lifting and restoring protection, the restored rule no longer required a pull request.
- Cause: branch protection PUT replaces the whole rule; a saved body carrying `reviews: null` restores "no PR required".
- Guard: the protect script builds the body from the tree, always restating a PR requirement (0 approvals), and diffs the read-back field by field; a fake-gh test pins the body. Audit: `protect-script`, `protection-live`.

**4. Prose said nine checks were required; the live rule required none.**
- Symptom: `checks: []`, `strict: null` while the docs claimed the opposite.
- Cause: the required list lived only in prose, so nothing compared it with GitHub.
- Guard: `.github/required-checks.json` + protect script + audit `protection-matches-declared`.

**5. A step before `actions/checkout` died with "No such file or directory".**
- Symptom: an aggregate job's first step (deliberately before checkout, to fail without paying for one) failed on every run.
- Cause: `defaults.run.working-directory` applies to every `run:` step, including one placed before the checkout, when that directory does not exist yet.
- Guard: a test over the PARSED workflows: no `run:` before the checkout may resolve inside the repo (`.`, an expression or an absolute path is fine). Neither the job-graph simulator nor the local runner can see this.

**6. A docs-only skip at STEP level still billed a runner.**
- Cause: the job started, ran setup, skipped its steps — a whole billed minute minimum per job.
- Guard: skip in the job's `if:` on the classifier's output; a skipped job bills 0 and counts as passed. Audit: `expensive-gated` (requires the scope condition in the job `if`).

**7. The dependency audit ran only on ready PRs.**
- Symptom: two red runs on the same three advisories, invisible to every draft before them.
- Cause: the audit step lived in a gated job (or carried a docs `if:`).
- Guard: audit in the cheap ungated job, no `if:`. Audit: `audit-ungated`.

## Local tiers, stamps and git

**8. A leaked `GIT_DIR` let tests rewrite the real `.git/config` during a push.**
- Symptom: after an ordinary `git push`, the clone had `core.bare=true`, `core.hooksPath=/dev/null` and a fake identity.
- Cause: a hook exports `GIT_DIR` (a push from a worktree sets it) and friends; the hook ran the suite; a test's `git init`/`git config` in its temp repo acted on the real repo. Unsetting only `GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE` misses `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY` and others.
- Guard: the hook runs `unset $(git rev-parse --local-env-vars)`; a shared `cleanEnv()` test helper deletes every `GIT_*` and sets `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; a test does a real `git push` to a scratch bare remote with `GIT_DIR`/`GIT_COMMON_DIR` leaked and compares `.git/config` sha256 before/after, with the old 3-variable unset as the negative control. Audit: `hook-strips-git-env`, `tests-hermetic-git`.

**9. `PATH=x:/usr/bin:/bin` did not hide `gh` on the Ubuntu runner.**
- Symptom: a "gh missing → treat as READY" test passed locally and failed in CI.
- Cause: `gh` is installed at `/usr/bin/gh` on GitHub's Ubuntu image (on macOS it lives under Homebrew), so the "minimal" PATH still had it.
- Guard: tests build PATH from a private bin dir of symlinks to exactly the tools needed, never from system dirs.

**10. `git merge-base origin/main HEAD` exited 128 in CI.**
- Cause: `actions/checkout` defaults to depth 1 on a detached HEAD with no `origin/main` ref, so there is no base to find.
- Guard: scripts that need a base take the range as an argument and REFUSE by name when `origin/main` is absent ("fetch it, or pass the range"); CI passes the range explicitly; jobs that classify use `fetch-depth: 0`. Never let an empty range read as a clean scan.

**11. A stamp did not cover the classifier (and in project B, the hook).**
- Symptom: editing the classifier or the hook left earlier full-run stamps valid.
- Cause: the stamp's suite hash listed the runner and workflow only.
- Guard: the hash covers runner, workflow, classifier, hook and the stamp script itself, read at the stamped commit; a test edits each hashed file and asserts the old stamp no longer admits. Audit: `stamp-covers-suite`.

**12. A failed `mktemp` made a test write into the clone.**
- Cause: `t="$(mktemp -d)"` with no check; `git -C "" config` then targets the current repo.
- Guard: `t="$(mktemp -d)" || exit 1` in every stand-in script.

**13. A green bun/node mismatch locally, red in CI.**
- Cause: the local runner warned instead of refusing, or checked bun but not node.
- Guard: read both pins from the workflow and refuse on mismatch, before any stage; a test refuses `latest`, a bare major and two pins. Audit: `toolchain-exact`, `toolchain-guard-test`, `local-refuses-bun`, `local-refuses-node`.

**14. vitest passed what tsc rejects.**
- Symptom: 27 real type errors in test files, every test green.
- Cause: vitest/bun strip types without checking them, and `tsconfig` excluded `test/**` and `*.test.ts`, so `tsc --noEmit` checked none of the test code either.
- Guard: typecheck covers the tests (the type packages the tests need are declared where tsc sees them), and the typecheck is in the fast tier and the cheap CI job.

**15. Fixed waits made a browser test flaky.**
- Symptom: intermittent failures on a scroll-reveal assertion.
- Cause: a fixed 900 ms sleep raced the reveal animation on a slow runner.
- Guard: wait on the condition (the attribute or computed style the script sets), never on a duration.
- Same defect, other form: `waitForLoadState("networkidle")` as a hydration gate held a CI runner past 30 s after "load" (4/4 local, green on rerun). Wait for the framework's own marker (React: `__reactProps$` on the controls) and add a scripts-off control that must time out — a gate that cannot fail passes at every call site.

**15b. A version pin that the local runner refuses forces a second node on the machine.**
- Guard: the runner reads the pin and puts Homebrew's keg-only `node@<major>/bin` first on PATH when it exists, then refuses a mismatch naming `brew install node@<major>`. The test points `HOMEBREW_PREFIX` at its private dir, or the host's real keg answers for the fake.

## Deploy

**16. A `HEAD^1..HEAD` docs-skip kept code off production.**
- Cause: the deploy concurrency group REPLACES a pending run with a newer one, and a failed code deploy is not retried, so code merge A then docs merge B left B's run alone, which judged B only and skipped.
- Guard: every deploy records `--meta <name>Sha=<sha>`; a secret-free scope job classifies `<live sha>..HEAD`, deploying on unreadable/non-ancestor/shallow; a test of "code deploy replaced or failed, then docs merge", plus a falsification showing `HEAD^1` skips. Audit: `deploy-live-range`, `deploy-sha-meta`.

**17. `env -u TOKEN` did not isolate repo code from the token.**
- Cause: a step running commit code can read a sibling step's environment, or poison later steps via `$GITHUB_ENV`, `$GITHUB_PATH`, `$RUNNER_TEMP`.
- Guard: three jobs — token job runs no repo code (`permissions: {}`, no checkout); scope job holds no secret; deploy job. A guard asserts the workflow contains no `env -u <TOKEN>`. Audit: `deploy-split`.

**18. `npx vercel@<version>` floated every transitive dependency beside the token.**
- Guard: committed lockfile dir, `npm ci --ignore-scripts`, a jq check that every `resolved` is on `registry.npmjs.org` with an `integrity`; Dependabot `npm` entry for that dir. Audit: `deploy-cli-locked`, `dependabot-ecosystems`.

**19. Vercel CLI ≥ 65.4 runs a prebuilt native binary.**
- Fact: the launcher runs `@vercel/vc-native-linux-x64` (pinned by the lock). If that package is ever absent it downloads it at run time WITH THE TOKEN PRESENT, checked against the registry's sha512 rather than the lock.
- Guard: prove each CLI bump with one `workflow_dispatch target=preview` on the PR branch before merging; health-check the preview. Treat a missing native package in the lock as a blocker.

**20. Dependabot security updates never came for the JavaScript.**
- Cause: the dependency graph does not parse `bun.lock`, and Dependabot's `bun` ecosystem supports version updates only. Alerts read zero while two critical advisories applied.
- Guard: `bun audit` (it reads the lockfile) in the cheap job; Dependabot `bun` for version drift; never infer coverage from "zero alerts". A Dependabot security job failing with "updater encountered an error" on the CLI dir: re-check alerts after the bump merges and read the alert it acted on.

**21. The deploy CLI's own tree carried every Dependabot alert, and a CLI bump fixed none.**
- Measured: 43 alerts (1 critical tar), all in the CLI lock dir; the newest `vercel` resolved the same versions; `npm audit fix` proposed a DOWNGRADE.
- Guard: `overrides` keyed `name@^major` → patched version inside that major (proved by `npm ci --ignore-scripts`, `vercel --version`, the lock test, a preview and the production deploy); alerts needing a major jump inside the vendor's packages dismissed `tolerable_risk` with the reason on the alert; both revisited on every CLI bump, and an override the new tree satisfies is deleted.

**22. Changing the hosting runtime version: flip the platform setting BEFORE the preview.**
- Cause: the platform builds remotely from its project setting, so a preview of a pin change built before the flip tests the old runtime. The build log line "Node.js version changed from X to Y" is the evidence it took.
