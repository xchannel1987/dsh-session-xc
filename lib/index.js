// dsh-session-xc 插件入口（Host / Node 侧）
//
// 职责：
//   1. 注册设置命名空间 dsh-session-xc（showSessionCount / showArchiveEntry / enableSessionMove 开关），
//      设置页"会话增强"卡片由客户端 settings.plugin.item 渲染。
//   2. 功能 1（工作区可见会话数）为纯客户端功能（lib/client.js 调官方 workspace.list RPC）。
//   3. 功能 2（已归档会话入口 + 恢复）：官方只有单向 workspace.archiveSession，没有
//      unarchive；本插件注册 /dsh-session-xc RPC 的 unarchiveSession 端点，从
//      workspaceRegistry 的全局 archivedSessionIds 移除目标会话。
//   4. 功能 3（跨工作区移动会话）：修改 session 日志文件中的 cwd 字段，实现真正的移动。
//   5. 功能 4（删除已归档会话）：从 archivedSessionIds 移除并删除会话文件，释放存储空间。

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { realpath, mkdir, rm } from "node:fs/promises";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { join, dirname } from "node:path";

export const name = "dsh-session-xc";
export const inject = [];

const NS = "dsh-session-xc";

/** 设置命名空间 schema。 */
const SettingsSchema = z.object({
  showSessionCount: z.boolean().default(true),
  showArchiveEntry: z.boolean().default(true),
  enableSessionMove: z.boolean().default(true)
});

// ========== 路径编码函数（从官方 dsh-session-persistence-jsonl 复制） ==========

