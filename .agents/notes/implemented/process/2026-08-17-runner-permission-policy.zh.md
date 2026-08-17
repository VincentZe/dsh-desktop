# Agent Note: Runner child 权限策略

Status: implemented

[English](2026-08-17-runner-permission-policy.md) | 中文

## 问题

runner 之前没有调用方可控制的权限输入，默认 JSON-RPC 组合还使用未受限的 local bash 和文件系统 provider。因此调用方无法选择 child 的文件策略，模型可见的 workspace 也可能被误认为执行限制。

## 决策

runner 接受 `--permission read-only|workspace-write|danger-full-access` 和 `--approval ask|never`。默认解析为 `workspace-write + ask`；显式选择 full access 且未覆盖审批策略时，审批改为 `never`；解析结果通过 `DSH_PERMISSION_MODE` 和 `DSH_APPROVAL_POLICY` 传入 child。内置 JSON-RPC 组合通过共享 sandbox policy、sandbox bash、sandbox filesystem 和 approval 插件消费这些值。自定义组合也会收到相同环境变量，但必须自行挂载并消费对应能力。

## 考虑过的替代方案

**只增加 CLI 元数据。** 这会让调用方声明一个策略却不改变执行，而此前的 local provider 不受限制，结果不安全。

**只暴露权限预设。** runner 在这个进程边界还需要为无人值守调用方独立覆盖审批策略，因此两个机制级取值保持显式。

**在 JSON-RPC child 中使用人工审批界面。** child 是 stdout 由协议占用的自动化 runtime；没有配置机器应答者时，审批请求按拒绝关闭，而不会隐式打开提示。

## 后果

默认 runner child 受 workspace 限制，并且由调用方选择策略。策略在 runner 启动 child 时固定；要在运行中改变它，需要暴露会话权限命令的 runtime 或创建新的 child 会话。自定义 `--config` 仍可能忽略这些部署变量，因此需要更强执行限制时必须检查其插件组合。
