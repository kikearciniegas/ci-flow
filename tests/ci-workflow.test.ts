// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Rafael Arciniegas
// This repo's own CI (.github/workflows/ci.yml): every required check reports on
// every event (no job `if:`, no workflow-level paths filter), ready_for_review
// starts a run, and bun-version is one exact x.y.z (never `latest` or a bare
// major, which turn CI red on a release with no change in the tree). Each rule
// has a negative control that must be caught.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TEXT = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const REQUIRED: string[] = JSON.parse(readFileSync(join(ROOT, ".github/required-checks.json"), "utf8"));

function problems(text: string, required: string[]): string[] {
  const y = Bun.YAML.parse(text) as any;
  const on = y?.on ?? y?.true ?? {};
  const out: string[] = [];
  for (const ev of ["push", "pull_request"]) {
    if (on[ev]?.paths || on[ev]?.["paths-ignore"]) out.push(`${ev}: workflow-level paths filter`);
  }
  if (![on.pull_request?.types ?? []].flat().includes("ready_for_review")) out.push("pull_request types lack ready_for_review");
  const jobs = y?.jobs ?? {};
  for (const name of required) {
    if (!jobs[name]) out.push(`required check ${name} is not a job`);
    else if (jobs[name].if) out.push(`required check ${name} has an if:`);
  }
  const pins = Object.values(jobs).flatMap((j: any) => (j?.steps ?? []).map((s: any) => s?.with?.["bun-version"]).filter((v: unknown) => v != null).map(String));
  if (!pins.length) out.push("no bun-version pin");
  for (const v of new Set(pins)) if (!/^\d+\.\d+\.\d+$/.test(v)) out.push(`bun-version ${v} is not exact (latest / a bare major drift)`);
  if (new Set(pins).size > 1) out.push(`bun-version has ${new Set(pins).size} different pins`);
  return out;
}

const mut = (from: string | RegExp, to: string) => {
  const t = TEXT.replace(from, to);
  if (t === TEXT) throw new Error(`control matched nothing: ${from}`);
  return t;
};

describe("ci.yml", () => {
  test("required checks report on every event; bun pinned exactly", () => {
    expect(problems(TEXT, REQUIRED)).toEqual([]);
  });
  const controls: [string, string, string[]?][] = [
    ["bun latest", mut(/bun-version: \S+/, "bun-version: latest")],
    ["bun bare major", mut(/bun-version: \S+/, "bun-version: 1")],
    ["paths filter", mut("  pull_request:\n", "  pull_request:\n    paths: ['skills/**']\n")],
    ["ready_for_review dropped", mut(", ready_for_review]", "]")],
    ["required job gated", mut("  checks:\n    runs-on:", "  checks:\n    if: github.event_name == 'pull_request'\n    runs-on:")],
    ["required job missing", TEXT, [...REQUIRED, "nope"]],
  ];
  for (const [label, text, req] of controls) {
    test(`control caught: ${label}`, () => expect(problems(text, req ?? REQUIRED).length).toBeGreaterThan(0));
  }
});
