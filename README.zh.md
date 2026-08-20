# dsh-cursor-codex

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）接到 Cursor 编辑器与 OpenAI Codex CLI —— 以 ACP agent、MCP 服务或 headless worker 三种形态。

| 目录 | 是什么 |
|---|---|
| [`acp/`](acp/) | npm bundle `@jeremy9682/dsh-acp`：`dsh plugin --profile acp add @jeremy9682/dsh-acp` 之后，`dsh --profile acp` 在你现有 dsh 组合（共享凭据、模型设置、会话日志）上启动 [Agent Client Protocol](https://agentclientprotocol.com) stdio 服务。 |
| [`server/`](server/) | 零依赖 MCP stdio 服务，向 Cursor、Codex 等 MCP 客户端提供 `dsh_delegate` 与 `dsh_health` 两个工具。 |
| [`skills/`](skills/) | 教 Cursor 和 Codex「何时、如何把活派给 dsh」的 agent skills。 |
| [`templates/`](templates/) | 现成的 `mcp.json`、Cursor 自定义 subagent、Codex `dsh.config.toml` 配置模板。 |
| [`registry/`](registry/) | 提交到官方 ACP registry 的 `dsh-acp` 条目（agent.json + 图标）。 |
| [`docs/`](docs/) | 通道选型指南（中英）外加实战 [overlay cookbook](docs/cookbook-integration-overlays.zh.md) 与 [fleet 治理 cookbook](docs/cookbook-fleet-governance.zh.md)（Codex 当 DSH 子代理、第三方适配器接 DeepSeek、3082 端口排练）。 |

## 快速开始

```sh
# 1. 安装 dsh（或处处用 `npx @deepseek-ai/dsh`）
npm install -g @deepseek-ai/dsh

# 2a. ACP（Zed / JetBrains / 任意 ACP 客户端）
dsh plugin --profile acp add @jeremy9682/dsh-acp
dsh --profile acp
#     （npm 发布前可用：`dsh plugin --profile acp add file:/path/to/dsh-cursor-codex/acp`）

# 2b. MCP（Cursor / Codex）
#   Cursor:  把 templates/cursor/mcp.json 合并进 ~/.cursor/mcp.json
#   Codex:   cp templates/codex/dsh.config.toml ~/.codex/dsh.config.toml
#            codex -p dsh "你的任务"

# 2c. 一次性 headless（任何 shell）
dsh --profile headless "<完整自包含的任务文本>"
```

`2b` 与 `2c` 配有 skills：把 `skills/cursor-delegate-to-dsh` 与 `skills/codex-delegate-to-dsh` 装进对应编辑器的 skills 目录，agent 就知道何时派活。

## 为什么是三条通道？

Cursor 与 Codex 在 ACP 生态里是 agent 而非客户端——两者目前都不能加载第三方 ACP agent。对照官方文档核实的完整结论见 [`docs/integration-guide.zh.md`](docs/integration-guide.zh.md)。

## 已验证

- ACP profile：`initialize` → `session/new` → `session/prompt` → 流式回答 → `end_turn`（dsh 0.1.0-rc.6 实测通过）。
- MCP 服务：`initialize` → `tools/list` → `dsh_health` → `dsh_delegate` 真实任务（dsh 0.1.0-rc.6 实测通过）。

## Cursor ACP 的安全 DSH 升级

Cursor provider 现在附带 `dsh-cursor-upgrade-gate`。它先把指定的 DSH 包装进独立候选目录，再用真实行为探针检查跨 provider replay 过滤是否仍保留 agent-loop 标记；只有行为仍有缺陷且代码形状精确匹配时，才补候选目录。候选还必须通过外部 Cursor smoke，之后才能原子切换 `current` 软链接。完整命令与回滚方法见 [`cursor-provider/README.md`](cursor-provider/README.md#dsh-upgrades)。不要先全局覆盖正在工作的 DSH，否则会在验证前擦掉兼容性修复。

## License

[MIT](LICENSE)
