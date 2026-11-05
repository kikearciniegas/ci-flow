// Falsification suite for skills/ci-flow/scripts/audit.ts:  bun test tests/
//
// A synthetic repository that implements the whole reference design must
// PASS every check; then each check gets a mutation of that repository which
// must flip exactly that check to FAIL. A check no mutation can fail is
// vacuous, and this file is where that would show. GitHub is a fake `gh` on
// PATH serving canned JSON, which also records every call so the suite can
// assert the audit never writes.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const AUDIT = join(import.meta.dir, "../skills/ci-flow/scripts/audit.ts");
const ROOT = mkdtempSync(join(tmpdir(), "ci-flow-audit-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// Hermetic: a leaked GIT_DIR (a hook, a worktree) would point every git call
// below at the caller's repository.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
// A fake private prefix, so the repo-name check is tested without the owner's real list.
writeFileSync(join(ROOT, "prefixes"), "acme_\n");
ENV.CI_FLOW_PREFIXES_FILE = join(ROOT, "prefixes");

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const BASE: Record<string, string> = {
  ".github/workflows/ci.yml": `name: CI
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  cheap:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      scope: \${{ steps.scope.outputs.scope }}
    steps:
      - uses: actions/checkout@${SHA} # v7
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@${SHA} # v2
        with:
          bun-version: 1.4.4
      - uses: actions/setup-node@${SHA} # v7
        with:
          node-version: 22.23.4
      - uses: actions/cache@${SHA} # v6
        with:
          path: ~/.bun/install/cache
          key: bun
      - name: secret scan
        run: |
          v=8.30.1
          curl -fsSL -o gl.tgz "https://github.com/gitleaks/gitleaks/releases/download/v$v/gitleaks_\${v}_linux_x64.tar.gz"
          echo "abc  gl.tgz" | sha256sum -c -
          ./gitleaks git --log-opts="$RANGE" .
      - id: scope
        run: echo "scope=$(node scripts/scope.mjs "$RANGE")" >> "$GITHUB_OUTPUT"
      - run: bun install --frozen-lockfile
      - run: bun audit
  unit:
    needs: cheap
    if: \${{ github.event_name == 'pull_request' && !github.event.pull_request.draft && needs.cheap.outputs.scope != 'docs' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      matrix:
        part: [a, b]
    steps:
      - uses: actions/setup-node@${SHA} # v7
        with:
          node-version: 22.23.4
      - run: npm test
  unit-count:
    needs: [cheap, unit]
    if: \${{ always() && needs.unit.result != 'skipped' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: test "\${{ needs.unit.result }}" = success
  browser:
    needs: cheap
    if: \${{ github.event_name == 'pull_request' && !github.event.pull_request.draft && needs.cheap.outputs.scope != 'docs' }}
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/setup-node@${SHA} # v7
        with:
          node-version: 22.23.4
      - uses: actions/cache@${SHA} # v6
        with:
          path: ~/.cache/ms-playwright
          key: pw
      - run: npx playwright test
  warm-browsers:
    if: \${{ github.event_name == 'push' }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/setup-node@${SHA} # v7
        with:
          node-version: 22.23.4
      - uses: actions/cache@${SHA} # v6
        with:
          path: ~/.cache/ms-playwright
          key: pw
      - run: npx playwright install chromium
`,
  ".github/workflows/deploy.yml": `name: Deploy
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      target:
        type: choice
        options: [preview, production]
concurrency:
  group: deploy-x
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  live-commit:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions: {}
    outputs:
      sha: \${{ steps.live.outputs.sha }}
    steps:
      - id: live
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        run: echo "sha=abc" >> "$GITHUB_OUTPUT"
  deploy-scope:
    needs: live-commit
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      scope: \${{ steps.s.outputs.scope }}
    steps:
      - uses: actions/checkout@${SHA} # v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@${SHA} # v7
        with:
          node-version: 22.23.4
      - id: s
        run: echo "scope=$(sh scripts/deploy-scope.sh "$LIVE" "$SHA")" >> "$GITHUB_OUTPUT"
  deploy:
    needs: [live-commit, deploy-scope]
    if: \${{ !(needs.deploy-scope.result == 'success' && needs.deploy-scope.outputs.scope == 'skip') }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/setup-node@${SHA} # v7
        with:
          node-version: 22.23.4
      - run: |
          jq -e '[.packages[] | select((.resolved // "" | startswith("https://registry.npmjs.org/") | not) or .integrity == null)] | length == 0' tools/cli/package-lock.json
          cd tools/cli && npm ci --ignore-scripts
      - env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        run: tools/cli/node_modules/.bin/cli deploy --meta "appSha=$SHA"
`,
  ".github/required-checks.json": `["cheap", "unit-count", "browser"]\n`,
  ".github/dependabot.yml": `version: 2
updates:
  - package-ecosystem: bun
    directory: "/"
    schedule: { interval: weekly }
  - package-ecosystem: npm
    directory: "/tools/cli"
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
    groups:
      actions:
        patterns: ["*"]
`,
  "scripts/scope.mjs": `// prints docs or code\nconsole.log("code");\n`,
  ".githooks/pre-push": `#!/usr/bin/env bash
unset $(git rev-parse --local-env-vars)
draft=$(gh pr view "$b" --json isDraft -q .isDraft)
mode=$(node scripts/scope.mjs "$base..$sha")
scripts/stamp.sh check "$sha" "$mode" || bash scripts/ci-local.sh fast
`,
  "scripts/stamp.sh": `#!/usr/bin/env bash
suite() { for f in scripts/ci-local.sh .github/workflows/ci.yml scripts/scope.mjs scripts/stamp.sh .githooks/pre-push; do git show "$1:$f"; done | git hash-object --stdin; }
tree=$(git rev-parse 'HEAD^{tree}')
`,
  "scripts/ci-local.sh": `#!/usr/bin/env bash
pin="$(sed -n 's/ *bun-version: //p' .github/workflows/ci.yml)"
[ "$(bun --version)" = "$pin" ] || exit 2
npin="$(sed -n 's/ *node-version: //p' .github/workflows/ci.yml)"
[ "$(node --version)" = "v$npin" ] || exit 2
mode=$(node scripts/scope.mjs "$r")
scripts/stamp.sh write code
`,
  "scripts/mark-ready.sh": `#!/usr/bin/env bash
scripts/stamp.sh check "$head" code || exit 1
gh pr ready "$pr"
`,
  "scripts/protect-main.sh": `#!/usr/bin/env bash
case "\${1:---dry-run}" in --dry-run) mode=dry ;; --apply) mode=apply ;; esac
want=$(jq . .github/required-checks.json)
gh api -X PUT repos/o/r/branches/main/protection --input - <<<"$want"
back=$(gh api repos/o/r/branches/main/protection)
`,
  "scripts/deploy-scope.sh": `#!/bin/sh
git merge-base --is-ancestor "$1" "$2" || { echo deploy; exit 0; }
node "$(dirname "$0")/scope.mjs" "$1..$2"
`,
  "test/ci-gates.test.ts": `const ci = read(".github/workflows/ci.yml");\nexpect(gate).toContain("github.event_name == 'pull_request'");\nexpect(gate).toContain("!github.event.pull_request.draft");\n`,
  "test/toolchain.test.ts": `expect(pins("bun-version")).not.toContain("latest");\nexpect(pins("node-version")).toHaveLength(1);\n`,
  "test/hook.test.ts": `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));\nspawnSync("git", ["init", dir], { env });\n`,
  "test/e2e.spec.ts": `import { chromium } from "playwright";\n// waitForLoadState("networkidle") is named in a comment only\nawait page.goto(url);\nawait page.waitForFunction(() => document.querySelector("main") !== null);\n`,
  "tools/cli/package.json": `{"dependencies":{"cli":"1.0.0"}}\n`,
  "tools/cli/package-lock.json": `{"packages":{}}\n`,
  "bun.lock": "{}\n",
};

const runsOk = { workflow_runs: [
  { id: 1, event: "pull_request", head_branch: "feature", conclusion: "success" },
  { id: 2, event: "push", head_branch: "main", conclusion: "success" },
  { id: 3, event: "workflow_run", head_branch: "main", conclusion: "success" },
] };
const REPO = { default_branch: "main", name: "r", private: true, owner: { login: "o", type: "Organization" },
  delete_branch_on_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false };
const ORG = { plan: { name: "team", seats: 1, filled_seats: 1, private_repos: 999999 }, two_factor_requirement_enabled: true,
  members_can_create_public_repositories: false, members_can_create_private_repositories: true, default_repository_permission: "read" };
const GH_BASE: Record<string, unknown> = {
  repo: REPO,
  org: ORG,
  vuln: "",
  asf: { enabled: true, paused: false },
  wfperm: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
  actperm: { enabled: true, allowed_actions: "selected", sha_pinning_required: true },
  forkpriv: { run_workflows_from_fork_pull_requests: false, send_write_tokens_to_workflows: false, send_secrets_and_variables: false },
  retention: { days: 14 },
  secrets: { secrets: [{ name: "NPM_TOKEN" }] },
  keys: [{ id: 1, title: "ci read", read_only: true }],
  hooks: [{ id: 2, config: { url: "https://hooks.example.invalid/x", insecure_ssl: "0", secret: "********" } }],
  collab: [],
  envs: { environments: [{ name: "production", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }] },
  rules: [],
  usage: { usageItems: [{ sku: "Actions Linux", quantity: 600, repositoryName: "r", netAmount: 0 }, { sku: "Actions storage", quantity: 9000, repositoryName: "r" }] },
  budgets: { budgets: [{ budget_product_sku: "actions", budget_amount: 20 }] },
  protection: {
    required_status_checks: { strict: true, checks: ["cheap", "unit-count", "browser"].map((context) => ({ context, app_id: 15368 })) },
    enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
    required_pull_request_reviews: { required_approving_review_count: 0 },
  },
  completed: { workflow_runs: Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, event: "pull_request", conclusion: "success" })) },
  success: runsOk,
  alerts: [{ number: 7, dependency: { package: { name: "tar" } }, dismissed_comment: "deploy-CLI tree only; fix needs a major jump" }],
  jobs: { jobs: [
    { conclusion: "success", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:01:30Z" },
    { conclusion: "skipped", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:00Z" },
  ] },
};

// The fake answers GETs (and the read-only \`gh repo list\`); any other shape is
// refused and logged. A "<name>.err" file makes that endpoint fail with its text.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_DIR/calls.log"
if [ "$1" = repo ] && [ "$2" = list ]; then cat "$GH_DIR/repolist.json" 2>/dev/null || exit 1; exit 0; fi
if [ "$1" = api ] && [ "$2" = --paginate ] && [ "$3" = --slurp ]; then
  case "$4" in *dependabot/alerts*) cat "$GH_DIR/alertsAll.json" 2>/dev/null || exit 1; exit 0 ;; *) exit 9 ;; esac
