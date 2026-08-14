# Cookbook：DSH 集成 overlay 配方

来自真实 `$DSH_HOME`（`~/.dsh/experiments/`）的实战 overlay 配方。每个 overlay 都是一份补丁清单，用 `--patch` 应用（或合并进 profile 的 `cordis.patch.yml`），叠加在 headless/web profile 之上而不改动其本体。

## 1. 把 Codex 挂成 DSH 子代理

文件：`experiments/codex-overlay.yml`

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
- id: tool-subagent
  config:
    provider: codex
    toolName: subagent
    backgroundMode: one-shot
    maxDepth: provider-managed
```

作用：注册官方 Codex 子代理 provider，并把 `subagent` 工具指到它上面。此后每次委派都是一次进程外 Codex 运行（provider 自己拉起 Codex），DSH 本体仍跑在 DeepSeek 上。注意这是本工具包主方向的**反向**：这里是 DSH 调 Codex。

运行：

```sh
dsh --profile headless --patch ~/.dsh/experiments/codex-overlay.yml "<task>"
```

要点：

- `codex` 需在 PATH 上并已登录（`codex login`）。
- id 定向补丁会**整体替换** `tool-subagent` 的 config——保留的字段要全部重写。
- `maxDepth: provider-managed` 让 Codex provider 自己管理嵌套；要设上限就显式给值。

## 2. 让第三方 LLM 适配器走 DeepSeek（pi-ai）

文件：`experiments/pi-ai-overlay.yml`

```yaml
- id: llm-pi-ai
  config:
    providers:
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
        models:
          - id: deepseek-v4-flash
            contextWindow: 128000
- id: agent-default-model
  config:
    provider: deepseek
    model: deepseek-v4-flash
```

作用：给第三方适配器（`@deepseek-ai/dsh-llm-pi-ai`）配一条指向 **DeepSeek API** 的真实 provider 路由，再把 agent 默认模型指过去——整个 agent 循环改走 pi-ai 适配器而非原生 `llm-deepseek`。

这个模式对所有接收 `providers` 映射的适配器通用：把适配器指向任意 OpenAI 兼容端点，再翻转 `agent-default-model`。适合想要非原生适配器的语义（不同的工具调用约定、推理控制）却仍按 DeepSeek 计费时使用。

运行：

```sh
dsh --profile headless --patch ~/.dsh/experiments/pi-ai-overlay.yml "<task>"
```

## 3. 在第二个 Web 端口排练 Codex provider

文件：`experiments/web-demo-overlay.yml`

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
```

作用：只插入 Codex 子代理 provider——`subagent` 工具仍走默认 provider。用于在 Web UI 里排练，但起在独立端口，不动线上实例：

```sh
dsh web --port 3082 --patch ~/.dsh/experiments/web-demo-overlay.yml
```

绝不要在线上端口（3080）上做排练——overlay 会改变运行中 profile 的组合。

## 4. 外部席位：Codex / Cursor 与 DSH 协同

上面的 overlay 只是双向安排的一面，本工具包正起源于这套安排。生产形态：

- **DSH → Codex**：经 `dsh-subagent-codex` 当委派席位（配方 1），或经 OAuth 当 LLM provider。
- **DSH → Cursor**：用 ACP 子代理 provider 驱动 `cursor-agent acp`（`@deepseek-ai/dsh-subagent-acp`），或用 [dsh-observability](https://github.com/jeremy9682/dsh-observability) 里的 `cursor_delegate` 工具。
- **Codex / Cursor → DSH**：本工具包的主方向——ACP profile（Zed/JetBrains）、MCP 服务（`dsh_delegate`）或 headless CLI。

实战存活下来的四条规矩：

1. **一会话一席位。** 每次委派都是一个新进程、新会话；绝不假设跨边界共享对话状态。
2. **验证，不轻信。** 委派席位的报告是待审查的输入，不是证据——核对它改动的文件/diff。
3. **凭据不出家门。** DSH 读自己的存储；任务文本与 overlay 里不放任何秘密。
4. **排练用第二个端口。** 任何会碰到线上会话的组合实验，先起自己的端口/profile。
