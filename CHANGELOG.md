# Changelog

## [0.11.4] - 2026-09-24

### Changed
- **设置入口移到新版「插件页」**（与 modsearch、官方 subagent 同款机制）：从
  `settings.plugin.item` 改挂 `plugins.bundle.config`（keyed，key = `dsh-session-xc`），
  `view='page'` 时渲染整页配置表单。旧 `settings.plugin.item` 已随 DSH 0.1.7 设置系统重构移除。

## [0.11.1] - 2026-09-22

### Fixed
- **跨工作区移动后标题丢失：会话在列表里"改名成工作区名、找不到"**。根因：官方会话列表的
  标题来自 `sessionProjectionCache` 的零 I/O 提示（`cachedSnapshot` / `cachedPredecessorTitle`），
  其 `lifecycleIdentityMatches` 要求缓存 record 的 identity 与磁盘 header 的
  createdAt+**cwd**+isSeeded+inheritedEventCount 严格相等。移动只重写了 header.cwd，旧
  checkpoint record 仍绑定旧 cwd → record 被判"无关生命周期"整体读作不存在 → 列表行没有
  title 投影 → 客户端 `displayTitleOf` 回退 basename(cwd) = **工作区名**（要等会话被打开
  一次、投影从日志重折叠并重建 checkpoint 后才自愈）。重启后应用排队移动的场景必现。
  现 `performSessionMove` 成功后同步修复缓存 record 的 identity.cwd：
  - 优先走官方服务写链 `sessionProjectionCache.put()`（ctx.get 动态获取，domain 写链保证
    进程内存+磁盘一致，**本次启动的列表立即恢复标题**）；
  - 服务不可用 / put 失败 / predecessor 旧格式代 record（不得重盖当前版本戳）时，退化为
    磁盘原子改写（tmp+rename，只动 identity.cwd，version 戳与 rows 原样保留，下次启动生效）；
  - 生命周期守卫（createdAt/isSeeded 与旧 header 一致才修）防会话 id 复用误改；全程
    best-effort，任何失败不影响移动本身。

## [0.11.0] - 2026-09-11

### Added
- **新会话首轮自动起名**：每个新顶级会话第一轮结束（turn/end）后延迟约 1.5s，用**会话自身的模型**
  （request header 的 provider/model，无需配置）自动调用一次大模型（maxTokens=2048、60s 超时、
  purpose=session-title），上下文取第一轮的用户提问 + 助手回答（思维链块丢弃），生成有意义的标题后
  经官方 `sessionTitle.rename` 提交（追加 `session/title` 事件，seq 最新者胜出且 source=user 钉住）。
  - **仅非官方模型路由生效**（provider ≠ `deepseek-official`）：官方 DeepSeek 适配器对 session-title
    强制 `thinking: disabled`，内置 LLM 起名本身可用，本插件让位不重复调用；设置项 hint 与 README
    均写明该限制。
  - **背景/根因**：内置 `session-title-first-prompt-llm` 的 `maxOutputTokens: 64` 对推理模型
    （v4-flash/v4-pro/qwen3.8 等）必挂——64 token 被思维链吃光、正文为空（直连 liteLLM 实测
    `finish_reason=length`、`content=""`），只剩"第一轮前几个字"兜底名；pi-ai/liteLLM 适配器
    没有官方 deepseek 适配器那样的 session-title thinking 特判。
  - **一次性 + 不覆盖用户手动名**：每会话仅触发一次；已存在 user 来源标题（手动改名）时跳过；
    仅处理无 parentSession 的顶级会话（subagent 不处理）；会话转瞬失效/无可用 llm 服务/无路由时安全跳过。
  - 设置卡新增「新会话首轮自动起名」开关（默认开，`autoTitleFirstRound`），关闭后回退官方默认行为。
  - 服务端实现零新依赖（按 dsh-llm 流式 chunk 协议自带 ~30 行纯文本组装，不 import 平台包），
    单元可测函数经 `_internal` 导出。

## [0.10.5] - 2026-09-11

### Fixed
- **筛选后仍显示"展开其余 N 个会话"、活跃会话可能看不到**：官方对会话数多的组做预览折叠
  （只渲染前几行 + 展开按钮），筛选态下该按钮的 N 把被隐藏的非活跃会话也计入（误导），
  且折叠预览外的活跃会话根本没渲染。现筛选开启时：可见组若处于折叠态则**代点官方展开按钮**
  并**隐藏该按钮**（展开后计数按钮已无意义）；只记录"筛选代点过"的组，**关闭或暂停（搜索）
  筛选时自动回缩还原**（实例热替换时同样先回缩）。

## [0.10.4] - 2026-09-11

