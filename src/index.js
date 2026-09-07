// dsh-session-xc 插件入口（Host / Node 侧）
//
// 职责：
//   1. 注册设置命名空间 dsh-session-xc（showSessionCount / showArchiveEntry / enableSessionMove 开关），
//      设置页"会话增强"卡片由客户端 settings.plugin.item 渲染。
//   2. 功能 1（工作区可见会话数）为纯客户端功能（lib/client.js 调官方 workspace.list RPC）。
//   3. 功能 2（已归档会话入口 + 恢复）：官方只有单向 workspace.archiveSession，没有
//      unarchive；本插件注册 /dsh-session-xc RPC 的 unarchiveSession 端点，从
//      workspaceRegistry 的全局 archivedSessionIds 移除目标会话。
//   4. 功能 3（跨工作区移动会话）：仅重写 session 日志的首帧（header 帧）中的 cwd 字段，
//      事件帧逐字节原样保留，实现真正的移动。官方 zstd 容器是"多帧拼接"（首帧=恰好一行
//      header，后续帧=事件批次，均带 checksum）；一次性 zstdDecompressSync 只会静默返回
//      第一帧，旧实现据此整文件重压缩导致会话历史全部丢失（0.8.1 修复：逐帧扫描 +
//      只替换首帧 + 临时文件写入 + 官方读取器同款校验通过后才删旧目录，失败自动回滚）。
//      新 DSH（>=0.1.2-alpha.3）中会话一旦被 GUI 打开，Host 即常驻激活其 Agent，直到进程退出
//      才释放（关闭浏览器标签页不会释放）。移动常驻会话会造成历史分裂，故常驻会话的移动先排队。
//      排队清单持久化在插件自有文件 ~/.dsh/storages/dsh-session-xc/pending-moves.json
//      （0.8.1 修复：0.8.0 存 workspaceRegistry 全局状态，官方 domain open 时被 zod schema
//      剥掉未知键，重启后排队必然丢失），由下次 Host 启动时自动应用。
//   5. 功能 4（删除已归档会话）：从 archivedSessionIds 移除并删除会话文件，释放存储空间。

import z from "@deepseek-ai/schemastery";
import { mkdir, rm, readFile, writeFile, rename, cp, open, stat } from "node:fs/promises";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
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

// ========== zstd 帧原语（移植自官方 dsh-session-persistence-jsonl/zstd） ==========

/**
 * 官方会话日志是"多个独立 zstd 帧拼接"的容器：首帧=恰好一行 header（带 checksum），
 * 后续每帧=一个事件批次（带 checksum），文件尾部可能带一个写入中断产生的撕裂帧。
 * 注意：node:zlib 的一次性 zstdDecompressSync 对多帧输入只会静默返回第一帧的明文，
 * 绝不能用它整文件解压后重压缩（0.8.0 的数据丢失事故根因）。
 */
const ZSTD_MAGIC = 4247762216;
/** 与官方 compressZstdFrame 一致：独立可解码、带 checksum 的单帧。 */
const ZSTD_CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } };

/**
 * 不解压块内容、仅按帧头/块头结构定位所有完整帧（官方 scanZstdFrames 的移植）。
 * 完整结构非法则抛错；EOF 落在最后一帧内部时返回其起点（撕裂帧，移动时原样保留字节）。
 * @param {Buffer} buffer - 会话文件完整字节。
 * @param {number} [maxFrames] - 完整帧数上限（元数据读取用）。
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}}
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 断言帧明文=恰好一行（官方 assertZstdHeaderFrame 同款不变量），返回去掉换行的行文本。 */
function assertSingleHeaderLine(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) {
    throw new Error("corrupt Zstandard session log: first frame is not exactly one header line");
  }
  return plaintext.subarray(0, plaintext.length - 1).toString("utf8");
}

/** 校验 header 行确实是目标会话且 cwd 已改写。 */
function assertMovedHeader(line, sessionId, expectedCwd) {
  const header = JSON.parse(line);
  if (!header || header.type !== "session" || header.id !== sessionId) {
    throw new Error(`session log header id mismatch: expected ${sessionId}`);
  }
  if (expectedCwd !== undefined && header.cwd !== expectedCwd) {
    throw new Error("session log header cwd was not rewritten");
  }
  return header;
}

