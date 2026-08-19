# dsh-cursor-codex

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to the Cursor editor, the OpenAI Codex CLI, and ZCode — as an ACP agent, an MCP server, a headless worker, or a thin CLI socket over those same binaries.

| Directory | What it is |
|---|---|
| [`acp/`](acp/) | npm bundle `@jeremy9682/dsh-acp`: `dsh plugin --profile acp add @jeremy9682/dsh-acp` → `dsh --profile acp` boots an [Agent Client Protocol](https://agentclientprotocol.com) stdio server over your existing dsh composition (shared credentials, model settings, and session logs). |
| [`server/`](server/) | Zero-dependency MCP stdio server exposing `dsh_delegate` and `dsh_health` to Cursor, Codex, ZCode, and other MCP clients. |
| [`gateway/`](gateway/) | Thin CLI over existing `dsh` / `agent-run` / `cursor-agent acp`. Not a router. Cursor Cloud is rejected (`CLOUD_NO_LOCAL_HTTP`). |
| [`skills/`](skills/) | Agent skills teaching Cursor, Codex, and ZCode when and how to delegate to dsh. |
| [`templates/`](templates/) | Ready-made Cursor `mcp.json`, ZCode `config.snippet.json`, Cursor custom subagent, and Codex `dsh.config.toml` profiles. |
| [`registry/`](registry/) | The `dsh-acp` entry (agent.json + icon) submitted to the official ACP registry. |
| [`docs/`](docs/) | Channel-selection guide (EN/ZH) plus cookbooks for [integration overlays](docs/cookbook-integration-overlays.md), [fleet governance](docs/cookbook-fleet-governance.md), and the [ZCode / Cloud gateway](docs/zcode-cloud-gateway.md). |

## Quick start

```sh
# 1. Install dsh (or use `npx @deepseek-ai/dsh` everywhere)
npm install -g @deepseek-ai/dsh

# 2a. ACP (Zed / JetBrains / any ACP client)
dsh plugin --profile acp add @jeremy9682/dsh-acp
dsh --profile acp
#     (before the npm publish lands: `dsh plugin --profile acp add file:/path/to/dsh-cursor-codex/acp`)

# 2b. MCP (Cursor / Codex / ZCode)
#   Cursor:  merge templates/cursor/mcp.json into ~/.cursor/mcp.json
#   Codex:   cp templates/codex/dsh.config.toml ~/.codex/dsh.config.toml
#            codex -p dsh "your task"
#   ZCode:   merge templates/zcode/config.snippet.json into ~/.zcode/cli/config.json

# 2c. One-shot headless (any shell)
dsh --profile headless "<complete self-contained task>"

# 2d. Thin CLI socket (same binaries; Cloud is not a via)
node gateway/local-gateway.mjs doctor
node gateway/local-gateway.mjs run --via dsh --cwd /path/to/repo "<task>"
```

`2b`–`2d` ship skills: install `skills/cursor-delegate-to-dsh`, `skills/codex-delegate-to-dsh`, and `skills/zcode-delegate-to-dsh` into the respective editor's skills directory so the agent knows when to delegate.

## Why MCP, ACP, and a thin CLI?

Cursor, Codex, and ZCode are ACP *agents* or MCP *clients*, not ACP clients that can load a third-party agent. The full picture is in [`docs/integration-guide.md`](docs/integration-guide.md). Cursor Cloud is not a local socket; see [`docs/zcode-cloud-gateway.md`](docs/zcode-cloud-gateway.md).

## Verified

- ACP profile: `initialize` → `session/new` → `session/prompt` → streamed answer → `end_turn` (tested against dsh 0.1.0-rc.6).
- MCP server: `initialize` → `tools/list` → `dsh_health` → `dsh_delegate` real task (tested against dsh 0.1.0-rc.6).
- Local gateway: `node --test gateway/local-gateway.test.mjs` (Cloud `--via` fails closed; doctor prints no secrets).

## License

[MIT](LICENSE)
