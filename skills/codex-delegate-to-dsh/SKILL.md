---
name: codex-delegate-to-dsh
description: Delegate a bounded task to DeepSeek Harness (dsh) from Codex. Use when a task is long-running, mechanical, parallelizable, or deserves a separate DeepSeek context — e.g. "let DSH handle this", batch migrations, overnight jobs, or a second opinion from deepseek-v4-pro. Triggers on dsh, deepseek harness, delegate to dsh, or running a job outside this session.
---

# Codex → DeepSeek Harness delegation

DeepSeek Harness (`dsh`) is a separate coding agent (DeepSeek-powered) on this machine. It is NOT this Codex session and shares none of your conversation. Treat it as a disposable worker with its own workspace context.

## Pick a channel (in this order)

1. **MCP tool `dsh_delegate`** — if a `dsh` MCP server is configured (`[mcp_servers.dsh]` in config.toml, see `templates/codex/`), call the tool. One call, one task, returns the committed final answer.
2. **Shell** — otherwise:

   ```sh
   dsh --profile headless "<complete self-contained task>"
   ```

   The task text is the ONLY input: include repo path, goal, constraints, and the verification command. Codex itself is not an ACP client, so the ACP profile (`dsh --profile acp`) is for Zed/JetBrains-style clients, not for this session.
3. **Reverse direction** — this machine's dsh can drive Codex as a subagent provider (`@deepseek-ai/dsh-subagent-codex`); that is dsh calling Codex, not this session delegating. Do not confuse the two.

## What to delegate

- Whole bounded units: "fix the failing tests in X", "write a report from these files", "run the migration".
- Long-running or parallel work you do not need to babysit.
- Tasks where a fresh DeepSeek context is cheaper than burning this session.

## What NOT to delegate

- Anything needing this conversation's context or intermediate state.
- Interactive/approval-heavy work.
- Tasks where you must stream partial results back to the user.

## Guardrails

- Verify the result after it returns: check the files/diff it changed; never trust the report alone.
- Never put API keys in the task text; dsh reads credentials from its own store.
- One task per call. If it fails (nonzero exit / timeout), read the stderr tail, fix the task text, retry once — then report to the user instead of looping.