fi
[ "$1" = api ] && [ $# -eq 2 ] || exit 9
case "$2" in
  repos/o/r) f=repo ;;
  repos/o/r/vulnerability-alerts) f=vuln ;;
  repos/o/r/automated-security-fixes) f=asf ;;
  repos/o/r/actions/permissions/workflow) f=wfperm ;;
  repos/o/r/actions/permissions/fork-pr-workflows-private-repos) f=forkpriv ;;
  repos/o/r/actions/permissions/fork-pr-contributor-approval) f=forkpub ;;
  repos/o/r/actions/permissions/artifact-and-log-retention) f=retention ;;
  repos/o/r/actions/permissions) f=actperm ;;
  repos/o/r/actions/secrets*) f=secrets ;;
  repos/o/r/private-vulnerability-reporting) f=pvr ;;
  repos/o/r/keys) f=keys ;;
  repos/o/r/hooks) f=hooks ;;
  repos/o/r/collaborators*) f=collab ;;
  repos/o/r/environments) f=envs ;;
  repos/o/r/rules/branches/*) f=rules ;;
  orgs/o/settings/billing/budgets) f=budgets ;;
  */settings/billing/usage*) f=usage ;;
  orgs/o) f=org ;;
  users/o) f=whois ;;
  user) f=user ;;
  *dependabot/alerts*) f=alerts ;;
  */protection) f=protection ;;
  */runs/*/jobs*) f=jobs ;;
  *status=completed*) f=completed ;;
  */runs*) f=success ;;
  *) exit 1 ;;
