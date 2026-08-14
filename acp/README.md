# @jeremy9682/dsh-acp

DeepSeek Harness as an [Agent Client Protocol](https://agentclientprotocol.com) agent — one command, sharing `$DSH_HOME` credentials and session logs with `dsh web`.

This package is part of [dsh-cursor-codex](../../README.md), the Cursor / Codex ↔ DeepSeek Harness integration kit.

## Install

Requires Node.js >= 22.15, the [`dsh`](https://github.com/deepseek-ai/deepseek-harness) launcher, and pnpm (first provisioning only).

```sh
dsh plugin --profile acp add @jeremy9682/dsh-acp
dsh --profile acp          # ACP stdio server; stdout = JSON-RPC only
```

Before the npm publish lands, install from a local checkout of this repo:

```sh
dsh plugin --profile acp add file:/path/to/dsh-cursor-codex/acp
```

Or let the standalone entry provision and boot in one step:

```sh
npx -y @jeremy9682/dsh-acp
```

`DSH_ACP_PROFILE` overrides the profile name (default `acp`).

## Configure the model

The bundle defaults to `deepseek-v4-pro`. Override per machine in the profile's patch layer (`$DSH_HOME/profiles/acp/cordis.patch.yml`) — an id-targeted patch replaces the whole config, so restate kept fields:

```yaml
- id: acp-agent
  name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```

## Register in an ACP client

Zed (`Settings > Agents > External Agents > Add Custom Agent`):

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

The registry entry (`dsh-acp`) makes the same server discoverable in registry-backed clients. See [docs/integration-guide.md](../docs/integration-guide.md) for Cursor / Codex specifics: neither editor is an ACP client today, so they use the MCP server or the headless CLI instead.

## What the server supports

Fresh sessions per `session/new`, text prompts, committed assistant text, permission auto-answer, and cancellation — the official `@deepseek-ai/dsh-acp` contract. No image input, no session load/resume, no MCP mounting (baseline ACP).

## License

[MIT](../../LICENSE)
