# DeepSeek Harness ↔ Cursor / Codex integration guide

This kit connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to the Cursor editor and the OpenAI Codex CLI. It ships three channels — pick one per client.

## One important direction fact first

In the [Agent Client Protocol](https://agentclientprotocol.com) ecosystem, Cursor and Codex are currently **ACP agents (servers)**, not ACP clients. Neither has an official way to load a third-party ACP agent. So:

| Channel | Cursor | Codex CLI | Zed / JetBrains / other ACP clients |
|---|---|---|---|
| ACP server (`dsh --profile acp`) | ✗ not an ACP client | ✗ not an ACP client | ✓ native |
| MCP server (`dsh_delegate`) | ✓ native (`mcp.json`) | ✓ native (`[mcp_servers]` / plugins) | ✓ (MCP) |
| headless CLI (`dsh --profile headless`) | ✓ via shell / custom subagent | ✓ via `codex exec` | ✓ |

For Cursor and Codex the practical answer is **MCP or the headless CLI**. For Zed/JetBrains the ACP profile is the clean answer.

## Prerequisites

- Node.js >= 22.15, npm (for `dsh`); pnpm only when installing the ACP bundle.
- `npm install -g @deepseek-ai/dsh` — or `npx @deepseek-ai/dsh` everywhere.
- A DeepSeek API key saved through the dsh Web UI Models page (`dsh web`), or `DEEPSEEK_API_KEY` exported in the environment.

## Channel 1 — ACP profile (Zed / JetBrains / any ACP client)

```sh
dsh plugin --profile acp add @jeremy9682/dsh-acp   # one-time
dsh --profile acp                                   # stdio ACP server
```

Until the npm publish lands, the equivalent local-checkout install is
`dsh plugin --profile acp add file:/path/to/dsh-cursor-codex/acp`.

Zed `settings.json`:

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "dsh-acp"
    }
  }
}
```

The `dsh-acp` entry in the [ACP registry](https://github.com/agentclientprotocol/registry) makes it discoverable in registry-backed clients. Sessions share `$DSH_HOME` credentials and session logs with `dsh web`. Baseline ACP only: fresh sessions, text prompts, committed answers, auto-answered permissions.

## Channel 2 — MCP server (Cursor and Codex)

Zero-dependency stdio MCP server with two tools: `dsh_delegate(task, cwd?, timeout_ms?)` and `dsh_health`.

Cursor — merge into `~/.cursor/mcp.json` (path template in [`templates/cursor/mcp.json`](../templates/cursor/mcp.json)):

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["/path/to/dsh-cursor-codex/server/dsh-mcp.mjs"]
    }
  }
}
```

Codex — copy [`templates/codex/dsh.config.toml`](../templates/codex/dsh.config.toml) to `~/.codex/dsh.config.toml`, then:

```sh
codex -p dsh "your task"        # -p is additive over config.toml
codex exec -p dsh "your task"
```

The `dsh_delegate` tool runs one headless task and returns the committed final answer. The bundled skills ([`skills/`](../skills/)) teach each agent when and how to delegate.

## Channel 3 — headless CLI (anywhere a shell runs)

```sh
dsh --profile headless "<complete self-contained task>"
```

One fresh persisted session per call; prints the final assistant text and exits. This is the fallback when MCP is not configured, and the building block for CI scripts.

## Reverse direction: DSH driving Cursor / Codex

DSH can treat Cursor and Codex as subagent backends through its ACP subagent provider (`@deepseek-ai/dsh-subagent-acp`), driving `cursor-agent acp` / `codex-acp` per delegation. Codex can also serve as a DSH LLM provider (OAuth). Those flows belong to the DSH side of the fence; see the harness docs.

## Relation to plain DeepSeek API setups

Configurations that point Cursor/Codex directly at `api.deepseek.com` (Cursor "Override OpenAI Base URL", Codex `[model_providers.deepseek]`) use the **DeepSeek API**, not the harness. They give you DeepSeek models inside your editor; this kit gives you the **dsh agent** (its sandbox, tools, sessions, and credentials) behind any client. The two coexist: e.g. Codex runs its own model while delegating isolated jobs to dsh.

## Security notes

- `dsh_delegate` and the ACP server run with the permissions of the local user and the dsh sandbox policy (`DSH_PERMISSION_MODE`, default `workspace-write`). Do not bind these servers to a network port.
- Never put API keys in task text. dsh reads credentials from its own store (`$DSH_HOME`).
- Verify delegated results against the real files/diff — a worker's report is not proof.
