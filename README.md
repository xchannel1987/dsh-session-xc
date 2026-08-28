# dsh-session-xc

[![npm version](https://img.shields.io/npm/v/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![license](https://img.shields.io/npm/l/dsh-session-xc.svg)](https://github.com/keyiadiannao/dsh-session-xc/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)


DSH 客户端插件：为侧边栏工作区列表提供会话相关小工具。

## 功能

### 功能 1：工作区会话数展示

工作区名称旁和工作区抽屉标题后显示**可见会话数**和**已完成未读会话数**，如 `requirements (2/3)`：

- 显示位置：左侧工作区列表，每个工作区名称旁（半角括号）；
- **可见会话数（活跃）**：工作区 `sessionIds` 中 非归档、非子代理、且 blank 会话仅当前会话计入的会话数，与展开该工作区后侧边栏实际显示的行数一致；
- **已完成未读会话数**：可见会话中 `completed === true` 的会话数（即会话行前的绿色点，表示已完成运行但未被查看的会话）；显示时用绿色数字标识；
- **显示格式**：
  - 无已完成未读：`(3)` - 只显示活跃会话数
  - 有已完成未读：`(2/3)` - 2 是未读数（绿色），3 是活跃数
- **工作区抽屉标题**：也显示所有工作区的汇总统计，格式相同；
- 当前会话 id 读取官方持久化选择 `localStorage["dsh.sessions.current"]`；
- 数量都为 0 时**不显示**括号；
- 数据来源：订阅 DSH 核心的 `workspaces.list` 和 `sessions.list` store

### 功能 2：已归档会话入口与恢复

- 工作区操作区显示归档按钮（有归档会话时）
- 点击归档按钮打开归档面板
- **PC 端**：每个会话有「恢复」按钮
- **移动端**：点击整行即恢复

### 功能 3：删除已归档会话

在归档面板中永久删除已归档的会话，释放存储空间：

- **PC 端**：每个会话有「删除」按钮（红色），点击后弹出确认对话框
- **移动端**：左滑显示删除按钮，点击后弹出确认对话框
- 删除后会话文件被永久删除，无法恢复；同步期间保留工作区归属占位，避免残留摘要进入未分组列表

### 功能 4：跨工作区移动会话

拖拽会话行到目标工作区或该工作区下的任意会话行，实现跨工作区移动会话（可在设置中关闭）；拖拽进入有效目标时显示高亮指示，释放前会弹出二次确认。客户端复用官方拖拽的 `dataTransfer.text/plain` 会话 ID，服务端以工作区 `sessionIds` 查找源工作区，缺少运行时路径时回退到会话 header.cwd。

---

## 详细说明

### 功能 1：工作区可见会话数

- 数据来源：RPC `workspace.list`（官方，无需改后端）；5s 轮询 + 页面可见时即时刷新，随新建/归档/删除会话自动更新。初始化刷新期间等待完整会话基线和全部挂账会话摘要就绪后再展示数量。

## 结构

```
dsh-session-xc/
├── package.json      # dsh.bundle.patch + dsh.client(platform/inject) 声明
├── cordis.patch.yml  # insert 加载服务端 bundle
├── lib/
│   ├── index.js      # 服务端最小 cordis 插件（承载 bundle 加载）
│   └── client.js     # 客户端：workspace.list + session.list → DOM 注入 (N) 徽标
├── build.ps1         # npm pack → tgz
└── README.md
```

## 实现要点

- 官方 `dsh-client-ui-workspace` 无行级 slot（`sidebar.workspaces` 为 single、内部仅 directoryFlow），故采用 **DOM 注入**：
  - 行定位：`[role="treeitem"][aria-expanded]`（官方 `ProjectRowItem` 的稳定属性，不依赖带 hash 的 CSS module 类名）；
  - 标题 span：行内唯一无子元素且文本等于行标题的 span，其后插入 `<span data-dstk-workspace> (N)</span>`；
  - 重建：MutationObserver（body subtree，debounce 300ms）幂等重建；`data-dstk-workspace` 防重复。

## 构建与安装

```powershell
cd D:\workspace\dsh-session-xc
.\build.ps1
dsh plugin --profile web add "dsh-session-xc@file:D:\workspace\dsh-session-xc\dsh-session-xc-0.2.11.tgz"
# 然后手动重启 dsh web（电源按钮或命令行）
```

## 卸载

```powershell
dsh plugin --profile web remove dsh-session-xc
# 重启 dsh web
```

## 已知边界

- 依赖官方工作区行的稳定结构（role/aria-expanded/标题文本）；官方重构该结构后需回归适配。
- `session.list` 不可用时退化为"仅按归档过滤"，子代理挂账场景下数字可能略大。
- 同名工作区（标题可重复）会显示同一计数，后续可升级为按行序/workspaceId 精确关联。
- 归档按钮的 tooltip 复用官方 primitives `Tooltip`（side=bottom / delayMs=500），与 GUI 其它图标按钮提示一致；按钮为 React 渲染，并使用稳定 mount 标识去重，官方重渲染行时由 rAF 同帧恢复。
- 已归档会话面板：PC（视口宽度 >= 768px）使用居中 modal，包含遮罩、标题区、滚动列表和显式“恢复”按钮；点击行主体不恢复，恢复中按钮会禁用。遮罩、关闭按钮和 Esc 均可关闭。移动端继续使用原有小浮层和整行恢复行为；面板挂载在 body，并在 window 捕获阶段拦截官方 outside-pointer 关闭事件，恢复/删除后保持工作区抽屉和归档列表打开，最后一项显示空状态；操作期间保持移动端工作区抽屉和归档面板打开。