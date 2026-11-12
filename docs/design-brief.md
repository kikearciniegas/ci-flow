# Design Brief: ci-flow

> [!NOTE]
> No visual interface. "Design" here is the shape of the text the audit prints and the voice of the rules.

## Output design (audit report)

- Two Markdown tables: **CI design**, then **Dependabot**. One row per check id, with a status and a one-line reason.
- Statuses are words, not colours: `pass`, `FAIL` (bold), `blocked`, `n.a.`. Readable in a plain terminal, a log, or a screen reader.
- A **Hardening** list of exact commands, printed for the owner to run or not.
- A summary line: `N pass, N fail, N blocked by plan, N n.a.`.

## Voice of the rules

- Each rule, then **why** in one clause: a rule without its reason gets broken by the first edge case.
- Measured numbers with their date, never adjectives ("~45% of its minutes", not "a lot").
- No private product, client or org names in anything shipped: see repo-create, `~/.claude/skills/repo-create/POLICY.md` (on GitHub: [kikearciniegas/repo-create](https://github.com/kikearciniegas/repo-create)).

## Accessibility targets

- No meaning carried by colour alone.
- The hook's reminder is one line.

## References

- [`SKILL.md`](../skills/ci-flow/SKILL.md) for check ids and their order.
- [`references/lessons.md`](../skills/ci-flow/references/lessons.md) for the symptom / cause / guard format.
