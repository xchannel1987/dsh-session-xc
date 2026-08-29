# dsh-session-xc

[![npm version](https://img.shields.io/npm/v/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![license](https://img.shields.io/npm/l/dsh-session-xc.svg)](https://github.com/xchannel1987/dsh-session-xc/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[中文](README.md) | [English](README_EN.md)

**DSH Session Management Enhancement Plugin** — Powerful session management for sidebar workspaces including statistics display, archive recovery, deletion, and cross-workspace moving.

## ✨ Core Features

### 📊 Session Count Statistics
Display session statistics next to workspace names:

| Format | Meaning |
|--------|---------|
| `(3)` | 3 active sessions |
| `(2/3)` | 2 unread completed / 3 active sessions |

- **Active Sessions**: Non-archived, non-subagent visible sessions
- **Unread Completed**: Completed but not viewed sessions (green number)
- **Drawer Summary**: Workspace drawer title also shows aggregate stats

### 📁 Archived Session Management
- **Archive Entry**: Archive button shown in workspace action area
- **Archive Panel**: Click to view all archived sessions
- **One-Click Restore**: PC - click "Restore" button; Mobile - tap entire row

### 🗑️ Permanent Deletion
Safely delete archived sessions to free up storage:

- **PC**: Red "Delete" button + confirmation dialog
- **Mobile**: Swipe left to reveal delete button + confirmation dialog
- **Clean Removal**: Session files permanently removed after deletion

### 🔀 Cross-Workspace Moving
Drag sessions to target workspace for moving:

- **Drag Indicator**: Highlights when entering valid target
- **Confirmation**: Confirmation dialog before release
- **Auto Categorization**: Workspace attribution updated after move

## 📦 Installation

```bash
# Using DSH CLI
dsh plugin --profile web add dsh-session-xc

# Or using npm
npm install dsh-session-xc
```

Restart DSH after installation. Enhanced features will appear in sidebar workspace list.

## ⚙️ Configuration

| Option | Default | Description |
|--------|---------|-------------|
| showSessionCount | true | Show session count statistics |
| enableDragMove | true | Enable drag-and-drop moving |

## 🎮 Usage Guide

### View Session Statistics
- Check numbers next to workspace names
- Expand workspace to see details
- Green numbers indicate unread completed sessions

### Restore Archived Sessions
1. Click archive button (folder icon) next to workspace
2. Find target session in archive panel
3. Click "Restore" button

### Delete Archived Sessions
1. Find target session in archive panel
2. PC: Click red "Delete" button
3. Mobile: Swipe left and tap "Delete"
4. Confirm deletion

### Move Sessions to Other Workspaces
1. Long press session row to start dragging
2. Drag to target workspace or any session under it
3. Release when target highlights
4. Confirm move

## 🔧 Data Sources

- **Workspace Data**: RPC `workspace.list`
- **Session Data**: RPC `sessions.list`
- **Polling Refresh**: 5-second interval + immediate refresh when page visible

## 📱 Mobile Adaptation

- **Touch Friendly**: 44px minimum touch target
- **Swipe Gestures**: Swipe left to reveal delete button
- **Responsive Layout**: Auto-adapts to different screen sizes

## 📄 License

[MIT](LICENSE)

## 🔗 Links

- [GitHub](https://github.com/xchannel1987/dsh-session-xc)
- [npm](https://www.npmjs.com/package/dsh-session-xc)
- [Issues](https://github.com/xchannel1987/dsh-session-xc/issues)
