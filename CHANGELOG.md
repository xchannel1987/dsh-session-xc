# Changelog

## [0.7.9] - 2026-09-01

### Fixed
- 修复"工作区总活跃会话数"（抽屉分区标题汇总徽标）在归档/恢复会话后不更新的问题：徽标作为标题子节点注入后，标题元素的 textContent 混入了徽标文本（如 "工作区 (5)"），导致后续标题匹配失败、汇总徽标自首次挂载起冻结。

## [0.7.8] - 2026-09-01

### Fixed
- 拖拽会话校验：仅当 transfer 中 id 是 sessions store 真实会话 id 时才处理移动，避免工作区行拖拽（官方同样写入 text/plain）被误判为会话移动。

## [0.7.7] - 2026-09-01

### Fixed
- 声明 `sessions` / `workspaces` 为客户端注入服务（对齐官方 dsh-client-ui-workspace 模式），修复 `ctx.get` 取不到会话/工作区服务导致徽标/归档/拖拽不生效的问题。

## [0.7.6] - 2026-09-01

### Fixed
- 客户端会话数据层适配新 DSH：sessions 独立服务 + phase 就绪判断。

## [0.7.5] - 2026-09-01

### Fixed
- Host 端不再依赖旧版 dsh-settings 的 `installSettingsSection` / `settingsNamespace` 导出（新版 0.1.2-alpha.3 已移除），改为直接经 `ctx.settings.register` 服务接口注册设置命名空间。

## [0.7.4] - 2025-01-20

### Added
- Unread completed session count display

## [0.7.0] - 2025-01-15

### Added
- Cross-workspace session move
- Batch delete archived sessions

## [0.6.0] - 2025-01-10

### Added
- Archived sessions management (view/restore/delete)

## [0.5.0] - 2025-01-05

### Added
- Workspace session count display
