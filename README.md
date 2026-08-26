# dsh-session-xc

DSH 客户端插件：为侧边栏工作区列表提供会话相关小工具。

## 功能（第一个目标）

工作区名称旁显示**可见会话数**，如 `requirements (3)`：

- 显示位置：左侧工作区列表，每个工作区名称旁（半角括号）；
- 计数口径：**挂账可见** = 工作区 `sessionIds` 中 非归档（`archivedSessionIds`）、非子代理（`origin !== "subagent"`）、且 blank 会话仅当前会话计入（官方 `sessionVisible` 同款规则）的会话数，与展开该工作区后侧边栏实际显示的行数一致；
- 当前会话 id 读取官方持久化选择 `localStorage["dsh.sessions.current"]`（`SessionRuntime.selection` 的副本，即官方 `list.current` 的来源）；
- 可见会话数为 0 时**不显示**括号；
- 数据来源：RPC `workspace.list`（官方，无需改后端）；5s 轮询 + 页面可见时即时刷新，随新建/归档/删除会话自动更新。

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
- 归档按钮的 tooltip 复用官方 primitives `Tooltip`（side=bottom / delayMs=500），与 GUI 其它图标按钮提示一致；按钮为 React 渲染，官方重渲染行时由 rAF 同帧重插恢复。
- 已归档会话面板：PC（视口宽度 >= 768px）使用居中 modal，包含遮罩、标题区、滚动列表和显式“恢复”按钮；点击行主体不恢复，恢复中按钮会禁用。遮罩、关闭按钮和 Esc 均可关闭。移动端继续使用原有小浮层和整行恢复行为。
