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
//      新 DSH（>=0.1.2-alpha.3）中会话一旦被 GUI 打开，Host 即常驻激活其 Agent，直到进程退出
//      才释放（关闭浏览器标签页不会释放）。移动常驻会话会造成历史分裂，故常驻会话的移动先排队
//      到 workspaceRegistry 全局状态（pendingMoves），由下次 Host 启动时自动应用。
//   5. 功能 4（删除已归档会话）：从 archivedSessionIds 移除并删除会话文件，释放存储空间。

import z from "@deepseek-ai/schemastery";
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

// ========== 会话移动：即时执行 / 常驻排队 ==========

/**
 * 实际执行一次会话移动（不检查常驻状态；调用方须保证会话未在本进程激活）。
 * 移动日志文件、改写 header 中的 cwd，并同步 workspaceRegistry 内存与持久状态。
 * @param c - 注入了 workspaceRegistry 等服务的上下文。
 * @param {string} sessionId - 会话 ID。
 * @param {string} targetWorkspaceId - 目标工作区 ID。
 * @returns {Promise<{ok: boolean, value?: object, error?: object}>}
 */
async function performSessionMove(c, sessionId, targetWorkspaceId) {
  const registry = c.workspaceRegistry;

  // 1. 获取目标工作区
  const targetWs = registry.get(WorkspaceId(targetWorkspaceId));
  if (!targetWs) {
    return { ok: false, error: { code: "workspace-not-found", message: "Target workspace not found", details: {} } };
  }

  // 2. 获取当前 session 信息
  const header = registry.headers.get(sessionId);
  if (!header) {
    return { ok: false, error: { code: "session-not-found", message: "Session not found in persistence", details: {} } };
  }

  const oldCwd = registry.sessionPaths.get(sessionId) || header.cwd;
  const newCwd = targetWs.path;
  if (typeof oldCwd !== "string" || oldCwd.length === 0 || typeof newCwd !== "string" || newCwd.length === 0) {
    return { ok: false, error: { code: "session-path-missing", message: "Session workspace path is unavailable", details: {} } };
  }

  // 3. 查找源工作区：以 workspace.sessionIds 作为归属真源，path 仅作兼容回退。
  let sourceWs = null;
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

  // 4. 执行文件移动
  try {
    await moveSessionFile(sessionId, oldCwd, newCwd);
  } catch (err) {
    return { ok: false, error: { code: "move-failed", message: `Failed to move session file: ${err.message}`, details: { error: err.message } } };
  }

  // 5. 更新内存与持久状态
  registry.sessionPaths.set(sessionId, newCwd);
  await targetWs.mutate((record) => ({
    ...record,
    sessionIds: Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)
      ? record.sessionIds
      : [sessionId, ...(Array.isArray(record.sessionIds) ? record.sessionIds : [])]
  }));
  await sourceWs.mutate((record) => ({
    ...record,
    sessionIds: (Array.isArray(record.sessionIds) ? record.sessionIds : []).filter((id) => id !== sessionId)
  }));

  return { ok: true, value: { sessionId, targetWorkspaceId } };
}

/** 读取排队移动列表（存于 workspaceRegistry 全局状态，跨重启持久）。 */
function getPendingMoves(registry) {
  return Array.isArray(registry.state?.pendingMoves) ? registry.state.pendingMoves : [];
}

/** 写回排队移动列表。 */
async function savePendingMoves(registry, list) {
  const next = { ...registry.state, pendingMoves: list };
  await registry.global.set(next);
  registry.state = next;
}

/** 排队一个移动；同一会话只保留最后一次目标（后拖覆盖先拖）。 */
async function enqueuePendingMove(registry, sessionId, targetWorkspaceId) {
  const next = getPendingMoves(registry).filter((m) => m && m.sessionId !== sessionId);
  next.push({ sessionId, targetWorkspaceId });
  await savePendingMoves(registry, next);
}

/** 应用时发现"条目已失效"的错误码：直接丢弃，不再排队。 */
const STALE_MOVE_ERRORS = new Set([
  "workspace-not-found",
  "session-not-found",
  "session-path-missing",
  "source-workspace-not-found",
  "same-workspace"
]);

