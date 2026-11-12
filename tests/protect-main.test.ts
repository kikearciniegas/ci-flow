// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Rafael Arciniegas
// scripts/protect-main.sh against a fake gh serving GitHub's GET shape:
// a live rule equal to the body is "(no difference)"; a dropped required check is a diff line;
// "Branch not protected" (no rule yet) is a CREATE; any other refusal still REFUSES.
// No network: any gh call other than the GET and the PUT exits 9.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/protect-main.sh");
const REQUIRED: string[] = JSON.parse(readFileSync(join(ROOT, ".github/required-checks.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "ci-flow-protect-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// GET: the rule file if present, else the error (stdout body, stderr line, exit 1). PUT: saves the body, then serves "after".
writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$*" >> "$GH_DIR/calls"
case "$*" in
  "api repos/kikearciniegas/ci-flow/branches/main/protection")
    [ -f "$GH_DIR/rule" ] && { cat "$GH_DIR/rule"; exit 0; }
    cat "$GH_DIR/err.out"; cat "$GH_DIR/err.txt" >&2; exit 1 ;;
  "api -X PUT repos/kikearciniegas/ci-flow/branches/main/protection --input -")
    cat > "$GH_DIR/put"; cp "$GH_DIR/after" "$GH_DIR/rule"; echo '{}'; exit 0 ;;
esac
exit 9
`);
chmodSync(join(dir, "gh"), 0o755);

// GitHub's GET shape: booleans wrapped as {enabled}, checks as {context, app_id}, extra fields the PUT does not take.
const live = (checks: string[]) => ({
  url: "https://api.github.invalid/x",
  required_status_checks: { strict: true, contexts: checks, checks: checks.map((context) => ({ context, app_id: 15368 })) },
  enforce_admins: { url: "x", enabled: true },
  required_pull_request_reviews: { url: "x", dismiss_stale_reviews: false, require_code_owner_reviews: false, require_last_push_approval: false, required_approving_review_count: 0 },
  required_linear_history: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
  required_conversation_resolution: { enabled: true }, lock_branch: { enabled: false }, allow_fork_syncing: { enabled: false },
  required_signatures: { enabled: false }, block_creations: { enabled: false },
});
type Gh = { rule?: object | string; err?: { out: string; line: string }; after?: object };
function run(mode: "--dry-run" | "--apply", gh: Gh) {
  const d = mkdtempSync(join(dir, "gh-"));
  writeFileSync(join(d, "calls"), "");
  if (gh.rule !== undefined) writeFileSync(join(d, "rule"), typeof gh.rule === "string" ? gh.rule : JSON.stringify(gh.rule));
  if (gh.err) { writeFileSync(join(d, "err.out"), gh.err.out); writeFileSync(join(d, "err.txt"), `${gh.err.line}\n`); }
  if (gh.after) writeFileSync(join(d, "after"), JSON.stringify(gh.after));
  const r = spawnSync("bash", [SCRIPT, mode], { env: { PATH: `${dir}:${process.env.PATH}`, GH_DIR: d }, encoding: "utf8" });
  const calls = readFileSync(join(d, "calls"), "utf8").trim().split("\n").filter(Boolean);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, puts: calls.filter((c) => c.includes("-X PUT")),
    put: () => JSON.parse(readFileSync(join(d, "put"), "utf8")) };
}
function dryRun(rule: object) {
  const r = run("--dry-run", { rule });
  return { status: r.status, out: r.stdout.split("=== live -> body\n")[1] ?? r.stdout + r.stderr };
}
// gh's own answers to GET .../protection: stdout carries the body, stderr "gh: <message> (HTTP <code>)".
const ghErr = (message: string, code: number) =>
  ({ out: JSON.stringify({ message, documentation_url: "https://docs.github.com/x", status: String(code) }), line: `gh: ${message} (HTTP ${code})` });
const NOT_PROTECTED = ghErr("Branch not protected", 404);
const checksOf = (b: any) => b.required_status_checks.checks.map((c: any) => `${c.context} @${c.app_id}`);

test("a live rule equal to the body: (no difference)", () => {
  const r = dryRun(live(REQUIRED));
  expect(r.status).toBe(0);
  expect(r.out.trim()).toBe("(no difference)");
});
test("control: a dropped required check is a diff line", () => {
  const r = dryRun(live(REQUIRED.slice(1)));
  expect(r.status).toBe(0);
  expect(r.out).toContain(`+      "${REQUIRED[0]} @15368"`);
});

test("first apply: \"Branch not protected\" -> one PUT of the body, read back, exit 0", () => {
  const r = run("--apply", { err: NOT_PROTECTED, after: live(REQUIRED) });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(r.puts).toHaveLength(1);
  expect(r.calls).toHaveLength(3); // GET, PUT, read-back GET
  expect(checksOf(r.put())).toEqual(REQUIRED.map((c) => `${c} @15368`));
  expect(r.stdout).toBe(`applied and read back: ${REQUIRED.map((c) => `${c} @15368`).join(", ")}\n`);
});
test("dry-run on an unprotected branch: no write; the full body and a CREATE plan are printed", () => {
  const r = run("--dry-run", { err: NOT_PROTECTED });
  expect(r.status).toBe(0);
  expect(r.puts).toHaveLength(0);
  const [head, plan] = r.stdout.split("=== live -> body\n");
  const body = JSON.parse(head.replace("=== PUT body\n", ""));
  expect(checksOf(body)).toEqual(REQUIRED.map((c) => `${c} @15368`));
  expect(body.enforce_admins).toBe(true);
  expect(plan).toBe("(no rule yet: --apply would CREATE it)\n");
});
// Negative controls (ruling M1): only that exact 404 means "no rule yet"; a plan refusal is never a CREATE.
for (const [name, gh] of [
  ["404 \"Upgrade to GitHub Pro…\" (plan lacks protection)", { err: ghErr("Upgrade to GitHub Pro or make this repository public to enable this feature.", 404) }],
  ["403 \"Upgrade to GitHub Pro…\"", { err: ghErr("Upgrade to GitHub Pro or make this repository public to enable this feature.", 403) }],
  ["404 \"Branch not found\"", { err: ghErr("Branch not found", 404) }],
  ["garbage JSON on a 200", { rule: "not json {" }],
] as [string, Gh][]) {
  for (const mode of ["--dry-run", "--apply"] as const) {
    test(`control: ${name}, ${mode}: REFUSED, no PUT`, () => {
      const r = run(mode, { ...gh, after: live(REQUIRED) });
      expect(r.status).toBe(1);
      expect(r.puts).toHaveLength(0);
      expect(r.stderr).toContain("REFUSED: could not read the live rule for kikearciniegas/ci-flow main");
      expect(r.stdout).not.toContain("CREATE");
    });
  }
}
