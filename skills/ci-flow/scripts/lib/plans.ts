// What each GitHub plan gives a repo, an owner's minutes, and development names.
import { ghGet } from "./gh.ts";

// ------------------------------------------------------------ plan knowledge
// What each GitHub plan gives a repo of each visibility (GitHub docs, checked
// 2026-11-02). Repositories and collaborators are UNLIMITED on every plan,
// public and private; what differs is the features a PRIVATE repo gets, and the
// Actions minutes and Packages storage it draws on. A public repo gets every
// feature below free, and standard-runner minutes free.
export type Plan = "free" | "pro" | "team" | "enterprise";
export const planOf = (n: unknown): Plan | undefined => {
  const s = String(n ?? "").toLowerCase();
  return s === "free" || s === "pro" || s === "team" ? s : /enterprise|business/.test(s) ? "enterprise" : undefined;
};
export const QUOTA: Record<Plan, number> = { free: 2000, pro: 3000, team: 3000, enterprise: 50000 }; // Linux min/month, private repos
export const PACKAGES_GB: Record<Plan, number> = { free: 0.5, pro: 2, team: 2, enterprise: 50 };
export const capsFor = (plan: Plan | undefined, pub: boolean) => {
  const paid = plan === "pro" || plan === "team" || plan === "enterprise", orgPaid = plan === "team" || plan === "enterprise";
  return {
    protection: pub || paid, // branch protection + rulesets
    environments: pub || paid, // environments, environment secrets, deployment branch policies
    envReviewers: pub || plan === "enterprise", // required reviewers / wait timers on environments
    secretScanning: pub ? "included" : orgPaid ? "a paid add-on (Secret Protection)" : "not available",
    codeql: pub ? "included" : orgPaid ? "a paid add-on (Code Security)" : "not available",
    privateReporting: pub,
  };
};
/** This month's Actions Linux minutes of an owner, its budget, and the 80% warning line. Throws when billing is unreadable. */
export function minutesOf(owner: string, isOrg: boolean, plan: Plan) {
  const now = new Date(), y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const u = ghGet(`${isOrg ? "orgs" : "users"}/${owner}/settings/billing/usage?year=${y}&month=${m}`);
  if (!u.ok) throw new Error(`${u.msg}${isOrg ? "" : " (needs: gh auth refresh -h github.com -s user)"}`);
  // Minutes only: the same report carries Actions STORAGE, which is not minutes.
  const items = (u.data?.usageItems ?? []).filter((i: any) => /^actions[ _]linux$/i.test(String(i.sku)));
  const sum = (xs: any[]) => Math.round(xs.reduce((s, i) => s + Number(i.quantity ?? 0), 0));
  const total = sum(items), quota = QUOTA[plan];
  const spent = items.reduce((s: number, i: any) => s + Number(i.netAmount ?? 0), 0); // US$ billed beyond the included minutes
  let budget: number | undefined;
  if (isOrg) {
    const b = ghGet(`orgs/${owner}/settings/billing/budgets`);
    if (b.ok) budget = (b.data?.budgets ?? []).find((x: any) => [x.budget_product_sku, x.budget_product_skus].flat().includes("actions"))?.budget_amount;
  }
  const day = now.getUTCDate(), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pct = Math.round((100 * total) / quota), projected = Math.round((total / day) * days);
  const reset = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const line = `${isOrg ? "org" : "account"} ${total} of ${quota} included Linux min (${pct}%), ${Math.max(0, quota - total)} remaining until ${reset}` +
    `${budget != null ? `, Actions budget US$${budget}` : ""}`;
  // Past 80% the numbers that decide the rest of the month get their own line, above the tables' noise.
  const warn = total < 0.8 * quota ? "" :
    `Actions minutes ${pct}% used: ${total} of ${quota} included (${isOrg ? "org" : "account"} ${owner}), ${Math.max(0, quota - total)} remaining until ${reset}; ` +
    `at this pace ${projected} by month end` +
    (budget != null ? `; budget US$${budget}, US$${spent.toFixed(2)} spent, US$${Math.max(0, budget - spent).toFixed(2)} left before Actions stops`
      : `; no Actions budget — Actions stops at ${quota}`);
  return { month: `${y}-${String(m).padStart(2, "0")}`, total, quota, budget, line, warn,
    byRepo: (name: string) => sum(items.filter((i: any) => i.repositoryName === name)) };
}
// Naming lifecycle (POLICY.md §2 "Names leak too"): while private and in
// development a repo carries a random name unrelated to the product, client or
// folder; once public, the product name is out anyway, so the repo takes it.
const ADJ = ["amber", "brisk", "cobalt", "dusty", "ember", "fabled", "gentle", "hollow", "ivory", "jolly", "keen", "lunar", "misty", "noble", "opal", "quiet", "rustic", "silver", "tidal", "velvet"];
const NOUN = ["badger", "canyon", "delta", "falcon", "glacier", "harbor", "island", "juniper", "kettle", "lantern", "meadow", "nebula", "orchid", "pebble", "quarry", "river", "summit", "thistle", "willow", "zephyr"];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
export const randomName = () => `${pick(ADJ)}-${pick(NOUN)}-${100 + Math.floor(Math.random() * 900)}`;