/**
 * 尝试应用排队中的移动：
 * - 仍在本进程常驻激活的会话：跳过（留待下次启动）；
 * - 目标/源/会话已消失或已在目标工作区：丢弃；
 * - 文件读写等暂时性失败：保留，下次重试。
 * @param c - 注入了 workspaceRegistry / sessions 的上下文。
 * @returns {Promise<{applied: number, dropped: number, deferred: number}>}
 */
async function flushPendingMoves(c) {
  const registry = c.workspaceRegistry;
  const pending = getPendingMoves(registry);
  const result = { applied: 0, dropped: 0, deferred: 0 };
  if (pending.length === 0) return result;
  const remaining = [];
  for (const entry of pending) {
    if (!entry || typeof entry.sessionId !== "string" || entry.sessionId.length === 0
      || typeof entry.targetWorkspaceId !== "string" || entry.targetWorkspaceId.length === 0) {
      result.dropped += 1;
      continue;
    }
    if (c.sessions?.get(entry.sessionId) !== undefined) {
      result.deferred += 1;
      remaining.push(entry);
      continue;
    }
    const res = await performSessionMove(c, entry.sessionId, entry.targetWorkspaceId);
    if (res.ok) {
      result.applied += 1;
      console.log(`[dsh-session-xc] Applied queued session move: ${entry.sessionId} -> ${entry.targetWorkspaceId}`);
    } else if (STALE_MOVE_ERRORS.has(res.error && res.error.code)) {
      result.dropped += 1;
      console.warn(`[dsh-session-xc] Dropped stale queued move for ${entry.sessionId}: ${res.error && res.error.code}`);
    } else {
      result.deferred += 1;
      remaining.push(entry);
      console.error(`[dsh-session-xc] Queued move deferred for ${entry.sessionId}: ${(res.error && res.error.message) || "unknown"}`);
    }
  }
  if (remaining.length !== pending.length) {
    await savePendingMoves(registry, remaining);
  }
  return result;
}

