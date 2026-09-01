# Changelog

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