/**
 * 以官方 readFirstZstdLine 同款流程验证 zstd 日志首帧（分块读取→定位首帧→解码→断言）。
 * @param {string} path - 待验证文件。
 * @param {string} sessionId - 期望的会话 ID。
 * @param {string} expectedCwd - 期望的 header.cwd。
 */
async function verifyZstdLogHeader(path, sessionId, expectedCwd) {
  const handle = await open(path, "r");
  try {
    let content = Buffer.alloc(0);
    const chunk = Buffer.alloc(8192);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) throw new Error("verification failed: no complete header frame");
      content = Buffer.concat([content, Buffer.from(chunk.subarray(0, bytesRead))]);
      const first = scanZstdFrames(content, 1).frames[0];
      if (first === undefined) continue;
      const plaintext = zstdDecompressSync(content.subarray(first.start, first.end));
      assertMovedHeader(assertSingleHeaderLine(plaintext), sessionId, expectedCwd);
      return;
    }
  } finally {
    await handle.close();
  }
}

/** 验证明文（compression=none）日志首行。 */
async function verifyPlainLogHeader(path, sessionId, expectedCwd) {
  const handle = await open(path, "r");
  try {
    let content = Buffer.alloc(0);
    const chunk = Buffer.alloc(8192);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) throw new Error("verification failed: plaintext log has no header line");
      content = Buffer.concat([content, Buffer.from(chunk.subarray(0, bytesRead))]);
      const nl = content.indexOf(10);
      if (nl < 0) continue;
      assertMovedHeader(content.subarray(0, nl).toString("utf8"), sessionId, expectedCwd);
      return;
    }
  } finally {
    await handle.close();
  }
}

/** 路径存在性（任何错误都视为不存在之外的失败原样抛出，ENOENT→false）。 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

// ========== 移动会话文件 ==========

/**
 * 移动会话日志文件：只重写首帧（header 帧）中的 cwd，事件帧（含撕裂尾帧）逐字节原样保留。
 * 安全次序：目标已存在即拒绝 → 写临时文件 → 官方读取器同款校验 → 原子改名 →
 * 复制日志之外的其他产物 → 校验通过后才删除旧目录；删除旧目录失败则回滚新副本，
 * 保证"要么完整移动、要么原样不动"，绝不留下重复会话 id 或截断文件。
 * @param {string} sessionId - 会话 ID
 * @param {string} oldCwd - 原工作区路径
 * @param {string} newCwd - 目标工作区路径
 * @param {{root?: string}} [opts] - 测试可注入 sessions root。
 * @returns {Promise<{success: boolean}>}
 */
