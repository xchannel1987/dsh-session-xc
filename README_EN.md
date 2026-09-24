# dsh-session-xc

[![npm version](https://img.shields.io/npm/v/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![license](https://img.shields.io/npm/l/dsh-session-xc.svg)](https://github.com/xchannel1987/dsh-session-xc/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-session-xc.svg)](https://www.npmjs.com/package/dsh-session-xc)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[中文](README.md) | [English](README_EN.md)

**DSH Session Management Enhancement Plugin** — Powerful session management for sidebar workspaces including statistics display, archive recovery, deletion, cross-workspace moving, and automatic first-round session naming.

> **DSH 0.1.7 compatible (`>=0.1.7-rc.1`)**: settings now live on the new **Plugins** page under the `dsh-session-xc` package (`plugins.bundle.config`, same mechanism as modsearch / official subagent).

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
- **Resident Queuing (v0.8.0)**: In DSH 0.1.2+, once a session is opened in the GUI the
  host keeps its agent resident until DSH restarts (closing tabs does not release it).
  Dropping such a session queues the move persistently; it applies automatically on the
  next DSH startup. Sessions never opened still move instantly.
- **Title Preservation (v0.11.1)**: the move now also repairs the official projection-cache
  record's identity.cwd, so listing titles survive moves and restarts (before 0.11.1 the
  title hint was rejected as an unrelated lifecycle and the row fell back to showing the
  workspace name until the session was opened once).

### 🔍 Active Sessions Filter (v0.10.0)
A “show only active sessions” toggle sits left of the drawer search button:

- **Active =** session last activity (updatedAt) falls on the local calendar “today”; archived/subagent sessions excluded
- **One click** to show only today-active sessions and their workspaces; click again to restore the full list
- **Persistent** toggle state (localStorage); the pressed style is highlighted in accent blue
- **Search-friendly**: filtering pauses while a search query is active and resumes once cleared
- **Empty hint**: shows “no sessions active today” when everything would be hidden

## 📦 Installation

```bash
# Using DSH CLI
dsh plugin --profile web add dsh-session-xc

# Or using npm
npm install dsh-session-xc
```

Restart DSH after installation. Enhanced features will appear in sidebar workspace list.

### 🤖 First-Round Auto Naming (v0.11.0)
About 1.5s after a new top-level session completes its first round (turn/end), the plugin calls the
LLM using **the session's own model** (request-header provider/model, no configuration) to rename the
session meaningfully, using the full first round as context (user prompts + assistant answer, reasoning dropped).

- **Scope (important)**: active only on **non-official DeepSeek routes** (provider ≠ `deepseek-official`) —
  official routes already have working built-in LLM naming (the official adapter disables model thinking for
  session-title calls), so the plugin steps aside there.
- **Why needed**: the built-in title provider fails on "reasoning model + liteLLM/pi-ai" routes
  (its 64-token budget is consumed by chain-of-thought, output text stays empty), leaving only the
  first-few-words fallback; this plugin uses a 2048-token budget plus full-round context.
- Committed via the official `sessionTitle.rename` (`session/title` event — latest seq wins and is
  pinned; a title you renamed manually is never overwritten). One-shot per session; subagent sessions excluded.
- Toggle: "First-round auto naming" in the settings card (default on).

## ⚙️ Configuration

| Option | Default | Description |
|--------|---------|-------------|
| showSessionCount | true | Show session count statistics |
| showArchiveEntry | true | Show archived sessions entry on workspace rows |
| enableSessionMove | true | Enable drag-and-drop moving |
| showActiveFilterEntry | true | Show the “only active sessions” toggle left of the search button |
| autoTitleFirstRound | true | Auto-name new sessions after their first round (non-official model routes only; official routes already have built-in LLM naming) |

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

### Show Only Active Sessions
1. Click the funnel button left of the drawer search button (pressed style = accent blue tint)
2. The list keeps only sessions touched today and their workspaces; collapsed groups that still
   have active sessions stay visible — expand the header to reveal them
3. Click again to restore the full list; the toggle survives page reloads

### Move Sessions to Other Workspaces
1. Long press session row to start dragging
2. Drag to target workspace or any session under it
3. Release when target highlights
4. Confirm move (if you see a "queued" toast, the session is resident in this DSH
   process; the move completes automatically after the next DSH restart)

## 🔧 Data Sources

- **Workspace Data**: RPC `workspace.list`
- **Session Data**: RPC `sessions.list`
- **Refresh**: store subscriptions + immediate refresh when page visible + 60s heartbeat
  (since v0.10.0 filter state converges automatically across midnight)
- **Activity data (v0.10.0)**: `updatedAt` from the sessions store (same field the official
  relative-time labels use); row→session mapping reads official components' React fiber
  (`props.node` / `props.group.sessions`, the full set incl. collapsed rows), falling back to
  title matching with fail-open behavior
- **Move safety (v0.9.0+)**: compatible with DSH 0.1.5 session format generations
  (`session.jsonl.zstd` / `session.vN.jsonl.zstd` coexisting in one directory): a move rewrites
  only the numerically highest generation's header frame; older generations ride along untouched
- **Title hint preservation (v0.11.1)**: official listing titles come from the
  `sessionProjectionCache` zero-I/O hint, whose record identity must match the header exactly
  (incl. cwd); a move now rewrites the record's identity.cwd too (official `put()` write chain
  first, atomic on-disk rewrite as fallback), so titles survive moves and restarts
- **RPC transport (v0.9.0+)**: on DSH 0.1.5+ endpoints are served under the exact routes
  `/api/dsh-session-xc/<endpoint>` (inheriting the official /api auth fence), with automatic
  fallback to the legacy `/dsh-session-xc` channel (0.1.5's `connection.rpc.handle` has a
  third-party registration regression; the legacy channel needs a host-side patch there)

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