/**
* @param ctx - cordis 上下文（web profile 的 host 合成）。
* @param config - bundle 配置（默认值复用 settings 的默认项）。
*/
export function apply(ctx, config = {}) {
  const startupTimers = [];
  // 1) 设置分区：持久化到 ~/.dsh/storages（dsh-settings），live 生效。
  //    直接经 settings 服务注册（与当前 DSH 兼容：dsh-settings 0.1.2-alpha.3 已移除
  //    installSettingsSection / settingsNamespace，统一使用 ctx.settings.register）。
  ctx.inject(["settings"], (sctx) => {
    sctx.settings.register(NS, SettingsSchema, { base: {} });
  });

  // 2) RPC 端点
  ctx.inject(["connection", "workspaceRegistry", "sessionPersistence", "sessions", "agents"], (c) => {
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
          
          const registry = c.workspaceRegistry;
          
          // 顺带应用历史排队（更早的条目可能已具备执行条件）
          await flushPendingMoves(c);
          
          // 常驻检查：新 DSH 中会话一旦被打开即在 Host 常驻激活（Agent 驻留到进程退出，
          // 关闭浏览器标签页不会释放）。其内存 header 仍指向旧 cwd，直接移动文件会让续聊
          // 写回旧路径、重启后触发重复会话 id 故障；因此排队到下次 Host 启动时执行。
          const resident = c.sessions?.get(sessionId);
          if (resident !== undefined) {
            const targetWs = registry.get(WorkspaceId(targetWorkspaceId));
            if (!targetWs) {
              return { ok: false, error: { code: "workspace-not-found", message: "Target workspace not found", details: {} } };
            }
            const currentCwd = registry.sessionPaths.get(sessionId)
              || registry.headers.get(sessionId)?.cwd
              || resident.header?.cwd;
            if (currentCwd && currentCwd === targetWs.path) {
              return { ok: false, error: { code: "same-workspace", message: "Session already in target workspace", details: {} } };
            }
            await enqueuePendingMove(registry, sessionId, targetWorkspaceId);
            const busy = c.agents?.get(sessionId)?.status === "running";
            return { ok: true, value: { sessionId, targetWorkspaceId, queued: true, busy, requiresRestart: true } };
          }
          
          return await performSessionMove(c, sessionId, targetWorkspaceId);
        }
        
        // ========== listPendingMoves ==========
        if (endpoint === "listPendingMoves") {
          const registry = c.workspaceRegistry;
          return { ok: true, value: { pendingMoves: getPendingMoves(registry) } };
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
        
        // ========== deleteAllArchivedSessions ==========
        if (endpoint === "deleteAllArchivedSessions") {
          const { sessionIds, workspaceId } = payload || {};
          if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
            return { ok: false, error: { code: "bad-request", message: "sessionIds array required", details: {} } };
          }
          if (typeof workspaceId !== "string" || workspaceId.length === 0) {
            return { ok: false, error: { code: "bad-request", message: "workspaceId required", details: {} } };
          }

          const registry = c.workspaceRegistry;
          const workspace = registry.get(WorkspaceId(workspaceId));
          if (!workspace) {
            return { ok: false, error: { code: "workspace-not-found", message: "Workspace not found", details: {} } };
          }
          const archived = Array.isArray(registry.state.archivedSessionIds)
            ? registry.state.archivedSessionIds
            : [];
          const workspaceSessionIds = Array.isArray(workspace.record?.sessionIds)
            ? workspace.record.sessionIds
            : [];
          const requestedIds = [...new Set(sessionIds.filter(id => typeof id === "string" && id.length > 0))];
          const deletedIds = [];
          const failedIds = [];

          for (const sessionId of requestedIds) {
            if (!archived.includes(sessionId) || !workspaceSessionIds.includes(sessionId)) {
              failedIds.push(sessionId);
              continue;
            }

            let cwd = registry.sessionPaths.get(sessionId);
            if (!cwd) {
              const header = registry.headers.get(sessionId);
              if (header && header.cwd) cwd = header.cwd;
            }

            let deleteSuccess = false;
            if (cwd) {
              const root = getSessionsRoot();
              const sessionDir = join(root, projectKey(cwd), encodeSegment(sessionId));
              try {
                await rm(sessionDir, { recursive: true, force: true });
                deleteSuccess = true;
                console.log("[dsh-session-xc] Deleted session dir:", sessionDir);
              } catch (err) {
                console.error("[dsh-session-xc] Failed to delete session dir:", err);
              }
            }
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
                      deleteSuccess = true;
                      console.log("[dsh-session-xc] Deleted session dir by scan:", sessionDir);
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

            if (deleteSuccess) {
              deletedIds.push(sessionId);
              registry.sessionPaths.delete(sessionId);
              registry.headers.delete(sessionId);
            } else {
              failedIds.push(sessionId);
            }
          }

          const nextState = {
            ...registry.state,
            archivedSessionIds: archived.filter(id => !deletedIds.includes(id))
          };
          if (deletedIds.length > 0) {
            await registry.global.set(nextState);
            registry.state = nextState;
          }
          return {
            ok: true,
            value: {
              deletedCount: deletedIds.length,
              failedCount: failedIds.length,
              deletedIds,
              failedIds,
              archivedSessionIds: [...registry.state.archivedSessionIds]
            }
          };
        }
        
        // 未知端点
        return { ok: false, error: { code: "bad-request", message: "unknown endpoint", details: {} } };
      },
      { authority: "trusted-host" }
    );

    // 启动后自动应用排队移动。浏览器重连可能早于 flush（会话重新常驻 → 条目顺延到下次启动）
    // 或晚于 flush（直接应用成功），故安排两次尝试。
    for (const delay of [1500, 6000]) {
      const timer = setTimeout(() => {
        flushPendingMoves(c).catch((err) => {
          console.error("[dsh-session-xc] flushPendingMoves error:", err);
        });
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
      startupTimers.push(timer);
    }
  });
  
  return function cleanup() {
    for (const timer of startupTimers) clearTimeout(timer);
  };
}