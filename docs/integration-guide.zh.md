# DeepSeek Harness ↔ Cursor / Codex 接入指南

本工具包把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）接到 Cursor 编辑器与 OpenAI Codex CLI，提供三条通道，按客户端选择。

## 先说一个重要的方向事实

在 [Agent Client Protocol](https://agentclientprotocol.com) 生态里，Cursor 与 Codex 目前都是 **ACP agent（被调用方）**，官方都不支持作为客户端加载第三方 ACP agent。因此：

| 通道 | Cursor | Codex CLI | Zed / JetBrains 等 ACP 客户端 |
|---|---|---|---|
| ACP 服务（`dsh --profile acp`） | ✗ 不是 ACP 客户端 | ✗ 不是 ACP 客户端 | ✓ 原生 |
| MCP 服务（`dsh_delegate`） | ✓ 原生（`mcp.json`） | ✓ 原生（`[mcp_servers]` / 插件） | ✓（MCP） |
| headless CLI（`dsh --profile headless`） | ✓ 通过 shell / 自定义 subagent | ✓ 通过 `codex exec` | ✓ |

对 Cursor 和 Codex 而言，现实答案是 **MCP 或 headless CLI**；对 Zed/JetBrains，ACP profile 是最干净的答案。

## 前置条件

- Node.js >= 22.15 与 npm（安装 `dsh`）；只有安装 ACP bundle 时才需要 pnpm。
- `npm install -g @deepseek-ai/dsh`，或处处用 `npx @deepseek-ai/dsh`。
- DeepSeek API Key：在 dsh Web UI 的 Models 页面保存（`dsh web`），或在环境里导出 `DEEPSEEK_API_KEY`。

## 通道一 — ACP profile（Zed / JetBrains / 任意 ACP 客户端）

```sh
dsh plugin --profile acp add @jeremy9682/dsh-acp   # 一次性
dsh --profile acp                                   # stdio ACP 服务
```

Zed `settings.json`：

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

[ACP registry](https://github.com/agentclientprotocol/registry) 里的 `dsh-acp` 条目让注册表型客户端可以直接发现它。会话与 `dsh web` 共享 `$DSH_HOME` 凭据与会话日志。基线 ACP 能力：新建会话、文本提示、提交后的最终回答、权限自动应答。

## 通道二 — MCP 服务（Cursor 与 Codex）

零依赖 stdio MCP 服务，两个工具：`dsh_delegate(task, cwd?, timeout_ms?)` 与 `dsh_health`。

Cursor —— 合并进 `~/.cursor/mcp.json`（模板见 [`templates/cursor/mcp.json`](../templates/cursor/mcp.json)）：

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

Codex —— 把 [`templates/codex/dsh.config.toml`](../templates/codex/dsh.config.toml) 拷到 `~/.codex/dsh.config.toml`，然后：

```sh
codex -p dsh "你的任务"        # -p 与 config.toml 叠加生效
codex exec -p dsh "你的任务"
```

`dsh_delegate` 每次执行一个 headless 任务并返回最终回答。随附的 skills（[`skills/`](../skills/)）教两个客户端"何时派活、怎么派"。

## 通道三 — headless CLI（任何能跑 shell 的地方）

```sh
dsh --profile headless "<完整自包含的任务文本>"
```

每次调用一个全新的持久化会话，打印最终文本后退出。MCP 未配置时的兜底方案，也是 CI 脚本的积木。

## 反向：DSH 驱动 Cursor / Codex

DSH 可以通过其 ACP subagent provider（`@deepseek-ai/dsh-subagent-acp`）把 `cursor-agent acp` / `codex-acp` 当作子代理后端；Codex 也可以作为 DSH 的 LLM provider（OAuth）。这些属于 DSH 侧的玩法，见官方文档。

## 与"直连 DeepSeek API"方案的关系

把 Cursor/Codex 直接指向 `api.deepseek.com` 的配置（Cursor 的 Override OpenAI Base URL、Codex 的 `[model_providers.deepseek]`）用的是 **DeepSeek API**，不是 harness：那让你在编辑器里用 DeepSeek 模型；本工具包给的是 **dsh agent**（沙箱、工具、会话、凭据）背后的任意客户端。两者可以共存：比如 Codex 跑自己的模型，同时把隔离任务委派给 dsh。

## 安全须知

- `dsh_delegate` 与 ACP 服务以本地用户权限运行，受 dsh 沙箱策略约束（`DSH_PERMISSION_MODE`，默认 `workspace-write`）。不要把这两个服务绑到网络端口。
- 绝不在任务文本里放 API Key；dsh 从自己的凭据存储（`$DSH_HOME`）读取。
- 委派结果要对照真实文件/diff 验证——worker 的报告不等于事实。
