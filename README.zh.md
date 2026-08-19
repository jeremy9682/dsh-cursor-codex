# dsh-cursor-codex

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）接到 Cursor、Codex CLI 与 ZCode —— 以 ACP agent、MCP 服务、headless worker，或包一层这些现成二进制的薄 CLI。

| 目录 | 是什么 |
|---|---|
| [`acp/`](acp/) | npm bundle `@jeremy9682/dsh-acp`：`dsh plugin --profile acp add @jeremy9682/dsh-acp` 之后，`dsh --profile acp` 在你现有 dsh 组合（共享凭据、模型设置、会话日志）上启动 [Agent Client Protocol](https://agentclientprotocol.com) stdio 服务。 |
| [`server/`](server/) | 零依赖 MCP stdio 服务，向 Cursor、Codex、ZCode 等 MCP 客户端提供 `dsh_delegate` 与 `dsh_health` 两个工具。 |
| [`gateway/`](gateway/) | 薄 CLI，spawn 现成的 `dsh` / `agent-run` / `cursor-agent acp`。不是路由器。Cursor Cloud 会被拒绝（`CLOUD_NO_LOCAL_HTTP`）。 |
| [`skills/`](skills/) | 教 Cursor、Codex、ZCode「何时、如何把活派给 dsh」的 agent skills。 |
| [`templates/`](templates/) | 现成的 Cursor `mcp.json`、ZCode `config.snippet.json`、Cursor 自定义 subagent、Codex `dsh.config.toml`。 |
| [`registry/`](registry/) | 提交到官方 ACP registry 的 `dsh-acp` 条目（agent.json + 图标）。 |
| [`docs/`](docs/) | 通道选型指南（中英）外加 [overlay cookbook](docs/cookbook-integration-overlays.zh.md)、[fleet 治理 cookbook](docs/cookbook-fleet-governance.zh.md)、以及 [ZCode / Cloud 网关](docs/zcode-cloud-gateway.zh.md)。 |

## 快速开始

```sh
# 1. 安装 dsh（或处处用 `npx @deepseek-ai/dsh`）
npm install -g @deepseek-ai/dsh

# 2a. ACP（Zed / JetBrains / 任意 ACP 客户端）
dsh plugin --profile acp add @jeremy9682/dsh-acp
dsh --profile acp
#     （npm 发布前可用：`dsh plugin --profile acp add file:/path/to/dsh-cursor-codex/acp`）

# 2b. MCP（Cursor / Codex / ZCode）
#   Cursor:  把 templates/cursor/mcp.json 合并进 ~/.cursor/mcp.json
#   Codex:   cp templates/codex/dsh.config.toml ~/.codex/dsh.config.toml
#            codex -p dsh "你的任务"
#   ZCode:   把 templates/zcode/config.snippet.json 合并进 ~/.zcode/cli/config.json

# 2c. 一次性 headless（任何 shell）
dsh --profile headless "<完整自包含的任务文本>"

# 2d. 薄 CLI 插座（同一批二进制；Cloud 不是合法 via）
node gateway/local-gateway.mjs doctor
node gateway/local-gateway.mjs run --via dsh --cwd /path/to/repo "<任务>"
```

`2b`–`2d` 配有 skills：把 `skills/cursor-delegate-to-dsh`、`skills/codex-delegate-to-dsh`、`skills/zcode-delegate-to-dsh` 装进对应编辑器的 skills 目录。

## 为什么是 MCP、ACP 和薄 CLI？

Cursor、Codex 与 ZCode 是 ACP *agent* 或 MCP *客户端*，不能加载第三方 ACP agent。完整结论见 [`docs/integration-guide.zh.md`](docs/integration-guide.zh.md)。Cursor Cloud 不是本机插座，见 [`docs/zcode-cloud-gateway.zh.md`](docs/zcode-cloud-gateway.zh.md)。

## 已验证

- ACP profile：`initialize` → `session/new` → `session/prompt` → 流式回答 → `end_turn`（dsh 0.1.0-rc.6 实测通过）。
- MCP 服务：`initialize` → `tools/list` → `dsh_health` → `dsh_delegate` 真实任务（dsh 0.1.0-rc.6 实测通过）。

## License

[MIT](LICENSE)