esac
if [ -f "$GH_DIR/$f.err" ]; then cat "$GH_DIR/$f.err" >&2; exit 1; fi
[ -f "$GH_DIR/$f.json" ] || exit 1
cat "$GH_DIR/$f.json"
`;

let n = 0;
type Result = { status: number; out: string; rows: Map<string, string>; calls: string };
/** hooksPath: [core.hooksPath value, path it resolves to under the fixture (HOME = the fixture dir), hook written there]. */
type Opts = { hook?: string | null; email?: string; hooksPath?: [string, string, string] };
const GITLEAKS_HOOK = "#!/bin/sh\ngitleaks git --pre-commit --staged\n";
/** Write the fake gh's answers; `{ __err: text }` makes that endpoint fail with `text` on stderr. */
function writeGh(ghDir: string, bin: string, gh: Record<string, unknown | null>) {
  for (const [k, v] of Object.entries({ ...GH_BASE, ...gh })) {
    if (v == null) continue;
    const e = (v as any)?.__err;
    writeFileSync(join(ghDir, e ? `${k}.err` : `${k}.json`), e ?? JSON.stringify(v));
  }
  writeFileSync(join(bin, "gh"), FAKE_GH); chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(ghDir, "calls.log"), "");
}
function audit(files: Record<string, string | null>, gh: Record<string, unknown | null> = {}, extra: string[] = [], opts: Opts = {}): Result {
  const dir = join(ROOT, `r${n++}`), repo = join(dir, "repo"), ghDir = join(dir, "gh"), bin = join(dir, "bin"), tpl = join(dir, "tpl");
  for (const d of [repo, ghDir, bin, tpl]) mkdirSync(d, { recursive: true });
  for (const [p, c] of Object.entries({ ...BASE, ...files })) {
    if (c == null) continue;
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  writeGh(ghDir, bin, gh);
  const g = (...a: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...a], { env: ENV, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  // An empty template: the host's own hooks (a global gitleaks hook) must neither run nor be judged.
  g("init", "-q", `--template=${tpl}`); g("add", "-A");
  g("-c", "user.name=t", "-c", `user.email=${opts.email ?? "1+t@users.noreply.github.com"}`, "commit", "-qm", "fixture");
  const hook = opts.hook === undefined ? GITLEAKS_HOOK : opts.hook;
  if (hook != null) { mkdirSync(join(repo, ".git/hooks"), { recursive: true }); writeFileSync(join(repo, ".git/hooks/pre-commit"), hook); }
  if (opts.hooksPath) {
    const [value, at, text] = opts.hooksPath;
    g("config", "core.hooksPath", value);
    mkdirSync(join(dir, at), { recursive: true }); writeFileSync(join(dir, at, "pre-commit"), text);
  }
  // The audit reads core.hooksPath: the host's global git config must not answer for the fixture.
  const r = spawnSync("bun", [AUDIT, repo, "--ref", "HEAD", "--repo", "o/r", ...extra],
    { env: { ...ENV, PATH: `${bin}:${ENV.PATH}`, GH_DIR: ghDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...(opts.hooksPath ? { HOME: dir } : {}) }, encoding: "utf8" });
  const rows = new Map<string, string>();
  for (const l of r.stdout.split("\n")) {
    const m = /^\| ([\w.-]+) \| (\*\*FAIL\*\*|\*\*blocked\*\*|pass|n\.a\.) \|/.exec(l);
    if (m) rows.set(m[1], m[2] === "**FAIL**" ? "fail" : m[2] === "**blocked**" ? "blocked" : m[2]);
  }
  return { status: r.status ?? -1, out: r.stdout + r.stderr, rows, calls: readFileSync(join(ghDir, "calls.log"), "utf8") };
}
/** `--owner` mode: no repository, only the fake gh. */
function ownerAudit(gh: Record<string, unknown | null>) {
  const dir = join(ROOT, `o${n++}`), ghDir = join(dir, "gh"), bin = join(dir, "bin");
  for (const d of [ghDir, bin]) mkdirSync(d, { recursive: true });
  writeGh(ghDir, bin, gh);
  const r = spawnSync("bun", [AUDIT, "--owner", "o"], { env: { ...ENV, PATH: `${bin}:${ENV.PATH}`, GH_DIR: ghDir }, encoding: "utf8" });
  return { status: r.status ?? -1, out: r.stdout + r.stderr, calls: readFileSync(join(ghDir, "calls.log"), "utf8") };
}

/** Replace in one base file, refusing a mutation that changes nothing (a vacuous mutation proves nothing). */
function mut(path: string, from: string | RegExp, to: string): Record<string, string> {
  const before = BASE[path];
  const after = before.replace(from, to);
  if (after === before) throw new Error(`mutation of ${path} matched nothing: ${from}`);
  return { [path]: after };
}

// Three reference variants, each passing everything it evaluates. Visibility
// and plan decide which configuration checks apply, so no single fixture can
// exercise them all: a check is n.a. in one variant only if another passes it.
const PUB_GH = {
  repo: { ...REPO, private: false, owner: { login: "o", type: "User" },
    security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } } },
  user: { login: "o", plan: { name: "free" }, two_factor_authentication: true },
  forkpub: { approval_policy: "first_time_contributors" },
  pvr: { enabled: true },
};
const VARIANTS = {
  base: { files: {} as Record<string, string | null>, gh: {} as Record<string, unknown>, args: [] as string[] },
  pub: { files: { "SECURITY.md": "Report privately via GitHub private vulnerability reporting.\n" }, gh: PUB_GH, args: [] },
  cfg: { files: {}, gh: {}, args: ["--config-only"] },
};
type V = keyof typeof VARIANTS;
const auditV = (v: V, files: Record<string, string | null> = {}, gh: Record<string, unknown> = {}, opts: Opts = {}) =>
  audit({ ...VARIANTS[v].files, ...files }, { ...VARIANTS[v].gh, ...gh }, VARIANTS[v].args, opts);
const REF: Record<V, Result> = { base: auditV("base"), pub: auditV("pub"), cfg: auditV("cfg") };
const base = REF.base;

describe("baseline", () => {
  test("the reference fixtures fail nothing, and every check passes in at least one", () => {
    expect(base.rows.size).toBeGreaterThan(55);
    for (const r of Object.values(REF)) expect([...r.rows].filter(([, s]) => s === "fail" || s === "blocked")).toEqual([]);
    const ids = new Set(Object.values(REF).flatMap((r) => [...r.rows.keys()]));
    expect([...ids].filter((id) => !Object.values(REF).some((r) => r.rows.get(id) === "pass"))).toEqual([]);
  });
  test("--config-only reports configuration only, and no minutes", () => {
    expect(REF.cfg.rows.has("trigger-once")).toBe(false);
    expect(REF.cfg.rows.get("dependabot-ecosystems")).toBe("pass");
    expect(REF.cfg.rows.get("branch-baseline")).toBe("pass");
    expect(REF.cfg.out).not.toContain("Billed minutes");
  });
  test("minutes come from the latest green runs, each job rounded up", () => {
    expect(base.out).toContain("full PR run   2 min");
    expect(base.out).toContain("main push     2 min");
  });
  test("exit 0 without --strict even when a check fails; 1 with it", () => {
    const m = mut(".github/workflows/ci.yml", "cancel-in-progress: true", "cancel-in-progress: false");
    expect(audit(m).status).toBe(0);
    expect(audit(m, {}, ["--strict"]).status).toBe(1);
    expect(audit({}, {}, ["--strict"]).status).toBe(0);
  });
  test("the audit only ever reads from GitHub", () => {
    const lines = base.calls.trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l).toMatch(/^api [^ ]+$/);
  });
  test("GitHub unreachable is FAIL, never pass", () => {
    const r = audit({}, { protection: null, completed: null });
    expect(r.rows.get("protection-live")).toBe("fail");
    expect(r.rows.get("protection-matches-declared")).toBe("fail");
    expect(r.rows.get("ci-red-rate")).toBe("fail");
  });
});

// A private repo on Free: GitHub refuses protection "with an upgrade message",
// the plan is inferred from that, and the project's needs decide blocked vs n.a.
const FREE_GH = {
  repo: { ...REPO, owner: { login: "o", type: "User" } },
  user: { login: "o", two_factor_authentication: true },
  protection: { __err: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" },
};
describe("plan × visibility × project needs", () => {
  test("Free private WITH CI and deploy: protection and environments are blocked, with the options; --strict still exits 0", () => {
    const r = audit({}, FREE_GH, ["--strict"]);
    expect(r.out).toContain("plan free");
    for (const id of ["plan-protection", "plan-environments", "protection-live", "protection-matches-declared"]) expect(r.rows.get(id)).toBe("blocked");
    expect(r.rows.get("deploy-credential-scope")).toBe("n.a.");
    expect(r.rows.get("secret-scanning")).toBe("n.a.");
    expect([...r.rows].filter(([, s]) => s === "fail")).toEqual([]);
    expect(r.out).toContain("plan-protection (plan decision): (a) move the repo to the Team org");
    expect(r.status).toBe(0);
  });
  test("Free private WITHOUT CI or deploy: the same missing features are n.a., not blocked", () => {
    const r = audit({ [".github/workflows/ci.yml"]: null, [".github/workflows/deploy.yml"]: null }, FREE_GH, ["--config-only"]);
    expect(r.rows.get("plan-protection")).toBe("n.a.");
    expect(r.rows.get("plan-environments")).toBe("n.a.");
    expect(r.rows.get("branch-baseline")).toBe("n.a.");
  });
  test("past 80% of the included minutes the report states limit, remaining and budget left", () => {
    const r = audit({}, { usage: { usageItems: [{ sku: "Actions Linux", quantity: 2500, repositoryName: "r", netAmount: 0 }] } });
    expect(r.rows.get("plan-minutes")).toBe("pass"); // a budget is set, so the quota is not a stop
    expect(r.out).toMatch(/\*\*Actions minutes 83% used: 2500 of 3000 included .*500 remaining until \d{4}-\d{2}-01; at this pace \d+ by month end; budget US\$20, US\$0\.00 spent, US\$20\.00 left before Actions stops\*\*/);
    expect(base.out).not.toContain("Actions minutes 20% used");
  });
  test("a public repo with a development name gets a rename-to-product suggestion; a folder label gets a random name", () => {
    const pub = auditV("pub", {}, { repo: { ...PUB_GH.repo, name: "amber-river-123" } });
    expect(pub.rows.get("repo-name")).toBe("pass");
    expect(pub.out).toContain("repo-name (suggestion): public now, so the product name can replace the development name: gh repo rename <product-name>");
    const lab = audit({}, { repo: { ...REPO, name: "acme-thing" } });
    expect(lab.out).toMatch(/repo-name: rename to a random development name: gh repo rename [a-z]+-[a-z]+-\d{3} -R o\/r/);
  });
  test("hardening fixes are printed, never run", () => {
    const r = audit({}, { retention: { days: 90 } });
    expect(r.out).toContain("- log-retention: gh api -X PUT repos/o/r/actions/permissions/artifact-and-log-retention -F days=14");
    for (const l of r.calls.trim().split("\n")) expect(l).toMatch(/^api [^ ]+$/);
  });
  test("core.hooksPath: a hook chained to .git/hooks/pre-commit counts; ~ is expanded; an unchained one fails", () => {
    const chain = '#!/bin/sh\nexec "$(git rev-parse --git-common-dir)/hooks/pre-commit" "$@"\n';
    expect(audit({}, {}, [], { hooksPath: [".githooks", "repo/.githooks", chain] }).rows.get("gitleaks-precommit")).toBe("pass");
    expect(audit({}, {}, [], { hooksPath: ["~/hk", "hk", GITLEAKS_HOOK], hook: null }).rows.get("gitleaks-precommit")).toBe("pass");
    expect(audit({}, {}, [], { hooksPath: [".githooks", "repo/.githooks", "#!/bin/sh\nexit 0\n"] }).rows.get("gitleaks-precommit")).toBe("fail");
    expect(audit({}, {}, [], { hooksPath: [".githooks", "repo/.githooks", chain], hook: "#!/bin/sh\nexit 0\n" }).rows.get("gitleaks-precommit")).toBe("fail");
    // naming hooks/pre-commit is not chaining to the default hook
    expect(audit({}, {}, [], { hooksPath: [".githooks", "repo/.githooks", '#!/bin/sh\nfor h in .githooks/pre-commit.d/*; do "$h" || exit 1; done\n'] }).rows.get("gitleaks-precommit")).toBe("fail");
  });
  test("a declared add-on list: adopted add-ons are checked, the others are n.a., nothing else changes", () => {
    const all = audit({ ".github/ci-flow.json": '{"addons": ["gated-expensive", "classifier", "local-stamps", "deploy"]}' });
    expect(all.rows.get("addons-declared")).toBe("pass");
    expect([...all.rows].filter(([, s]) => s === "fail")).toEqual([]);
    // The fixture has a classifier, so `classifier` must stay declared (addons-declared).
    const narrow = audit({ ".github/ci-flow.json": '{"addons": ["gated-expensive", "classifier", "deploy"]}' });
    expect(narrow.rows.get("addons-declared")).toBe("pass");
    for (const id of ["mark-ready-gate", "hook-tiers", "stamp-covers-suite", "local-refuses-node"]) expect(narrow.rows.get(id)).toBe("n.a.");
    for (const id of ["expensive-gated", "deploy-split", "timeouts", "cheap-secret-scan"]) expect(narrow.rows.get(id)).toBe("pass");
    // n.a. by declaration still lets a real defect elsewhere through
    const broken = audit({ ".github/ci-flow.json": '{"addons": ["gated-expensive", "classifier", "deploy"]}', ...mut(CI, "    timeout-minutes: 5\n", "") });
    expect(broken.rows.get("timeouts")).toBe("fail");
  });
  test("printed fixes quote a hostile branch name and drop a hostile action name", () => {
    const evil = "x';touch pwn;'";
    const r = auditV("cfg", mut(".github/workflows/ci.yml", "oven-sh/setup-bun@", "ev'il;touch pwn/x@"),
      { repo: { ...REPO, default_branch: evil }, protection: { __err: "gh: Branch not protected (HTTP 404)" }, actperm: { enabled: true, allowed_actions: "all", sha_pinning_required: false } });
    expect(r.rows.get("actions-policy")).toBe("fail");
    const fixes = r.out.split("## Hardening")[1];
    expect(fixes).not.toContain("touch pwn/x");
    const quoted = /branches\/(.+)\/protection --input/.exec(fixes)![1];
    expect(spawnSync("sh", ["-c", `printf %s ${quoted}`]).stdout.toString()).toBe(evil); // the shell reads back the exact name
  });
});

describe("--owner (before creating a repo)", () => {
  test("Team org: plan, seats, counts, unlimited slots, the feature table, minutes and a random private name", () => {
    const r = ownerAudit({ whois: { type: "Organization" }, repolist: [
      { name: "a", visibility: "PRIVATE", isArchived: false }, { name: "b", visibility: "PRIVATE", isArchived: true }, { name: "c", visibility: "PUBLIC", isArchived: false }] });
    expect(r.status).toBe(0);
    for (const s of ["Plan: team (GitHub), seats 1/1", "1 public, 2 private (1 archived); slots: unlimited on every plan",
      "| branch protection / rulesets | yes | yes |", "| environment reviewers / wait timers | **no** | yes |",
      "| Actions minutes (standard Linux) | 3000/month, shared by the org | free |", "org 600 of 3000 included Linux min (20%)"]) expect(r.out).toContain(s);
    expect(r.out).toMatch(/gh repo create o\/[a-z]+-[a-z]+-\d{3} --private/);
    expect(r.out).not.toContain("Team org instead");
    for (const l of r.calls.trim().split("\n")) expect(l).toMatch(/^(api [^ ]+|repo list o .*)$/);
  });
  test("Free user, plan unreadable: inferred from a private repo's protection; private features shown missing", () => {
    const r = ownerAudit({ whois: { type: "User" }, user: { login: "o" }, protection: FREE_GH.protection,
      repolist: [{ name: "r", visibility: "PRIVATE", isArchived: false, defaultBranchRef: { name: "main" } }] });
    for (const s of ["Plan: free (inferred from r's branch protection)", "| branch protection / rulesets | **no** | yes |",
      "| Actions minutes (standard Linux) | 2000/month, shared by the account | free |", "create it under the Team org instead"]) expect(r.out).toContain(s);
  });
});

const CI = ".github/workflows/ci.yml", DEP = ".github/workflows/deploy.yml";
const NO_PLAN = { org: { ...ORG, plan: undefined } };
const MUTATIONS: [string, Record<string, string | null>, Record<string, unknown>?, V?, Opts?][] = [
  ["workflows-parse", { [CI]: BASE[CI] + "  bad: [unclosed\n" }],
  ["addons-declared", { ".github/ci-flow.json": '{"addons": ["classifier", "local-stamps", "deploy"]}' }], // e2e/browser jobs exist
  ["addons-declared", { ".github/ci-flow.json": '{"addons": ["gated-expensive", "classifier", "local-stamps"]}' }], // deploy.yml exists
  ["addons-declared", { ".github/ci-flow.json": '{"addons": ["gated-expensive", "classifier", "local-stamps", "deploy", "stamps"]}' }],
  ["addons-declared", { ".github/ci-flow.json": "not json" }],
  ["trigger-once", mut(CI, "  push:\n    branches: [main]\n", "  push:\n")],
  ["ready-for-review", mut(CI, ", ready_for_review]", "]")],
  ["concurrency-ci", mut(CI, "cancel-in-progress: true", "cancel-in-progress: false")],
  ["concurrency-deploy", mut(DEP, "cancel-in-progress: false", "cancel-in-progress: true")],
  ["no-workflow-paths-filter", mut(CI, "    branches: [main]\n", "    branches: [main]\n    paths-ignore: ['**.md']\n")],
  ["timeouts", mut(CI, "    timeout-minutes: 5\n", "")],
  ["permissions-top", mut(CI, "  contents: read", "  contents: write")],
  ["actions-sha-pinned", mut(CI, `oven-sh/setup-bun@${SHA}`, "oven-sh/setup-bun@v2")],
  ["classifier-tracked", mut(CI, `echo "scope=$(node scripts/scope.mjs "$RANGE")"`, `echo "scope=code"`)],
  // The hook reaches the classifier through the runner too, so both must lose it.
  ["classifier-shared", { ...mut(".githooks/pre-push", /mode=\$\(node scripts\/scope\.mjs [^\n]*\n/, "mode=code\n"),
    ...mut("scripts/ci-local.sh", /mode=\$\(node scripts\/scope\.mjs [^\n]*\n/, "mode=code\n") }],
  ["classifier-shared", mut("scripts/ci-local.sh", /mode=\$\(node scripts\/scope\.mjs [^\n]*\n/, "mode=code\n")],
  ["cheap-secret-scan", mut(CI, /\s+echo "abc {2}gl\.tgz" \| sha256sum -c -/, "")],
  ["audit-ungated", mut(CI, "      - run: bun audit", "      - if: github.event_name == 'pull_request'\n        run: bun audit")],
  ["expensive-gated", mut(CI, /!github\.event\.pull_request\.draft && /g, "")],
  ["expensive-gated", mut(CI, "if: ${{ github.event_name == 'pull_request' && !github.event.pull_request.draft && needs.cheap.outputs.scope != 'docs' }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 15", "if: ${{ !github.event.pull_request.draft && needs.cheap.outputs.scope != 'docs' }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 15")],
  ["browser-job", mut(CI, "~/.cache/ms-playwright", "~/.cache/other")],
  ["install-cache", mut(CI, "~/.bun/install/cache", "~/.npm")],
  ["matrix-aggregate", { ".github/required-checks.json": `["cheap", "unit-count", "browser", "unit"]\n` }, { protection: { ...(GH_BASE.protection as object) } }],
  ["matrix-aggregate", mut(CI, "if: ${{ always() && needs.unit.result != 'skipped' }}", "if: ${{ needs.unit.result != 'skipped' }}")],
  ["required-declared", { ".github/required-checks.json": null }],
  ["protect-script", mut("scripts/protect-main.sh", /gh api -X PUT[^\n]*\n/, "")],
  ["protection-live", {}, { protection: { ...(GH_BASE.protection as any), required_status_checks: { ...(GH_BASE.protection as any).required_status_checks, strict: false } } }],
  ["protection-live", {}, { protection: { ...(GH_BASE.protection as any), required_status_checks: { strict: true, checks: ["cheap", "unit-count", "browser"].map((context) => ({ context, app_id: 1 })) } } }],
  ["protection-matches-declared", { ".github/required-checks.json": `["cheap", "unit-count"]\n` }],
  ["toolchain-exact", mut(CI, "bun-version: 1.4.4", "bun-version: latest")],
  ["toolchain-exact", mut(CI, "node-version: 22.23.4", "node-version: 22")],
  ["cache-default-branch", mut(CI, /  warm-browsers:\n[\s\S]*?npx playwright install chromium\n/, "")],
  ["toolchain-every-job", mut(CI, /    steps:\n      - uses: actions\/setup-node@[0-9a-f]+ # v7\n        with:\n          node-version: 22\.23\.4\n      - run: npm test/, "    steps:\n      - run: npm test")],
  ["toolchain-guard-test", { "test/toolchain.test.ts": null }],
  ["local-refuses-bun", mut("scripts/ci-local.sh", /\[ "\$\(bun --version\)"[^\n]*\n/, "")],
  ["local-refuses-node", mut("scripts/ci-local.sh", /\[ "\$\(node --version\)"[^\n]*\n/, "")],
  ["hook-tiers", mut(".githooks/pre-push", /draft=[^\n]*\n/, "")],
  ["mark-ready-gate", mut("scripts/mark-ready.sh", /scripts\/stamp\.sh check[^\n]*\n/, "")],
  ["stamp-covers-suite", mut("scripts/stamp.sh", " .githooks/pre-push;", ";")],
  ["hook-strips-git-env", mut(".githooks/pre-push", /unset [^\n]*\n/, "")],
  ["tests-hermetic-git", mut("test/hook.test.ts", /const env = [^\n]*\n/, "const env = process.env;\n")],
  ["gate-tests", { "test/ci-gates.test.ts": null }],
  ["browser-wait-proxy", mut("test/e2e.spec.ts", "await page.waitForFunction(() => document.querySelector(\"main\") !== null);", "await page.waitForLoadState(\"networkidle\");")],
  ["browser-wait-proxy", mut("test/e2e.spec.ts", "await page.waitForFunction(() => document.querySelector(\"main\") !== null);", "await page.waitForTimeout(900);")],
  ["deploy-split", mut(DEP, "      - id: live\n", `      - uses: actions/checkout@${SHA} # v7\n      - id: live\n`)],
  ["deploy-live-range", mut(DEP, `sh scripts/deploy-scope.sh "$LIVE" "$SHA"`, "node scripts/scope.mjs HEAD^1..HEAD")],
  ["deploy-cli-locked", mut(DEP, "npm ci --ignore-scripts", "npm ci")],
  ["deploy-sha-meta", mut(DEP, ` --meta "appSha=$SHA"`, "")],
  ["deploy-preview", mut(DEP, "options: [preview, production]", "options: [production]")],
  ["dependabot-ecosystems", mut(".github/dependabot.yml", /  - package-ecosystem: npm\n[^\n]*\n[^\n]*\n/, "")],
  ["dependabot-actions-grouped", mut(".github/dependabot.yml", /    groups:\n[^\n]*\n[^\n]*\n/, "")],
  ["alert-dismissal-reason", {}, { alerts: [{ number: 7, dependency: { package: { name: "tar" } }, dismissed_comment: "  " }] }],
  ["ci-red-rate", {}, { completed: { workflow_runs: Array.from({ length: 20 }, (_, i) => ({ id: i, event: "push", conclusion: i < 4 ? "failure" : "success" })) } }],
  // Repository configuration. A plan that cannot be read is an unknown, and unknown is FAIL.
  ["plan-detected", {}, NO_PLAN],
  ["plan-protection", {}, NO_PLAN],
  ["plan-environments", {}, NO_PLAN],
  ["plan-minutes", {}, { usage: { usageItems: [{ sku: "Actions Linux", quantity: 2900, repositoryName: "r" }] }, budgets: { budgets: [] } }],
  ["plan-minutes", {}, { usage: { __err: "gh: Not Found (HTTP 404)" } }],
  ["repo-name", {}, { repo: { ...REPO, name: "acme-thing" } }],
  ["merge-hygiene", {}, { repo: { ...REPO, allow_rebase_merge: true } }],
  ["merge-hygiene", {}, { repo: { ...REPO, delete_branch_on_merge: false } }],
  ["dependabot-alerts", {}, { vuln: { __err: "gh: Not Found (HTTP 404)" } }],
  ["dependabot-security-updates", {}, { asf: { enabled: false } }],
  ["actions-token", {}, { wfperm: { default_workflow_permissions: "write", can_approve_pull_request_reviews: false } }],
  ["actions-token", {}, { wfperm: { default_workflow_permissions: "read", can_approve_pull_request_reviews: true } }],
  ["actions-policy", {}, { actperm: { enabled: true, allowed_actions: "all", sha_pinning_required: true } }],
  ["actions-policy", {}, { actperm: { enabled: true, allowed_actions: "selected" } }],
  ["fork-pr-policy", {}, { forkpriv: { run_workflows_from_fork_pull_requests: true, send_write_tokens_to_workflows: false, send_secrets_and_variables: true } }],
  ["fork-pr-policy", {}, { forkpub: { approval_policy: "first_time_contributors_new_to_github" } }, "pub"],
  ["secret-scanning", {}, { repo: { ...PUB_GH.repo, security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "disabled" } } } }, "pub"],
  ["private-vuln-reporting", {}, { pvr: { enabled: false } }, "pub"],
  ["security-policy", { "SECURITY.md": null }, {}, "pub"],
  ["branch-baseline", {}, { protection: { ...(GH_BASE.protection as any), allow_force_pushes: { enabled: true } } }, "cfg"],
  ["branch-baseline", {}, { protection: { __err: "gh: Branch not protected (HTTP 404)" } }, "cfg"],
  ["deploy-keys", {}, { keys: [{ id: 1, title: "old deploy", read_only: false }] }],
  ["webhooks", {}, { hooks: [{ id: 2, config: { url: "http://hooks.example.invalid/x", insecure_ssl: "0", secret: "********" } }] }],
  ["webhooks", {}, { hooks: [{ id: 2, config: { url: "https://hooks.example.invalid/x", insecure_ssl: "0" } }] }],
  ["collaborators", {}, { collab: [{ login: "x", permissions: { admin: true } }] }],
  ["deploy-credential-scope", {}, { secrets: { secrets: [{ name: "VERCEL_TOKEN" }] } }],
  ["deploy-credential-scope", {}, { envs: { environments: [{ name: "preview", deployment_branch_policy: null }] } }],
  ["log-retention", {}, { retention: { days: 90 } }],
  ["commit-email-noreply", {}, {}, "base", { email: "t@example.invalid" }],
  ["gitleaks-precommit", {}, {}, "base", { hook: null }],
  ["gitleaks-precommit", {}, {}, "base", { hook: "#!/bin/sh\n# gitleaks git --pre-commit --staged (a comment is not a call)\nexit 0\n" }],
  ["org-baseline", {}, { org: { ...ORG, members_can_create_public_repositories: true } }],
  ["org-baseline", {}, { org: { ...ORG, two_factor_requirement_enabled: false } }],
  ["account-2fa", {}, { user: { ...PUB_GH.user, two_factor_authentication: false } }, "pub"],
  ["account-2fa", {}, { user: { login: "o", plan: { name: "free" } } }, "pub"],
];

