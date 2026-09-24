// dsh-session-xc 插件入口（Host / Node 侧）
//
// 职责：
//   1. 注册设置命名空间 dsh-session-xc（showSessionCount / showArchiveEntry / enableSessionMove /
//      showActiveFilterEntry 开关），
//      设置页"会话增强"配置由客户端 plugins.bundle.config 渲染（插件页，同 modsearch）。
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
//      DSH 0.1.5 适配（0.9.0）：
//      ① 会话日志有"格式代际"（v0=session.jsonl.zstd，现行 v3=session.v3.jsonl.zstd；旧会话
//         被打开时迁移发布新代并保留旧代文件）。移动逻辑改为重写"编号最高规范代"文件的首帧
//         （官方只认最高代并校验其 cwd 与所在目录一致），低代际历史文件原样随行；目标重复
//         检查同步覆盖所有代际文件名。
//      ② RPC 改挂 /api 精确 Fetch 路由（connection.fetch.register，复用官方认证围栏），因
//         0.1.5 的 connection.rpc.handle 在第三方插件 fiber 内抛 "cannot get property
//         webServer without inject"（官方回归，实测+离线复现确认）；旧通道 try/catch 兜底，
//         客户端优先 /api、transport 失败自动回退旧通道。
//      ③ 投影缓存 identity 同步（0.11.1）：官方列表标题走 sessionProjectionCache 的零 I/O
//         提示，record identity 与 header 严格匹配（含 cwd）。0.11.0 及以前移动只重写
//         header.cwd，旧 record 被判"无关"丢弃 → 列表标题丢失，客户端回退显示
//         basename(cwd)=工作区名（"会话改名成工作区名、找不到"），打开会话一次才自愈。
//         现移动成功后同步改写 record 的 identity.cwd（官方 put() 写链优先、磁盘原子改写
//         兜底），标题提示跨移动/重启不丢。见 repairProjectionCacheIdentity。
//   5. 功能 4（删除已归档会话）：从 archivedSessionIds 移除并删除会话文件，释放存储空间。
//   6. 功能 5（新会话第一轮自动起名，v0.11.0）：内置 session-title 的 LLM provider 在
//      "推理模型 + liteLLM/pi-ai 路由"下必挂（maxOutputTokens=64 被思维链吃光、正文为空，
//      官方 deepseek 适配器有 purpose=session-title→thinking disabled 特判，pi-ai 没有）。
//      本插件在**非官方 deepseek 路由**（官方路由内置 provider 本身可用，让位）下，于每个新
//      顶级会话第一轮结束（turn/end）后延迟 1.5s，用会话自身模型（request header 的
//      provider/model，无需配置）跑一次 maxTokens=2048 的起名调用，上下文取第一轮的用户提问
//      + 助手回答，最后经 sessionTitle.rename 提交（user source 钉住，seq 最新胜出）。

import z from "@deepseek-ai/schemastery";
import { mkdir, rm, readFile, writeFile, rename, cp, open, readdir, stat } from "node:fs/promises";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { join, dirname } from "node:path";

export const name = "dsh-session-xc";
export const inject = [];

const NS = "dsh-session-xc";

/**
 * 设置命名空间 schema。
 * 字段标记 volatile（等价 schemastery >= 3.18.4 的 `.volatile()`，用 `.extra()` 写法以兼容
 * profile 内提升的 3.18.1）：DSH >= 0.1.7 的设置服务只把「含 volatile 字段」的 Config
 * 投影为可配置命名空间，未标记则整个命名空间不出现在 describe() 里。
 */
const SettingsSchema = z.object({
  showSessionCount: z.boolean().default(true).extra("volatile", true),
  showArchiveEntry: z.boolean().default(true).extra("volatile", true),
  enableSessionMove: z.boolean().default(true).extra("volatile", true),
  showActiveFilterEntry: z.boolean().default(true).extra("volatile", true),
  // 新会话第一轮自动起名：仅在**非官方**模型路由（provider !== deepseek-official）下生效；
  // 官方 DeepSeek 路由已有内置 LLM 起名（适配器自带 thinking 关闭），本插件让位不重复调用。
  autoTitleFirstRound: z.boolean().default(true).extra("volatile", true)
});

