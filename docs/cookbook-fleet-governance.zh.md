# Cookbook：以 DSH 为主脑的 fleet 治理

本章提炼作者在多智能体 fleet（DSH、Codex、Cursor）上运行的治理层。上游 canon 在公开仓库 [agent-skill-advisor-layer](https://github.com/jeremy9682/agent-skill-advisor-layer)；本文是面向 DSH 的版本。

## 三条关键规矩

1. **用能保护目标的最小工作流。** 单文件修复不套六步流程；复杂工作先有持久计划再动手。
2. **昂贵工作流只建议、不自动启动。** 通宵运行、跨会话规划、发布门禁都是高成本动作。`skill-advisor` skill（随 [dsh-skill-pack](https://github.com/jeremy9682/dsh-skill-pack) v0.2.0 发布）最多建议一个这样的工作流，一句话说明理由，等待明确批准。
3. **diff 就是门禁。** 没有 agent 终审自己的改动；没有绿色证据不上线；委派席位的报告是待审查输入，不是证据。

## 路由表（provider 无关）

| 任务形状 | 默认路由 | 必需证据 |
| --- | --- | --- |
| 小修复 | 直接改、跑聚焦验证、汇报 | 测试/lint/typecheck，或"为什么都不适用"的具体理由 |
| 新功能 | 先出计划（仓库上下文、决策、仓库相对路径），再按计划实现 | 可实施的计划 |
| 大重构 | 计划、按有界单元实现、发布前对照计划评审 | 计划可追溯、回滚说明 |
| Bug/失败测试 | 复现 → 假设 → 证根因 → 修 | 回归测试或根因表征证据 |
| 评审 | 对照意图比较 diff，而非只看本地风格 | 带严重度与文件引用的发现 |
| 发布 | 明确批准后的高成本门禁工作流 | push 前绿色检查 |
| Skill 安装/更新 | 供应链变更：评审 SKILL.md diff 与任何 scripts | 锁定来源（repo、ref、tree hash） |

"改"与"评"映射到你实际跑的席位（DSH headless 任务、Codex 席、Cursor 席），表格形状不变。DSH 特化：有界修改用 `dsh --profile headless`，编辑器原生委派用 `dsh --profile acp`，单个 DSH 会话内扇出用 `subagent`/`workflow`。

## Worktree 隔离（概念）

作者编排器的承重安全属性是 `git worktree` 隔离：并发 agent 各占一个 worktree，互不碰撞——这是正确性保证，不是安全沙箱。纯 git 就能拿到同样属性：

```sh
git worktree add ../repo-seat-a -b seat/a   # A 席在这里工作
git worktree add ../repo-seat-b -b seat/b   # B 席在这里工作
# 每个 dsh/codex/cursor 席各占一个 worktree；评审通过后再合入
```

评审与计划都假定"操作者自己的 shell"信任模型：合入前的关闸动作是读 diff。

## Skill 舰队卫生

- 目录保持精简。adviser 矩阵里每行一个 skill 时，路由价值就衰减了。
- 信任前先审计：装 skill 是供应链变更。评审 SKILL.md diff 与任何 `scripts/`；锁定来源（repo、ref、tree hash）。
- 一事实一归宿：常驻规则写进 AGENTS.md 并链接其出处，别把长流程文本复制进每个仓库。

## 外部席位

席位机制本身（Codex 当 DSH 子代理、第三方适配器、排练端口）见 [cookbook-integration-overlays.zh.md](cookbook-integration-overlays.zh.md)。