/** 将 cwd 编码为项目目录名（如 --D-workspace-project-a--）。 */
function projectKey(cwd) {
  if (!cwd) return "_no-cwd";
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i];
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (/^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 将 sessionId 编码为安全路径段。 */
function encodeSegment(raw) {
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** 获取 sessions root 目录路径。 */
function getSessionsRoot() {
  const home = process.env.USERPROFILE || process.env.HOME;
  return join(home, ".dsh", "sessions");
}

// ========== 移动会话文件 ==========

/**
 * 移动会话日志文件，修改 header 中的 cwd。
 * @param {string} sessionId - 会话 ID
 * @param {string} oldCwd - 原工作区路径
 * @param {string} newCwd - 目标工作区路径
 * @returns {Promise<{success: boolean}>}
 */
async function moveSessionFile(sessionId, oldCwd, newCwd) {
  const root = getSessionsRoot();
  const oldProjectDir = projectKey(oldCwd);
  const newProjectDir = projectKey(newCwd);
  const sessionDirName = encodeSegment(sessionId);
  
  const oldPath = join(root, oldProjectDir, sessionDirName, "session.jsonl.zstd");
  const newDir = join(root, newProjectDir, sessionDirName);
  const newPath = join(newDir, "session.jsonl.zstd");
  
  // 1. 读取并解压
  const { readFile } = await import("node:fs/promises");
  const compressed = await readFile(oldPath);
  const decompressed = zstdDecompressSync(compressed);
  const content = decompressed.toString("utf8");
  
  // 2. 修改第一行（header）
  const firstNewline = content.indexOf("\n");
  const firstLine = content.substring(0, firstNewline);
  const rest = content.substring(firstNewline);
  
  const header = JSON.parse(firstLine);
  header.cwd = newCwd;  // 关键：修改 cwd
  const newFirstLine = JSON.stringify(header);
  const newContent = newFirstLine + rest;
  
  // 3. 重新压缩
  const newCompressed = zstdCompressSync(Buffer.from(newContent, "utf8"));
  
  // 4. 写入新位置
  await mkdir(newDir, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(newPath, newCompressed);
  
  // 5. 删除旧文件
  await rm(dirname(oldPath), { recursive: true, force: true });
  
  return { success: true };
}

// ========== WorkspaceId 品牌类型（简化版，不引入额外依赖） ==========

/** 将字符串标记为 WorkspaceId（编译时品牌，运行时无开销）。 */
function WorkspaceId(id) {
  return id;
}

/**
* @param ctx - cordis 上下文（web profile 的 host 合成）。
* @param config - bundle 配置（默认值复用 settings 的默认项）。
*/
export function apply(ctx, config = {}) {
  // 1) 设置分区：持久化到 ~/.dsh/storages（dsh-settings），live 生效。
  installSettingsSection(ctx, settingsNamespace(NS), SettingsSchema, {}, {
    setSource: (source) => {
      void source;
    },
    onChange: () => {
    }
  });

  // 2) RPC 端点
  ctx.inject(["connection", "workspaceRegistry", "sessionPersistence"], (c) => {
    c.connection.rpc.handle(
      "/dsh-session-xc",
      async (endpoint, payload) => {
        // ========== unarchiveSession ==========
        if (endpoint === "unarchiveSession") {
          const sessionId = payload && typeof payload === "object" ? payload.sessionId : void 0;
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            return { ok: false, error: { code: "bad-request", message: "sessionId required", details: {} } };
          }
          const registry = c.workspaceRegistry;
          const state = registry.state;
          const archived = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
          if (archived.includes(sessionId)) {
            const next = { ...state, archivedSessionIds: archived.filter((id) => id !== sessionId) };
            await registry.global.set(next);
            registry.state = next;
          }
          return { ok: true, value: { archivedSessionIds: [...registry.state.archivedSessionIds] } };
        }
        
        // ========== moveSession ==========
        if (endpoint === "moveSession") {
          const { sessionId, targetWorkspaceId } = payload || {};
          
          // 参数校验
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            return { ok: false, error: { code: "bad-request", message: "sessionId required", details: {} } };
          }
          if (typeof targetWorkspaceId !== "string" || targetWorkspaceId.length === 0) {
            return { ok: false, error: { code: "bad-request", message: "targetWorkspaceId required", details: {} } };
          }
          
          // 1. 检查会话是否活跃（在内存中）
          const sessions = c.get("sessions");
          const liveSession = sessions?.get(sessionId);
          if (liveSession !== undefined) {
            return { 
              ok: false, 
              error: { 
                code: "session-active", 
                message: "Cannot move a live session. Please close the session first.",
                details: {}
              } 
            };
          }
          
          const registry = c.workspaceRegistry;
          
          // 2. 获取目标工作区
          const targetWs = registry.get(WorkspaceId(targetWorkspaceId));
          if (!targetWs) {
            return { ok: false, error: { code: "workspace-not-found", message: "Target workspace not found", details: {} } };
          }
          
          // 3. 获取当前 session 信息
          const header = registry.headers.get(sessionId);
          if (!header) {
            return { ok: false, error: { code: "session-not-found", message: "Session not found in persistence", details: {} } };
          }
          
          const oldCwd = registry.sessionPaths.get(sessionId) || header.cwd;
          const newCwd = targetWs.path;
          if (typeof oldCwd !== "string" || oldCwd.length === 0 || typeof newCwd !== "string" || newCwd.length === 0) {
            return { ok: false, error: { code: "session-path-missing", message: "Session workspace path is unavailable", details: {} } };
          }
          
          // 4. 查找源工作区
          let sourceWs = null;
          // 以 workspace.sessionIds 作为归属真源，path 仅作兼容回退。
          for (const ws of registry.list()) {
            if (Array.isArray(ws.record?.sessionIds) && ws.record.sessionIds.includes(sessionId)) {
              sourceWs = ws;
              break;
            }
          }
          if (!sourceWs) {
            for (const ws of registry.list()) {
              if (ws.path === oldCwd) {
                sourceWs = ws;
                break;
              }
            }
          }
          if (!sourceWs) {
            return { ok: false, error: { code: "source-workspace-not-found", message: "Source workspace not found", details: {} } };
          }
          if (oldCwd === newCwd || sourceWs === targetWs) {
            return { ok: false, error: { code: "same-workspace", message: "Session already in target workspace", details: {} } };
          }
          
          // 6. 执行文件移动
          try {
            await moveSessionFile(sessionId, oldCwd, newCwd);
          } catch (err) {
            return { 
              ok: false, 
              error: { 
                code: "move-failed", 
                message: `Failed to move session file: ${err.message}`,
                details: { error: err.message }
              } 
            };
          }
          
          // 7. 更新内存状态
          // 7a. 更新 sessionPaths
          registry.sessionPaths.set(sessionId, newCwd);
          
          // 7b. 更新目标工作区 record（添加 sessionId）
          await targetWs.mutate((record) => ({
            ...record,
            sessionIds: record.sessionIds.includes(sessionId) 
              ? record.sessionIds 
              : [sessionId, ...record.sessionIds]
          }));
          
          // 7c. 更新源工作区 record（移除 sessionId）
          if (sourceWs) {
            await sourceWs.mutate((record) => ({
              ...record,
              sessionIds: record.sessionIds.filter((id) => id !== sessionId)
            }));
          }
          
          return { ok: true, value: { sessionId, targetWorkspaceId } };
        }
        
        // ========== deleteSession ==========
        if (endpoint === "deleteSession") {
          const sessionId = payload && typeof payload === "object" ? payload.sessionId : void 0;
          
          // 1. 参数校验
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            return { ok: false, error: { code: "bad-request", message: "sessionId required", details: {} } };
          }
          
          const registry = c.workspaceRegistry;
          
          // 2. 检查是否已归档（只能删除已归档的会话）
          const archived = Array.isArray(registry.state.archivedSessionIds) 
            ? registry.state.archivedSessionIds 
            : [];
          if (!archived.includes(sessionId)) {
            return { ok: false, error: { code: "session-not-archived", message: "只能删除已归档的会话", details: {} } };
          }
          
          // 3. 获取会话信息（优先从 sessionPaths，否则从 headers）
          let cwd = registry.sessionPaths.get(sessionId);
          if (!cwd) {
            // 如果 sessionPaths 中没有，尝试从 headers 获取 cwd
            const header = registry.headers.get(sessionId);
            if (header && header.cwd) {
              cwd = header.cwd;
            }
          }
          
          // 4. 保留 workspace.sessionIds 占位，直到 sessions.list 发现文件已删除。
          // 如果先脱离工作区，官方 sessions store 的滞后摘要会被归入未分组。
          
          // 5. 删除会话文件目录
          let deleteSuccess = false;
          if (cwd) {
            const root = getSessionsRoot();
            const projectDir = projectKey(cwd);
            const sessionDir = join(root, projectDir, encodeSegment(sessionId));
            try {
              await rm(sessionDir, { recursive: true, force: true });
              deleteSuccess = true;
              console.log("[dsh-session-xc] Deleted session dir:", sessionDir);
            } catch (err) {
              console.error("[dsh-session-xc] Failed to delete session dir:", err);
            }
          }
          
          // 如果 cwd 方式失败，扫描所有项目目录尝试删除
          if (!deleteSuccess) {
            try {
              const { readdir: readdirSync, stat } = await import("node:fs/promises");
              const root = getSessionsRoot();
              const projectDirs = await readdirSync(root).catch(() => []);
              for (const pDir of projectDirs) {
                const sessionDir = join(root, pDir, encodeSegment(sessionId));
                try {
                  const s = await stat(sessionDir);
                  if (s.isDirectory()) {
                    await rm(sessionDir, { recursive: true, force: true });
                    console.log("[dsh-session-xc] Deleted session dir by scan:", sessionDir);
                    deleteSuccess = true;
                    break;
                  }
                } catch (e) {
                  // 目录不存在，继续扫描
                }
              }
            } catch (err) {
              console.error("[dsh-session-xc] Failed to scan and delete:", err);
            }
          }
          
          // 6. 清理内存索引
          registry.sessionPaths.delete(sessionId);
          registry.headers.delete(sessionId);
          
          // 7. 先保留原 workspace.sessionIds，只移除归档标记；
          // sessions.list 刷新后会因文件不存在而移除该会话，避免进入未分组。
          const nextState = {
            ...registry.state,
            archivedSessionIds: archived.filter(id => id !== sessionId)
          };
          await registry.global.set(nextState);
          registry.state = nextState;
          
          return { ok: true, value: { deleted: true, sessionId } };
        }
        
        // 未知端点
        return { ok: false, error: { code: "bad-request", message: "unknown endpoint", details: {} } };
      },
      { authority: "trusted-host" }
    );
  });
  
  return function cleanup() {
  };
}