describe("a comment naming a tool is not a call", () => {
  // 0231: runOf() read shell comments, so a comment saying "e2e" made a cheap job a browser job.
  test("comment lines in run: do not make a job a browser job or a node job", () => {
    const files = mut(CI, 'run: test "\${{ needs.unit.result }}" = success',
      'run: |\n          # e2e and npx named in a comment, never run\n          test "\${{ needs.unit.result }}" = success');
    const r = auditV("base", files);
    expect(r.rows.get("browser-job")).toBe("pass");
    expect(r.rows.get("toolchain-every-job")).toBe("pass");
  });
  test("a trailing comment after a command is not a call either", () => {
    // A block scalar: in a plain `run: cmd # x` YAML itself drops the comment.
    const files = mut(CI, 'run: test "\${{ needs.unit.result }}" = success',
      'run: |\n          test "\${{ needs.unit.result }}" = success  # e2e and npx named after the command');
    const r = auditV("base", files);
    expect(r.rows.get("browser-job")).toBe("pass");
    expect(r.rows.get("toolchain-every-job")).toBe("pass");
  });
  test("a # inside quotes or mid-word starts no comment: the call after it still counts", () => {
    for (const run of ['echo "# x" && npx playwright test', "echo '# x' && npx playwright test", "echo a#b && npx playwright test"]) {
      const r = auditV("base", mut(CI, 'run: test "\${{ needs.unit.result }}" = success', `run: ${run}`));
      expect(r.rows.get("browser-job")).toBe("fail");
    }
  });
});

