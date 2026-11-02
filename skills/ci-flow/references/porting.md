# Porting the ci-flow design to a repository

Load before setting up CI on a repo that has none, or copying any piece of
this design between repos. Copy SHAPES from an existing implementation
(project A or B, or the fixture in `../../tests/audit.test.ts`), never a file
wholesale: every one of them names its own repo, paths and suites.

## 0. Before you start

- Run the audit on the target and keep the output; it is the before picture.
- Read the target's CLAUDE.md / CI docs for decisions that override a line of
  the design (a job deliberately not draft-gated, a classifier exception).
  Record each override beside the code, not only in the PR.
- Work in a fresh worktree off the default branch; open a DRAFT PR.

## 1. Files, and what to rename in each

| Piece | Typical path | Rename / adapt |
|---|---|---|
| Classifier | `scripts/ci/scope.mjs` | the doc globs (`*.md`, `docs/`…), the source dirs scanned for doc readers, the browser path regex |
| CI workflow | `.github/workflows/ci.yml` | job names (they become required checks), the scope job id in every `if`, pins (`bun-version`, `node-version`), cache keys, gitleaks version + sha256 |
| Required list | `.github/required-checks.json` | the non-matrix job names that must always report |
| Protect script | `scripts/ci/protect-main.sh` | `REPO=<owner>/<repo>`, `BRANCH`, keep `APP=15368` |
| Hook | `.githooks/pre-push` + an install script setting `core.hooksPath` | runner path, stamp path; keep `--local-env-vars`. If `core.hooksPath` is set, the hooks dir must also carry (or chain to) the gitleaks pre-commit (POLICY.md §1) |
| Local runner | `scripts/ci-local.sh` (`fast`/`docs`/`code`) | the steps, mirroring ci.yml job by job; pin reads for bun AND node |
| Stamp | `scripts/ci/stamp.sh` | stamp dir name under the git common dir; the suite list (runner, workflow, classifier, hook, itself) |
| Mark-ready | `scripts/ci/mark-ready.sh` | none beyond paths |
| Deploy scope | `scripts/ci/deploy-scope.sh` | classifier path |
| Deploy workflow | `.github/workflows/deploy.yml` | environment names, the sha meta name (`<project>Sha`), the CLI dir, the health URL |
| Locked CLI | `tools/<cli>/package.json` + `package-lock.json` | exact CLI version; generate the lock with npm and commit it |
| Dependabot | `.github/dependabot.yml` | ecosystems in use, the CLI dir, groups |
| Tests | wherever the repo keeps them | gate test, required-checks replay, toolchain pin, protect-main (fake gh), hook/stamp/mark-ready behaviour, deploy-scope, CLI lock, step order, `cleanEnv` helper |

The sha meta name must be the same in the token job's read and the deploy's
`--meta`; a mismatch reads as "no live sha" and deploys every time (safe, but
the docs skip never fires).

## 2. Order

1. Classifier + its tests (unknown → code, deleted doc → code, comment mention ≠ read).
2. CI workflow: cheap job first, then the gated jobs, then the aggregate for any matrix. Gate tests with negative controls.
3. Toolchain pins + pin test + local runner refusal.
4. Hook, stamp, mark-ready, `cleanEnv`; the real-push `.git/config` test.
5. Deploy split, deploy-scope, locked CLI, sha meta.
6. Dependabot.
7. **Protection LAST**, after the PR that makes every required job exist and
   report has merged: a required name that never reports blocks every merge.

## 3. Verification (each step must be SEEN, not assumed)

1. Local full run on the clean tree: `scripts/ci-local.sh code` → stamp written.
2. A fast-tier push of the draft: the hook ran the fast tier (its output is in the push log).
3. Draft CI run: only the cheap jobs ran; every expensive job shows "skipped".
4. Mark ready via the mark-ready script: refused without a stamp (try it once on an unstamped head), accepted with one; the ready run executes every job.
5. A docs-only draft: the classifier says `docs`, expensive jobs skip, required checks all report.
6. Preview deploy: `gh workflow run deploy.yml --ref <branch> -f target=preview`; health URL answers; the deployment carries the sha meta.
7. Protect script: `--dry-run` shows the intended diff against live; `--apply`; read back equal; audit `protection-live` and `protection-matches-declared` pass.
8. Audit `--strict` on the merged default branch; each remaining FAIL has a recorded owner decision.
9. Budget: the audit's billed-minutes lines × expected PRs/month against the org quota (SKILL.md, Budget arithmetic).