async function moveSessionFile(sessionId, oldCwd, newCwd, opts = {}) {
  const root = opts.root || getSessionsRoot();
  const sessionDirName = encodeSegment(sessionId);
  const oldDir = join(root, projectKey(oldCwd), sessionDirName);
  const newDir = join(root, projectKey(newCwd), sessionDirName);
  // Windows/NTFS 目录名大小写不敏感：大小写拼写差异会编码出不同 projectKey 字符串
  // 却落在同一物理目录，必须按平台语义比较。
  const sameDir = process.platform === "win32"
    ? oldDir.toLowerCase() === newDir.toLowerCase()
    : oldDir === newDir;
  if (sameDir) {
    throw Object.assign(new Error("source and target session directories are identical"), { code: "SAME_DIR" });
  }

  // 1. 识别日志产物编码（官方两种：zstd / 明文；两者并存属官方 encoding-mismatch，拒绝操作）
  const oldZstd = join(oldDir, "session.jsonl.zstd");
  const oldPlain = join(oldDir, "session.jsonl");
  const hasZstd = await exists(oldZstd);
  const hasPlain = await exists(oldPlain);
  if (hasZstd && hasPlain) throw new Error("session directory holds both plain and zstd logs; refusing to move");
  if (!hasZstd && !hasPlain) throw Object.assign(new Error(`session log not found: ${oldDir}`), { code: "ENOENT" });

  // 2. 目标目录防覆盖：任何已存在的目标产物都意味着重复 id 风险，直接拒绝
  const newZstd = join(newDir, "session.jsonl.zstd");
  const newPlain = join(newDir, "session.jsonl");
  if (await exists(newZstd) || await exists(newPlain)) {
    throw new Error(`target session artifact already exists: ${newDir}`);
  }

  await mkdir(newDir, { recursive: true });
  const finalPath = hasZstd ? newZstd : newPlain;
  const tmpPath = finalPath + ".move-tmp";

  try {
    if (hasZstd) {
      // 3a. zstd：逐帧定位，只替换首帧，其余字节原样拼接（checksum / 撕裂尾帧语义全部保留）
      const buf = await readFile(oldZstd);
      const { frames } = scanZstdFrames(buf);
      if (frames.length === 0) throw new Error("corrupt session log: no complete Zstandard frame");
      const first = frames[0];
      const plaintext = zstdDecompressSync(buf.subarray(first.start, first.end));
      const header = assertMovedHeader(assertSingleHeaderLine(plaintext), sessionId, undefined);
      header.cwd = newCwd;
      const newFirstFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n", "utf8"), ZSTD_CHECKSUM_OPTIONS);
      await writeFile(tmpPath, Buffer.concat([newFirstFrame, buf.subarray(first.end)]));
      await verifyZstdLogHeader(tmpPath, sessionId, newCwd);
    } else {
      // 3b. 明文：只替换首行
      const content = await readFile(oldPlain, "utf8");
      const nl = content.indexOf("\n");
      if (nl < 0) throw new Error("corrupt plaintext session log: missing header newline");
      const header = assertMovedHeader(content.slice(0, nl), sessionId, undefined);
      header.cwd = newCwd;
      await writeFile(tmpPath, JSON.stringify(header) + content.slice(nl), "utf8");
      await verifyPlainLogHeader(tmpPath, sessionId, newCwd);
    }
    // 4. 校验通过后原子发布
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  // 5. 复制日志之外的其他会话产物（当前官方布局只有一个日志文件，防未来新增）。
  //    force:false 不覆盖刚发布的新日志。
  try {
    await cp(oldDir, newDir, { recursive: true, force: false, errorOnExist: false });
  } catch {
    // 额外产物复制失败不否决移动本身（新日志已发布并验证）
  }

  // 6. 新文件已验证，才删除旧目录；删除失败则回滚新副本，避免留下重复会话 id
  try {
    await rm(oldDir, { recursive: true, force: true });
  } catch (err) {
    await rm(newDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`failed to remove old session directory (rolled back): ${err.message}`);
  }

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
  // 目录键碰撞防护：不同拼写的路径（分隔符方向、Windows 大小写等）可能落在同一物理
  // 会话目录，此时"移动"会退化为就地重写+删除整个会话目录，必须拒绝。
  const oldKey = projectKey(oldCwd);
  const newKey = projectKey(newCwd);
  if (process.platform === "win32" ? oldKey.toLowerCase() === newKey.toLowerCase() : oldKey === newKey) {
    return { ok: false, error: { code: "same-workspace", message: "Source and target encode to the same session directory", details: {} } };
  }

  // 4. 执行文件移动
  try {
    await moveSessionFile(sessionId, oldCwd, newCwd);
  } catch (err) {
    return { ok: false, error: { code: "move-failed", message: `Failed to move session file: ${err.message}`, details: { error: err.message } } };
  }

  // 5. 更新内存索引与持久状态。
  //    headers 也必须改写 cwd：官方 reportFilteredCandidates 以 sessionPaths 与 record.path
  //    的一致性过滤成员，而后续 delete/move 会把 header.cwd 当路径真源使用。
  registry.sessionPaths.set(sessionId, newCwd);
  const oldHeader = registry.headers.get(sessionId);
  if (oldHeader) registry.headers.set(sessionId, { ...oldHeader, cwd: newCwd });
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

// ========== 排队移动清单（插件自有持久化文件） ==========
//
// 0.8.0 曾把 pendingMoves 塞进 workspaceRegistry 全局状态，但官方 workspace domain
// 每次打开都会用 zod schema parse 存储值，未知键被剥掉 —— 重启后排队必然丢失，
// "重启后自动应用"从未真正生效。0.8.1 起改用插件自有 JSON 文件（原子写入）。

/** 排队清单文件路径。 */
function getPendingMovesFile() {
  const home = process.env.USERPROFILE || process.env.HOME;
  return join(home, ".dsh", "storages", "dsh-session-xc", "pending-moves.json");
}

/** 规范化一条排队记录；非法返回 null。 */
function normalizePendingEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) return null;
  if (typeof entry.targetWorkspaceId !== "string" || entry.targetWorkspaceId.length === 0) return null;
  return { sessionId: entry.sessionId, targetWorkspaceId: entry.targetWorkspaceId, queuedAt: typeof entry.queuedAt === "number" ? entry.queuedAt : Date.now() };
}