describe("false results found by an outside review (2026-11-05)", () => {
  const SCAN = /      - name: secret scan\n[\s\S]*?--log-opts="\$RANGE" \.\n/;
  const scanWf = (on: string) => ({ ".github/workflows/secret-scan.yml": `name: secret scan
on:
${on}
permissions:
  contents: read
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
${BASE[CI].match(SCAN)![0]}` });
  test("a cache written by a job that runs on every event (!cancelled()) is written on the push", () => {
    const r = auditV("base", mut(CI, "if: \${{ github.event_name == 'push' }}", "if: \${{ !cancelled() }}"));
    expect(r.rows.get("cache-default-branch")).toBe("pass");
  });
  test("control: a job excluded from the push (event_name != 'push') writes no default-branch cache", () => {
    const r = auditV("base", mut(CI, "if: \${{ github.event_name == 'push' }}", "if: \${{ github.event_name != 'push' }}"));
    expect(r.rows.get("cache-default-branch")).toBe("fail");
  });
  test("the range secret scan may live in its own PR-triggered workflow", () => {
    const r = auditV("base", { ...mut(CI, SCAN, ""), ...scanWf("  push:\n    branches: [main]\n  pull_request:") });
    expect(r.rows.get("cheap-secret-scan")).toBe("pass");
  });
  test("control: a secret scan in a manual-only workflow does not count", () => {
    const r = auditV("base", { ...mut(CI, SCAN, ""), ...scanWf("  workflow_dispatch:") });
    expect(r.rows.get("cheap-secret-scan")).toBe("fail");
  });
  test("a dependency audit in a job gated on the docs scope is gated", () => {
    const files = mut(CI, "      - run: bun audit\n  unit:\n", `  deps:
    needs: cheap
    if: \${{ needs.cheap.outputs.scope != 'docs' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: bun audit
  unit:
`);
    expect(auditV("base", files).rows.get("audit-ungated")).toBe("fail");
  });
  test("a Python audit (pip-audit) is recognised, and judged, without a JavaScript manifest", () => {
    const noJs = { "bun.lock": null, "tools/cli/package.json": null, "tools/cli/package-lock.json": null, "requirements.txt": "requests==2.32.0\n" };
    const ok = mut(CI, "      - run: bun audit\n", "      - run: uvx pip-audit -r requirements.txt\n");
    expect(auditV("base", { ...noJs, ...ok }).rows.get("audit-ungated")).toBe("pass");
    const gated = mut(CI, "      - run: bun audit\n", "      - if: github.event_name == 'pull_request'\n        run: uvx pip-audit -r requirements.txt\n");
    expect(auditV("base", { ...noJs, ...gated }).rows.get("audit-ungated")).toBe("fail");
    const none = mut(CI, "      - run: bun audit\n", "");
    expect(auditV("base", { ...noJs, ...none }).rows.get("audit-ungated")).toBe("fail");
  });
  test("no PR-triggered workflow: ci-red-rate names that, never an empty workflow path", () => {
    const r = auditV("base", mut(CI, /  pull_request:\n    types: \[[^\]]*\]\n/, "  workflow_dispatch:\n"));
    expect(r.rows.get("ci-red-rate")).toBe("fail");
    expect(r.out).not.toContain("workflows//");
    expect(r.out).toContain("no workflow with a pull_request trigger");
  });
  test("a gating output without gated-expensive is a classifier, and must be declared", () => {
    const decl = (a: string[]) => ({ ".github/ci-flow.json": JSON.stringify({ addons: a }) });
    const bare = auditV("base", decl(["local-stamps", "deploy"]));
    expect(bare.rows.get("addons-declared")).toBe("fail");
    expect(bare.out).toContain("classifier is not declared");
    // gated-expensive brings its own scope output: no classifier is demanded for it.
    expect(auditV("base", decl(["gated-expensive", "local-stamps", "deploy"])).rows.get("addons-declared")).toBe("pass");
  });
});

