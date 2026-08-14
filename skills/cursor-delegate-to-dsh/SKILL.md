---
name: cursor-delegate-to-dsh
description: Delegate a bounded task to DeepSeek Harness (dsh) from Cursor. Use when a task is long-running, mechanical, parallelizable, or deserves a separate DeepSeek context — e.g. "let DSH handle this", batch migrations, overnight jobs, or a second opinion from deepseek-v4-pro. Triggers on dsh, deepseek harness, delegate to dsh, or running a job outside this session.
---

# Cursor → DeepSeek Harness delegation

DeepSeek Harness (`dsh`) is a separate coding agent (DeepSeek-powered) running on this machine. It is NOT this Cursor session and does not share your conversation. Treat it as a disposable worker with its own workspace context.

## Pick a channel (in this order)

1. **MCP tool `dsh_delegate`** — if `dsh` appears in your MCP tools list, use it. One call, one task, returns the committed final answer.
2. **Shell** — otherwise run the CLI directly:

   ```sh
   dsh --profile headless "<complete self-contained task>"
   ```

   The task text is the ONLY input: no conversation is shared, so include everything it needs (repo path, goal, constraints, verification command). Add `cd <repo>` or pass a cwd context in the task text; use `--patch` overlays only if the project documents them.
3. **ACP / editor-native agent** — for Zed/JetBrains setups the same machine exposes `dsh --profile acp` (Agent Client Protocol). Cursor itself is not an ACP client, so prefer 1 or 2.

## What to delegate

- Whole bounded units: "fix the failing tests in X", "write a report from these files", "run the migration", "clean up Y".
- Long-running or parallel work you do not need to babysit.
- Tasks where a fresh DeepSeek context (deepseek-v4-pro) is cheaper than burning this session.

## What NOT to delegate

- Anything needing this conversation's context or intermediate state.
- Interactive/approval-heavy work (headless runs a one-shot approval policy).
- Tasks where you must stream partial results back to the user.

## Guardrails

- Verify the result after it returns: check the files/diff it changed; never trust the report alone.
- Never put API keys in the task text; dsh reads credentials from its own store.
- One task per call. If it fails (nonzero exit / timeout), read the stderr tail, fix the task text, retry once — then report to the user instead of looping.