/** 读取排队移动列表（文件缺失/损坏一律按空列表处理）。 */
async function loadPendingMoves() {
  try {
    const raw = await readFile(getPendingMovesFile(), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.pendingMoves) ? parsed.pendingMoves : [];
    return list.map(normalizePendingEntry).filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

/** 原子写回排队移动列表（tmp + rename）。 */
async function savePendingMoves(list) {
  const file = getPendingMovesFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify({ version: 1, pendingMoves: list }, null, 2), "utf8");
  await rename(tmp, file);
}

/** 排队一个移动；同一会话只保留最后一次目标（后拖覆盖先拖）。 */
async function enqueuePendingMove(sessionId, targetWorkspaceId) {
  const next = (await loadPendingMoves()).filter((m) => m.sessionId !== sessionId);
  next.push(normalizePendingEntry({ sessionId, targetWorkspaceId }));
  await savePendingMoves(next);
}

/**
 * 一次性迁移：0.8.0 塞在 workspaceRegistry 全局状态里的 pendingMoves（仅同进程
 * 热升级时内存中还可见；重启后已被官方 zod parse 剥掉，无从恢复）。
 */
async function migrateLegacyPendingMoves(registry) {
  try {
    const legacy = Array.isArray(registry.state?.pendingMoves) ? registry.state.pendingMoves : [];
    if (legacy.length === 0) return;
    const current = await loadPendingMoves();
    const seen = new Set(current.map((m) => m.sessionId));
    const merged = [...current];
    for (const entry of legacy) {
      const normalized = normalizePendingEntry(entry);
      if (normalized && !seen.has(normalized.sessionId)) {
        merged.push(normalized);
        seen.add(normalized.sessionId);
      }
    }
    await savePendingMoves(merged);
    console.log(`[dsh-session-xc] Migrated ${merged.length - current.length} legacy pendingMoves from workspaceRegistry state`);
  } catch (err) {
    console.error("[dsh-session-xc] migrateLegacyPendingMoves error:", err);
  }
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
  const pending = await loadPendingMoves();
  const result = { applied: 0, dropped: 0, deferred: 0 };
  if (pending.length === 0) return result;
  const remaining = [];
  for (const entry of pending) {
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
    await savePendingMoves(remaining);
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
    // 同进程热升级时，把 0.8.0 遗留在 workspaceRegistry 全局状态里的排队条目迁入自有文件（尽力而为）
    migrateLegacyPendingMoves(c.workspaceRegistry).catch(() => {});

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
            await enqueuePendingMove(sessionId, targetWorkspaceId);
            const busy = c.agents?.get(sessionId)?.status === "running";
            return { ok: true, value: { sessionId, targetWorkspaceId, queued: true, busy, requiresRestart: true } };
          }
          
          return await performSessionMove(c, sessionId, targetWorkspaceId);
        }
        
        // ========== listPendingMoves ==========
        if (endpoint === "listPendingMoves") {
          return { ok: true, value: { pendingMoves: await loadPendingMoves() } };
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

/**
 * 供诊断/验证脚本使用的内部实现导出（cordis 加载器只消费 apply/name/inject，
 * 额外导出无副作用）。
 */
export const _internal = {
  projectKey,
  encodeSegment,
  getSessionsRoot,
  getPendingMovesFile,
  scanZstdFrames,
  assertSingleHeaderLine,
  moveSessionFile,
  verifyZstdLogHeader,
  loadPendingMoves,
  savePendingMoves,
  enqueuePendingMove,
  ZSTD_CHECKSUM_OPTIONS
};