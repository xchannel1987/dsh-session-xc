# dsh-session-xc

[![npm version](https://img.shields.io/npm/v/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![license](https://img.shields.io/npm/l/dsh-session-xc.svg)](https://github.com/xchannel1987/dsh-session-xc/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[中文](README.md) | [English](README_EN.md)

**DSH 会话管理增强插件** —— 为侧边栏工作区提供更强大的会话管理功能，包括统计展示、归档恢复、删除和跨工作区移动。

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
| enableDragMove | true | 启用拖拽移动功能 |

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

### 移动会话到其他工作区
1. 长按会话行开始拖拽
2. 拖到目标工作区或该工作区下的会话
3. 目标高亮时释放
4. 确认移动（若提示"已排队"，说明该会话在本 DSH 进程内常驻，重启 DSH 后自动完成移动）

## 🔧 数据来源

- **工作区数据**：RPC `workspace.list`
- **会话数据**：RPC `sessions.list`
- **轮询刷新**：5 秒间隔 + 页面可见时即时刷新

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
