#!/usr/bin/env bun
/**
 * ci-flow audit — READ-ONLY check of one repository against the ci-flow
 * reference design (SKILL.md, "The reference design").
 *
 *   bun audit.ts <repo-path> [--ref <git-ref>] [--repo <owner/name>] [--strict] [--config-only]
 *
 * Reads the tree at <ref> (default origin/main) through `git show` — never the
 * working tree, which may hold another session's edits — plus `gh api` GETs for
 * the live branch protection, repository settings, plan, billing and recent
 * runs. It writes nothing anywhere: hardening fixes are PRINTED, never applied.
 *
 * Two sections: "CI design" (the reference design) and "Repository
 * configuration" (POLICY.md §2), judged against what the owner's PLAN gives a
 * repo of this VISIBILITY. `--config-only` runs the second alone, for repos with
 * no CI. A feature the plan × visibility lacks is `blocked` when the project
 * needs it (the row names the options) and n.a. when it does not; `blocked` is
 * an owner decision, so --strict ignores it.
 *
 * Detection is by BEHAVIOUR, not filename: the classifier is whatever the CI
 * job other jobs gate on runs into $GITHUB_OUTPUT; the hook is the tracked
 * `pre-push`; the stamp is the script hashing a tree; the local runner is what
 * calls `<stamp> write`. Anything the audit cannot determine is FAIL, never
 * PASS. Exit 0 always (it is a report); --strict exits 1 on any FAIL.
 *
 * shortcut: checks read workflow YAML structurally but scripts as TEXT (comment
 * lines dropped), so a script can satisfy a text check without doing the thing
 * (a dead string naming `--local-env-vars` counts). The repository's own
 * behavioural tests prove behaviour; this audit proves the design is present.
 */
import { readFileSync } from "node:fs";
import { Blocked, ghGet, prefetch, run, type GhRes } from "./lib/gh.ts";
import { ownerReport } from "./lib/owner.ts";
import { capsFor, minutesOf, planOf, QUOTA, randomName } from "./lib/plans.ts";

type Status = "pass" | "fail" | "n.a." | "blocked";
type Section = "ci" | "config";
type Row = { id: string; status: Status; ev: string; fix?: string; section: Section };

function usage(code: number): never {
  console.error("usage: bun audit.ts <repo-path> [--ref <git-ref>] [--repo <owner/name>] [--strict] [--config-only]\n       bun audit.ts --owner <login>   # before creating a repo: plan, limits, counts, minutes");
  process.exit(code);
}
const argv = process.argv.slice(2);
let repoPath = "", ref = "origin/main", slugArg = "", strict = false, configOnly = false, ownerArg = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--ref") ref = argv[++i] ?? usage(2);
  else if (a === "--repo") slugArg = argv[++i] ?? usage(2);
  else if (a === "--strict") strict = true;
  else if (a === "--config-only") configOnly = true;
  else if (a === "--owner") ownerArg = argv[++i] ?? usage(2);
  else if (a === "-h" || a === "--help") usage(0);
  else if (!repoPath) repoPath = a;
  else usage(2);
}
if (!repoPath && !ownerArg) usage(2);

const git = (...a: string[]) => run("git", ["-C", repoPath, ...a]);

if (ownerArg) ownerReport(ownerArg);

