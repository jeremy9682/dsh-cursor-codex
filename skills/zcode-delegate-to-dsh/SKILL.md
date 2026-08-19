---
name: zcode-delegate-to-dsh
description: >-
  Delegate a bounded task from ZCode to DeepSeek Harness, agent-run, or
  Cursor ACP on this machine. Use when the user asks to let DSH / agent-run /
  Cursor ACP handle a job, or when the work is long-running, mechanical, or
  needs a governed seat. Triggers on dsh, deepseek harness, agent-run,
  cursor-agent acp, local-gateway. Never Cursor Cloud.
---

# ZCode → local DSH / agent-run / Cursor ACP

ZCode is a **client** on this machine. It does not classify seats. Task
shape → model/effort stays in
`agent-skill-advisor-layer/routing-policy.yaml` via `agent-run`.

Cursor Cloud is **not** a local socket. Do not call `api.cursor.com`, do not
invent an HTTP gateway, and do not pass `--via cloud`.

## Pick a channel (in this order)

1. **MCP tool `dsh_delegate`** — if `dsh` appears in ZCode's MCP tool list
   (config from `templates/zcode/config.snippet.json` merged into
   `~/.zcode/cli/config.json` or `<repo>/.zcode/config.json`), call it.
   One call, one task, committed final answer.
2. **Thin CLI** wrapping the same binaries:

   ```sh
   node /path/to/dsh-cursor-codex/gateway/local-gateway.mjs doctor
   node /path/to/dsh-cursor-codex/gateway/local-gateway.mjs run --via dsh \
     --cwd /absolute/repo \
     "<complete self-contained task>"
   ```

3. **Governed seat** (when the user named a task shape or asked for
   agent-run). Do **not** guess the shape:

   ```sh
   node /path/to/dsh-cursor-codex/gateway/local-gateway.mjs run --via agent-run \
     --task-shape ordinary_bug_fix \
     --cwd /absolute/repo \
     "<task>"
   ```

4. **Cursor as worker** (official ACP stdio, not HTTP):

   ```sh
   node /path/to/dsh-cursor-codex/gateway/local-gateway.mjs run --via cursor-acp \
     --cwd /absolute/repo \
     "<task>"
   ```

ZCode is not an ACP client in the Zed sense; prefer MCP or the CLI. The ACP
profile `dsh --profile acp` is for Zed/JetBrains, not for this session.

## What to delegate

- Whole bounded units with repo path, goal, constraints, and a verification command.
- Long-running or parallel work that does not need this ZCode transcript.

## What NOT to delegate

- Work that needs this conversation's intermediate state.
- Cursor Cloud / any public HTTP URL as if it were `agent-run`.
- Interactive approval-heavy loops (headless uses a one-shot policy).

## Guardrails

- Verify files/diff after return; never trust the report alone.
- Never put API keys in the task text.
- One task per call. On failure, retry once with a tighter task text, then stop.