### Changed
- **`@deepseek-ai/dsh-settings` 从 dependencies 降级为 optional peerDependencies**（运行期行为不变）。0.8.x 起设置分区改走 `ctx.settings.register` 服务接口，本插件已不再 import 该 npm 包（全仓 grep 只在注释里出现），这份硬依赖属迁移遗留。留着有两个副作用：
  1. 被 pnpm hoisted 布局顶到 profile 顶层，`dsh plugin add` 每次报 `✕ unmet peer @deepseek-ai/dsh-settings@^0.1.5-rc.1: found 0.1.1-rc.2`；
  2. 更要紧的是这份 0.1.1-rc.2 副本会**遮蔽**同 profile 里真正 import 它的插件（dsh-better-sidebar 静态 import `SettingsConflictError`，peer 要求 ^0.1.5-rc.1），使其按 node_modules 就近解析拿到旧版。改为 optional peer 后 profile 不再落地旧副本，解析回落到 `~/.dsh/profiles/node_modules` 那层宿主依赖镜像（dsh-app-boot 的 profile module fallback），版本与宿主一致。
- 声明为 optional 的意义：`@deepseek-ai/dsh-settings` 由宿主提供、profile 的 `autoInstallPeers: false` 也决定它不该被装进 profile，故不进入 pnpm 的 missing-peer 告警。

## [0.10.3] - 2026-09-11

### Changed
- **筛选按钮样式与官方图标按钮完全一致**：不再手写内联样式，改为运行时复制官方搜索按钮的
  实际 className（28px 圆形、hover 出现主题圆形底色指示、颜色随 header `color:inherit`），
  官方升级更换 CSS module 哈希前缀也自动跟随；另加插件兜底类（复刻官方 `.searchButton` 规则，
  官方类名读取失败时观感不变）。按压态改由专用类 + `!important` 实现（主题蓝 16% 底 +
  主色图标，hover 加深至 24%），不再用内联 style 以免压掉官方 hover。

## [0.10.2] - 2026-09-11

### Fixed
- **筛选按钮被甩到头部最左侧（0.10.1 的修复引入）**：官方 `.searchSlot` 自带
  `margin-left:auto`（搜索框组推右对齐），按钮挂在 slot 之前时 auto 间隙落在按钮与 slot
  之间。现将 auto 转移到按钮自身（`margin-left:auto`）并把 slot 的 `margin-left` 内联清零
  （不触碰官方样式表；按钮移除/插件卸载时还原）。按钮随搜索框组一起靠右、紧贴搜索图标
  左侧；展开搜索时 slot（flex:1）变宽，按钮自动让位。

## [0.10.1] - 2026-09-11

### Fixed
- **只看活跃会话按钮遮挡官方搜索按钮（0.10.0 引入）**：官方折叠态 `.searchSlot{max-width:28px}`
  且 `sectionHeader{overflow:hidden}`，按钮 mount 最初注入 slot 内部（搜索图标之前）导致
  28px 可视窗被 22px 按钮占满、搜索图标被挤出裁切（“搜索按钮不见了”）。现挂点外移一层：
  `sectionHeader` 内、`searchSlot` 之前——视觉仍是搜索图标紧邻左侧，展开搜索时 slot 变宽、
  按钮（flex:none）自动让位；旧位置的残留 mount 由幂等去重循环在下一帧自动清理。

## [0.10.0] - 2026-09-11

### Added
- **只看活跃会话筛选**：工作区抽屉头部搜索图标按钮**左侧**注入开关按钮（自绘漏斗图标 +
  官方 Tooltip；按压态主题蓝底色高亮，`aria-pressed` 标记）。开启后仅显示 updatedAt 落在本地
  日历今天的会话及其所在工作区组（`groupSection` 整体隐藏，不留空隙），再次点击恢复完整列表。
  - 开关状态 localStorage 持久化（键 `dsh-session-xc.onlyActive`），刷新后保持；60s 心跳使
    跨零点后筛选态自动收敛；判定口径与徽标一致（归档/subagent 会话不计入）。
  - 行↔会话映射优先读官方行组件 React fiber（`SessionNodeItem.props.node` /
    `ProjectRowItem.props.group.sessions` 全集，覆盖折叠未渲染行；折叠组含活跃会话时组头
    保留，点开即可见）；fiber 不可用时回退 store/标题匹配，歧义一律保持可见（fail-open）。
  - 搜索词非空（官方搜索结果视图接管列表）时筛选暂停、列表原样，清空后自动恢复；全部隐藏时
    列表区显示“今天没有活跃会话”提示；flat 平铺视图同规则只过滤会话行。
- 设置卡片“会话增强”新增第 4 个开关 `showActiveFilterEntry`（默认开）：关闭后按钮移除并恢复
  完整列表（localStorage 已存的筛选值保留，重新开启时恢复按压态）。
- 服务端设置命名空间新增 `showActiveFilterEntry: boolean`（默认 true）；本功能纯客户端，无新 RPC。

### Known Limitations
- 官方“展开 N 个会话”按钮的计数不感知筛选（数字含被隐藏的非活跃会话，展开后行仍会被正确过滤）；
  筛选期间被隐藏的工作区组无法作为拖拽移动落点（display:none 的自然结果）；
  工作区徽标计数仍显示全部可见会话数，不随筛选变化（刻意保留总体信息）。

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
