# Changelog

## [0.9.0] - 2026-09-10

### Fixed
- **适配 DSH 0.1.5 服务端 RPC 注册失败（官方回归，服务端功能全灭）**：0.1.5 的
  `connection.rpc.handle` 内部在调用方 fiber 执行 `owner.effect(() => owner.webServer.register(route))`，
  第三方插件无论怎样声明 inject 都被 cordis 以 `cannot get property "webServer" without inject`
  拒绝（离线用真实 cordis 4.0.2 + 官方源码复现；线上表现为 `POST /dsh-session-xc/*` 全 405），
  恢复/删除/批量删除/移动/排队查询集体失效。现改为 `connection.fetch.register` 把五个端点挂载为
  `/api/dsh-session-xc/<endpoint>` 精确 Fetch 路由（复用官方 /api 通道的 Host/Origin 围栏、浏览器
  认证与 client-request 信封），旧通道保留 try/catch 兜底（<=0.1.4，或 0.1.5+ 已在
  cordis.patch.yml 给 connection bundle 补注 webServer 的环境）；客户端统一先走 /api、
  transport 失败自动回退旧通道。
- **适配会话格式代际（DSH 0.1.5 持久层 v1-v3，修复移动的数据危险路径）**：会话日志分"代际"文件
  （v0=`session.jsonl(.zstd)`，现行 v3=`session.v3.jsonl(.zstd)`；旧会话被打开时官方迁移发布新代
  且**保留旧代文件**），官方只认编号最高代的 header 并校验其 cwd 与所在目录一致
  （`assertStoredIdentity`）。0.8.x 移动逻辑只认 v0 文件名：仅含 v3 的会话移动报"日志不存在"；
  v0+v3 并存的已迁移会话移动后 v3（cwd 仍指旧目录）随目录带走 → 官方打开时判定身份不一致、
  `listArtifacts` 抛错可**拖垮整个会话列表**。现移动改为扫描全部规范代际文件、只重写最高代
  首帧 header（其余字段与事件帧逐字节保留），低代历史原样随行，目标重复检查与混合编码
  拒绝同步覆盖所有代际。
- 客户端移除对 0.1.5 已删除的 `connection.api` 门面的引用（失效的 `api.workspace.list`
  轮询回退删除；主路径 store 订阅不受影响）。
- 移动端"恢复会话后保持侧边栏展开"的按钮 aria-label 兼容 0.1.5 新官方文案「打开侧边栏」
  （旧文案「展开侧边栏」保留兜底）。
- `package.json` 的 `dsh.client.inject` 移除 0.1.5 已删除的 `@deepseek-ai/dsh-client-ui-slots`，
  替换为 `slots` 服务新提供方 `@deepseek-ai/dsh-client-ui-renderer`。

### Added
- 服务端启动时打印 `[dsh-session-xc] RPC transports mounted: ...`，两种传输的挂载结果可直接
  从 `~/.dsh/dsh-web.log` 观察（一个都挂不上时打 FATAL）。

## [0.8.2] - 2026-09-08

### Added
- package.json 声明 `engines.dsh: ">=0.1.2-alpha.3"`，供 dsh-market 展示宿主版本要求并参与兼容性过滤；无功能改动。

## [0.8.1] - 2026-09-07

### Fixed
- **修复移动会话导致历史全部丢失的严重数据损坏**（0.7.0 引入移动功能以来所有版本受影响）。
  根因一：官方会话日志是"多个独立 zstd 帧拼接"的容器（首帧=恰好一行 header，后续帧=事件
  批次，均带 checksum），而 node:zlib 的一次性 `zstdDecompressSync` 对多帧输入**只会静默
  返回第一帧**；旧实现据此以为拿到了整个文件，重压缩写出的"移动后"会话只剩 header 帧，
  随后旧目录被删除，历史事件永久丢失。现改为：逐帧结构扫描（移植官方 `scanZstdFrames`），
  只重写首帧 header 的 cwd（与官方同款 checksum 帧），事件帧（含写入中断的撕裂尾帧）
  逐字节原样保留。
- 根因二：排队移动清单 `pendingMoves` 存于 workspaceRegistry 全局状态，但官方 workspace
  domain 每次启动都会用 zod schema 重新 parse 存储值，未知键被剥掉——排队跨重启必然丢失，
  "重启后自动应用"从未真正生效（用户重启后再次拖拽即触发根因一的即时移动损坏）。现改存
  插件自有文件 `~/.dsh/storages/dsh-session-xc/pending-moves.json`（tmp+rename 原子写入），
  并在同进程热升级时一次性迁移旧全局状态里的遗留条目。
- 根因三（防御）：即使解压完整，旧实现"整文件重压成单帧、无 checksum"也违反官方
  "首帧=恰好一行 header"的硬校验（`assertZstdHeaderFrame`），会被官方读取器判为损坏并使
  整个会话列表枚举抛错。新实现写入前先经官方读取器同款校验（分块读首帧→解码→断言
  header 行/id/cwd），通过后才原子改名发布。
- 移动流程改为"要么完整移动、要么原样不动"：目标产物已存在即拒绝（防重复会话 id 击穿
  官方列表）；新文件校验通过后才删除旧目录；删除旧目录失败（如会话意外常驻、文件被占用）
  自动回滚新副本。
- 新增同目录防护：源/目标路径编码到同一物理会话目录时（分隔符方向差异、Windows/NTFS
  大小写不敏感）直接按 same-workspace 拒绝——旧实现在该场景会"就地重写+删除整个目录"，
  让会话彻底消失（归档列表里留下打不开也恢复不了的幽灵条目）。
- 移动成功后同步更新 workspaceRegistry 内存索引（`headers` 的 cwd 此前不更新，导致官方
  成员过滤告警、后续删除/再移动把旧 cwd 当路径真源）。
- 支持官方 compression=none 的明文 `session.jsonl` 日志移动；两种编码产物并存的目录
  （官方视为 encoding mismatch）拒绝操作。

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
