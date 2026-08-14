# dsh-cursor-codex

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to the Cursor editor and the OpenAI Codex CLI — as an ACP agent, an MCP server, or a headless worker.

| Directory | What it is |
|---|---|
| [`acp/`](acp/) | npm bundle `@jeremy9682/dsh-acp`: `dsh plugin --profile acp add @jeremy9682/dsh-acp` → `dsh --profile acp` boots an [Agent Client Protocol](https://agentclientprotocol.com) stdio server over your existing dsh composition (shared credentials, model settings, and session logs). |
| [`server/`](server/) | Zero-dependency MCP stdio server exposing `dsh_delegate` and `dsh_health` to Cursor, Codex, and other MCP clients. |
| [`skills/`](skills/) | Agent skills teaching Cursor and Codex when and how to delegate to dsh. |
| [`templates/`](templates/) | Ready-made `mcp.json`, Cursor custom subagent, and Codex `dsh.config.toml` profiles. |
| [`registry/`](registry/) | The `dsh-acp` entry (agent.json + icon) submitted to the official ACP registry. |
| [`docs/`](docs/) | Channel-selection guide (EN/ZH) plus a [cookbook](docs/cookbook-integration-overlays.md) of battle-tested integration overlays (Codex as DSH subagent, third-party adapter → DeepSeek, port-3082 rehearsal). |

## Quick start

```sh
# 1. Install dsh (or use `npx @deepseek-ai/dsh` everywhere)
npm install -g @deepseek-ai/dsh

# 2a. ACP (Zed / JetBrains / any ACP client)
dsh plugin --profile acp add @jeremy9682/dsh-acp
dsh --profile acp
#     (before the npm publish lands: `dsh plugin --profile acp add file:/path/to/dsh-cursor-codex/acp`)

# 2b. MCP (Cursor / Codex)
#   Cursor:  merge templates/cursor/mcp.json into ~/.cursor/mcp.json
#   Codex:   cp templates/codex/dsh.config.toml ~/.codex/dsh.config.toml
#            codex -p dsh "your task"

# 2c. One-shot headless (any shell)
dsh --profile headless "<complete self-contained task>"
```

Both `2b` and `2c` ship skills: install `skills/cursor-delegate-to-dsh` and `skills/codex-delegate-to-dsh` into the respective editor's skills directory so the agent knows when to delegate.

## Why three channels?

Cursor and Codex are ACP *agents*, not ACP clients — neither can load a third-party ACP agent today. The full picture, verified against official docs, is in [`docs/integration-guide.md`](docs/integration-guide.md).

## Verified

- ACP profile: `initialize` → `session/new` → `session/prompt` → streamed answer → `end_turn` (tested against dsh 0.1.0-rc.6).
- MCP server: `initialize` → `tools/list` → `dsh_health` → `dsh_delegate` real task (tested against dsh 0.1.0-rc.6).

## License

[MIT](LICENSE)