/**
 * 插件 Config：DSH >= 0.1.7 由宿主插件「导出的 Config」声明设置命名空间
 * （命名空间 id = profile 条目 id = NS）；旧版 ctx.settings.register 接口已移除。
 */
export const Config = SettingsSchema;

/**
 * 解包 volatile 字段引用：schemastery >= 3.18.4 把 volatile 值包成不可变引用
 * （官方插件写 `this.config.x.get()`），3.18.1 则是普通值。两种都归一化为普通值。
 */
function readField(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

/** 归一化整份配置为普通值对象（逐字段解包 volatile 引用）。 */
function readConfig(config) {
  const out = {};
  for (const key of Object.keys(config ?? {})) out[key] = readField(config[key]);
  return out;
}

/**
 * 当前生效设置（普通值）。DSH >= 0.1.7：值随 apply 的 config 参数注入，改设置后宿主重载
 * 插件；模块级供第一轮自动起名等模块级函数读取（与 autoTitleState 同风格）。
 */
let liveSettings = {};

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

// ========== 会话格式代际（DSH 0.1.5+，对齐官方 dsh-session-format） ==========
//
// 0.1.5 起会话日志有"格式代际"：v0 保留原名 session.jsonl(.zstd)，之后每代是
// session.vN.jsonl(.zstd)（N>=1、无前导零）。当前代为 v3；旧会话被打开时官方会
// 迁移发布新代文件并**保留旧代**（同目录多代并存）。官方解析器只取"编号最高的
// 规范代"作为权威（resolveGenerationInDirectory），且校验该代 header.cwd 编码出的
// 目录必须与文件实际所在目录一致（assertStoredIdentity）——低代文件仅作历史，
// 从不被重新校验。因此移动会话 = 只重写最高代文件的 header 帧，低代原样随行；
// 若只认 v0 文件名（0.8.x 行为），对仅含 v3 的新会话会找不到日志，对 v0+v3 并存
// 的已迁移会话会造成"v3 header.cwd 与新目录不一致"，官方 listArtifacts 直接抛错、
// 拖垮整个会话列表。

/** 规范代际文件名（与官方 CANONICAL_LOG_FILENAME + 压缩后缀一致）。 */
const CANONICAL_GENERATION_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/;

/**
 * 解析一个规范代际文件名。
 * @param {string} filename - 目录项名。
 * @returns {{version: number, zstd: boolean}|undefined} 非规范名返回 undefined。
 */
function parseCanonicalGenerationName(filename) {
  const match = CANONICAL_GENERATION_RE.exec(filename);
  if (match === null) return undefined;
  return { version: match[1] === undefined ? 0 : Number(match[1]), zstd: filename.endsWith(".zstd") };
}

/**
 * 列出一个会话目录内的规范代际产物，按版本号降序（每种编码各自排序）。
 * @param {string} dir - 会话目录。
 * @returns {Promise<{zstd: {version:number,name:string}[], plain: {version:number,name:string}[]}|null>}
 *   目录不存在返回 null。
 */
async function scanSessionDirGenerations(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  const zstd = [];
  const plain = [];
  for (const name of names) {
    const parsed = parseCanonicalGenerationName(name);
    if (parsed === undefined) continue;
    (parsed.zstd ? zstd : plain).push({ version: parsed.version, name });
  }
  zstd.sort((a, b) => b.version - a.version);
  plain.sort((a, b) => b.version - a.version);
  return { zstd, plain };
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
 * 移动会话日志目录：只重写"最高规范代际"日志文件首帧（header 帧）中的 cwd，事件帧
 * （含撕裂尾帧）与低代际历史文件逐字节原样保留。
 * DSH 0.1.5+ 会话格式代际：v0=session.jsonl(.zstd)，vN=session.vN.jsonl(.zstd)；旧会话
 * 被打开时官方迁移发布新代并保留旧代文件。官方只认编号最高代的 header，且校验其 cwd
 * 编码出的目录与文件实际位置一致（assertStoredIdentity）——移动必须重写最高代；若只认
 * v0 文件名（0.8.x 行为）：仅含 v3 的新会话找不到日志无法移动，v0+v3 并存的已迁移会话
 * 移动后 v3 header.cwd 与新目录不一致，官方 listArtifacts 整体抛错、拖垮全部会话列表。
 * 安全次序：目标已存在即拒绝 → 写临时文件 → 官方读取器同款校验 → 原子改名 →
 * 复制低代际历史等其他产物 → 校验通过后才删除旧目录；删除旧目录失败则回滚新副本，
 * 保证"要么完整移动、要么原样不动"，绝不留下重复会话 id 或截断文件。
 * @param {string} sessionId - 会话 ID
 * @param {string} oldCwd - 原工作区路径
 * @param {string} newCwd - 目标工作区路径
 * @param {{root?: string}} [opts] - 测试可注入 sessions root。
 * @returns {Promise<{success: boolean, generation: {version: number, name: string}}>}
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

  // 1. 扫描源目录的规范代际文件：取"编号最高代"作为权威日志（与官方
  //    resolveGenerationInDirectory 一致）；zstd/明文两种编码并存属官方 encoding-mismatch，拒绝操作。
  const source = await scanSessionDirGenerations(oldDir);
  if (source === null) throw Object.assign(new Error(`session log not found: ${oldDir}`), { code: "ENOENT" });
  if (source.zstd.length > 0 && source.plain.length > 0) {
    throw new Error("session directory holds both plain and zstd generations; refusing to move");
  }
  const hasZstd = source.zstd.length > 0;
  const generation = (hasZstd ? source.zstd : source.plain)[0];
  if (generation === undefined) throw Object.assign(new Error(`session log not found: ${oldDir}`), { code: "ENOENT" });
  const oldLog = join(oldDir, generation.name);

  // 2. 目标目录防覆盖：目标目录内存在任何规范代际文件（不只 v0 名）都意味着重复 id 风险，直接拒绝
  const target = await scanSessionDirGenerations(newDir);
  if (target !== null && (target.zstd.length > 0 || target.plain.length > 0)) {
    throw new Error(`target session artifact already exists: ${newDir}`);
  }

  await mkdir(newDir, { recursive: true });
  const finalPath = join(newDir, generation.name);
  const tmpPath = finalPath + ".move-tmp";

  try {
    if (hasZstd) {
      // 3a. zstd：逐帧定位，只替换最高代首帧，其余字节原样拼接（checksum / 撕裂尾帧语义全部保留）
      const buf = await readFile(oldLog);
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
      const content = await readFile(oldLog, "utf8");
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

  // 5. 复制旧目录其余文件（低代际历史日志、未来新增的其他产物）到新目录。
  //    force:false 不覆盖刚发布的新日志；低代际 header 里的旧 cwd 属历史遗留，官方从不重校验。
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

  return { success: true, generation };
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

  // 6. 修复投影缓存 identity（0.11.1，best-effort）：官方列表标题走 sessionProjectionCache
  //    的零 I/O 提示，record identity 与磁盘 header 严格匹配（含 cwd）；只改 header 不改
  //    缓存 record 会让标题提示整体失效，列表回退显示 basename(cwd)=工作区名。
  //    失败不否决移动本身（文件与注册表已一致；标题提示在会话被打开一次后也会自愈）。
  try {
    const repair = await repairProjectionCacheIdentity(c, sessionId, header, newCwd);
    if (repair.repaired) {
      console.log(`[dsh-session-xc] projection-cache identity repaired for ${sessionId} (via ${repair.via})`);
    } else if (repair.reason !== "no-record" && repair.reason !== "already-current") {
      console.warn(`[dsh-session-xc] projection-cache identity not repaired for ${sessionId}: ${repair.reason}`);
    }
  } catch (err) {
    console.warn(`[dsh-session-xc] projection-cache repair error for ${sessionId}: ${err && err.message ? err.message : String(err)}`);
  }

  return { ok: true, value: { sessionId, targetWorkspaceId } };
}

// ========== 投影缓存 identity 修复（0.11.1） ==========
//
// 官方会话列表的标题是"零 I/O 提示"：dsh-api-session-controller.projectionsFor 以磁盘
// header 为 identity 见证查 sessionProjectionCache（cachedSnapshot / cachedPredecessorTitle），
// 其 lifecycleIdentityMatches 要求 record.identity 与 header 的 createdAt+cwd+isSeeded+
// inheritedEventCount 严格相等、formatVersion 匹配（predecessor 提示则要求更旧的
// formatVersion）。移动会话重写了 header.cwd，旧 checkpoint record 的 identity 仍绑定旧
// cwd → record 被判"无关"整体读作不存在 → 列表行没有 title 投影 → 客户端 displayTitleOf
// 回退 basename(cwd) = 工作区名（用户视角：会话"改名成工作区名、找不到了"）。打开会话
// 一次才会自愈（hydrate 从日志重折叠 + checkpoint 以新 identity 重写 record）。
//
// 修复策略（best-effort，全部包在 try/catch 中，不影响移动本身）：
//   1. 直接读磁盘 record 文件（per-record 布局：<storages>/session_projcache/sessions/
//      <id>.json，形如 {version, record:{identity, rows}}）拿到存储 identity 原样——不做
//      任何 identity 猜测；被移动会话必非常驻（常驻走排队），磁盘即权威（domain 内存由
//      open 时 loadAll 自磁盘播种，之后仅 checkpoint 写，非常驻会话无未落盘增量）。
//   2. 生命周期守卫：record.identity 的 createdAt/isSeeded 必须与旧 header 一致，防 id
//      复用场景误改无关生命周期的 record。
//   3. 当代格式 record（formatVersion === 旧 header.version）优先走官方服务写链
//      cache.put(id, {...identity, cwd:newCwd}, rows)：domain 写链保证进程内存+磁盘一致，
//      本次启动的列表立即恢复标题。服务经 ctx.get 动态获取（官方同款、无 inject 门禁，
//      缺席返回 undefined），旧宿主/服务未激活时自动退化。
//   4. 其余情况（服务不可用、put 失败、predecessor 旧代 record——旧代 record 不得经 put
//      重新盖上当前版本戳，否则污染官方版本语义）退化为磁盘原子改写（tmp+rename，只动
//      identity.cwd，version 戳与 rows 原样保留）：domain 下次启动 loadAll 时生效。

/** 投影缓存 per-record 记录文件路径（键为会话 id，官方 SAFE_KEY_RE 保证路径安全）。 */
function getProjectionCacheRecordFile(sessionId) {
  const home = process.env.USERPROFILE || process.env.HOME;
  return join(home, ".dsh", "storages", "session_projcache", "sessions", encodeSegment(sessionId) + ".json");
}

/**
 * 移动成功后把投影缓存 record 的 identity.cwd 换成新工作区路径，保住列表标题提示。
 * @param c - 注入了 services 的上下文（用 ctx.get 动态取 sessionProjectionCache，可缺席）。
 * @param {string} sessionId - 会话 ID。
 * @param {object} oldHeader - 移动前的存储 header（cwd=旧路径；提供 version/createdAt/isSeeded 守卫）。
 * @param {string} newCwd - 目标工作区路径（与重写后 header.cwd 完全一致）。
 * @returns {Promise<{repaired: boolean, via?: string, reason?: string}>}
 */
async function repairProjectionCacheIdentity(c, sessionId, oldHeader, newCwd) {
  const file = getProjectionCacheRecordFile(sessionId);
  let doc;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { repaired: false, reason: "no-record" };
    return { repaired: false, reason: "record-unreadable: " + (err && err.message ? err.message : String(err)) };
  }
  const record = doc && doc.record;
  if (!record || typeof record.identity !== "object" || record.identity === null
    || typeof record.rows !== "object" || record.rows === null) {
    return { repaired: false, reason: "record-malformed" };
  }
  // 生命周期守卫：只修属于同一会话生命周期的 record
  if (oldHeader && (record.identity.createdAt !== oldHeader.createdAt
    || (record.identity.isSeeded ?? false) !== (oldHeader.isSeeded ?? false))) {
    return { repaired: false, reason: "identity-lifecycle-mismatch" };
  }
  if (record.identity.cwd === newCwd) return { repaired: false, reason: "already-current" };
  const newIdentity = { ...record.identity, cwd: newCwd };

  // 当代格式 record 才能走官方 put()（会重盖当前版本戳）；predecessor 旧代 record 仅磁盘改写
  const currentFormat = Boolean(oldHeader) && record.identity.formatVersion === oldHeader.version;
  let cache;
  try {
    cache = c && typeof c.get === "function" ? c.get("sessionProjectionCache") : undefined;
  } catch {
    cache = undefined;
  }
  if (currentFormat && cache && typeof cache.put === "function") {
    try {
      await cache.put(sessionId, newIdentity, record.rows);
      return { repaired: true, via: "service" };
    } catch (err) {
      console.warn("[dsh-session-xc] projection-cache put failed for " + sessionId + ", falling back to disk: " + (err && err.message ? err.message : String(err)));
    }
  }
  // 磁盘原子改写兜底：只动 identity.cwd，version 戳与 rows 原样保留（下次启动 loadAll 生效）
  try {
    const next = { ...doc, record: { ...record, identity: newIdentity } };
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify(next), "utf8");
    await rename(tmp, file);
    return { repaired: true, via: "disk" };
  } catch (err) {
    return { repaired: false, reason: "disk-write-failed: " + (err && err.message ? err.message : String(err)) };
  }
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
 * 处理官方 Connection RPC 的 client-request 信封（与 dsh-client-connection 0.1.5 的
 * rpcFetchHandler 同款语义），供 /api 精确 Fetch 路由使用：
 * POST + application/json + {type:"client-request",rpcId,method,payload}
 *   → {type:"server-response",rpcId,result}。
 * 路由位于官方 /api 通道的认证围栏之内（Host/Origin + 浏览器认证在进入 fetch 前已执行），
 * 无需自行鉴权。客户端用 connection.rpc.call("/api", "dsh-session-xc/<ep>", payload) 调用。
 * @param {Request} request - Web Request（官方共享 /api handler 桥接产物）。
 * @param {string} wireMethod - 信封 method 必须等于该值（如 "dsh-session-xc/moveSession"）。
 * @param {string} bareEndpoint - 传给业务 dispatch 的裸端点名（如 "moveSession"）。
 * @param {(endpoint: string, payload: unknown) => Promise<object>} dispatch - 业务分发。
 * @returns {Promise<Response>}
 */
async function handleApiEnvelope(request, wireMethod, bareEndpoint, dispatch) {
  if (request.method !== "POST") return new Response("not found", { status: 404 });
  const contentType = request.headers.get("content-type");
  if ((contentType ? contentType.split(";", 1)[0].trim().toLowerCase() : "") !== "application/json") {
    return new Response("content type must be application/json", { status: 415 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("body is not JSON", { status: 400 });
  }
  const rpcId = body && typeof body === "object" && typeof body.rpcId === "string" ? body.rpcId : "invalid-request";
  const envelopeError = (message) => Response.json({
    type: "server-response",
    rpcId,
    result: { ok: false, error: { code: "gateway/bad-request", message, details: {} } }
  });
  if (!body || typeof body !== "object" || body.type !== "client-request" || typeof body.method !== "string") {
    return envelopeError("invalid client-request message");
  }
  if (body.method !== wireMethod) {
    return envelopeError(`method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(wireMethod)}`);
  }
  try {
    const result = await dispatch(bareEndpoint, body.payload);
    return Response.json({ type: "server-response", rpcId, result });
  } catch (error) {
    return new Response(`handler failure: ${String(error)}`, { status: 500 });
  }
}

// ========== 功能 5：新会话第一轮自动起名（仅非官方模型路由；零新依赖） ==========
//
// 触发链：session/event 火线（global:true）→ 顶级会话（无 parentSession）出现合格 user/message
// 标记 → 首个 turn/end 后延迟 1.5s → 会话仍在线且尚无用户手动标题时，用会话自身路由
// （requestHeader().config 的 provider/model，无需任何配置）调 llm.stream（maxTokens=2048、
// purpose=session-title、60s 超时）→ 按 dsh-llm 流式 chunk 协议纯文本组装（丢弃 reasoning 块，
// 不 import @deepseek-ai/dsh-llm，避免给插件 bundle 增加解析依赖）→
// sessionTitle.rename 提交（追加 session/title，source=user，seq 最新在投影折叠中胜出并钉住）。

const OFFICIAL_PROVIDER = "deepseek-official";
const TITLE_AFTER_TURN_END_DELAY_MS = 1500;
const TITLE_CALL_TIMEOUT_MS = 60000;
const TITLE_MAX_INPUT_BYTES = 8000;
const TITLE_MAX_OUTPUT_TOKENS = 2048;
const TITLE_SYSTEM_PROMPT =
  "Create a concise title for an AI coding-assistant session from the supplied conversation.\n" +
  "Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.\n" +
  "Use the language of the conversation. Aim for about 10 CJK characters or 5 words.";

/** 每个会话一轮的触发状态（模块级；插件重载后自然重置，最多重复一次起名调用）。 */
const autoTitleState = new Map();

/** 清洗标题文本：去 ESC 序列/控制字符/不可见字符，压成一行。 */
function cleanTitleText(input) {
  if (typeof input !== "string") return "";
  return input
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\|$)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060\u2064\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 不劈分码点的 UTF-8 字节预算截断。 */
function truncateUtf8Bytes(input, maxBytes) {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let outStr = "";
  let used = 0;
  for (const ch of input) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (used + bytes > maxBytes) break;
    outStr += ch;
    used += bytes;
  }
  return outStr;
}

/** 事件 content 块里的纯文本（text 块，不含 reasoning/image）。 */
function textBlocksOf(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** 收集首个回合（截至第一个 turn/end 事件）的用户提问与助手正文。 */
function collectFirstRoundContent(session) {
  const userTexts = [];
  const assistantParts = [];
  for (const event of session.snapshotEvents()) {
    if (event.type === "turn/end") break;
    if (event.type === "user/message" && event.data && event.data.source && event.data.source.kind === "user") {
      const text = textBlocksOf(event.data.content).trim();
      if (text.length > 0) userTexts.push(truncateUtf8Bytes(text, 2000));
    } else if (event.type === "assistant/message" && event.data && event.data.message) {
      const text = textBlocksOf(event.data.message.content).trim();
      if (text.length > 0) assistantParts.push(text);
    }
  }
  return { userTexts, assistantText: truncateUtf8Bytes(assistantParts.join("\n"), 4000) };
}

/** 组帧：把第一轮对话转成 JSON 数组给模型，并落在 UTF-8 输入预算内。 */
function frameConversation(userTexts, assistantText, maxBytes) {
  const entries = [];
  for (const text of userTexts.slice(0, 4)) entries.push({ role: "user", text });
  if (assistantText && assistantText.length > 0) entries.push({ role: "assistant", text: assistantText });
  return truncateUtf8Bytes("Generate the session title from this JSON array of conversation messages:\n" + JSON.stringify(entries), maxBytes);
}

/** 用会话自身路由发起一次小型起名调用，返回清洗后的非空标题；无可见正文返回 null。 */
async function requestTitle(t, session, route, framed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_CALL_TIMEOUT_MS);
  if (typeof timeout.unref === "function") timeout.unref();
  try {
    const stream = t.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{
        role: "user",
        source: { kind: "plugin", plugin: "dsh-session-xc" },
        content: [{ type: "text", text: framed }]
      }],
      system: TITLE_SYSTEM_PROMPT,
      maxTokens: TITLE_MAX_OUTPUT_TOKENS,
      sessionId: session.id,
      purpose: "session-title",
      signal: controller.signal
    });
    let text = "";
    for await (const chunk of stream) {
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text;
      } else if (chunk && chunk.type === "finish") {
        const reason = chunk.reason;
        const kind = reason && reason.kind;
        if (kind !== "stop" && kind !== "max-tokens") {
          throw new Error("title stream ended with " + String(kind) + (reason && reason.failure ? ": " + reason.failure.message : ""));
        }
      }
      // reasoning-delta / tool-call-delta / block-start / block-end / usage：起名场景全部忽略
    }
    const title = cleanTitleText(text);
    return title.length > 0 ? title : null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 第一轮结束后（延迟已过）的落库流程。 */
async function maybeAutoTitleFirstRound(t, session, sid) {
  const state = autoTitleState.get(sid);
  // 防御：只有监听器登记过"本轮已见合格用户消息"的会话才执行（见 user/message 分支）
  if (!state || !state.userSeen || state.done) return;
  state.done = true;
  const note = (msg) => console.log("[dsh-session-xc] first-round auto-title " + msg);
  // 设置开关（服务端直读当前生效设置；触发点与落库点双检查，覆盖运行中关闭的场景）
  if (liveSettings.autoTitleFirstRound === false) { note("skip: autoTitleFirstRound disabled"); return; }
  try {
    if (t.sessions && t.sessions.get(sid) !== session) { note("skip: session no longer live"); return; }
    const current = t.sessionTitle ? t.sessionTitle.get(session) : void 0;
    if (current && current.source && current.source.kind === "user") { note("skip: user manual title present"); return; }
    const header = typeof session.requestHeader === "function" ? session.requestHeader() : void 0;
    const route = header && header.config ? header.config : void 0;
    if (!route || typeof route.provider !== "string" || typeof route.model !== "string") { note("skip: no request route"); return; }
    // 仅非官方路由生效：官方 deepseek 适配器对 session-title 强制 thinking=disabled，内置
    // provider 可用；本插件让位，避免与内置起名重复调用/打架。
    if (route.provider === OFFICIAL_PROVIDER) { note("skip: official route " + route.provider); return; }
    if (!t.llm || typeof t.llm.stream !== "function") { note("skip: llm service unavailable"); return; }
    const { userTexts, assistantText } = collectFirstRoundContent(session);
    if (userTexts.length === 0) { note("skip: no eligible user message"); return; }
    const framed = frameConversation(userTexts, assistantText, TITLE_MAX_INPUT_BYTES);
    const title = await requestTitle(t, session, route, framed);
    if (!title) { note("warn: LLM produced no visible text"); return; }
    if (t.sessions.get(sid) !== session) { note("skip: session disposed during call"); return; }
    const accepted = t.sessionTitle.rename(session, title);
    note('renamed "' + sid + '" -> "' + accepted.title + '" (' + route.provider + "/" + route.model + ")");
  } catch (error) {
    console.warn("[dsh-session-xc] first-round auto-title failed for " + sid + ": " + (error && error.message ? error.message : String(error)));
  }
}

/**
* @param ctx - cordis 上下文（web profile 的 host 合成）。
* @param config - bundle 配置（默认值复用 settings 的默认项）。
*/
export function apply(ctx, config = {}) {
  const startupTimers = [];
  const cleanupFns = [];
  // 1) 设置来源（DSH >= 0.1.7）：命名空间由导出的 Config 声明，值经本函数的 config 参数
  //    注入——用户改设置后宿主会重载本插件，所以每次 apply 拿到的都是最新值，无需 watch。
  //    （旧版 ctx.settings.register 在 0.1.7 已移除，这里不再调用。）
  liveSettings = readConfig(config);

  // 2) RPC 端点
  ctx.inject(["connection", "workspaceRegistry", "sessionPersistence", "sessions", "agents"], (c) => {
    // 同进程热升级时，把 0.8.0 遗留在 workspaceRegistry 全局状态里的排队条目迁入自有文件（尽力而为）
    migrateLegacyPendingMoves(c.workspaceRegistry).catch(() => {});

    /** 业务分发：endpoint 名 + payload → result 信封（{ok,value} | {ok,error}），两种传输共用。 */
    const dispatch = async (endpoint, payload) => {
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
    };

    // 传输挂载（能挂几种挂几种；客户端优先 /api，transport 失败时自动回退旧通道）：
    //   1) DSH 0.1.5+：经 connection.fetch.register 注册精确 Fetch 路由 /api/dsh-session-xc/<endpoint>，
    //      复用官方 /api 通道的 Host/Origin 围栏 + 浏览器认证 + client-request 信封（离线复现验证
    //      第三方 fiber 可注册成功：registerFetchRoute 的 effect 体只触碰 service 内部 Map）。
    //   2) 旧通道 /dsh-session-xc（connection.rpc.handle）：0.1.5 其内部 register 在第三方插件 fiber
    //      里执行 owner.effect(() => owner.webServer.register(route))，cordis 对无作用域 ctx 抛
    //      cannot get property "webServer" without inject（无论调用方如何声明 inject，实测+离线
    //      复现确认，属官方回归），故 try/catch 兜底；旧版本（<=0.1.4）仍能正常挂载。
    const RPC_ENDPOINTS = ["unarchiveSession", "moveSession", "listPendingMoves", "deleteSession", "deleteAllArchivedSessions"];
    const mountedTransports = [];
    if (c.connection?.fetch?.register) {
      try {
        for (const ep of RPC_ENDPOINTS) {
          c.connection.fetch.register({
            path: `/api/dsh-session-xc/${ep}`,
            methods: ["POST"],
            requestBody: "buffered",
            fetch: (request) => handleApiEnvelope(request, `dsh-session-xc/${ep}`, ep, dispatch)
          });
        }
        mountedTransports.push("/api/dsh-session-xc/*");
      } catch (err) {
        console.error("[dsh-session-xc] fetch route registration failed:", err);
      }
    }
    if (c.connection?.rpc?.handle) {
      try {
        c.connection.rpc.handle(
          "/dsh-session-xc",
          (endpoint, payload) => dispatch(endpoint, payload),
          { authority: "trusted-host" }
        );
        mountedTransports.push("/dsh-session-xc");
      } catch (err) {
        console.warn(`[dsh-session-xc] legacy rpc channel unavailable (expected on DSH 0.1.5+): ${err && err.message ? err.message : err}`);
      }
    }
    if (mountedTransports.length === 0) {
      console.error("[dsh-session-xc] FATAL: no RPC transport mounted; server-side features unavailable");
    } else {
      console.log("[dsh-session-xc] RPC transports mounted:", mountedTransports.join(", "));
    }

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
  
  // 3) 新会话第一轮自动起名（仅非官方模型路由；官方路由内置 provider 可用，让位）
  ctx.inject(["sessionTitle", "sessions", "llm"], (t) => {
    const off = ctx.on("session/event", (session, event) => {
      try {
        if (!session || !session.id) return;
        if (session.header && session.header.parentSession !== undefined) return; // 排除 subagent 会话
        const sid = session.id;
        if (event && event.type === "user/message" && event.data && event.data.source && event.data.source.kind === "user") {
          if (textBlocksOf(event.data.content).trim().length === 0) return;
          let st = autoTitleState.get(sid);
          if (!st) { st = { userSeen: false, scheduled: false, done: false }; autoTitleState.set(sid, st); }
          st.userSeen = true;
        } else if (event && event.type === "turn/end") {
          const st = autoTitleState.get(sid);
          if (!st || !st.userSeen || st.scheduled) return;
          // 设置开关：turn/end 触发点再查一次（设置可能在本轮中途被关闭）
          if (liveSettings.autoTitleFirstRound === false) return;
          st.scheduled = true;
          const timer = setTimeout(() => {
            maybeAutoTitleFirstRound(t, session, sid).catch(() => {});
          }, TITLE_AFTER_TURN_END_DELAY_MS);
          if (typeof timer.unref === "function") timer.unref();
          startupTimers.push(timer);
        }
      } catch (err) { /* 监听器绝不抛 */ }
    }, { global: true });
    cleanupFns.push(off);
    console.log("[dsh-session-xc] first-round auto-title installed (non-official routes only, " + TITLE_AFTER_TURN_END_DELAY_MS + "ms after turn/end)");
  });

  return function cleanup() {
    for (const fn of cleanupFns) { try { fn(); } catch (e) { /* ignore */ } }
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
  assertMovedHeader,
  parseCanonicalGenerationName,
  scanSessionDirGenerations,
  moveSessionFile,
  verifyZstdLogHeader,
  verifyPlainLogHeader,
  handleApiEnvelope,
  loadPendingMoves,
  savePendingMoves,
  enqueuePendingMove,
  getProjectionCacheRecordFile,
  repairProjectionCacheIdentity,
  ZSTD_CHECKSUM_OPTIONS,
  autoTitleState,
  cleanTitleText,
  truncateUtf8Bytes,
  textBlocksOf,
  collectFirstRoundContent,
  frameConversation,
  requestTitle,
  maybeAutoTitleFirstRound,
  OFFICIAL_PROVIDER,
  TITLE_AFTER_TURN_END_DELAY_MS,
  TITLE_MAX_OUTPUT_TOKENS
};