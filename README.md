# dsh-session-xc

[![npm version](https://img.shields.io/npm/v/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![license](https://img.shields.io/npm/l/dsh-session-xc.svg)](https://github.com/xchannel1987/dsh-session-xc/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[中文](README.md) | [English](README_EN.md)

**DSH 会话管理增强插件** —— 为侧边栏工作区提供更强大的会话管理功能，包括统计展示、归档恢复、删除、跨工作区移动和新会话首轮自动起名。

## ✨ 核心特性

### 📊 会话数统计展示
在工作区名称旁显示会话数量统计：

| 格式 | 含义 |
|------|------|
| `(3)` | 3 个活跃会话 |
| `(2/3)` | 2 个未读完成会话 / 3 个活跃会话 |

- **活跃会话**：非归档、非子代理的可见会话
- **未读完成**：已完成运行但未查看的会话（绿色数字）
- **抽屉汇总**：工作区抽屉标题也显示汇总统计

### 📁 归档会话管理
- **归档入口**：工作区操作区显示归档按钮
- **归档面板**：点击查看所有已归档会话
- **一键恢复**：PC 端点击「恢复」按钮，移动端点击整行

### 🗑️ 永久删除
安全删除已归档会话，释放存储空间：

- **PC 端**：红色「删除」按钮 + 确认对话框
- **移动端**：左滑显示删除按钮 + 确认对话框
- **安全清理**：删除后会话文件被永久移除

### 🔀 跨工作区移动
拖拽会话到目标工作区实现移动：

- **拖拽指示**：进入有效目标时高亮显示
- **二次确认**：释放前弹出确认对话框
- **自动归类**：移动后自动更新工作区归属
- **常驻排队（v0.8.0）**：DSH 0.1.2+ 中会话一旦被 GUI 打开，Host 即常驻激活该会话
  （关闭标签页不会释放，重启 DSH 才释放）。拖拽这类会话时移动会自动排队并持久化，
  下次重启 DSH 后自动完成，无需额外操作；从未打开过的会话仍然即时移动

### 🔍 只看活跃会话（v0.10.0）
抽屉头部搜索按钮左侧的「只看活跃会话」开关：

- **活跃定义**：会话最后操作时间（updatedAt）落在本地日历“今天”；归档/subagent 会话不计入
- **一键筛选**：开启后只显示今天有操作的会话及其所在工作区，再次点击恢复完整列表
- **状态持久化**：开关状态存 localStorage，刷新后保持；按压态有主题蓝底色高亮
- **与搜索共存**：搜索词非空时筛选自动暂停并恢复完整列表，清空后继续筛选
- **空态提示**：没有任何当天活跃会话时列表区显示“今天没有活跃会话”小字提示

### 🤖 新会话首轮自动起名（v0.11.0）
每个新会话第一轮结束（turn/end）后，延迟约 1.5 秒自动调用大模型，用**会话自身的模型**
（request header 里的 provider/model，无需配置）把标题改成一个有意义的名字：

- **上下文完整**：取第一轮的用户提问 + 助手回答（思维链丢弃），起名质量远高于只取首条消息
- **生效范围（重要）**：仅在**非官方 DeepSeek 模型路由**（provider ≠ `deepseek-official`）下生效——
  官方路由的内置 LLM 起名本身可用（官方适配器对 session-title 强制关闭思维链），本插件让位不重复调用
- **为什么需要它**：内置 LLM 起名在"推理模型 + liteLLM/pi-ai 路由"下必挂（起名额度 64 token 被
  思维链吃光、正文为空），只剩"第一轮前几个字"的兜底名；本插件用 2048 token 额度 + 完整回合上下文补上
- **落库方式**：经官方 `sessionTitle.rename` 追加 `session/title` 事件（seq 最新者胜出），
  并把标题钉住——不会被之后的自动生成覆盖；你在第一轮里手动改过的名字也不会被覆盖
- **一次性**：每个会话只触发一次；仅处理新顶级会话（subagent 会话不处理）
- **可开关**：设置卡「新会话首轮自动起名」开关（默认开），关闭后回退官方默认行为

## 📦 安装

```bash
# 使用 DSH CLI
dsh plugin --profile web add dsh-session-xc

# 或使用 npm
npm install dsh-session-xc
```

安装后重启 DSH，侧边栏工作区列表将显示增强功能。

## ⚙️ 配置

| 选项 | 默认值 | 说明 |
|------|--------|------|
| showSessionCount | true | 显示会话数统计 |
| showArchiveEntry | true | 工作区操作区显示归档入口 |
| enableSessionMove | true | 启用拖拽移动功能 |
| showActiveFilterEntry | true | 搜索按钮左侧显示“只看活跃会话”开关按钮 |
| autoTitleFirstRound | true | 新会话第一轮自动起名（仅非官方模型路由生效；官方路由已有内置 LLM 起名） |

## 🎮 使用指南

### 查看会话统计
- 查看工作区名称旁的数字
- 展开工作区查看详细信息
- 绿色数字表示未读完成的会话

### 恢复归档会话
1. 点击工作区旁的归档按钮（文件夹图标）
2. 在归档面板中找到目标会话
3. 点击「恢复」按钮

### 删除归档会话
1. 在归档面板中找到目标会话
2. PC 端点击红色「删除」按钮
3. 移动端左滑后点击「删除」
4. 确认删除

### 只看活跃会话
1. 点击抽屉头部搜索按钮左侧的漏斗图标按钮（开启后呈主题蓝按压态）
2. 列表只显示今天有操作记录的会话及其工作区；组折叠时含活跃会话的工作区仍保留，点开即可见
3. 再次点击按钮恢复完整列表；开关状态刷新页面后保持

### 新会话首轮自动起名
1. 新开一个会话并完成第一轮对话（提问 + 回复结束）
2. 约 1.5 秒后，插件用该会话自身模型生成一个有意义的标题并写入会话
3. 侧边栏/标签页显示的名字自动更新；之后不会再变（除非你手动改名）

> 仅非官方模型路由生效：官方 DeepSeek 模型（deepseek-official）下内置起名已可用，本插件不重复调用。

### 移动会话到其他工作区
1. 长按会话行开始拖拽
2. 拖到目标工作区或该工作区下的会话
3. 目标高亮时释放
4. 确认移动（若提示"已排队"，说明该会话在本 DSH 进程内常驻，重启 DSH 后自动完成移动）

## 🔧 数据来源

- **工作区数据**：RPC `workspace.list`
- **会话数据**：RPC `sessions.list`
- **轮询刷新**：store 订阅 + 页面可见时即时刷新 + 60 秒心跳（v0.10.0 起跨天筛选态自动收敛）
- **活跃判定（v0.10.0）**：sessions store 的 updatedAt（官方行相对时间同源字段）；行↔会话映射优先读官方组件 React fiber（props.node / props.group.sessions 全集），失败回退标题匹配并 fail-open
- **移动安全（v0.9.0+）**：兼容 DSH 0.1.5 会话格式代际（`session.jsonl.zstd` / `session.vN.jsonl.zstd`
  多代并存）：移动只重写编号最高代文件的 header 帧，低代历史文件逐字节原样随行
- **RPC 通道（v0.9.0+）**：DSH 0.1.5+ 走 `/api/dsh-session-xc/<endpoint>` 精确路由（复用官方认证围栏），
  transport 失败自动回退旧 `/dsh-session-xc` 通道（0.1.5 的 `connection.rpc.handle` 存在第三方插件
  注册回归，旧通道在 0.1.5 需宿主侧补丁才可用）

## 📱 移动端适配

- **触摸友好**：44px 最小触控区域
- **滑动手势**：左滑显示删除按钮
- **响应式布局**：自动适配不同屏幕尺寸

## 📄 许可证

[MIT](LICENSE)

## 🔗 链接

- [GitHub](https://github.com/xchannel1987/dsh-session-xc)
- [npm](https://www.npmjs.com/package/dsh-session-xc)
- [问题反馈](https://github.com/xchannel1987/dsh-session-xc/issues)
