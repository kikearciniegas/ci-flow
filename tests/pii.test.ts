// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kikearciniegas
// Personal-data backstop in CI (ci-flow POLICY.md §1, "Plan limits and secrets"):
// 1. the tracked .gitleaks.toml is what the cheap job's range scan loads
//    (gitleaks reads it from the source dir) and it blocks an email and a phone
//    while keeping the default secret rules; negative controls pass;
// 2. the cheap job's "Commit identities" step, run as written in ci.yml, refuses
//    a commit whose author or committer email is not a GitHub noreply address.
// Real gitleaks (./gitleaks in CI, from PATH locally) and real git; PII-shaped
// values are assembled at run time so this file holds none.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "pii-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// Fail closed: no gitleaks is a failure to run, never a skip.
const GITLEAKS = existsSync(join(ROOT, "gitleaks")) ? join(ROOT, "gitleaks") : Bun.which("gitleaks");
if (!GITLEAKS) throw new Error("gitleaks not found (./gitleaks or PATH): the PII tests refuse to skip");

// Hermetic git: no caller GIT_*, no global/system config, PATH from a private bin.
const BIN = join(TMP, "bin");
mkdirSync(BIN);
for (const t of ["git", "bash", "awk", "cat"]) {
  const p = Bun.which(t);
  if (!p) throw new Error(`${t} not found`);
  symlinkSync(p, join(BIN, t));
}
symlinkSync(GITLEAKS, join(BIN, "gitleaks"));
const ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")) as [string, string][]),
  PATH: BIN, HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

const AT = "@";
const NOREPLY = `1+fixture${AT}users.noreply.github.com`;
const EMAIL = `jane.fixture${AT}fixture-mail.com`;

let n = 0;
function repo(withConfig = true) {
  const dir = join(TMP, `r${n++}`);
  mkdirSync(dir);
  const g = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: dir, env: ENV, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  g("config", "user.name", "fixture"); g("config", "user.email", NOREPLY);
  if (withConfig) copyFileSync(join(ROOT, ".gitleaks.toml"), join(dir, ".gitleaks.toml"));
  writeFileSync(join(dir, "README"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  const commit = (text: string, env: Record<string, string> = {}) => {
    writeFileSync(join(dir, "a.txt"), text + "\n");
    g("add", "-A");
    const r = spawnSync("git", ["commit", "-q", "-m", "change"], { cwd: dir, env: { ...ENV, ...env }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  return { dir, base, commit };
}

// Exactly the cheap job's invocation, from the source dir.
const scan = (dir: string, base: string) =>
  spawnSync("gitleaks", ["git", "--redact", "--no-banner", `--log-opts=${base}..HEAD`, "."], { cwd: dir, env: ENV, encoding: "utf8" });

describe(".gitleaks.toml (range scan)", () => {
  const blocked: [string, string][] = [
    ["email", `contact ${EMAIL}`],
    ["E.164 phone", "call +1" + "415" + "555" + "0100"],
    ["formatted phone", "call (415) 555-" + "0100"],
    ["default secret rules still on", "token = ghp_" + "A1b2C3d4E5".repeat(4)],
  ];
  for (const [label, text] of blocked) test(`blocks: ${label}`, () => {
    const r = repo(); r.commit(text);
    const s = scan(r.dir, r.base);
    expect(s.status).toBe(1);
    expect(s.stdout + s.stderr).not.toContain(text.split(" ").pop()!);
  });
  const passes: [string, string][] = [
    ["noreply addresses", `1+jane${AT}users.noreply.github.com noreply${AT}github.com`],
    ["example.* addresses", `a${AT}example.invalid b${AT}example.com c${AT}example.org d${AT}example.net e${AT}mail.example.com`],
    ["version string", "version 1.2.3-4567, release 2026.11.11"],
    ["40-hex sha", "sha 3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["ISO timestamp and epoch", "at 2026-11-11T10:00:00+00:00 and 2026-11-11T10:00:00.123+05:30, epoch 1731312000123"],
    ["uuid and ids", "id 550e8400-e29b-41d4-a716-446655440000, port 49152"],
    ["the GitHub login", "https://github.com/kikearciniegas/ci-flow"],
  ];
  for (const [label, text] of passes) test(`passes: ${label}`, () => {
    const r = repo(); r.commit(text);
    expect(scan(r.dir, r.base).status).toBe(0);
  });
  test("control: without .gitleaks.toml the same email passes, so the file is what blocks it", () => {
    const r = repo(false); r.commit(`contact ${EMAIL}`);
    expect(scan(r.dir, r.base).status).toBe(0);
  });
});

describe("ci.yml Commit identities step", () => {
  const y = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as any;
  const step = (y.jobs.checks.steps as any[]).find((s) => s.name === "Commit identities (commits in this run)");
  test("the step exists in the ungated required job", () => {
    expect(step?.run).toBeString();
    expect(y.jobs.checks.if).toBeUndefined();
    expect(step.if).toBeUndefined();
  });
  // GitHub runs `run:` with bash -e -o pipefail.
  const runStep = (dir: string, base: string) =>
    spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], { cwd: dir, env: { ...ENV, BASE: base }, encoding: "utf8" });
  const id = (who: "AUTHOR" | "COMMITTER", email: string) => ({ [`GIT_${who}_NAME`]: "fixture", [`GIT_${who}_EMAIL`]: email });
  test("blocks a non-noreply author, without printing the address", () => {
    const r = repo(); r.commit("x", id("AUTHOR", EMAIL));
    const s = runStep(r.dir, r.base);
    expect(s.status).toBe(1);
    expect(s.stdout).toContain("author email is not a GitHub noreply address");
    expect(s.stdout + s.stderr).not.toContain(EMAIL);
  });
  test("blocks a non-noreply committer", () => {
    const r = repo(); r.commit("x", id("COMMITTER", EMAIL));
    const s = runStep(r.dir, r.base);
    expect(s.status).toBe(1);
    expect(s.stdout).toContain("committer email is not a GitHub noreply address");
  });
  test("passes noreply authors and GitHub's own committer", () => {
    const r = repo(); r.commit("x", id("COMMITTER", `noreply${AT}github.com`));
    const s = runStep(r.dir, r.base);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain("1 commit(s): every author and committer email");
  });
  test("an empty range fails closed", () => {
    const r = repo();
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: r.dir, env: ENV, encoding: "utf8" }).stdout.trim();
    const s = runStep(r.dir, head);
    expect(s.status).toBe(1);
    expect(s.stdout).toContain("empty commit range");
  });
});