describe("self-audit false positives", () => {
  test("no package manifest: the dependency audit is n.a., not a FAIL", () => {
    // No manifest AND no audit step; an audit step that exists is judged (outside review, 2026-11-05).
    const r = auditV("base", { "bun.lock": null, "tools/cli/package.json": null, "tools/cli/package-lock.json": null, ...mut(CI, "      - run: bun audit\n", "") });
    expect(r.rows.get("audit-ungated")).toBe("n.a.");
  });
  test("a fixture STRING naming playwright and a fixed wait is not a Playwright file", () => {
    const r = auditV("base", { "test/fixture.test.ts": 'const f = `import { chromium } from "playwright";\nawait page.waitForTimeout(400);`;\n' });
    expect(r.rows.get("browser-wait-proxy")).toBe("pass");
  });
});

describe("each check can fail", () => {
  for (const [id, files, gh, v = "base", opts] of MUTATIONS) {
    test(`${id} flips to FAIL (${v})`, () => {
      expect(REF[v].rows.get(id)).toBe("pass");
      expect(auditV(v, files, gh ?? {}, opts ?? {}).rows.get(id)).toBe("fail");
    });
  }
  test("every check a reference fixture reports has at least one mutation", () => {
    const covered = new Set(MUTATIONS.map(([id]) => id));
    const ids = new Set(Object.values(REF).flatMap((r) => [...r.rows.keys()]));
    expect([...ids].filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe("limits closed (2026-11-05)", () => {
  const unpinScope = () => mut(DEP, /persist-credentials: false\n      - uses: actions\/setup-node@[0-9a-f]+ # v7\n        with:\n          node-version: 22\.23\.4\n/, "persist-credentials: false\n");
  test("node run by a tracked script the step calls needs the pin too", () => {
    const r = auditV("base", unpinScope());
    expect(r.rows.get("toolchain-every-job")).toBe("fail");
    expect(r.out).toContain("deploy-scope runs node (via scripts/deploy-scope.sh) without node-version");
  });
  test("control: a called script that names node only in a comment needs no pin", () => {
    const r = auditV("base", { ...unpinScope(), "scripts/deploy-scope.sh": "#!/bin/sh\n# node scope.mjs used to run here\necho deploy\n" });
    expect(r.rows.get("toolchain-every-job")).toBe("pass");
  });
  test("control: a called script that names npm only inside a quoted message needs no pin", () => {
    const r = auditV("base", { ...unpinScope(), "scripts/deploy-scope.sh": "#!/bin/sh\necho \"run npm ci first\" >&2\necho 'or node x'\necho deploy\n" });
    expect(r.rows.get("toolchain-every-job")).toBe("pass");
  });
  test("a call inside a quoted command substitution still counts", () => {
    const r = auditV("base", { ...unpinScope(), "scripts/deploy-scope.sh": "#!/bin/sh\ncase \"$(node scope.mjs \"$1\")\" in docs) echo skip ;; *) echo deploy ;; esac\n" });
    expect(r.rows.get("toolchain-every-job")).toBe("fail");
  });
  const alert = (i: number, why = "tolerable: dev only") => ({ number: i, dependency: { package: { name: `p${i}` } }, dismissed_comment: why });
  const page1 = Array.from({ length: 100 }, (_, i) => alert(i));
  test("a full first page of dismissed alerts reads the rest: a bare dismissal on page 2 fails", () => {
    const r = auditV("base", {}, { alerts: page1, alertsAll: [page1, [alert(100, "")]] });
    expect(r.rows.get("alert-dismissal-reason")).toBe("fail");
    expect(r.out).toContain("1 of 101 dismissed alert(s)");
  });
  test("control: fewer than 100 dismissed alerts makes no paginated call", () => {
    const r = auditV("base", {}, { alerts: page1.slice(0, 99) });
    expect(r.rows.get("alert-dismissal-reason")).toBe("pass");
    expect(r.calls).not.toContain("--paginate");
  });
});

describe("Dependabot on a repo without workflows (2026-11-05)", () => {
  const NO_WF = { ".github/workflows/ci.yml": null, ".github/workflows/deploy.yml": null };
  const BARE = { ...NO_WF, ".github/dependabot.yml": null, "tools/cli/package.json": null, "tools/cli/package-lock.json": null, "bun.lock": null };
  test("no workflow, no action, no manifest: both Dependabot rows are n.a.", () => {
    const r = audit(BARE, {}, ["--config-only"]);
    expect(r.rows.get("dependabot-ecosystems")).toBe("n.a.");
    expect(r.rows.get("dependabot-actions-grouped")).toBe("n.a.");
  });
  test("control: a manifest still needs dependabot.yml, and the fix names no github-actions", () => {
    const r = audit({ ...BARE, "pyproject.toml": "[project]\nname = \"x\"\n" }, {}, ["--config-only"]);
    expect(r.rows.get("dependabot-ecosystems")).toBe("fail");
    expect(r.out).toContain("add .github/dependabot.yml: each package ecosystem the repo uses");
    expect(r.rows.get("dependabot-actions-grouped")).toBe("n.a.");
  });
  test("control: a composite action alone still needs the github-actions entry", () => {
    const r = audit({ ...BARE, "action.yml": "name: x\nruns:\n  using: composite\n  steps: []\n" }, {}, ["--config-only"]);
    expect(r.rows.get("dependabot-ecosystems")).toBe("fail");
    expect(r.rows.get("dependabot-actions-grouped")).toBe("fail");
  });
  test("control: workflows present and no github-actions entry still fails both", () => {
    const r = audit(mut(".github/dependabot.yml", /  - package-ecosystem: github-actions[\s\S]*$/, ""));
    expect(r.rows.get("dependabot-ecosystems")).toBe("fail");
    expect(r.rows.get("dependabot-actions-grouped")).toBe("fail");
  });
});
