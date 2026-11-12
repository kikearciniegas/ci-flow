// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Rafael Arciniegas
// The ci-flow trigger hook: fires on state-changing git/GitHub actions and on
// .github edits, once per session per repo; never on read-only commands.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "../skills/ci-flow/hooks/trigger.sh");
const tmp = mkdtempSync(join(tmpdir(), "ci-flow-trigger-"));
const repo = join(tmp, "repo");
mkdirSync(repo);
const env = { PATH: process.env.PATH!, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
spawnSync("git", ["init", "-q", "--template=", repo], { env });
let n = 0;

/** Runs the hook in a fresh session (so the once-per-session marker never masks a result). */
function fire(tool: string, input: Record<string, string>, session = `s${n++}`, cwd = repo): string {
  const r = spawnSync("bash", [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: input, session_id: session, cwd }), env: { ...env, TMPDIR: tmp }, encoding: "utf8" });
  expect(r.status).toBe(0); // a reminder never blocks
  return r.stdout;
}
const bash = (command: string, session?: string) => fire("Bash", { command }, session);
const top = () => spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const ctx = (o: string) => JSON.parse(o).hookSpecificOutput.additionalContext as string;

describe("fires", () => {
  for (const c of ["git commit -m x", `git -C ${repo} push origin main`, "/usr/bin/git commit -q", "cd x && git push", "git -c user.name=a commit -m x",
    "gh pr create --draft", "gh pr ready 3", "gh pr merge 3 --squash",
    "gh api -X PUT repos/o/r/branches/main/protection --input -", "gh api -X POST repos/o/r/rulesets --input -", "gh api repos/o/r/rulesets/7 --method PUT --input -",
    `gh api -X PUT "repos/o/r/branches/main/protection" --input -`, "gh api -X PUT 'repos/o/r/branches/main/protection' --input -", "gh api -X POST 'repos/o/r/rulesets' --input -",
    "gh api graphql -f query='mutation { updateRepository(input: {}) { clientMutationId } }'",
    // attached flag forms and a field flag as the first token
    "gh api -XPUT repos/o/r/branches/main/protection --input -", "gh api --method=PUT repos/o/r/branches/main/protection --input -",
    "gh api repos/o/r/rulesets -fname=x", "gh api repos/o/r/rulesets -Fenforcement=active", "gh api repos/o/r/rulesets --field=name=x", "gh api repos/o/r/rulesets --raw-field=name=x",
    "gh api repos/o/r/branches/main/protection --input=p.json", "gh api -f name=x repos/o/r/rulesets",
    // a graphql mutation whatever the flag order; a query from a file may be one (fail closed)
    "gh api -X POST graphql -f query='mutation{x}'", "gh api --method=POST graphql -f query='mutation{x}'", "gh api graphql -F query=@q.graphql",
    // a quoted value with spaces is one token; quoted gh can run for real (ruling S5)
    "gh api -f name='my rule' -X POST repos/o/r/rulesets", "sh -c 'gh api -X PUT repos/o/r/rulesets/1 --input -'",
    // known over-fire, accepted (a reminder only): a ruleset path named inside a value
    "gh api -X PATCH repos/o/r -f description='see /rulesets'"])
    test(c, () => expect(bash(c)).toContain("ci-flow applies"));
  for (const f of [".github/workflows/ci.yml", ".github/workflows/deploy.yaml", ".github/dependabot.yml", ".github/required-checks.json", ".github/ci-flow.json"])
    test(`Write ${f}`, () => expect(fire("Write", { file_path: join(repo, f) })).toContain("ci-flow applies"));
  test("names the repo root and the audit", () => {
    const o = JSON.parse(bash("git commit -m x"));
    expect(o.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(o.hookSpecificOutput.additionalContext).toContain(`audit.ts ${top()}`);
  });
  test("a Write that creates .github/ still names the repo root, not the new directory", () =>
    expect(ctx(fire("Write", { file_path: join(repo, ".github/workflows/new.yml") }))).toContain(`audit.ts ${top()}.`));
  test("`cd <repo> && git commit` from another cwd names <repo>", () =>
    expect(ctx(fire("Bash", { command: `cd ${repo} && git commit -m x` }, undefined, tmp))).toContain(`audit.ts ${top()}.`));
  test("a multi-line command still fires", () => expect(bash("echo start\ngit commit -m x")).toContain("ci-flow applies"));
});

describe("does not fire", () => {
  for (const c of ["git status", "git log --grep commit", "git diff HEAD", "git fetch", "git show HEAD:x", "git commit-tree abc", "git config push.default simple",
    "gh pr view 3", "gh pr list", "gh repo view", "gh api repos/o/r --jq .private", "gh api 'repos/o/r/actions/runs?status=queued'",
    "gh api graphql -f query='{ viewer { login } }'", "ls .github/workflows", "gh api repos/o/r/branches/main/protection",
    // repository settings belong to repo-create's trigger
    "gh repo create o/x --private", "gh repo rename y", "gh repo edit --visibility public", "gh api --method PATCH repos/o/r -F delete_branch_on_merge=true",
    "gh api repos/o/r/environments/p/deployment-branch-policies -f name=main", "gh api -X POST repos/o/r/transfer -f new_owner=x",
    "gh secret set TOKEN --body x", "gh repo deploy-key add key.pub", "gh api -X POST repos/o/r/keys -f key=x", "gh repo unarchive o/x",
    "gh api repos/o/r -fprivate=true", "gh api --method=PATCH repos/o/r", "gh api -f a=b repos/o/r",
    // explicit GETs, an unquoted echo, a graphql query read
    "gh api -X GET repos/o/r", "gh api --method=GET repos/o/r", "gh api -X GET repos/o/r/rulesets", "echo gh api -X PATCH",
    "gh api graphql -f query='query{viewer{login}}'"])
    test(c, () => expect(bash(c)).toBe(""));
  for (const f of ["src/ci.yml", ".github/CODEOWNERS", "docs/workflows/ci.yml"])
    test(`Write ${f}`, () => expect(fire("Write", { file_path: join(repo, f) })).toBe(""));
  test("Read of a workflow", () => expect(fire("Read", { file_path: join(repo, ".github/workflows/ci.yml") })).toBe(""));
});

describe("once per session per repo", () => {
  test("second action in the same session is silent; a new session fires again", () => {
    expect(bash("git commit -m a", "same")).toContain("ci-flow applies");
    expect(bash("git push", "same")).toBe("");
    expect(bash("git push", "other")).toContain("ci-flow applies");
  });
  test("a hostile session id cannot write outside the marker directory", () => {
    expect(bash("git commit -m a", "../../escape")).toContain("ci-flow applies");
    expect(existsSync(join(tmp, "escape"))).toBe(false);
    expect(existsSync(join(tmp, "ci-flow-trigger", "escape"))).toBe(true); // reduced to safe characters, kept inside
  });
  test("repos whose paths differ only by / vs _ each get their own reminder", () => {
    for (const p of ["x/a_b", "x/a/b"]) { mkdirSync(join(tmp, p), { recursive: true }); spawnSync("git", ["init", "-q", "--template=", join(tmp, p)], { env }); }
    expect(fire("Bash", { command: "git commit -m a" }, "col", join(tmp, "x/a_b"))).toContain("ci-flow applies");
    expect(fire("Bash", { command: "git commit -m a" }, "col", join(tmp, "x/a/b"))).toContain("ci-flow applies");
  });
  test("a relative cwd ends (no hang) and still reminds", () => {
    const r = spawnSync("bash", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, session_id: "rel", cwd: "rel" }), env: { ...env, TMPDIR: tmp }, encoding: "utf8", timeout: 5000, cwd: "/" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ci-flow applies");
  });
  test("a symlinked marker directory is never written through; the hook still reminds", () => {
    const target = join(tmp, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(tmp, "ci-flow-trigger", "linked"));
    expect(bash("git commit -m a", "linked")).toContain("ci-flow applies");
    expect(bash("git commit -m a", "linked")).toContain("ci-flow applies"); // no marker, so it fires again
    expect(readdirSync(target)).toEqual([]);
  });
});
