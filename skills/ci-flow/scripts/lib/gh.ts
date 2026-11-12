// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Rafael Arciniegas
// Process and GitHub plumbing for audit.ts: no state of the audited repo lives here.
import { spawnSync } from "node:child_process";

export const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
};

/** `gh api` answers fetched in parallel before the checks ask (speed only: any other path is fetched when asked). */
export const prefetched = new Map<string, { ok: boolean; out: string; err: string }>();
export const prefetch = (paths: string[]) => Promise.all(paths.filter((p) => !prefetched.has(p)).map(async (p) => {
  try {
    const c = Bun.spawn(["gh", "api", p], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text(), c.exited]);
    prefetched.set(p, { ok: code === 0, out, err });
  } catch { /* left to the synchronous call, which reports the error */ }
}));
/** A plan refusing a feature: reported as `blocked`, never as pass or as an unknown. */
export class Blocked extends Error {}
export type GhRes = { ok: true; data: any } | { ok: false; kind: "blocked" | "missing" | "error"; msg: string };
/** GET that keeps the REASON of a refusal: the plan, a 404, or anything else (unknown). */
export const ghGet = (path: string): GhRes => {
  const r = prefetched.get(path) ?? run("gh", ["api", path]);
  if (r.ok) { try { return { ok: true, data: r.out.trim() ? JSON.parse(r.out) : null }; } catch { return { ok: true, data: r.out }; } }
  const all = `${r.err}\n${r.out}`;
  const msg = `gh api ${path}: ${r.err.trim().split("\n")[0] || "failed"}`;
  if (/Upgrade to GitHub|make this repository public to enable/i.test(all)) return { ok: false, kind: "blocked", msg };
  return { ok: false, kind: /HTTP 404|"status":\s*"404"/.test(all) ? "missing" : "error", msg };
};
