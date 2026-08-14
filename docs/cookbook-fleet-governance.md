# Cookbook: fleet governance with DSH as the brain

This chapter distills the governance layer this kit's author runs across a multi-agent fleet (DSH, Codex, Cursor). The upstream canon lives in the public [agent-skill-advisor-layer](https://github.com/jeremy9682/agent-skill-advisor-layer) repository; this is the DSH-facing edition.

## The three rules that matter

1. **Use the smallest workflow that protects the goal.** A single-file fix does not get a six-step process. Complex work gets a durable plan before implementation.
2. **Suggest expensive workflows; never auto-launch them.** Overnight runs, multi-session plans, and shipping gates are high-cost. The `skill-advisor` skill (shipped in [dsh-skill-pack](https://github.com/jeremy9682/dsh-skill-pack) v0.2.0) suggests at most one such workflow with a one-sentence reason and waits for explicit approval.
3. **The diff is the gate.** No agent final-reviews its own change; nothing ships without green evidence; a delegated seat's report is input for review, never proof.

## Routing table (provider-neutral)

| Task shape | Default route | Required evidence |
| --- | --- | --- |
| Small fix | Edit directly, run focused verification, report | Test, lint, typecheck, or a concrete reason none applies |
| New feature | Plan first (repo context, decisions, repo-relative paths), then implement against the plan | Implementation-ready plan |
| Broad refactor | Plan, implement in bounded units, review against the plan before ship | Plan traceability, rollback notes |
| Bug / failing test | Reproduce → hypothesize → prove root cause → fix | Regression test or characterization evidence |
| Review | Compare the diff to the intent, not just local style | Findings with severity + file references |
| Ship | High-cost gate workflow after explicit approval | Green checks before push |
| Skill install / update | Supply-chain change: review the SKILL.md diff and any scripts | Pinned provenance (repo, ref, tree hash) |

Map "edits" and "reviews" onto whichever seats you run (DSH headless jobs, Codex seats, Cursor seats); the table's shapes stay the same. DSH specifics: `dsh --profile headless` for bounded edits, `dsh --profile acp` for editor-native delegation, `subagent`/`workflow` for fan-out inside one DSH session.

## Worktree isolation (concept)

The load-bearing safety property of the author's orchestrator is `git worktree` isolation: concurrent agents get separate worktrees so they cannot collide — a correctness guarantee, not a security sandbox. You can get the same property with plain git:

```sh
git worktree add ../repo-seat-a -b seat/a   # seat A works here
git worktree add ../repo-seat-b -b seat/b   # seat B works here
# each dsh/codex/cursor seat gets its own worktree; merge only after review
```

Reviews and plans assume the operator's own shell trust model: the closing gate is reading the diff before merge.

## Skill fleet hygiene

- Keep the skill catalog short. Routing value decays when every skill has a row in an advisor matrix.
- Audit before trusting: a skill install is a supply-chain change. Review the SKILL.md diff and any `scripts/`; pin provenance (repo, ref, tree hash).
- One home per fact: keep standing rules in AGENTS.md and link to their homes instead of copying long workflow text into every repo.

## External seats

For the seat mechanics themselves (Codex as DSH subagent, third-party adapters, rehearsal ports), see [cookbook-integration-overlays.md](cookbook-integration-overlays.md).
