# Changelog

## [0.8.0] - 2026-09-04

### Fixed
- 适配 DSH 0.1.2+ 的会话常驻语义，修复"跨工作区移动会话"提示
  `Cannot move a live session. Please close the session first.` 导致功能整体不可用的问题。
  根因：新 DSH 中会话一旦被 GUI 打开，Host 即常驻激活其 Agent，直到进程退出都不会释放
  （关闭浏览器标签页无效，且新核心没有向客户端提供任何释放/关闭会话的 RPC），
  旧的"常驻即拒移"检查几乎拦截所有被点开过的会话。
- 新行为：未常驻会话仍即时移动；常驻会话拖拽时将移动排队并持久化到
  workspaceRegistry 全局状态（pendingMoves），下次 Host 启动时（1.5s / 6s 两次尝试 +
  任意 moveSession 调用时顺带）在会话再次激活前自动应用；排队幂等、同会话后拖覆盖先拖、
  失效条目自动丢弃、文件暂时不可用时保留待下次重试。
- 客户端 toast 区分"已移动 / 已排队（重启后自动完成）"；页面加载后如仍有未应用的排队
  （如浏览器在 Host flush 前抢先重连并打开该会话），提示剩余数量。
- 新增 `listPendingMoves` RPC 端点；服务端 RPC 显式声明 `sessions` / `agents` 注入服务。

### Changed
- 仓库维护：`src/client.js` 从 `lib/client.js` 反向恢复为完整同源副本
  （自 v0.7.6 起因手工双写漂移，尾部截断约 650 行、且缺失 0.7.9 修复；两者仅行尾符不同）。

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