const ls = git("ls-tree", "-r", "--name-only", ref);
if (!ls.ok) { console.error(`cannot read ${ref} in ${repoPath}: ${ls.err.trim()}`); process.exit(2); }
const FILES = ls.out.split("\n").filter(Boolean);
const TRACKED = new Set(FILES);
const cache = new Map<string, string | null>();
const show = (p: string): string | null => {
  if (!cache.has(p)) { const r = git("show", `${ref}:${p}`); cache.set(p, r.ok ? r.out : null); }
  return cache.get(p)!;
};
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COMMENT = /^\s*(#|\/\/|\*|\/\*)/;
/** A file's text with comment LINES dropped: a comment naming a thing is not doing it. */
const codeCache = new Map<string, string>();
const code = (p: string) => {
  if (!codeCache.has(p)) codeCache.set(p, (show(p) ?? "").split("\n").filter((l) => !COMMENT.test(l)).join("\n"));
  return codeCache.get(p)!;
};
/** `path:line` of the first non-comment line matching re, or the bare path. */
const at = (p: string, re: RegExp) => {
  const i = (show(p) ?? "").split("\n").findIndex((l) => !COMMENT.test(l) && re.test(l));
  return i < 0 ? p : `${p}:${i + 1}`;
};

// ---------------------------------------------------------------- workflows
type WF = { path: string; text: string; y: any; on: Record<string, any> };
const parseErrors: string[] = [];
const WFS: WF[] = FILES.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).flatMap((path) => {
  const text = show(path) ?? "";
  try {
    const y = Bun.YAML.parse(text) as any;
    const o = y?.on ?? y?.true; // YAML 1.1 parsers read a bare `on` as true
    const on = typeof o === "string" ? { [o]: null } : Array.isArray(o) ? Object.fromEntries(o.map((k) => [k, null])) : (o ?? {});
    return [{ path, text, y, on }];
  } catch (e) { parseErrors.push(`${path}: ${(e as Error).message}`); return []; }
});
type Job = { id: string; j: any; wf: WF };
const jobsOf = (wf?: WF): Job[] => (wf ? Object.entries(wf.y?.jobs ?? {}).map(([id, j]) => ({ id, j, wf })) : []);
const needsOf = (j: any): string[] => [j?.needs ?? []].flat().map(String);
const ifOf = (j: any) => String(j?.if ?? "");
const stepsOf = (j: any): any[] => (Array.isArray(j?.steps) ? j.steps : []);
/** Shell text minus comments: a `#` at a word start, outside quotes, to the end of its line. */
const stripShellComments = (s: string) => {
  let out = "", q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && q !== "'") { out += c + (s[++i] ?? ""); continue; }
    if (q) { if (c === q) q = ""; }
    else if (c === "'" || c === '"') q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) { while (i + 1 < s.length && s[i + 1] !== "\n") i++; continue; }
    out += c;
  }
  return out;
};
/** A job's `run:` text minus shell comments: a comment naming e2e or node is not a call. */
const runOf = (j: any) => stepsOf(j).map((s) => stripShellComments(String(s?.run ?? ""))).join("\n");
const nameOf = (x: Job) => String(x.j?.name ?? x.id);
const DRAFT = /!\s*github\.event\.pull_request\.draft\b/;
const PR_EVENT = /github\.event_name\s*==\s*['"]pull_request['"]/;
const isExpensive = (x: Job) => /pull_request\.draft/.test(ifOf(x.j));
const BROWSER = /playwright|browser-suites|\be2e\b/i;
/** A step caching a path matching re. */
const caches = (x: Job, re: RegExp) => stepsOf(x.j).some((s) => /actions\/cache/.test(String(s?.uses ?? "")) && re.test(String(s?.with?.path ?? "")));
/** Every remote action a workflow uses (local ./ and docker:// excluded). */
const USES = WFS.flatMap((w) => jobsOf(w).flatMap((x) => [x.j?.uses, ...stepsOf(x.j).map((s) => s?.uses)])
  .filter((u): u is string => typeof u === "string" && !/^(\.\/|docker:\/\/)/.test(u)).map((u) => ({ w, u })));
/** The first n items joined, then "(+rest)". */
const firstN = (xs: string[], n: number, sep: string) => xs.slice(0, n).join(sep) + (xs.length > n ? ` (+${xs.length - n})` : "");

const CI = WFS.filter((w) => "pull_request" in w.on).sort((a, b) => jobsOf(b).length - jobsOf(a).length)[0];
const DEPLOY = WFS.find((w) => w !== CI && (/deploy/i.test(base(w.path)) || /deploy/i.test(String(w.y?.name ?? ""))));
const ciJobs = jobsOf(CI);
const DEPLOY_LOCKS = DEPLOY ? FILES.filter((f) => base(f) === "package-lock.json" && DEPLOY.text.includes(dir(f))) : [];
const ciJobKeys = new Set(ciJobs.flatMap((x) => [x.id, nameOf(x)]));

// The scope job: the one whose outputs other jobs' `if` reads most.
const outRefs = new Map<string, number>();
for (const x of ciJobs) for (const m of ifOf(x.j).matchAll(/needs\.([\w-]+)\.outputs\./g)) outRefs.set(m[1], (outRefs.get(m[1]) ?? 0) + 1);
const scopeJobId = [...outRefs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const scopeJob = ciJobs.find((x) => x.id === scopeJobId);
const classifier = (() => {
  for (const s of stepsOf(scopeJob?.j)) {
    const r = String(s?.run ?? "");
    if (!/GITHUB_OUTPUT/.test(r)) continue;
    const m = /\b(?:node|bun)\s+(?:run\s+)?(?:\.\/)?([\w./-]+\.(?:mjs|cjs|js|ts))\b/.exec(r);
    if (m) return m[1];
  }
  return undefined;
})();

// ---------------------------------------------------------- local machinery
const SCRIPT = /\.(sh|mjs|cjs|js|ts|bash)$|(^|\/)(pre-push|pre-commit)$/;
/** Tracked files a text names, resolved against the repo root and the naming file's directory. */
const refsIn = (p: string): string[] => {
  const out = new Set<string>();
  for (const [t] of code(p).matchAll(/[\w.\/-]+/g)) {
    const tok = t.replace(/^\.\//, "");
    for (const c of [tok, dir(p) ? `${dir(p)}/${tok}` : tok]) if (TRACKED.has(c) && c !== p) out.add(c);
  }
  return [...out];
};
const closure = (start: string, depth = 3): string[] => {
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    // The stamp NAMES the suite to hash it; following its list would make everything reach everything.
    frontier = frontier.filter((p) => p !== stamp).flatMap((p) => refsIn(p).filter((r) => SCRIPT.test(r) && !seen.has(r)));
    frontier.forEach((r) => seen.add(r));
  }
  return [...seen];
};
const textOf = (ps: string[]) => ps.map(code).join("\n");

const isTest = (f: string) => /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\//.test(f);
// Machinery is a tracked, non-test script: a test's stand-in hook must not be mistaken for the real one.
const MACHINERY = FILES.filter((f) => SCRIPT.test(f) && !isTest(f));
const stamp = MACHINERY.find((f) => /hash-object/.test(code(f)) && /\^\{tree\}/.test(code(f)));
/** The stamp script invoked with a verb (`<stamp> write`, `<stamp> check`). */
const stampCall = (verb: string) => new RegExp(`${esc(base(stamp!))}["']?\\s+${verb}`);
const hook = MACHINERY.find((f) => base(f) === "pre-push");
const hookSet = hook ? closure(hook) : [];
const runner = stamp
  ? MACHINERY.find((f) => f !== stamp && f !== hook && stampCall("write\\b").test(code(f)))
  : undefined;
const markReady = MACHINERY.find((f) => f !== hook && /\bgh pr ready\b/.test(code(f)));

const requiredJson = (() => {
  for (const f of FILES.filter((f) => /^\.github\/.*\.json$/.test(f))) {
    try {
      const v = JSON.parse(show(f) ?? "");
      if (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && ciJobKeys.has(s))) return { path: f, list: v as string[] };
    } catch { /* not this one */ }
  }
  return undefined;
})();

// ------------------------------------------------------------------ GitHub
const slug = slugArg || (() => {
  const u = git("remote", "get-url", "origin").out.trim();
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(u)?.[1] ?? "";
})();
if (slug && !/^[\w.-]+\/[\w.-]+$/.test(slug)) { console.error(`--repo must be owner/name: ${slug}`); process.exit(2); }
// Values from the tree or the API go into printed commands the owner may paste: quote them.
const shq = (s: string) => /^[\w.\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
const gh = (path: string): any => { const r = ghGet(path); if (!r.ok) throw new Error(r.msg); return r.data; };
let ghError = slug ? "" : "no GitHub slug (origin is not a github.com URL; pass --repo)";
let defaultBranch = /\/([\w.-]+)$/.exec(ref)?.[1] ?? "main";
if (defaultBranch === "HEAD") defaultBranch = "main";
let protection: any, repoJson: any, protRes: GhRes | undefined;
if (slug) {
  try { repoJson = gh(`repos/${slug}`); defaultBranch = repoJson.default_branch ?? defaultBranch; } catch (e) { ghError = (e as Error).message; }
  if (repoJson) {
    const org = repoJson.owner?.type === "Organization", wf = (w?: WF) => `actions/workflows/${w ? base(w.path) : ""}/runs`;
    await prefetch([
      `branches/${defaultBranch}/protection`, `rules/branches/${defaultBranch}`, "actions/secrets?per_page=100",
      "vulnerability-alerts", "automated-security-fixes", "actions/permissions", "actions/permissions/workflow",
      "actions/permissions/fork-pr-contributor-approval", "actions/permissions/fork-pr-workflows-private-repos",
      "actions/permissions/artifact-and-log-retention", "private-vulnerability-reporting", "keys", "hooks", "environments",
      `collaborators?affiliation=${org ? "outside" : "direct"}&per_page=100`, "dependabot/alerts?state=dismissed&per_page=100",
      ...(CI && !configOnly ? [`${wf(CI)}?status=completed&per_page=20`, `${wf(CI)}?status=success&per_page=30`] : []),
      ...(DEPLOY && !configOnly ? [`${wf(DEPLOY)}?status=success&per_page=5`] : []),
    ].map((p) => `repos/${slug}/${p}`).concat(org ? `orgs/${repoJson.owner.login}` : "user"));
  }
  protRes = ghGet(`repos/${slug}/branches/${defaultBranch}/protection`);
  if (protRes.ok) protection = protRes.data; else ghError ||= protRes.msg;
}
const protIsBlocked = protRes?.ok === false && protRes.kind === "blocked";

// ------------------------------------------------------------------ checks
const rows: Row[] = [];
type Verdict = [Status, string, string?];
const pass = (ev: string): Verdict => ["pass", ev];
/** `fix` is a suggested command or action, printed under Hardening; the audit never runs it. */
const fail = (ev: string, fix?: string): Verdict => ["fail", ev, fix];
const na = (ev: string): Verdict => ["n.a.", ev];
let section: Section = "ci";
// Add-ons a repo adopts (SKILL.md "Add-ons"); no file = the full design is audited.
const ADDONS: Record<string, string[]> = {
  "gated-expensive": ["ready-for-review", "expensive-gated", "browser-job", "matrix-aggregate", "gate-tests"],
  classifier: ["classifier-tracked", "classifier-shared"],
  "local-stamps": ["hook-tiers", "mark-ready-gate", "stamp-covers-suite", "hook-strips-git-env", "local-refuses-bun", "local-refuses-node"],
  deploy: ["concurrency-deploy", "deploy-split", "deploy-live-range", "deploy-cli-locked", "deploy-sha-meta", "deploy-preview"],
};
const DECL = ".github/ci-flow.json";
const declared = (() => {
  if (!TRACKED.has(DECL)) return undefined;
  try { const a = JSON.parse(show(DECL) ?? "")?.addons; return Array.isArray(a) ? a.map(String) : null; } catch { return null; }
})(); // undefined: no file; null: unreadable
const addonOf = (id: string) => Object.keys(ADDONS).find((k) => ADDONS[k].includes(id));
function check(id: string, fn: () => Verdict) {
  if (configOnly && section === "ci") return;
  const ad = addonOf(id);
  if (ad && Array.isArray(declared) && !declared.includes(ad)) { rows.push({ id, status: "n.a.", ev: `add-on ${ad} not adopted (${DECL})`, section }); return; }
  try { const [status, ev, fix] = fn(); rows.push({ id, status, ev, fix, section }); }
  catch (e) {
    if (e instanceof Blocked) rows.push({ id, status: "blocked", ev: e.message, section });
    else rows.push({ id, status: "fail", ev: `could not determine: ${(e as Error).message}`, section });
  }
}
const needCI = () => { if (!CI) throw new Error("no workflow with a pull_request trigger"); return CI; };

check("workflows-parse", () => (parseErrors.length ? fail(parseErrors.join("; ")) : pass(`${WFS.length} workflow(s) parsed`)));
// The declaration narrows what is checked; it must never hide a job the tree has.
check("addons-declared", () => {
  if (declared === undefined) return pass(`no ${DECL}: the full design is audited`);
  if (declared === null) return fail(`${DECL}: not JSON with an "addons" array`);
  const unknown = declared.filter((a) => !(a in ADDONS));
  const heavyJob = ciJobs.find((x) => isExpensive(x) || BROWSER.test(runOf(x.j)));
  const m = [unknown.length ? `unknown add-on(s): ${unknown.join(", ")} (known: ${Object.keys(ADDONS).join(", ")})` : "",
    heavyJob && !declared.includes("gated-expensive") ? `job ${heavyJob.id} is expensive but gated-expensive is not declared` : "",
    DEPLOY && !declared.includes("deploy") ? `${DEPLOY.path} deploys but deploy is not declared` : ""].filter(Boolean);
  return m.length ? fail(`${DECL}: ${m.join("; ")}`) : pass(`${DECL}: ${declared.join(", ") || "no add-ons"} (others n.a.)`);
});

// 1. Trigger once per change.
check("trigger-once", () => {
  const ci = needCI();
  const push = ci.on.push;
  if (!("push" in ci.on)) return pass(`${ci.path}: pull_request only`);
  const br = [push?.branches ?? []].flat();
  if (br.length === 0) return fail(`${at(ci.path, /^\s*push:/)}: push has no branches filter (every branch push runs beside its PR)`);
  const other = br.filter((b: string) => b !== defaultBranch);
  return other.length ? fail(`${at(ci.path, /^\s*push:/)}: push also on ${other.join(", ")}`) : pass(`${at(ci.path, /^\s*push:/)}: push on ${defaultBranch} only`);
});
check("ready-for-review", () => {
  const ci = needCI();
  const t = [ci.on.pull_request?.types ?? []].flat();
  if (!t.length) return fail(`${ci.path}: pull_request has no types (defaults omit ready_for_review, so marking ready runs nothing)`);
  return t.includes("ready_for_review") ? pass(at(ci.path, /types:/)) : fail(`${at(ci.path, /types:/)}: no ready_for_review`);
});
// 2. Cancel superseded runs.
check("concurrency-ci", () => {
  const ci = needCI();
  const c = ci.y.concurrency;
  const g = String(c?.group ?? ""), cip = c?.["cancel-in-progress"];
  if (!/github\.ref/.test(g)) return fail(`${ci.path}: no workflow-level concurrency group keyed on github.ref`);
  if (cip === true || (typeof cip === "string" && /true|pull_request/.test(cip))) return pass(at(ci.path, /cancel-in-progress/));
  return fail(`${at(ci.path, /cancel-in-progress|concurrency/)}: cancel-in-progress is ${JSON.stringify(cip)}`);
});
check("concurrency-deploy", () => {
  if (!DEPLOY) return na("no deploy workflow");
  const cip = DEPLOY.y.concurrency?.["cancel-in-progress"];
  return cip === false ? pass(at(DEPLOY.path, /cancel-in-progress/)) : fail(`${DEPLOY.path}: deploy concurrency cancel-in-progress is ${JSON.stringify(cip)} (must be false)`);
});
// 3. No workflow-level path filter on the workflow providing required checks.
check("no-workflow-paths-filter", () => {
  const ci = needCI();
  const bad = ["push", "pull_request"].filter((e) => ci.on[e] && (ci.on[e].paths || ci.on[e]["paths-ignore"]));
  return bad.length ? fail(`${at(ci.path, /paths(-ignore)?:/)}: ${bad.join(", ")} filtered at workflow level (a required check would stay pending)`) : pass(`${ci.path}: no paths/paths-ignore`);
});
// 4. Bound every job.
check("timeouts", () => {
  const miss = WFS.flatMap((w) => jobsOf(w).filter((x) => !x.j?.uses && x.j?.["timeout-minutes"] == null).map((x) => `${w.path}#${x.id}`));
  return miss.length ? fail(`no timeout-minutes: ${miss.join(", ")}`) : pass(`every job in ${WFS.length} workflow(s)`);
});
// 5. Least privilege, pinned actions.
check("permissions-top", () => {
  const bad = WFS.filter((w) => {
    const p = w.y?.permissions;
    if (p == null) return true;
    if (typeof p === "string") return p !== "read-all" && p !== "{}";
    return Object.values(p).some((v) => v !== "read" && v !== "none");
  }).map((w) => w.path);
  return bad.length ? fail(`top-level permissions missing or wider than read: ${bad.join(", ")}`) : pass(`${WFS.length} workflow(s) read-only at top level`);
});
check("actions-sha-pinned", () => {
  const bad: string[] = [];
  for (const { w, u } of USES) if (!/@[0-9a-f]{40}$/.test(u)) bad.push(`${at(w.path, new RegExp(esc(u)))} ${u}`);
  return bad.length ? fail(firstN(bad, 4, "; ")) : pass("every action pinned to a commit sha");
});
// 6. One tracked classifier, shared by CI, the hook and the local run.
check("classifier-tracked", () => {
  if (!scopeJob) return fail(`${CI?.path ?? "CI"}: no job's outputs gate another job (no classifier)`);
  if (!classifier) return fail(`${CI!.path}#${scopeJob.id}: scope output is not written by a tracked script (inline or missing)`);
  return TRACKED.has(classifier) ? pass(`${at(CI!.path, new RegExp(esc(classifier)))} runs ${classifier}`) : fail(`${classifier} is not tracked`);
});
check("classifier-shared", () => {
  if (!classifier) return fail("no classifier found");
  // An INVOCATION, not a mention: the stamp listing the classifier in its hash is not the hook using it.
  const b = new RegExp(`\\b(node|bun)\\s[^\\n]*${esc(base(classifier))}`);
  const inHook = hookSet.some((p) => b.test(code(p)));
  // The full run either classifies itself or is told its mode by a caller that does (the hook, mark-ready).
  const local = [runner, markReady].filter((p): p is string => !!p).find((p) => closure(p).some((q) => b.test(code(q))));
  const miss = [!hook ? "no pre-push hook" : !inHook ? `hook ${hook}` : "", local ? "" : `the full-run path (${[runner, markReady].filter(Boolean).join(", ") || "none found"})`].filter(Boolean);
  return miss.length ? fail(`${base(classifier)} not invoked by: ${miss.join(", ")}`) : pass(`CI, ${hook} and ${local} all run ${base(classifier)}`);
});
// 7. The cheap ungated job: range gitleaks (pinned + sha256) and the audit.
check("cheap-secret-scan", () => {
  const ci = needCI();
  for (const x of ciJobs) for (const s of stepsOf(x.j)) {
    const r = String(s?.run ?? "");
    if (!/gitleaks/.test(r)) continue;
    const where = at(ci.path, /gitleaks git|gitleaks detect/);
    const miss = [isExpensive(x) || s.if ? "job or step is gated" : "", /sha256sum -c|shasum -a 256 -c/.test(r) ? "" : "no sha256 check",
      /releases\/download\/v[\d$]/.test(r) ? "" : "no pinned release", /--log-opts/.test(r) ? "" : "not a range scan (--log-opts)"].filter(Boolean);
    return miss.length ? fail(`${where}: ${miss.join(", ")}`) : pass(`${where} (job ${x.id})`);
  }
  return fail(`${ci.path}: no gitleaks step`);
});
check("audit-ungated", () => {
  const ci = needCI();
  if (!FILES.some((f) => !f.includes("node_modules/") && /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f)))
    return na("no package manifest or lockfile: nothing to audit");
  for (const x of ciJobs) for (const s of stepsOf(x.j)) {
    if (!/\b(bun|npm|pnpm|yarn)\s+audit\b/.test(String(s?.run ?? ""))) continue;
    const where = at(ci.path, /\b(bun|npm|pnpm|yarn)\s+audit\b/);
    if (isExpensive(x) || /pull_request/.test(ifOf(x.j))) return fail(`${where}: audit runs in gated job ${x.id}`);
    if (s.if) return fail(`${where}: audit step has if: ${s.if}`);
    return pass(`${where} (job ${x.id}, ungated)`);
  }
  return fail(`${ci.path}: no dependency audit step`);
});
// 8. Expensive jobs: PR event AND not draft AND scope, behind a cheap job.
check("expensive-gated", () => {
  const ci = needCI();
  const ex = ciJobs.filter(isExpensive);
  if (!ex.length) return fail(`${ci.path}: no job is gated on draft (expensive jobs run on every event)`);
  const bad = ex.flatMap((x) => {
    const i = ifOf(x.j), m: string[] = [];
    if (!DRAFT.test(i)) m.push("no !draft");
    if (!PR_EVENT.test(i)) m.push("no event_name == 'pull_request' (!draft alone is true on push)");
    if (!/needs\.[\w-]+\.outputs\./.test(i)) m.push("no scope condition");
    if (!needsOf(x.j).length) m.push("no needs");
    return m.length ? [`${x.id}: ${m.join(", ")}`] : [];
  });
  return bad.length ? fail(`${ci.path}: ${bad.join("; ")}`) : pass(`${ex.map((x) => x.id).join(", ")} gated`);
});
check("browser-job", () => {
  const ci = needCI();
  // A push-only job that only warms the browser cache runs no tests (cache-default-branch).
  const pushOnly = (x: Job) => /event_name\s*==\s*['"]push['"]/.test(ifOf(x.j)) && !PR_EVENT.test(ifOf(x.j));
  const b = ciJobs.filter((x) => BROWSER.test(runOf(x.j)) && !pushOnly(x));
  if (!b.length) return na("no browser job");
  const bad = b.flatMap((x) => {
    const m: string[] = [];
    if (!isExpensive(x) || !PR_EVENT.test(ifOf(x.j))) m.push("not PR-only/ready-only");
    if (!/needs\.[\w-]+\.outputs\./.test(ifOf(x.j))) m.push("not path scoped");
    if (!caches(x, /ms-playwright/)) m.push("browsers not cached");
    return m.length ? [`${x.id}: ${m.join(", ")}`] : [];
  });
  return bad.length ? fail(`${ci.path}: ${bad.join("; ")}`) : pass(`${b.map((x) => x.id).join(", ")}: PR-only, scoped, cached`);
});
check("install-cache", () => {
  const bad = ciJobs.filter((x) => /\bbun install\b/.test(runOf(x.j)) &&
    !caches(x, /\.bun\/install\/cache/)).map((x) => x.id);
  if (!ciJobs.some((x) => /\bbun install\b/.test(runOf(x.j)))) return na("no bun install in CI");
  return bad.length ? fail(`${CI!.path}: bun install without a ~/.bun/install/cache cache in ${bad.join(", ")}`) : pass("every bun install job caches ~/.bun/install/cache");
});
// A cache is ref-scoped: a PR restores from its own ref and the default branch,
// never from another PR. A cache saved only by PR-gated jobs is a fresh download
// on every PR (a sibling repo, 2026-11-04: 279 MB of browsers, ~17 x 115 MB of
// tool caches, one per PR ref). Steps that save: actions/cache, and setup-*
// with `cache:` / `enable-cache:`.
// shortcut: a job counts as running on the push when its `if:` is empty or names
// push / github.ref; a job gated another way is not seen as a writer.
const cacheIdOf = (s: any): string | undefined => {
  const u = String(s?.uses ?? "").replace(/@.*/, "");
  if (u === "actions/cache" || u === "actions/cache/save") return String(s?.with?.path ?? "").trim() || undefined;
  if (/\/setup-/.test(u) && (s?.with?.cache || s?.with?.["enable-cache"])) return u;
  return undefined;
};
check("cache-default-branch", () => {
  const ci = needCI();
  const cached = ciJobs.flatMap((x) => stepsOf(x.j).map(cacheIdOf).filter(Boolean).map((id) => ({ id: id!, job: x })));
  if (!cached.length) return na("no cache step in CI");
  const onPush = (x: Job) => "push" in ci.on && (!ifOf(x.j) || /\bpush\b|github\.ref\b/.test(ifOf(x.j)));
  const writers = new Set(cached.filter((c) => onPush(c.job)).map((c) => c.id));
  const bad = [...new Set(cached.filter((c) => !writers.has(c.id)).map((c) => `${c.job.id}: ${c.id}`))];
  return bad.length
    ? fail(`${ci.path}: saved only by PR-gated jobs, so no other PR can restore it: ${firstN(bad, 4, "; ")}`)
    : pass(`every cache is also written on the ${defaultBranch} push`);
});
// 9. A gated matrix is never a required check; an always() aggregate stands in.
check("matrix-aggregate", () => {
  const ms = ciJobs.filter((x) => x.j?.strategy?.matrix && x.j?.if);
  if (!ms.length) return na("no gated matrix job");
  const req = new Set([...(requiredJson?.list ?? []), ...((protection?.required_status_checks?.checks ?? []).map((c: any) => c.context))]);
  const bad = ms.flatMap((x) => {
    const m: string[] = [];
    if (req.has(x.id) || req.has(nameOf(x))) m.push(`required (a skipped matrix reports "${nameOf(x)}" unexpanded)`);
    if (!ciJobs.some((a) => needsOf(a.j).includes(x.id) && /always\(\)/.test(ifOf(a.j)))) m.push("no always() aggregate needs it");
    return m.length ? [`${x.id}: ${m.join(", ")}`] : [];
  });
  return bad.length ? fail(`${CI!.path}: ${bad.join("; ")}`) : pass(`${ms.map((x) => x.id).join(", ")} aggregated, not required`);
});
// 10. Required checks declared in the tree, applied by script, matching live.
check("required-declared", () =>
  requiredJson ? pass(`${requiredJson.path}: ${requiredJson.list.join(", ")}`) : fail("no tracked .github/*.json listing CI job names"));
check("protect-script", () => {
  const f = MACHINERY.find((f) => /\/protection\b/.test(code(f)) && /\bPUT\b/.test(code(f)));
  if (!f) return fail("no tracked script PUTs branch protection");
  const t = show(f) ?? "";
  const miss = [requiredJson && t.includes(base(requiredJson.path)) ? "" : "does not read the declared list", /dry-run/.test(t) ? "" : "no dry-run",
    /read.?back|back=|readback/i.test(t) ? "" : "no read-back"].filter(Boolean);
  return miss.length ? fail(`${f}: ${miss.join(", ")}`) : pass(`${f}: dry-run, PUT from ${base(requiredJson!.path)}, read-back`);
});
const protBlocked = () => { if (protIsBlocked) throw new Blocked("this plan gives a private repo no branch protection — see plan-protection"); };
check("protection-live", () => {
  protBlocked();
  if (!protection) return fail(ghError || "protection not readable");
  const p = protection, rs = p.required_status_checks, checks = rs?.checks ?? [];
  const m = [rs?.strict === true ? "" : "strict off", p.enforce_admins?.enabled ? "" : "admins not included", p.allow_force_pushes?.enabled === false ? "" : "force-push allowed",
    p.allow_deletions?.enabled === false ? "" : "deletion allowed", p.required_pull_request_reviews ? "" : "no PR required",
    checks.length ? "" : "no required checks", checks.every((c: any) => c.app_id === 15368) ? "" : "a check not pinned to app 15368"].filter(Boolean);
  return m.length ? fail(`${slug} ${defaultBranch}: ${m.join(", ")}`) : pass(`${slug} ${defaultBranch}: strict, admins, PR, no force-push/delete, ${checks.length} checks @15368`);
});
check("protection-matches-declared", () => {
  protBlocked();
  if (!protection) return fail(ghError || "protection not readable");
  if (!requiredJson) return fail("nothing declared in the tree to compare with");
  const live = (protection.required_status_checks?.checks ?? []).map((c: any) => c.context).sort();
  const want = [...requiredJson.list].sort();
  return JSON.stringify(live) === JSON.stringify(want) ? pass(`live = ${requiredJson.path}`) : fail(`live [${live}] vs declared [${want}]`);
});
// 11. Exact toolchain pins, guarded by a test, refused locally.
const pins = (key: string) => WFS.flatMap((w) => jobsOf(w).flatMap((x) => stepsOf(x.j).map((s) => s?.with?.[key]).filter((v) => v != null).map((v) => ({ v: String(v), w: w.path }))));
check("toolchain-exact", () => {
  const out: string[] = [], bad: string[] = [];
  for (const k of ["bun-version", "node-version"]) {
    const ps = pins(k);
    if (!ps.length) continue;
    const vals = [...new Set(ps.map((p) => p.v))];
    const loose = vals.filter((v) => !/^\d+\.\d+\.\d+$/.test(v));
    if (loose.length) bad.push(`${k} ${loose.join("/")} (${at(ps[0].w, new RegExp(`${k}:\\s*['"]?${esc(loose[0])}`))})`);
    else if (vals.length > 1) bad.push(`${k} has ${vals.length} different pins: ${vals.join(", ")}`);
    else out.push(`${k} ${vals[0]}`);
  }
  if (!bad.length && !out.length) return na("no setup-bun/setup-node version in any workflow");
  return bad.length ? fail(bad.join("; ")) : pass(out.join(", "));
});
// An exact pin in SOME job says nothing about the others: a job that runs node
// without setup-node runs the runner image's node, which moves when GitHub
// updates the image (a sibling repo, 2026-11-01: pinned in browser, floating in checks
// and integration, and toolchain-exact passed).
// shortcut: reads `run:` text only, so node called from inside a script is not seen.
const INVOKES = { node: /(^|[\s;&|(`$])(node|npm|npx)\s/m, bun: /(^|[\s;&|(`$])(bun|bunx)\s/m } as const;
check("toolchain-every-job", () => {
  const bad: string[] = [], seen: string[] = [];
  for (const [tool, key] of [["node", "node-version"], ["bun", "bun-version"]] as const) {
    if (!pins(key).length) continue;
    seen.push(tool);
    for (const w of WFS) for (const x of jobsOf(w)) {
      if (!INVOKES[tool].test(runOf(x.j))) continue;
      if (!stepsOf(x.j).some((s) => s?.with?.[key] != null)) bad.push(`${w.path}#${x.id} runs ${tool} without ${key}`);
    }
  }
  if (!seen.length) return na("nothing pinned");
  return bad.length ? fail(firstN(bad, 5, "; ")) : pass(`every job running ${seen.join("/")} sets its pinned version`);
});
check("toolchain-guard-test", () => {
  const keys = ["bun-version", "node-version"].filter((k) => pins(k).length);
  if (!keys.length) return na("nothing pinned");
  const t = FILES.find((f) => isTest(f) && keys.every((k) => (show(f) ?? "").includes(k)) && /latest/.test(show(f) ?? ""));
  return t ? pass(`${t} asserts ${keys.join(" + ")}`) : fail(`no test asserts ${keys.join(" + ")} exact (refusing latest)`);
});
for (const [tool, key] of [["bun", "bun-version"], ["node", "node-version"]] as const) {
  check(`local-refuses-${tool}`, () => {
    if (!pins(key).length) return na(`${key} not pinned`);
    if (!runner) return fail("no local runner (nothing calls `<stamp> write`)");
    const t = textOf(closure(runner, 1));
    const reads = t.includes(key), probes = new RegExp(`\\b${tool} (--version|-v)\\b|process\\.version`).test(t);
    return reads && probes ? pass(`${at(runner, new RegExp(`${tool} (--version|-v)`))} compares with ${key}`) : fail(`${runner}: ${!reads ? `never reads ${key}` : `never checks \`${tool} --version\``}`);
  });
}
// 12. Local tiers: hook, stamp, mark-ready; git env stripped.
check("hook-tiers", () => {
  if (!hook) return fail("no tracked pre-push hook");
  const t = textOf(hookSet);
  const m = [/isDraft/.test(t) ? "" : "never asks gh for isDraft", stamp && stampCall("check").test(t) ? "" : "never checks a stamp"].filter(Boolean);
  return m.length ? fail(`${hook}: ${m.join(", ")}`) : pass(`${hook}: draft/ready tiers, stamp check`);
});
check("mark-ready-gate", () => {
  if (!markReady) return fail("no tracked script runs `gh pr ready`");
  return stamp && stampCall("check").test(code(markReady)) ? pass(`${at(markReady, /gh pr ready/)} after a stamp check`) : fail(`${markReady}: gh pr ready without a stamp check`);
});
check("stamp-covers-suite", () => {
  if (!stamp) return fail("no stamp script (nothing hashes a tree)");
  const covered = new Set(refsIn(stamp).concat(stamp));
  const want = [["classifier", classifier], ["CI workflow", CI?.path], ["hook", hook], ["local runner", runner]] as const;
  const miss = want.filter(([, p]) => !p || !covered.has(p)).map(([n, p]) => `${n}${p ? ` (${p})` : ""}`);
  const extra = markReady && !covered.has(markReady) ? ` [advisory: ${markReady} not hashed]` : "";
  return miss.length ? fail(`${stamp} hash omits: ${miss.join(", ")}${extra}`) : pass(`${stamp} hashes classifier, CI, hook, runner${extra}`);
});
check("hook-strips-git-env", () => {
  if (!hook) return fail("no tracked pre-push hook");
  return /--local-env-vars/.test(textOf(hookSet)) ? pass(at(hook, /--local-env-vars/)) : fail(`${hook}: does not unset $(git rev-parse --local-env-vars)`);
});
check("tests-hermetic-git", () => {
  const spawning = FILES.filter((f) => isTest(f) && /git(["'],\s*\[\s*["']|\s+)init\b/.test(show(f) ?? ""));
  if (!spawning.length) return na("no test makes its own git repo");
  const strip = FILES.find((f) => /test/.test(f) && /startsWith\(\s*["']GIT_["']\s*\)|\^GIT_|local-env-vars/.test(show(f) ?? ""));
  return strip ? pass(`${strip} strips GIT_* (${spawning.length} test file(s) run git init)`) : fail(`${spawning.length} test file(s) run git init; none strips GIT_* from the env`);
});
// A browser test waits for the condition, never a proxy of it: an idle network
// stood in for hydration and held a runner past 30 s; a fixed sleep raced a
// fade. Comment lines are dropped, so a comment naming the old wait is fine.
check("browser-wait-proxy", () => {
  // A Playwright file IMPORTS it at the start of a line; the word inside a string (a test fixture) is not one.
  const PW_IMPORT = /^\s*(import\b[^\n]*from\s*["'](playwright|@playwright\/test)["']|(const|let|var)\b[^\n]*=\s*require\(\s*["'](playwright|@playwright\/test)["']\))/m;
  const pw = FILES.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.includes("node_modules/") && PW_IMPORT.test(code(f)) && /\bpage\.\w/.test(show(f) ?? ""));
  if (!pw.length) return na("no Playwright test files");
  const PROXY = /waitForLoadState\(\s*["']networkidle|waitUntil:\s*["']networkidle|\.waitForTimeout\(/;
  const bad = pw.filter((f) => PROXY.test(code(f))).map((f) => at(f, PROXY));
  return bad.length ? fail(`waits on a proxy (networkidle or a fixed timeout): ${firstN(bad, 4, ", ")}`) : pass(`${pw.length} Playwright file(s), no networkidle or fixed-timeout waits`);
});
check("gate-tests", () => {
  const t = FILES.find((f) => isTest(f) && /pull_request\.draft/.test(show(f) ?? "") && /event_name/.test(show(f) ?? "") && /\.github\/workflows|ci\.ya?ml/.test(show(f) ?? ""));
  return t ? pass(`${t} asserts the draft + event gate`) : fail("no test parses the CI workflow and asserts the draft + event_name gate");
});
// 13. Deploy: three jobs, live-sha range, locked CLI, sha meta, preview.
check("deploy-split", () => {
  if (!DEPLOY) return na("no deploy workflow");
  const js = jobsOf(DEPLOY), uses = (x: Job, re: RegExp) => stepsOf(x.j).some((s) => re.test(String(s?.uses ?? "")));
  const secret = (x: Job) => /secrets\./.test(JSON.stringify(x.j));
  const token = js.find((x) => secret(x) && !uses(x, /actions\/checkout/) && JSON.stringify(x.j.permissions) === "{}");
  const scope = js.find((x) => !secret(x) && !x.j.environment && stepsOf(x.j).some((s) => /actions\/checkout/.test(String(s?.uses ?? "")) && s?.with?.["fetch-depth"] === 0 && s?.with?.["persist-credentials"] === false));
  const dep = js.find((x) => scope && needsOf(x.j).includes(scope.id) && new RegExp(`needs\\.${esc(scope.id)}\\.(outputs|result)`).test(ifOf(x.j)));
  const m = [token ? "" : "no token job (secrets, permissions: {}, no checkout)", scope ? "" : "no secret-free scope job (full fetch, persist-credentials: false)", dep ? "" : "deploy job not gated on the scope job"].filter(Boolean);
  return m.length ? fail(`${DEPLOY.path}: ${m.join("; ")}`) : pass(`${DEPLOY.path}: ${token!.id} -> ${scope!.id} -> ${dep!.id}`);
});
check("deploy-live-range", () => {
  if (!DEPLOY) return na("no deploy workflow");
  const ds = MACHINERY.find((f) => f !== hook && /merge-base --is-ancestor/.test(code(f)) && DEPLOY.text.includes(base(f)));
  if (/(?<![\w.])HEAD[~^]1\b/.test(runOf({ steps: jobsOf(DEPLOY).flatMap((x) => stepsOf(x.j)) }))) return fail(`${at(DEPLOY.path, /HEAD[~^]1/)}: deploy judges HEAD^1 (a docs merge after a code merge skips the code)`);
  return ds ? pass(`${ds}: judges live..HEAD, ancestor-checked`) : fail(`${DEPLOY.path}: no deploy-scope script judging the live sha (merge-base --is-ancestor)`);
});
check("deploy-cli-locked", () => {
  if (!DEPLOY) return na("no deploy workflow");
  const t = DEPLOY.text;
  const lock = DEPLOY_LOCKS[0];
  const m = [/\bnpx\s+[\w@/.-]+@\d/.test(t) ? "npx <pkg>@<version> (transitives float)" : "", lock ? "" : "no committed lockfile dir the workflow names",
    /npm ci\b[^\n]*--ignore-scripts/.test(t) ? "" : "no npm ci --ignore-scripts", /registry\.npmjs\.org/.test(t) && /integrity/.test(t) ? "" : "no resolved/integrity check"].filter(Boolean);
  return m.length ? fail(`${DEPLOY.path}: ${m.join(", ")}`) : pass(`${lock}: npm ci --ignore-scripts, registry + integrity checked`);
});
check("deploy-sha-meta", () => {
  if (!DEPLOY) return na("no deploy workflow");
  return /--meta\s+["']?\w+Sha=/.test(DEPLOY.text) ? pass(at(DEPLOY.path, /--meta\s+["']?\w+Sha=/)) : fail(`${DEPLOY.path}: deploy records no <name>Sha meta`);
});
check("deploy-preview", () => {
  if (!DEPLOY) return na("no deploy workflow");
  const opts = [DEPLOY.on.workflow_dispatch?.inputs?.target?.options ?? []].flat();
  return opts.includes("preview") ? pass(at(DEPLOY.path, /preview/)) : fail(`${DEPLOY.path}: no workflow_dispatch target: preview`);
});
// 14. Red CI is a defect.
const ciFile = CI ? base(CI.path) : "";
check("ci-red-rate", () => {
  if (!slug) throw new Error(ghError);
  const rs = gh(`repos/${slug}/actions/workflows/${ciFile}/runs?status=completed&per_page=20`).workflow_runs ?? [];
  if (!rs.length) return fail("no completed runs to judge");
  const red = rs.filter((r: any) => r.conclusion === "failure");
  const onMain = red.filter((r: any) => r.event === "push").length;
  const ev = `${red.length} of the last ${rs.length} completed runs failed (${onMain} on ${defaultBranch} push, ${red.length - onMain} on PRs)`;
  return red.length > 3 ? fail(ev) : pass(ev);
});

// 15. Dependabot — a repository setting as much as CI, so it runs with --config-only too.
section = "config";
const dbPath = FILES.find((f) => /^\.github\/dependabot\.ya?ml$/.test(f));
const db = (() => { try { return dbPath ? (Bun.YAML.parse(show(dbPath) ?? "") as any) : undefined; } catch { return undefined; } })();
const updates: any[] = db?.updates ?? [];
check("dependabot-ecosystems", () => {
  if (!db) return fail("no parseable .github/dependabot.yml", "add .github/dependabot.yml: github-actions (grouped, weekly) plus each package ecosystem the repo uses");
  const eco = (e: string, d?: string) => updates.some((u) => u["package-ecosystem"] === e && (!d || String(u.directory).replace(/\/$/, "") === d));
  const lockDirs = DEPLOY_LOCKS.map((f) => `/${dir(f)}`);
  const m = [eco("github-actions") ? "" : "no github-actions", TRACKED.has("bun.lock") && !eco("bun") ? "bun.lock but no bun ecosystem" : "",
    ...lockDirs.filter((d) => !eco("npm", d)).map((d) => `no npm entry for ${d}`)].filter(Boolean);
  return m.length ? fail(`${dbPath}: ${m.join(", ")}`) : pass(`${dbPath}: ${updates.map((u) => `${u["package-ecosystem"]}${u.directory !== "/" ? ` ${u.directory}` : ""}`).join(", ")}`);
});
check("dependabot-actions-grouped", () => {
  const u = updates.find((u) => u["package-ecosystem"] === "github-actions");
  if (!u) return fail("no github-actions entry");
  return u.groups && Object.keys(u.groups).length ? pass(`${dbPath}: github-actions grouped`) : fail(`${at(dbPath!, /github-actions/)}: github-actions not grouped (one full CI run per action bump)`);
});
// A dismissal with no reason is a suppression: nobody can tell later whether it
// was a decision or a click. shortcut: first 100 dismissed alerts only.
check("alert-dismissal-reason", () => {
  if (!slug) throw new Error(ghError);
  const ds: any[] = gh(`repos/${slug}/dependabot/alerts?state=dismissed&per_page=100`);
  const bare = ds.filter((a) => !String(a?.dismissed_comment ?? "").trim()).map((a) => `#${a.number} ${a.dependency?.package?.name ?? ""}`.trim());
  if (!ds.length) return pass("no dismissed alerts");
  return bare.length ? fail(`${bare.length} of ${ds.length} dismissed alert(s) carry no reason: ${bare.slice(0, 5).join(", ")}`) : pass(`${ds.length} dismissed alert(s), each with a reason`);
});

// ------------------------------------------------- repository configuration
// Settings live outside the tree (POLICY.md §2). Each row is judged against
// what the owner's PLAN gives a repo of this VISIBILITY (GitHub docs, checked
// 2026-11-02) and against what the PROJECT needs, read from its tree:
//   plan × visibility lacks it, project needs it  -> blocked, naming the options
//   plan × visibility lacks it, project does not  -> n.a., saying why
//   available but not set                         -> FAIL, with the fix command
// The owner's private folder labels (POLICY.md §2), one per line, kept outside any repo. No file: nothing matches.
const PREFIX_WORDS = (() => {
  try {
    return readFileSync(process.env.CI_FLOW_PREFIXES_FILE ?? `${process.env.HOME}/.config/ci-flow/private-prefixes`, "utf8").split("\n").map((s) => s.trim().replace(/[-_]$/, "")).filter(Boolean);
  } catch {
    return [];
  }
})();
const PREFIX = PREFIX_WORDS.length ? new RegExp(`^(${PREFIX_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[-_]`, "i") : /(?!)/;
const isPublic = repoJson?.private === false;
const visibility = repoJson ? (isPublic ? "public" : "private") : "unknown";
const owner: string = repoJson?.owner?.login ?? slug.split("/")[0] ?? "";
const isOrg = repoJson?.owner?.type === "Organization";
const needRepo = () => { if (!repoJson) throw new Error(ghError || "repository not readable"); return repoJson; };
const refuse = (r: GhRes & { ok: false }): never => { if (r.kind === "blocked") throw new Blocked(r.msg); throw new Error(r.msg); };
const must = (r: GhRes) => (r.ok ? r.data : refuse(r));
const R = (p: string) => ghGet(`repos/${slug}/${p}`);

// The plan of a user account is readable only by that user with the `user` scope;
// a private repo refused protection "with an upgrade message" is on Free.
const ownerRes = !slug || !repoJson ? undefined : isOrg ? ghGet(`orgs/${owner}`) : ghGet("user");
const ownerData = ownerRes?.ok && (isOrg || ownerRes.data?.login === owner) ? ownerRes.data : undefined;
let plan = planOf(ownerData?.plan?.name), planSource = plan ? (isOrg ? `orgs/${owner}` : "the account's own plan") : "";
if (!plan && !isPublic && protIsBlocked) {
  plan = "free"; planSource = "inferred: GitHub refuses protection on this private repo with an upgrade message";
}
const CAPS = capsFor(plan, isPublic);
let minutesWarn = "";

// What the project needs, from its tree and its secrets.
const DEPLOYISH = /DEPLOY|VERCEL|NETLIFY|CLOUDFLARE|CF_API|FLY_|RENDER|RAILWAY|AWS|GCP|GOOGLE|AZURE|HEROKU|SSH|KUBE/i;
const secRes = slug && repoJson ? R("actions/secrets?per_page=100") : undefined;
const repoSecrets: string[] = secRes?.ok ? (secRes.data?.secrets ?? []).map((s: any) => String(s.name)) : [];
const deploySecrets = repoSecrets.filter((n) => DEPLOYISH.test(n));
const needsGate = !!CI, needsEnv = !!DEPLOY || deploySecrets.length > 0;
const heavy = ciJobs.filter((x) => isExpensive(x) || BROWSER.test(runOf(x.j))).map((x) => x.id);
const OPTIONS = isOrg
  ? `upgrade the ${owner} org to Team`
  : "(a) move the repo to the Team org — owner rule: when it gains a deploy credential or an expensive required job; " +
    "(b) Pro, US$4/month, covers every private repo of this account; (c) make it public — a one-way door " +
    "(POLICY.md §2: full-history gitleaks, no client data); (d) accept the risk this row names";

check("plan-detected", () => {
  needRepo();
  const mins = isPublic ? "free on standard runners" : plan ? `${QUOTA[plan]} Linux min/month${isOrg ? " shared by the org" : ""}` : "?";
  const caps = `protection ${CAPS.protection ? "yes" : "no"}, environments ${CAPS.environments ? "yes" : "no"}, secret scanning ${CAPS.secretScanning}, CodeQL ${CAPS.codeql}, Actions ${mins}`;
  if (plan) return pass(`${plan} (${planSource}); a ${visibility} repo gets: ${caps}`);
  if (isPublic) return pass(`plan not readable; a public repo gets: ${caps}`);
  return fail(`plan not readable for a private repo (${ownerRes && !ownerRes.ok ? ownerRes.msg : "no plan field"})`,
    isOrg ? `read orgs/${owner} with an org-owner token` : "gh auth refresh -h github.com -s user");
});
const planRow = (has: boolean, need: boolean, what: string, why: string, risk: string): Verdict => {
  needRepo();
  if (!isPublic && !plan) throw new Error("plan unknown — see plan-detected");
  const on = isPublic ? "public repos" : `${plan} private repos`;
  if (has) return pass(`${what}: available on ${on}`);
  if (!need) return na(`${what}: not on ${on}; not needed (${why})`);
  return ["blocked", `${what}: not on ${on}, and needed (${why}). Without it: ${risk}`, OPTIONS];
};
check("plan-protection", () => planRow(CAPS.protection, needsGate, "branch protection / rulesets",
  needsGate ? `${CI!.path} runs on pull requests` : "no pull-request workflow to gate merges on",
  "CI only reports, merges never wait for it, the default branch can be force-pushed or deleted, and a main-push rerun finds a broken merge only after it lands"));
check("plan-environments", () => planRow(CAPS.environments, needsEnv, "environments + environment secrets",
  DEPLOY ? `${DEPLOY.path} deploys` : deploySecrets.length ? `deploy-like repository secret(s): ${deploySecrets.join(", ")}` : "no deploy workflow or deploy-like secret",
  "deploy credentials are repository secrets that a workflow on any branch can read"));
check("plan-minutes", () => {
  needRepo();
  if (isPublic) return pass("public repo: standard GitHub-hosted runners are free");
  if (!plan) throw new Error("plan unknown — see plan-detected");
  const u = minutesOf(owner, isOrg, plan);
  const ev = `${u.month}: this repo ${u.byRepo(repoJson.name)} min, ${u.line}${heavy.length ? `; expensive jobs: ${heavy.join(", ")}` : ""}`;
  minutesWarn = u.warn;
  if (u.warn && !(Number(u.budget) > 0))
    return fail(`${ev} — Actions stops at the quota`, isOrg
      ? `set an Actions budget with stop-usage on: https://github.com/organizations/${owner}/settings/billing/budgets (an excess Linux minute costs about US$0.006)`
      : "gate expensive jobs to ready PRs and skip docs-only changes (SKILL.md), or Pro for 3,000 min");
  return pass(ev);
});

// Naming lifecycle: see randomName in lib/plans.ts.
// shortcut: a name is "random-looking" by shape only (adjective-noun-digits, or a
// letters-hex id); a meaningful private name that is not a folder label passes —
// whether it leaks the product is the owner's call, not a regex's.
const RANDOMISH = /^[a-z]+-[a-z]+-\d{2,4}$|^[a-z]{1,4}-[0-9a-f]{6,}$/i;
const renameFix = (to: string, why: string) =>
  `${why}: gh repo rename ${to} -R ${slug} && git -C ${shq(repoPath)} remote set-url origin https://github.com/${owner}/${to}.git  # every other clone too; GitHub redirects the old name, do not rely on it`;
check("repo-name", () => {
  const r = needRepo();
  if (PREFIX.test(r.name)) return fail(`${slug}: the name carries a private folder label`, renameFix(randomName(), "rename to a random development name"));
  if (isPublic && RANDOMISH.test(r.name)) return ["pass", `${r.name}: public with a development name`, renameFix("<product-name>", "public now, so the product name can replace the development name")];
  return pass(isPublic ? `${r.name} (public: the product name is fine)` : RANDOMISH.test(r.name) ? `${r.name}: random development name` : `${r.name} — private: keep product, client and folder names out until launch (${randomName()} would do)`);
});
check("merge-hygiene", () => {
  const r = needRepo();
  const methods = ["allow_squash_merge", "allow_merge_commit", "allow_rebase_merge"].filter((k) => r[k] === true);
  const m = [r.delete_branch_on_merge === true ? "" : "merged branches are not deleted", methods.length === 1 ? "" : `${methods.length} merge methods enabled`].filter(Boolean);
  return m.length
    ? fail(`${slug}: ${m.join(", ")}`, `gh api -X PATCH repos/${slug} -F delete_branch_on_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false`)
    : pass(`branches deleted on merge, one merge method (${methods[0].replace(/^allow_|_merge$/g, "")})`);
});
check("dependabot-alerts", () => {
  needRepo();
  const r = R("vulnerability-alerts"); // 204 = on, 404 = off (documented)
  if (r.ok) return pass("Dependabot alerts on");
  return r.kind === "missing" ? fail("Dependabot alerts off", `gh api -X PUT repos/${slug}/vulnerability-alerts`) : refuse(r);
});
check("dependabot-security-updates", () => {
  needRepo();
  const d = must(R("automated-security-fixes"));
  return d?.enabled === true && d?.paused !== true ? pass("on")
    : fail(`Dependabot security updates ${d?.enabled ? "paused" : "off"}`, `gh api -X PUT repos/${slug}/automated-security-fixes`);
});
check("actions-token", () => {
  needRepo();
  const d = must(R("actions/permissions/workflow"));
  const m = [d?.default_workflow_permissions === "read" ? "" : `default GITHUB_TOKEN is ${d?.default_workflow_permissions}`,
    d?.can_approve_pull_request_reviews === false ? "" : "Actions can approve pull requests"].filter(Boolean);
  return m.length
    ? fail(m.join(", "), `gh api -X PUT repos/${slug}/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false`)
    : pass("read-only GITHUB_TOKEN, Actions cannot approve PRs");
});
const usedActions = [...new Set(USES.map(({ u }) => u.split("@")[0].split("/").slice(0, 2).join("/")))].sort();
check("actions-policy", () => {
  needRepo();
  const d = must(R("actions/permissions"));
  if (d?.enabled === false) return pass("Actions disabled for this repo");
  const m = [d?.allowed_actions === "all" ? "any action from any owner may run" : "",
    d?.sha_pinning_required === true ? "" : d?.sha_pinning_required === undefined ? "SHA-pinning policy not returned (unknown)" : "full-SHA pinning not enforced"].filter(Boolean);
  const third = usedActions.filter((a) => /^[\w.-]+\/[\w.-]+$/.test(a) && !/^(actions|github)\//.test(a));
  const scope = isOrg ? `orgs/${owner}` : `repos/${slug}`;
  const fix = `${isOrg ? "ORG-WIDE — pin every repo's actions to SHAs first (actions-sha-pinned), or their CI stops: " : ""}` +
    `gh api -X PUT ${scope}/actions/permissions ${isOrg ? "-f enabled_repositories=all" : "-F enabled=true"} -f allowed_actions=selected -F sha_pinning_required=true` +
    ` && gh api -X PUT ${scope}/actions/permissions/selected-actions -F github_owned_allowed=true -F verified_allowed=false${third.map((a) => ` -f 'patterns_allowed[]=${a}@*'`).join("")}`;
  return m.length ? fail(`${m.join(", ")} (workflows use: ${usedActions.join(", ") || "none"})`, fix) : pass(`allowed: ${d.allowed_actions}, full-SHA pinning enforced`);
});
check("fork-pr-policy", () => {
  needRepo();
  if (isPublic) {
    const p = String(must(R("actions/permissions/fork-pr-contributor-approval"))?.approval_policy);
    return ["first_time_contributors", "all_external_contributors"].includes(p) ? pass(`public: fork PR workflows wait for approval (${p})`)
      : fail(`public: most outside contributors' workflows run without approval (${p})`, `gh api -X PUT repos/${slug}/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors`);
  }
  const d = must(R("actions/permissions/fork-pr-workflows-private-repos"));
  const m = [d?.send_write_tokens_to_workflows ? "fork PRs get a write token" : "", d?.send_secrets_and_variables ? "fork PRs get secrets" : ""].filter(Boolean);
  return m.length
    ? fail(`private: ${m.join(", ")}`, `gh api -X PUT repos/${slug}/actions/permissions/fork-pr-workflows-private-repos -F run_workflows_from_fork_pull_requests=false -F send_write_tokens_to_workflows=false -F send_secrets_and_variables=false -F require_approval_for_fork_pr_workflows=true`)
    : pass(`private: fork PR workflows ${d?.run_workflows_from_fork_pull_requests ? "run without a write token or secrets" : "do not run"}`);
});
check("secret-scanning", () => {
  const r = needRepo();
  if (!isPublic) return na(`private: GitHub secret scanning is ${CAPS.secretScanning} on ${plan ?? "this plan"}; gitleaks stands in (gitleaks-precommit${configOnly ? "" : ", cheap-secret-scan"})`);
  const s = r.security_and_analysis ?? {};
  const off = ["secret_scanning", "secret_scanning_push_protection"].filter((k) => s[k]?.status !== "enabled");
  return off.length ? fail(`public: off: ${off.join(", ")}`, `gh api -X PATCH repos/${slug} ${off.map((k) => `-f 'security_and_analysis[${k}][status]=enabled'`).join(" ")}`)
    : pass("public: secret scanning and push protection on");
});
check("private-vuln-reporting", () => {
  needRepo();
  if (!isPublic) return na("private repo: GitHub offers private vulnerability reporting on public repos only");
  return must(R("private-vulnerability-reporting"))?.enabled === true ? pass("public: on")
    : fail("public: private vulnerability reporting off", `gh api -X PUT repos/${slug}/private-vulnerability-reporting`);
});
check("security-policy", () => {
  needRepo();
  if (!isPublic) return na("private repo: no outside reporters");
  const f = FILES.find((p) => /^(\.github\/|docs\/)?SECURITY\.md$/i.test(p));
  return f ? pass(f) : fail("public repo without SECURITY.md", "add SECURITY.md pointing reporters at GitHub private vulnerability reporting");
});
// Default-branch hygiene for every repo; a repo with CI is judged by the stricter protection-live.
check("branch-baseline", () => {
  needRepo();
  if (!configOnly) return na("judged by protection-live");
  if (protIsBlocked) return na("no protection on this plan for a private repo — see plan-protection");
  const rules = ghGet(`repos/${slug}/rules/branches/${defaultBranch}`);
  const types = new Set(rules.ok ? (rules.data ?? []).map((x: any) => x.type) : []);
  if (["deletion", "non_fast_forward", "pull_request"].every((t) => types.has(t))) return pass(`${defaultBranch}: rulesets block deletion and force-push and require a PR`);
  const fix = `gh api -X PUT repos/${slug}/branches/${shq(defaultBranch)}/protection --input - <<<'{"required_status_checks":null,"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":0},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}'  # a PUT replaces the whole rule`;
  if (!protection) {
    if (protRes && !protRes.ok && protRes.kind !== "missing") throw new Error(protRes.msg);
    return fail(`${defaultBranch} is not protected`, fix);
  }
  const p = protection;
  const m = [p.allow_force_pushes?.enabled === false ? "" : "force-push allowed", p.allow_deletions?.enabled === false ? "" : "deletion allowed",
    p.required_pull_request_reviews ? "" : "no PR required", p.enforce_admins?.enabled ? "" : "admins exempt"].filter(Boolean);
  return m.length ? fail(`${defaultBranch}: ${m.join(", ")}`, fix) : pass(`${defaultBranch}: PR required, no force-push or deletion, admins included`);
});
check("deploy-keys", () => {
  needRepo();
  const ks: any[] = must(R("keys")) ?? [];
  const rw = ks.filter((k) => k.read_only === false);
  return rw.length
    ? fail(`${rw.length} of ${ks.length} deploy key(s) can WRITE: ${rw.map((k) => `#${k.id} ${k.title}`).join(", ")}`, `replace each with a read-only key, then: gh api -X DELETE repos/${slug}/keys/<id>`)
    : pass(ks.length ? `${ks.length} deploy key(s), all read-only: ${ks.map((k) => k.title).join(", ")}` : "no deploy keys");
});
check("webhooks", () => {
  needRepo();
  const hs: any[] = must(R("hooks")) ?? [];
  const host = (u: string) => { try { return new URL(u).host; } catch { return "?"; } }; // never print a URL's path or query: tokens live there
  const bad = hs.filter((h) => !/^https:/.test(String(h.config?.url ?? "")) || String(h.config?.insecure_ssl) === "1" || !h.config?.secret)
    .map((h) => `#${h.id} ${host(h.config?.url ?? "")}`);
  return bad.length
    ? fail(`webhook(s) without https, TLS verification or a secret: ${bad.join(", ")}`, `gh api -X PATCH repos/${slug}/hooks/<id> -f 'config[secret]=<random>' -f 'config[insecure_ssl]=0' (or delete a hook nothing uses)`)
    : pass(hs.length ? `${hs.length} webhook(s), https + secret: ${hs.map((h) => host(h.config?.url ?? "")).join(", ")}` : "no webhooks");
});
check("collaborators", () => {
  needRepo();
  const kind = isOrg ? "outside" : "direct";
  const cs: any[] = must(R(`collaborators?affiliation=${kind}&per_page=100`)) ?? [];
  const others = cs.filter((c) => c.login !== owner);
  const high = others.filter((c) => c.permissions?.admin || c.permissions?.maintain);
  return high.length
    ? fail(`${kind} collaborator(s) with admin/maintain: ${high.map((c) => c.login).join(", ")}`, `gh api -X PUT repos/${slug}/collaborators/<login> -f permission=push, or remove those whose work is done`)
    : pass(others.length ? `${others.length} ${kind} collaborator(s), none above write: ${others.map((c) => c.login).join(", ")}` : `no ${isOrg ? "outside" : "other"} collaborators`);
});
check("deploy-credential-scope", () => {
  needRepo();
  if (!CAPS.environments) return na("no environments on this plan for a private repo — see plan-environments");
  if (!secRes?.ok) throw new Error(secRes?.msg ?? "secrets not readable");
  const envs: any[] = must(R("environments"))?.environments ?? [];
  const open = envs.filter((e) => !e.deployment_branch_policy).map((e) => e.name);
  const m = [deploySecrets.length ? `repository-level deploy-like secret(s), readable from any branch: ${deploySecrets.join(", ")}` : "",
    open.length ? `environment(s) any branch can deploy to: ${open.join(", ")}` : ""].filter(Boolean);
  const fix = [deploySecrets.length ? `move each into an environment: gh secret set <NAME> --env <env> -R ${slug}, then gh secret delete <NAME> -R ${slug}` : "",
    open.length ? `gh api -X PUT repos/${slug}/environments/<env> --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' && gh api -X POST repos/${slug}/environments/<env>/deployment-branch-policies -f name=${shq(defaultBranch)} -f type=branch` : ""].filter(Boolean).join("; ");
  return m.length ? fail(m.join("; "), fix) : pass(`${repoSecrets.length} repository secret(s), none deploy-like; ${envs.length} environment(s), each branch-restricted`);
});
check("log-retention", () => {
  needRepo();
  const d = must(R("actions/permissions/artifact-and-log-retention"));
  return Number(d?.days) <= 30 ? pass(`artifacts and logs kept ${d.days} days`)
    : fail(`artifacts and logs kept ${d?.days} days (screenshots, traces and any unredacted output live that long)`, `gh api -X PUT repos/${slug}/actions/permissions/artifact-and-log-retention -F days=14`);
});
// Reads git history at <ref>; prints domains only, never the addresses.
check("commit-email-noreply", () => {
  const lg = git("log", "-n", "200", "--format=%ae", ref);
  if (!lg.ok) throw new Error(lg.err.trim());
  const em = lg.out.split("\n").filter(Boolean);
  const bad = em.filter((e) => !/@users\.noreply\.github\.com$|^noreply@github\.com$|\[bot\]@/i.test(e));
  const domains = [...new Set(bad.map((e) => e.split("@")[1] ?? "?"))];
  return bad.length
    ? fail(`${bad.length} of the last ${em.length} commits carry a non-noreply author email (domains: ${domains.join(", ")})`,
      `git config --global user.email <id>+<login>@users.noreply.github.com and turn on "Block command line pushes that expose my email" (https://github.com/settings/emails); history keeps the old address — ${isPublic ? "already public" : "it becomes public if the repo ever does"}`)
    : pass(`last ${em.length} commits: noreply author emails`);
});
// Reads the LOCAL clone's hooks (not <ref>): the hook that runs is the clone's.
check("gitleaks-precommit", () => {
  const top = git("rev-parse", "--show-toplevel").out.trim();
  const hp = git("config", "--type=path", "--get", "core.hooksPath").out.trim(); // --type=path expands ~
  // --git-path hooks follows core.hooksPath; the file a hook chains to is the common dir's.
  const dflt = `${git("rev-parse", "--path-format=absolute", "--git-common-dir").out.trim()}/hooks`;
  const dirPath = hp ? (hp.startsWith("/") ? hp : `${top}/${hp}`) : dflt;
  const live = (p: string) => { try { return readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); } catch { return ""; } };
  const hookFile = `${dirPath}/pre-commit`, t = live(hookFile);
  const GL = /\bgitleaks\s+(git|protect|detect)\b/;
  const chained = !!hp && dirPath !== dflt && /(git-common-dir|git-path hooks)[^\n]*pre-commit|\.git\/hooks\/pre-commit/.test(t) && GL.test(live(`${dflt}/pre-commit`));
  const fix = `${hp ? `chain ${hookFile} to .git/hooks/pre-commit, or add` : "install"} gitleaks git --pre-commit --staged (global: ~/.claude/git-hooks/pre-commit via init.templateDir), then prove it with one blocked fake-secret commit`;
  if (!t) return fail(`no pre-commit hook at ${hookFile}`, fix);
  return GL.test(t) || chained ? pass(`${hookFile} runs gitleaks${chained ? " (chained)" : ""} — present, not proven by a blocked commit`) : fail(`${hookFile} does not run gitleaks`, fix);
});
check("org-baseline", () => {
  needRepo();
  if (!isOrg) return na("user-owned repository (see account-2fa)");
  const o = ownerData ?? must(ownerRes!);
  const m = [o.two_factor_requirement_enabled === true ? "" : o.two_factor_requirement_enabled == null ? "2FA requirement not readable (org-owner token needed)" : "2FA not required",
    o.members_can_create_public_repositories === false ? "" : "members can create PUBLIC repositories",
    ["read", "none"].includes(o.default_repository_permission) ? "" : `base permission ${o.default_repository_permission}`].filter(Boolean);
  return m.length
    ? fail(`${owner}: ${m.join(", ")}`, `gh api -X PATCH orgs/${owner} -F members_can_create_public_repositories=false -f default_repository_permission=read  # if Team refuses the public-only switch: -F members_can_create_repositories=false; 2FA: https://github.com/organizations/${owner}/settings/security`)
    : pass(`${owner}: 2FA required, members cannot create public repos, base permission ${o.default_repository_permission}`);
});
check("account-2fa", () => {
  needRepo();
  if (isOrg) return na("organization-owned (see org-baseline)");
  if (ownerRes && !ownerRes.ok) throw new Error(ownerRes.msg);
  if (!ownerData) return na(`owned by ${owner}, not the authenticated account`);
  const tf = ownerData.two_factor_authentication;
  return tf === true ? pass(`${owner}: 2FA on`)
    : fail(tf == null ? `${owner}: 2FA state not readable (the token lacks the user scope)` : `${owner}: 2FA off`,
      tf == null ? "gh auth refresh -h github.com -s user" : "https://github.com/settings/security, recovery codes into 1Password");
});

// ------------------------------------------------------------------ minutes
const minutes: string[] = [];
const billed = (runId: number) => {
  const jobs = gh(`repos/${slug}/actions/runs/${runId}/jobs?per_page=100`).jobs ?? [];
  const ran = jobs.filter((j: any) => j.conclusion !== "skipped" && j.started_at && j.completed_at);
  const min = ran.reduce((s: number, j: any) => s + Math.max(1, Math.ceil((Date.parse(j.completed_at) - Date.parse(j.started_at)) / 60000)), 0);
  return { min, n: ran.length, total: jobs.length };
};
const billedLine = (label: string, id: number, b = billed(id)) => `${label}${b.min} min  (run ${id}, ${b.n}/${b.total} jobs ran)`;
if (!configOnly) try {
  if (!slug || !CI) throw new Error(ghError || "no CI workflow");
  const rs = gh(`repos/${slug}/actions/workflows/${ciFile}/runs?status=success&per_page=30`).workflow_runs ?? [];
  await prefetch(rs.filter((r: any) => r.event === "pull_request").slice(0, 10).concat(rs.find((r: any) => r.event === "push" && r.head_branch === defaultBranch) ?? [])
    .map((r: any) => `repos/${slug}/actions/runs/${r.id}/jobs?per_page=100`));
  const prs = rs.filter((r: any) => r.event === "pull_request").slice(0, 10).map((r: any) => ({ r, b: billed(r.id) }));
  const full = prs.sort((a: any, b: any) => b.b.n - a.b.n)[0];
  minutes.push(full ? billedLine("full PR run   ", full.r.id, full.b) : "full PR run   no successful pull_request run found");
  const push = rs.find((r: any) => r.event === "push" && r.head_branch === defaultBranch);
  if (push) minutes.push(billedLine("main push     ", push.id));
  else minutes.push(`main push     no successful push run on ${defaultBranch} found`);
  if (DEPLOY) {
    const d = (gh(`repos/${slug}/actions/workflows/${base(DEPLOY.path)}/runs?status=success&per_page=5`).workflow_runs ?? []).find((r: any) => r.event === "workflow_run");
    if (d) minutes.push(billedLine("main deploy   ", d.id));
  }
} catch (e) { minutes.push(`not measured: ${(e as Error).message}`); }

// ------------------------------------------------------------------ report
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
console.log(`ci-flow audit: ${repoPath} @ ${ref}${slug ? ` (${slug})` : ""}`);
if (repoJson) console.log(`${visibility} repository, ${isOrg ? "organization" : "user"}-owned, plan ${plan ?? "unknown"}`);
const mark = (s: Status) => (s === "fail" ? "**FAIL**" : s === "blocked" ? "**blocked**" : s);
for (const [s, title] of [["ci", "CI design"], ["config", "Repository configuration"]] as const) {
  const rs = rows.filter((r) => r.section === s);
  if (!rs.length) continue;
  console.log(`\n## ${title}\n\n| check | result | evidence |\n|---|---|---|`);
  for (const r of rs) console.log(`| ${r.id} | ${mark(r.status)} | ${cell(r.ev)} |`);
}
const count = (s: Status) => rows.filter((r) => r.status === s).length;
const nf = count("fail");
console.log(`\n${count("pass")} pass, ${nf} fail, ${count("blocked")} blocked by plan, ${count("n.a.")} n.a.`);
if (minutesWarn) console.log(`\n**${minutesWarn}**`);
const todo = rows.filter((r) => r.fix && r.status !== "n.a.");
if (todo.length) {
  console.log("\n## Hardening — suggested, NOT applied; read each before running it\n");
  const tag = (s: Status) => (s === "blocked" ? " (plan decision)" : s === "pass" ? " (suggestion)" : "");
  for (const r of todo) console.log(`- ${r.id}${tag(r.status)}: ${r.fix}`);
}
if (minutes.length) {
  console.log("\nBilled minutes (latest green runs; each job rounded up to a whole minute):");
  for (const m of minutes) console.log(`  ${m}`);
}
process.exit(strict && nf ? 1 : 0);
