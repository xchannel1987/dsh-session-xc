// dsh-session-xc 浏览器端 bundle（手写，无构建步骤）v0.10.3
// v0.10.1 修复：筛选按钮挂点从 searchSlot 内部外移到 sectionHeader（slot 之前），
//   避免官方折叠态 28px 搜索槽 overflow 裁切把搜索图标挤出可视区。
// v0.10.2 修复：margin-left:auto 从 slot 交接给按钮自身，使其紧贴搜索图标左侧
//   随组靠右，不再被甩到头部最左。
// v0.10.3 改进：按钮运行时复制官方搜索按钮 className（28px 圆形、hover 圆形底色
//   指示、color:inherit），按压态用专用类 !important 覆盖，观感与官方图标按钮一致。
//
// v0.8.0 适配：DSH 0.1.2+ 会话常驻——被拖拽的会话若在本进程内已激活，
//   Host 会将其移动排队（pendingMoves），重启 DSH 后自动应用；客户端
//   区分"已移动"与"已排队"提示，并在启动后提示仍未应用的排队移动。
// v0.9.0 适配（DSH 0.1.5）：
//   1) RPC 优先走 /api 精确路由（dsh-session-xc/<endpoint>，服务端 connection.fetch.register 挂载、
//      复用官方认证围栏）；transport 失败自动回退旧 /dsh-session-xc 通道。
//   2) connection.api 已随 DSH 0.1.5 移除：废除失效的 api.workspace.list 轮询回退。
//   3) 移动端侧边栏展开按钮官方文案改为「打开侧边栏」，新旧双文案并配。
// v0.10.0 新增「只看活跃会话」：抽屉头部官方搜索图标按钮左侧注入开关按钮，
//   开启后只显示 updatedAt 落在本地日历今天的会话及其工作区组（groupSection 整体
//   隐藏）；状态 localStorage 持久化；判定优先 React fiber（props.node / props.group.
//   sessions 全集，覆盖折叠未渲染行），回退 store/标题匹配且歧义 fail-open；
//   官方搜索结果视图期间筛选暂停；全隐藏时 listArea 显示空态提示；60s 心跳收敛跨天。
//
// 功能：
//   徽标：工作区名称旁显示可见会话数 (N)（嵌入标题 span，同一行、0 不显示）
//   归档按钮：工作区行操作区 "..." 左侧（行内注入，显隐继承官方 rowActions hover）
//   面板：已归档会话列表，点击恢复（/dsh-session-xc unarchiveSession RPC）+ toast
//   拖拽：跨工作区移动会话（拖拽会话行到目标工作区行）
//   筛选：只看活跃会话（搜索按钮左侧开关，仅显示今天有操作的会话/工作区）
//   配置："会话增强"设置卡片（settings.plugin.item，官方 PluginCard 同款 UI）：
//     showSessionCount / showArchiveEntry / enableSessionMove / showActiveFilterEntry，live 生效。
//
// v0.5.0 修复：
//   订阅 DSH 核心的 workspaces.list store，而非独立调用 workspace.list API，
//   解决首次加载时归档图标显示错误的竞态条件问题。
//
// v0.2.11 修复：
//   1. 计数口径对齐官方 sessionVisible 规则：blank 会话（"新会话"占位行）只有是当前
//      会话时才计入可见数；否则每个曾被打开过的工作区残留的空白会话都会被多算，
//      典型表现正好 +1。当前会话 id 读取官方持久化选择 localStorage "dsh.sessions.current"。
//   2. 归档按钮 tooltip：由原生 title 改为官方 primitives Tooltip（side=bottom、
//      delayMs=500），与 GUI 其它图标按钮（sidebar 折叠/新建会话、消息操作按钮等）
//      提示气泡样式一致，按钮本体改为 React 渲染。
//
// 行内注入 + rAF 同帧重插（React 重渲染清除手动节点时 16ms 内恢复，视觉无闪）。

window.__ModuleLoader__.load({
  id: "dsh-session-xc",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var NS = "dsh-session-xc";
    var CONFIG_DEFAULTS = { showSessionCount: true, showArchiveEntry: true, enableSessionMove: true, showActiveFilterEntry: true };
    var FIELDS = [
      { key: "showSessionCount", label: "会话数展示", hint: "工作区名称旁显示可见会话数和已完成未读数 (N活跃, M未读)，为 0 时不显示" },
      { key: "showArchiveEntry", label: "已归档会话按钮", hint: "工作区操作区显示归档按钮，点击可查看并恢复已归档会话" },
      { key: "enableSessionMove", label: "跨工作区移动会话", hint: "启用后可拖拽会话到其他工作区" },
      { key: "showActiveFilterEntry", label: "只看活跃会话按钮", hint: "抽屉搜索按钮左侧显示\"只看活跃会话\"开关，开启后仅显示今天有操作的会话及其工作区；开关状态刷新后保持" }
    ];

    var ROW_SELECTOR = '[role="treeitem"][aria-expanded]';
    var REFRESH_MS = 5000;
    var RPC_CHANNEL = "/dsh-session-xc";
    // DSH 0.1.5+：服务端把端点挂到 /api/dsh-session-xc/<endpoint>（官方共享 /api 通道内精确路由），
    // 客户端 rpc.call("/api", RPC_API_PREFIX + name, payload) 调之；失败回退旧 RPC_CHANNEL。
    var RPC_API_PREFIX = "dsh-session-xc/";
    var BADGE_ATTR = "data-dstc-badge";
    var TITLE_ATTR = "data-dstc-title";
    var BTN_ATTR = "data-dstc-archive-btn";
    var MOUNT_ATTR = "data-dstc-archive-mount";
    var PANEL_ATTR = "data-dstc-archive-panel";
    var OVERLAY_ATTR = "data-dstc-archive-overlay";
    var CONTENT_ATTR = "data-dstc-archive-content";
    var CLOSE_ATTR = "data-dstc-archive-close";
    var TOAST_ATTR = "data-dstc-toast";
    // v0.10.0 只看活跃会话
    var FILTER_BTN_ATTR = "data-dstc-active-filter-btn";
    var FILTER_MOUNT_ATTR = "data-dstc-active-filter-mount";
    var FILTER_HIDDEN_ATTR = "data-dstc-filter-hidden";
    var FILTER_EMPTY_ATTR = "data-dstc-filter-empty";
    var LS_ONLY_ACTIVE = "dsh-session-xc.onlyActive";
    // 官方 CSS module 类名带可读 token（如 bhn1Oq_searchButton），子串选择器稳定
    var OFFICIAL_SEARCH_BUTTON_SELECTOR = '[class*="searchButton"]';
    var OFFICIAL_SEARCH_SLOT_SELECTOR = '[class*="searchSlot"]';
    var OFFICIAL_SEARCH_INPUT_SELECTOR = 'input[class*="searchInput"]';
    var OFFICIAL_SEARCH_RESULT_ROW_SELECTOR = '[class*="searchResultRow"]';
    var OFFICIAL_GROUP_SECTION_SELECTOR = '[class*="groupSection"]';
    var OFFICIAL_LIST_AREA_SELECTOR = '[class*="listArea"]';
    var OFFICIAL_SESSION_TITLE_SELECTOR = '[class*="_title"]';

    var inject = ["connection", "slots", "settingsScope", "sessions", "workspaces"];

    function resolveSettings(raw) {
      if (raw !== null && typeof raw === "object") {
        if ("value" in raw && ("status" in raw || "base" in raw || "revision" in raw)) return raw.value;
      }
      return raw;
    }

    function apply(ctx) {
      var instanceKey = "__dshSessionXcClientInstance";
      var previousInstance = typeof window !== "undefined" ? window[instanceKey] : null;
      if (previousInstance && typeof previousInstance.cleanup === "function") {
        try { previousInstance.cleanup(); } catch (e) { /* ignore stale instance */ }
      }
      var instance = { cleanup: null };
      if (typeof window !== "undefined") window[instanceKey] = instance;
      var connection = ctx.get("connection");
      // v0.9.0 RPC 传输：优先 /api 精确路由；transport 异常或网关"未知端点"响应时回退旧通道。
      function callPluginRpc(endpoint, payload) {
        return connection.rpc.call("/api", RPC_API_PREFIX + endpoint, payload).then(function (res) {
          var code = res && res.ok === false && res.error ? res.error.code : null;
          if (code === "unknown-endpoint" || code === "gateway/unknown-endpoint" || code === "gateway/not-found" || code === "gateway/rpc-not-found") {
            return connection.rpc.call(RPC_CHANNEL, endpoint, payload);
          }
          return res;
        }).catch(function () {
          return connection.rpc.call(RPC_CHANNEL, endpoint, payload);
        });
      }

      // v0.5.0: 获取 DSH 核心的 workspaces 服务
      var workspacesService = ctx.get("workspaces");
      var workspacesList = workspacesService && workspacesService.list;

      // 新 DSH (0.1.2-alpha.3)：sessions 是独立服务（ctx.sessions），不再挂在
      // workspaces.sessions 下。会话列表 store 提供 { ids, byId, phase }。
      var sessionsService = ctx.get("sessions");
      var sessionsList = sessionsService && sessionsService.list;
      // 诊断（仅异常时输出）：服务缺失时打印一次，便于定位版本兼容问题
      if ((!workspacesService || !workspacesList) && typeof console !== "undefined") {
        console.error("[dsh-session-xc] workspaces 服务不可用: ctx.get(\"workspaces\") =", workspacesService, "| list =", workspacesList);
      }
      if (!sessionsService && typeof console !== "undefined") {
        console.error("[dsh-session-xc] sessions 服务不可用: ctx.get(\"sessions\") =", sessionsService);
      }

      // —— 配置（settingsScope 命名空间，live） ——
      var config = Object.assign({}, CONFIG_DEFAULTS);
      var settingsScope = null;
      try {
        var scopeSvc = ctx.get("settingsScope");
        if (scopeSvc && typeof scopeSvc.bind === "function") {
          settingsScope = scopeSvc.bind({ namespace: NS });
          if (settingsScope && typeof settingsScope.getSnapshot === "function") {
            var rawCfg = resolveSettings(settingsScope.getSnapshot());
            if (rawCfg && typeof rawCfg === "object") Object.assign(config, rawCfg);
          }
          if (settingsScope && typeof settingsScope.subscribe === "function") {
            settingsScope.subscribe(function () {
              try {
                var v = resolveSettings(settingsScope.getSnapshot());
                if (v && typeof v === "object") {
                  Object.assign(config, v);
                  applyAll();
                  if (openWorkspaceTitle !== null && !config.showArchiveEntry) closePanel();
                }
              } catch (e) { /* ignore */ }
            });
          }
        }
      } catch (e) { /* 无 settingsScope 时配置保持默认 */ }

      var countsByTitle = new Map();
      var archiveByTitle = new Map();
      var deletedSessionIds = new Set(); // v0.5.0: 已删除会话 ID 缓存
      // v0.10.0 只看活跃会话：筛选开关（localStorage 持久化）+ store 缓存（fiber 不可用时的回退判定）
      var onlyActive = readOnlyActivePref();
      var metaByIdCache = new Map();
      var archivedIdSet = new Set();
      var heartbeatTimer = null;
      var panel = null;
      var openWorkspaceTitle = null;
      var timer = null;
      var visibilityHandler = null;
      var observer = null;
      var rafPending = false;
      var toastTimer = null;
      var pendingNoticeTimer = null;
      var docPointerHandler = null;
      var mobileOutsideGuard = null;
      var mobileKeepOpenTitle = null;
      var mobileKeepOpenUntil = 0;
      var docKeyHandler = null;
      var documentDragHandler = null;
      var documentDropHandler = null;
      var documentDragLeaveHandler = null;
      var documentDragEndHandler = null;
      var overlay = null; // PC 遮罩层（移动端为 null）
      var contentEl = null; // PC 内容容器（renderPanel 写入目标；移动端为 null，写入 panel）
      var overlayClickHandler = null; // PC 遮罩点击关闭 handler（closePanel 清理，避免重复绑定）

      // ---------- 拖拽移动会话相关变量 ----------
      var workspaceItems = []; // 工作区列表缓存 [{workspaceId, title, sessionIds, ...}]
      var currentDragSessionId = null; // 当前拖拽中的会话 ID
      var currentDragSourceWorkspaceId = null; // 当前拖拽中会话的源工作区 ID
      var dropHighlightEl = null; // 当前高亮的 drop 目标元素

      // ---------- 数据层 ----------

      function sessionTitleOf(meta, sid) {
        if (meta) {
          // v0.5.0: DSH 核心的 sessions store 直接提供 displayTitle
          if (typeof meta.displayTitle === "string" && meta.displayTitle.length > 0) return meta.displayTitle;
          // 回退到 title 属性
          if (typeof meta.title === "string" && meta.title.length > 0) return meta.title;
          // 兼容旧的 projections 结构（API 响应）
          var p = meta.projections && meta.projections.values;
          var t = p ? p.title : void 0;
          if (typeof t === "string" && t.length > 0) return t;
          if (t && typeof t === "object" && typeof t.val === "string" && t.val.length > 0) return t.val;
        }
        return sid;
      }

      // v0.5.0: 从 DSH 核心的 workspaces.list store 获取数据
      function computeArchiveData(workspaceSnapshot, sessionsSnapshot) {
        var items = Array.isArray(workspaceSnapshot && workspaceSnapshot.items) ? workspaceSnapshot.items : [];
        var archivedSessionIds = Array.isArray(workspaceSnapshot && workspaceSnapshot.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : [];
        var archived = new Set(archivedSessionIds);
        archivedIdSet = archived;

        workspaceItems = items;
        // WorkspaceRuntime 的 baselinesReady 只在 workspace.list 与 session.list
        // 都完成后为 true。未完成时清空展示数据，避免把临时 blank 会话算进数量。
        var baselinesReady = !!(workspaceSnapshot && sessionsSnapshot && workspaceSnapshot.phase === "ready" && sessionsSnapshot.phase === "ready");
        if (!baselinesReady) {
          countsByTitle = new Map();
          archiveByTitle = new Map();
          metaByIdCache = new Map();
          applyAll();
          if (openWorkspaceTitle !== null) renderPanel();
          return;
        }

        var byId = new Map();
        var currentId = null;
        try {
          if (typeof localStorage !== "undefined") {
            var rawCur = localStorage.getItem("dsh.sessions.current");
            if (rawCur) {
              var curObj = JSON.parse(rawCur);
              if (curObj && typeof curObj.sessionId === "string") currentId = curObj.sessionId;
            }
          }
        } catch (e) { currentId = null; }

        // sessions list store 结构: { ids: [], byId: {}, ... }
        if (sessionsSnapshot && sessionsSnapshot.byId && typeof sessionsSnapshot.byId === "object") {
          var sessionIds = sessionsSnapshot.ids || [];
          for (var i = 0; i < sessionIds.length; i++) {
            var sid = sessionIds[i];
            var it = sessionsSnapshot.byId[sid];
            if (it) byId.set(sid, it);
          }
        }
        metaByIdCache = byId; // v0.10.0: 活跃筛选的回退判定数据源

        var counts = new Map();
        var archive = new Map();
        // 获取 sessions store 中的有效会话 id 集合
        var validSessionIds = new Set();
        if (sessionsSnapshot && Array.isArray(sessionsSnapshot.ids)) {
          for (var vi = 0; vi < sessionsSnapshot.ids.length; vi++) {
            validSessionIds.add(sessionsSnapshot.ids[vi]);
          }
        }

        for (var k = 0; k < items.length; k++) {
          var ws = items[k];
          if (!ws || typeof ws.title !== "string" || ws.title.length === 0) continue;
          var ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
          var visible = 0;
          var completedCount = 0;
          var archivedItems = [];
          for (var j = 0; j < ids.length; j++) {
            var sid = ids[j];
            var meta = byId.get(sid);
            var isSub = !!(meta && meta.origin === "subagent");
            var isBlank = !!(meta && meta.blank);
            var isCompleted = !!(meta && meta.completed === true);
            if (archived.has(sid)) {
              // 只处理仍然存在于 sessions store 中的会话，且未被本地删除
              if (!isSub && !isBlank && validSessionIds.has(sid) && !deletedSessionIds.has(sid)) {
                archivedItems.push({ sessionId: sid, title: sessionTitleOf(meta, sid), updatedAt: meta ? meta.updatedAt : null });
              }
            } else if (!isSub && (!isBlank || sid === currentId) && !deletedSessionIds.has(sid)) {
              // 活跃会话也要过滤已删除的
              visible++;
              // 统计已完成但未读的会话（绿色点）
              if (isCompleted) {
                completedCount++;
              }
            }
          }
          if (visible > 0 || completedCount > 0) counts.set(ws.title, { visible: visible, completed: completedCount });
          if (archivedItems.length > 0) archive.set(ws.title, { count: archivedItems.length, items: archivedItems });
        }
        countsByTitle = counts;
        archiveByTitle = archive;
        applyAll();
        if (openWorkspaceTitle !== null) renderPanel();
      }

      // v0.5.0: 手动刷新数据（用于删除/恢复操作后）
      function snapshotsAreReady(wsSnapshot, sessionsSnapshot) {
        if (!wsSnapshot || !sessionsSnapshot || sessionsSnapshot.phase !== "ready") return false;
        if (wsSnapshot.phase !== "ready") return false;
        var byId = sessionsSnapshot.byId;
        if (!byId || typeof byId !== "object") return false;
        // baselinesReady 表示首个 list 已完成，但 workspace 投影可能仍暂时包含
        // 尚未落入 sessions.byId 的 blank/新增会话。等待所有挂账 ID 都有摘要，
        // 再计算数量，避免初始化时稳定地多算一个临时占位行。
        var items = Array.isArray(wsSnapshot.items) ? wsSnapshot.items : [];
        for (var i = 0; i < items.length; i++) {
          var ids = Array.isArray(items[i] && items[i].sessionIds) ? items[i].sessionIds : [];
          for (var j = 0; j < ids.length; j++) {
            if (!Object.prototype.hasOwnProperty.call(byId, ids[j])) return false;
          }
        }
        return true;
      }

      function refresh() {
        refreshFromStores();
      }

      // 订阅 workspace 与 sessions 两个 store；只有双方完成同一轮基线后才展示计数。
      var workspacesUnsubscribe = null;
      var sessionsUnsubscribe = null;
      function refreshFromStores() {
        try {
          if (!workspacesList || typeof workspacesList.getSnapshot !== "function") return;
          var wsSnapshot = workspacesList.getSnapshot();
          var sessionsList = sessionsService && sessionsService.list;
          var sessionsSnapshot = sessionsList && typeof sessionsList.getSnapshot === "function" ? sessionsList.getSnapshot() : null;
          if (snapshotsAreReady(wsSnapshot, sessionsSnapshot)) computeArchiveData(wsSnapshot, sessionsSnapshot);
          else computeArchiveData({ items: [], archivedSessionIds: [], baselinesReady: false }, null);
        } catch (e) { /* ignore */ }
      }
      if (workspacesList && typeof workspacesList.subscribe === "function") workspacesUnsubscribe = workspacesList.subscribe(refreshFromStores);
      var sessionsListForSubscription = sessionsService && sessionsService.list;
      if (sessionsListForSubscription && typeof sessionsListForSubscription.subscribe === "function") sessionsUnsubscribe = sessionsListForSubscription.subscribe(refreshFromStores);
      refreshFromStores();

      // ---------- 行工具 ----------

      function titleSpanOf(row) {
        var marked = row.querySelector("[" + TITLE_ATTR + "]");
        if (marked) return marked;
        var rowText = (row.textContent || "").trim();
        if (!rowText) return null;
        var spans = row.querySelectorAll("span");
        for (var i = 0; i < spans.length; i++) {
          var el = spans[i];
          if (el.childElementCount !== 0) continue;
          var t = (el.textContent || "").trim();
          if (t.length === 0) continue;
          if (t === rowText) {
            el.setAttribute(TITLE_ATTR, "");
            return el;
          }
        }
        return null;
      }

      function cleanTitleOf(span) {
        var clone = span.cloneNode(true);
        var badgeEl = clone.querySelector("[" + BADGE_ATTR + "]");
        if (badgeEl) badgeEl.remove();
        return (clone.textContent || "").trim();
      }

      // 计算抽屉分区标题文本时剔除已注入的徽标：徽标是标题元素的子节点，
      // textContent 会包含徽标文本（如 "工作区 (5)"），直接比较会匹配失败，
      // 导致"工作区总活跃会话数"在归档/恢复后不再更新（首次挂上徽标即冻结）。
      function cleanSectionLabelText(labelEl) {
        var clone = labelEl.cloneNode(true);
        var badgeEl = clone.querySelector("[" + BADGE_ATTR + "]");
        if (badgeEl) badgeEl.remove();
        return (clone.textContent || "").trim();
      }

      function rowActionsOf(row) {
        var spans = row.querySelectorAll("span");
        var candidates = [];
        for (var i = 0; i < spans.length; i++) {
          var s = spans[i];
          if (s.hasAttribute(BADGE_ATTR)) continue;
          if (s.querySelector("button")) candidates.push(s);
        }
        for (var ci = 0; ci < candidates.length; ci++) {
          var c = candidates[ci];
          var isTop = true;
          for (var cj = 0; cj < candidates.length; cj++) {
            if (ci !== cj && candidates[cj].contains(c)) { isTop = false; break; }
          }
          if (isTop) return c;
        }
        return null;
      }

      function fallbackIconSvg() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.2 L4 3 h12 l1.5 1.2"/><path d="M2.5 4.2 V14 a2 2 0 0 0 2 2 h11 a2 2 0 0 0 2 -2 V4.2"/><path d="M8 10 h4"/></svg>';
      }

      function ensureMountRoot(mount) {
        if (mount._dstkRoot || mount._dstkLegacy) return mount;
        var RDC = null, RD = null;
        try { RDC = require("react-dom/client"); } catch (e) { /* ignore */ }
        try { RD = require("react-dom"); } catch (e) { /* ignore */ }
        var createRoot = (RDC && RDC.createRoot) || (RD && RD.createRoot);
        if (createRoot) { mount._dstkRoot = createRoot(mount); mount._dstkLegacy = false; }
        else if (RD && typeof RD.render === "function") { mount._dstkRoot = null; mount._dstkLegacy = true; }
        return mount;
      }

      function renderInto(mount, element) {
        var m = ensureMountRoot(mount);
        if (m._dstkLegacy) { try { require("react-dom").render(element, mount); } catch (e) { /* ignore */ } }
        else if (m._dstkRoot) { try { m._dstkRoot.render(element); } catch (e) { /* ignore */ } }
      }

      // 归档按钮：官方 primitives Tooltip + IconArchiveOutline20（与 GUI 其它图标按钮提示样式一致）
      function renderArchiveButton(mount, label, title) {
        var ReactMod = require("react");
        var prim = null;
        try { prim = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { prim = null; }
        var TooltipC = prim && prim.Tooltip;
        var IconC = prim && prim.IconArchiveOutline20;
        var child = IconC
          ? ReactMod.createElement(IconC, { size: 16 })
          : ReactMod.createElement("span", { dangerouslySetInnerHTML: { __html: fallbackIconSvg() } });
        var btnEl = ReactMod.createElement("button", {
          type: "button",
          "data-dstc-archive-btn": "",
          "data-dstc-title": title,
          "aria-label": label,
          style: {
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16, padding: 0, border: "none", background: "transparent",
            borderRadius: 4, color: "var(--dsw-alias-label-tertiary,#8a94a6)",
            cursor: "pointer", flex: "none", transition: "color .12s ease"
          },
          onMouseEnter: function (e) { e.currentTarget.style.color = "var(--dsw-alias-label-primary, #1d2129)"; },
          onMouseLeave: function (e) { e.currentTarget.style.color = "var(--dsw-alias-label-tertiary, #8a94a6)"; },
          onClick: function (e) {
            e.stopPropagation();
            e.preventDefault();
            if (openWorkspaceTitle === title) closePanel();
            else openPanel(title, mount);
          }
        }, child);
        if (TooltipC) {
          renderInto(mount, ReactMod.createElement(TooltipC, { label: label, side: "bottom", delayMs: 500 }, btnEl));
        } else {
          renderInto(mount, btnEl);
        }
      }

      // ---------- 行内注入（幂等，受配置开关控制） ----------

      function applyAll() {
        try {
          if (typeof document === "undefined") return;
          var rows = document.querySelectorAll(ROW_SELECTOR);
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var titleSpan = titleSpanOf(row);
            if (!titleSpan) continue;
            var title = cleanTitleOf(titleSpan);
            var workspaceInfo = workspaceItems.find(function (ws) { return ws.title === title; });
            if (workspaceInfo && workspaceInfo.workspaceId) row.setAttribute(WORKSPACE_ID_ATTR, workspaceInfo.workspaceId);
            // —— 徽标（活跃会话数，受 showSessionCount 控制） ——
            var countData = countsByTitle.get(title);
            var badge = row.querySelector("[" + BADGE_ATTR + "]");
            // countsByTitle 现在存储的是对象 { visible, completed }，兼容旧的数字格式
            var visible = typeof countData === "object" && countData !== null ? countData.visible : (countData || 0);
            var completed = typeof countData === "object" && countData !== null ? countData.completed : 0;
            
            if (visible === 0 || !config.showSessionCount) {
              if (badge) badge.remove();
            } else {
              if (!badge) {
                badge = document.createElement("span");
                badge.setAttribute(BADGE_ATTR, "");
                badge.setAttribute("aria-hidden", "true");
                badge.style.cssText = "margin-left:6px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#9aa4b2);opacity:0.85;white-space:nowrap;user-select:none;";
                titleSpan.setAttribute(TITLE_ATTR, "");
                titleSpan.appendChild(badge);
              }
              
              // 构建显示文本：
              // - 没有已完成未读：显示 (活跃数)
              // - 有已完成未读：显示 (未读数/活跃数)，未读数用绿色
              var lastKey = visible + "|" + completed;
              if (badge._last !== lastKey) {
                if (completed > 0) {
                  // 有已完成未读：显示 (未读/活跃)，未读数用绿色
                  badge.innerHTML = ' (<span style="color:var(--dsw-alias-status-success,#22c55e);">' + completed + '</span>/' + visible + ')';
                } else {
                  // 没有已完成未读：显示 (活跃数)
                  badge.textContent = " (" + visible + ")";
                }
                badge._last = lastKey;
              }
            }
            // —— 归档按钮（受 showArchiveEntry 控制） ——
            var info = archiveByTitle.get(title);
            var mounts = row.querySelectorAll("[" + MOUNT_ATTR + "]");
            var mount = mounts.length > 0 ? mounts[0] : null;
            var unmarkedButtons = row.querySelectorAll("button[" + BTN_ATTR + "]");
            for (var ubi = 0; ubi < unmarkedButtons.length; ubi++) {
              var ub = unmarkedButtons[ubi];
              var um = ub.closest && ub.closest("[" + MOUNT_ATTR + "]");
              if (!um) { ub.remove(); }
            }
            var legacyButtons = row.querySelectorAll("[" + BTN_ATTR + "]");
            for (var li = 0; li < legacyButtons.length; li++) {
              var legacyMount = legacyButtons[li].parentNode;
              var insideStableMount = legacyButtons[li].closest && legacyButtons[li].closest("[" + MOUNT_ATTR + "]");
              if (!insideStableMount && (!legacyMount || !legacyMount.hasAttribute(MOUNT_ATTR))) {
                if (legacyMount && legacyMount._dstkRoot) { try { legacyMount._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
                if (legacyMount) legacyMount.remove(); else legacyButtons[li].remove();
              }
            }
            for (var mi = 1; mi < mounts.length; mi++) {
              var duplicateMount = mounts[mi];
              if (duplicateMount._dstkRoot) { try { duplicateMount._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
              duplicateMount.remove();
            }
            if (!info || info.count === 0 || !config.showArchiveEntry) {
              if (mount) {
                if (mount._dstkRoot) { try { mount._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
                mount.remove();
              }
              continue;
            }
            var rowActions = rowActionsOf(row);
            if (!rowActions) continue;
            var label = "已归档会话 (" + info.count + ")";
            if (!mount) {
              mount = document.createElement("span");
              mount.setAttribute(MOUNT_ATTR, "");
              mount.style.cssText = "display:inline-flex;align-items:center;justify-content:center;";
              rowActions.insertBefore(mount, rowActions.firstChild);
            }
            if (mount._dstkLabel !== label) {
              mount._dstkLabel = label;
              renderArchiveButton(mount, label, title);
            }
            var buttons = mount.querySelectorAll("button[" + BTN_ATTR + "]");
            if (buttons.length > 1) {
              for (var bi = 1; bi < buttons.length; bi++) {
                var duplicateButton = buttons[bi];
                var duplicateRoot = duplicateButton.closest && duplicateButton.closest("[" + MOUNT_ATTR + "]");
                if (duplicateRoot && duplicateRoot !== mount && duplicateRoot._dstkRoot) { try { duplicateRoot._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
                duplicateButton.remove();
              }
              buttons = mount.querySelectorAll("button[" + BTN_ATTR + "]");
            }
            var btn = buttons.length > 0 ? buttons[0] : null;
            if (btn && btn.getAttribute("data-dstc-title") !== title) btn.setAttribute("data-dstc-title", title);
          }
          
          // —— 工作区抽屉标题汇总统计 ——
          if (config.showSessionCount) {
            // 计算所有工作区的汇总统计
            var totalVisible = 0;
            var totalCompleted = 0;
            countsByTitle.forEach(function(countData) {
              var visible = typeof countData === "object" && countData !== null ? countData.visible : (countData || 0);
              var completed = typeof countData === "object" && countData !== null ? countData.completed : 0;
              totalVisible += visible;
              totalCompleted += completed;
            });
            
            // 找到工作区抽屉标题元素（"工作区" 或 "Sessions"/"Workspaces"）
            var sectionLabels = document.querySelectorAll('[class*="sectionLabel"]');
            for (var si = 0; si < sectionLabels.length; si++) {
              var labelEl = sectionLabels[si];
              // 用剔除徽标后的文本来匹配（徽标是标题子节点，直接取 textContent 会因混入徽标文本而永远匹配不上）
              var labelText = cleanSectionLabelText(labelEl);
              // 匹配 "工作区"、"会话"、"Workspaces"、"Sessions" 等标题
              if (labelText === "工作区" || labelText === "会话" || labelText === "Workspaces" || labelText === "Sessions") {
                // 检查是否已经有徽章
                var existingBadge = labelEl.querySelector("[" + BADGE_ATTR + "]");
                
                if (totalVisible === 0) {
                  // 没有活跃会话，移除徽章
                  if (existingBadge) existingBadge.remove();
                } else {
                  // 有活跃会话，显示徽章
                  if (!existingBadge) {
                    existingBadge = document.createElement("span");
                    existingBadge.setAttribute(BADGE_ATTR, "");
                    existingBadge.setAttribute("aria-hidden", "true");
                    existingBadge.style.cssText = "margin-left:6px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#9aa4b2);opacity:0.85;white-space:nowrap;user-select:none;";
                    labelEl.appendChild(existingBadge);
                  }
                  
                  // 更新徽章内容
                  var sectionLastKey = totalVisible + "|" + totalCompleted;
                  if (existingBadge._last !== sectionLastKey) {
                    if (totalCompleted > 0) {
                      // 有已完成未读：显示 (未读/活跃)，未读数用绿色
                      existingBadge.innerHTML = ' (<span style="color:var(--dsw-alias-status-success,#22c55e);">' + totalCompleted + '</span>/' + totalVisible + ')';
                    } else {
                      // 没有已完成未读：显示 (活跃数)
                      existingBadge.textContent = " (" + totalVisible + ")";
                    }
                    existingBadge._last = sectionLastKey;
                  }
                }
                break; // 只处理第一个匹配的标题
              }
            }
          }
          // —— v0.10.0：只看活跃会话（按钮挂载 + 筛选收敛，同帧完成） ——
          ensureFilterButton();
          applyActiveFilter();
        } catch (e) { /* 兜底 */ }
      }

      function scheduleApply() {
        if (rafPending) return;
        rafPending = true;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(function () { rafPending = false; applyAll(); });
        } else {
          setTimeout(function () { rafPending = false; applyAll(); }, 16);
        }
      }

      // ---------- 拖拽移动会话 ----------

      var SESSION_ROW_SELECTOR = '[role="treeitem"]:not([aria-expanded])';
      var DRAG_HIGHLIGHT_ATTR = "data-dstc-drag-highlight";
      var DRAG_SESSION_ATTR = "data-dstc-drag-session";
      var WORKSPACE_ID_ATTR = "data-dstc-workspace-id";
      var DROP_INDICATOR_ATTR = "data-dstc-drop-indicator";

      /** 根据 sessionId 查找所属工作区 */
      function findWorkspaceBySessionId(sessionId) {
        for (var i = 0; i < workspaceItems.length; i++) {
          var ws = workspaceItems[i];
          var ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
          if (ids.indexOf(sessionId) !== -1) return ws;
        }
        return null;
      }

      /** 校验 id 是否为 sessions store 中真实的会话 id（防工作区拖拽误判）。 */
      function isKnownSessionId(sid) {
        if (!sid || typeof sid !== "string" || sid.length === 0) return false;
        try {
          var snap = sessionsList && typeof sessionsList.getSnapshot === "function" ? sessionsList.getSnapshot() : null;
          if (snap && snap.byId && typeof snap.byId === "object" && Object.prototype.hasOwnProperty.call(snap.byId, sid)) return true;
        } catch (e) { /* fall through */ }
        if (workspaceItems && Array.isArray(workspaceItems)) {
          for (var i = 0; i < workspaceItems.length; i++) {
            var ids = Array.isArray(workspaceItems[i] && workspaceItems[i].sessionIds) ? workspaceItems[i].sessionIds : [];
            if (ids.indexOf(sid) !== -1) return true;
          }
        }
        return false;
      }

      /** 官方 SessionNodeItem 在 dragstart 时写入 text/plain = node.id。 */
      function getSessionIdFromTransfer(dataTransfer) {
        if (!dataTransfer || typeof dataTransfer.getData !== "function") return null;
        var value = dataTransfer.getData("text/plain");
        if (typeof value !== "string" || value.length === 0) return null;
        // 新 DSH：工作区行（ProjectRow）的 dragstart 同样写入 text/plain = row.key
        // （workspace key）。只有确实是会话 id 才继续，避免工作区拖拽被误判成会话拖拽。
        return isKnownSessionId(value) ? value : null;
      }

      /** 从工作区行提取 workspaceId */
      function getWorkspaceIdFromRow(wsRow) {
        var directId = wsRow.getAttribute(WORKSPACE_ID_ATTR);
        if (directId) return directId;
        var title = cleanTitleOf(titleSpanOf(wsRow));
        for (var i = 0; i < workspaceItems.length; i++) {
          if (workspaceItems[i].title === title) return workspaceItems[i].workspaceId;
        }
        return null;
      }

      /** 将任意工作区/会话目标解析为所属工作区行。 */
      function workspaceRowFromDropTarget(target) {
        var node = target && target.nodeType === 1 ? target : target && target.parentElement;
        if (!node) return null;
        var direct = node.closest && node.closest(ROW_SELECTOR);
        if (direct) return direct;
        while (node && node !== document.body) {
          var candidate = node.querySelector && node.querySelector(ROW_SELECTOR);
          if (candidate) return candidate;
          node = node.parentElement;
        }
        return null;
      }

      /** 高亮工作区行 */
      function highlightWorkspaceRow(wsRow, targetTitle) {
        clearDropHighlight();
        wsRow.setAttribute(DRAG_HIGHLIGHT_ATTR, "");
        wsRow.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))";
        wsRow.style.boxShadow = "inset 0 0 0 2px var(--dsw-alias-interactive-primary, #4f7cff)";
        wsRow.style.outline = "2px solid var(--dsw-alias-interactive-primary, #4f7cff)";
        wsRow.style.outlineOffset = "-2px";
        var indicator = wsRow.querySelector("[" + DROP_INDICATOR_ATTR + "]");
        if (!indicator) {
          indicator = document.createElement("span");
          indicator.setAttribute(DROP_INDICATOR_ATTR, "");
          indicator.textContent = "放置到此工作区";
          indicator.style.cssText = "position:absolute;right:8px;top:50%;transform:translateY(-50%);z-index:2;padding:2px 7px;border-radius:4px;background:var(--dsw-alias-interactive-primary,#4f7cff);color:#fff;font-size:11px;line-height:16px;pointer-events:none;white-space:nowrap;";
          var computed = window.getComputedStyle(wsRow);
          if (computed.position === "static") wsRow.style.position = "relative";
          wsRow.appendChild(indicator);
        }
        dropHighlightEl = wsRow;
      }

      /** 清除高亮 */
      function clearDropHighlight() {
        if (dropHighlightEl) {
          dropHighlightEl.removeAttribute(DRAG_HIGHLIGHT_ATTR);
          dropHighlightEl.style.background = "";
          dropHighlightEl.style.boxShadow = "";
          dropHighlightEl.style.outline = "";
          var indicator = dropHighlightEl.querySelector("[" + DROP_INDICATOR_ATTR + "]");
          if (indicator) indicator.remove();
          dropHighlightEl = null;
        }
      }

      function updateDragState(e) {
        if (!config.enableSessionMove) {
          clearDropHighlight();
          return null;
        }
        var sid = currentDragSessionId || getSessionIdFromTransfer(e && e.dataTransfer);
        if (sid) {
          currentDragSessionId = sid;
          var sourceWs = findWorkspaceBySessionId(sid);
          currentDragSourceWorkspaceId = sourceWs ? sourceWs.workspaceId : null;
        }
        var targetRow = workspaceRowFromDropTarget(e && e.target);
        var targetId = targetRow ? getWorkspaceIdFromRow(targetRow) : null;
        if (!sid || !targetRow || !targetId || targetId === currentDragSourceWorkspaceId) {
          clearDropHighlight();
          return null;
        }
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        highlightWorkspaceRow(targetRow);
        return { sessionId: sid, targetRow: targetRow, targetWorkspaceId: targetId };
      }

      /** 调用 RPC 移动会话 */
      function moveSessionViaRPC(sessionId, targetWorkspaceId) {
        if (!config.enableSessionMove) return;
        if (!connection || !connection.rpc || !connection.rpc.call) {
          toast("移动失败");
          return;
        }
        var targetWs = workspaceItems.find(function (ws) { return ws.workspaceId === targetWorkspaceId; });
        var confirmMsg = "确定将此会话移动到工作区“" + (targetWs ? targetWs.title : "目标工作区") + "”吗？\n\n移动后会话将从当前工作区移出。";
        if (!window.confirm(confirmMsg)) return;
        callPluginRpc("moveSession", {
          sessionId: sessionId,
          targetWorkspaceId: targetWorkspaceId
        }).then(function (res) {
          if (res && res.ok) {
            if (res.value && res.value.queued) {
              toast(res.value.busy
                ? "该会话正在生成中，已排队移动：重启 DSH 后自动完成"
                : "该会话在本 DSH 进程内常驻（仅关闭标签页无法释放），已排队移动：重启 DSH 后自动完成");
            } else {
              var targetWs = workspaceItems.find(function (ws) { return ws.workspaceId === targetWorkspaceId; });
              toast("已移动会话到 " + (targetWs ? targetWs.title : "目标工作区"));
            }
            refresh();
          } else {
            var errMsg = res && res.error && res.error.message ? res.error.message : "移动失败";
            toast(errMsg);
          }
        }).catch(function (err) {
          toast("移动失败: " + (err.message || "未知错误"));
        });
      }

      /** 注入拖拽事件监听 */
      function injectDragListeners() {
        if (typeof document === "undefined" || !config.enableSessionMove) return;
        if (documentDragHandler) return;

        // 在 document 捕获阶段接管跨工作区目标解析，覆盖工作区标题及其会话行。
        documentDragHandler = function (e) {
          if (!config.enableSessionMove) {
            clearDropHighlight();
            return;
          }
          if (!currentDragSessionId && !getSessionIdFromTransfer(e.dataTransfer)) return;
          updateDragState(e);
        };
        documentDropHandler = function (e) {
          if (!config.enableSessionMove) {
            clearDropHighlight();
            return;
          }
          var state = updateDragState(e);
          if (!state) return;
          e.stopPropagation();
          clearDropHighlight();
          moveSessionViaRPC(state.sessionId, state.targetWorkspaceId);
          currentDragSessionId = null;
          currentDragSourceWorkspaceId = null;
        };
        documentDragLeaveHandler = function (e) {
          if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) clearDropHighlight();
        };
        documentDragEndHandler = function () {
          clearDropHighlight();
          currentDragSessionId = null;
          currentDragSourceWorkspaceId = null;
        };
        document.addEventListener("dragover", documentDragHandler, true);
        document.addEventListener("drop", documentDropHandler, true);
        document.addEventListener("dragleave", documentDragLeaveHandler, true);
        document.addEventListener("dragend", documentDragEndHandler, true);

        // 兼容旧版已挂载节点；新的跨工作区处理由 document 捕获监听统一负责。
        // 1. 为工作区行添加 drop 监听
        var wsRows = document.querySelectorAll(ROW_SELECTOR);
        for (var i = 0; i < wsRows.length; i++) {
          var wsRow = wsRows[i];
          if (wsRow._dstcDragInjected) continue;
          wsRow._dstcDragInjected = true;

          wsRow.addEventListener("dragenter", function (e) {
            if (!config.enableSessionMove) return;
            var sid = currentDragSessionId || getSessionIdFromTransfer(e.dataTransfer);
            if (sid) {
              currentDragSessionId = sid;
              var sourceWs = findWorkspaceBySessionId(sid);
              currentDragSourceWorkspaceId = sourceWs ? sourceWs.workspaceId : null;
            }
            if (currentDragSessionId) e.preventDefault();
          });
          wsRow.addEventListener("dragover", function (e) {
            if (!config.enableSessionMove) return;
            var sid = currentDragSessionId || getSessionIdFromTransfer(e.dataTransfer);
            if (sid) {
              currentDragSessionId = sid;
              var sourceWs = findWorkspaceBySessionId(sid);
              currentDragSourceWorkspaceId = sourceWs ? sourceWs.workspaceId : null;
            }
            if (!currentDragSessionId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";

            var targetWsId = getWorkspaceIdFromRow(this);
            if (targetWsId === currentDragSourceWorkspaceId) {
              // 同工作区，不高亮
              clearDropHighlight();
              return;
            }

            highlightWorkspaceRow(this);
          });

          wsRow.addEventListener("dragleave", function (e) {
            if (e.relatedTarget && wsRow.contains(e.relatedTarget)) return;
            clearDropHighlight();
          });
          wsRow.addEventListener("dragend", function () {
            clearDropHighlight();
          });

          wsRow.addEventListener("drop", function (e) {
            if (!config.enableSessionMove) {
              clearDropHighlight();
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            clearDropHighlight();

            var sid = currentDragSessionId || getSessionIdFromTransfer(e.dataTransfer);
            if (sid) currentDragSessionId = sid;
            if (!currentDragSessionId) return;
            var targetWsId = getWorkspaceIdFromRow(this);
            if (targetWsId && targetWsId !== currentDragSourceWorkspaceId) {
              moveSessionViaRPC(currentDragSessionId, targetWsId);
            }

            currentDragSessionId = null;
            currentDragSourceWorkspaceId = null;
          });
        }

        // 2. 为会话行添加 dragstart 监听
        var sessionRows = document.querySelectorAll(SESSION_ROW_SELECTOR);
        for (var j = 0; j < sessionRows.length; j++) {
          var sRow = sessionRows[j];
          if (sRow._dstcDragInjected) continue;
          sRow._dstcDragInjected = true;

          // 官方会话行已经负责 dragstart/dragend；插件只在目标工作区的 dragover/drop
          // 中读取官方写入的 text/plain，避免与官方排序拖拽监听互相清理状态。
        }
      }

      // ---------- 只看活跃会话（v0.10.0） ----------
      // 活跃 = 会话 updatedAt 落在本地日历今天。按钮挂在官方搜索图标按钮左侧。
      // 判定优先 React fiber（SessionNodeItem.props.node / ProjectRowItem.props.group.
      // sessions 全集，覆盖折叠未渲染行；官方 bundle 不混淆 prop 键），fiber 不可用时
      // 回退 store/标题匹配，歧义一律保持可见（fail-open）。只加属性与 display，
      // 不删官方节点，随 applyAll（MutationObserver + rAF）幂等收敛。

      function readOnlyActivePref() {
        try {
          if (typeof localStorage !== "undefined") return localStorage.getItem(LS_ONLY_ACTIVE) === "1";
        } catch (e) { /* ignore */ }
        return false;
      }

      function writeOnlyActivePref(on) {
        try { if (typeof localStorage !== "undefined") localStorage.setItem(LS_ONLY_ACTIVE, on ? "1" : "0"); } catch (e) { /* ignore */ }
      }

      function isTodayActive(ms) {
        if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return false;
        var d = new Date(ms);
        var n = new Date();
        return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
      }

      /** 从 DOM 元素沿 fiber.return 上溯，找首个满足 pick 的 memoizedProps 值。 */
      function fiberPropOf(el, pick) {
        if (!el || el.nodeType !== 1) return null;
        var key = null;
        for (var k in el) {
          if (k.indexOf("__reactFiber$") === 0) { key = k; break; }
        }
        if (!key) return null;
        var fiber = el[key];
        var hops = 0;
        while (fiber && hops < 40) {
          var found = null;
          try { found = pick(fiber.memoizedProps); } catch (e) { found = null; }
          if (found) return found;
          fiber = fiber.return;
          hops++;
        }
        return null;
      }

      function sessionNodeOfRow(el) {
        return fiberPropOf(el, function (props) {
          return props && props.node && typeof props.node.id === "string" ? props.node : null;
        });
      }

      function groupOfRow(el) {
        return fiberPropOf(el, function (props) {
          return props && props.group && Array.isArray(props.group.sessions) ? props.group : null;
        });
      }

      function hideFiltered(el) {
        el.setAttribute(FILTER_HIDDEN_ATTR, "");
        el.style.setProperty("display", "none", "important");
      }

      function showFiltered(el) {
        if (el.hasAttribute(FILTER_HIDDEN_ATTR)) {
          el.removeAttribute(FILTER_HIDDEN_ATTR);
          el.style.removeProperty("display");
        }
      }

      function removeActiveFilterHints() {
        var hints = document.querySelectorAll("[" + FILTER_EMPTY_ATTR + "]");
        for (var i = 0; i < hints.length; i++) hints[i].remove();
      }

      function restoreAllFiltered() {
        if (typeof document === "undefined") return;
        var hidden = document.querySelectorAll("[" + FILTER_HIDDEN_ATTR + "]");
        for (var i = 0; i < hidden.length; i++) showFiltered(hidden[i]);
        removeActiveFilterHints();
      }

      function ensureEmptyHint() {
        if (document.querySelector("[" + FILTER_EMPTY_ATTR + "]")) return;
        var listArea = document.querySelector(OFFICIAL_LIST_AREA_SELECTOR);
        if (!listArea) return;
        var hint = document.createElement("div");
        hint.setAttribute(FILTER_EMPTY_ATTR, "");
        hint.textContent = "今天没有活跃会话";
        hint.style.cssText = "padding:14px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a94a6);user-select:none;";
        listArea.appendChild(hint);
      }

      /** 官方搜索结果视图（有查询词）接管列表：筛选暂停，清空后下一轮自动恢复。 */
      function searchViewActive() {
        try {
          if (document.querySelector(OFFICIAL_SEARCH_RESULT_ROW_SELECTOR)) return true;
          var inputs = document.querySelectorAll(OFFICIAL_SEARCH_INPUT_SELECTOR);
          for (var i = 0; i < inputs.length; i++) {
            if ((inputs[i].value || "").trim() !== "") return true;
          }
        } catch (e) { /* ignore */ }
        return false;
      }

      /** store 回退判活：归档/subagent 不算活跃；meta 缺失视为未知（fail-open 可见）。 */
      function metaTodayById(sid) {
        if (archivedIdSet.has(sid)) return false;
        var meta = metaByIdCache.get(sid);
        if (!meta) return true;
        if (meta.origin === "subagent") return false;
        return isTodayActive(meta.updatedAt);
      }

      function buildTitleFallbackSets() {
        var active = new Set();
        var inactive = new Set();
        metaByIdCache.forEach(function (meta, sid) {
          if (archivedIdSet.has(sid)) return;
          if (meta && meta.origin === "subagent") return;
          var title = typeof meta.displayTitle === "string" && meta.displayTitle.length > 0 ? meta.displayTitle
            : (typeof meta.title === "string" && meta.title.length > 0 ? meta.title : null);
          if (!title) return;
          if (isTodayActive(meta.updatedAt)) active.add(title); else inactive.add(title);
        });
        return { active: active, inactive: inactive };
      }

      function sessionRowTitleText(row) {
        var span = row.querySelector(OFFICIAL_SESSION_TITLE_SELECTOR);
        if (!span) return null;
        return (span.textContent || "").trim();
      }

      function applyActiveFilter() {
        if (typeof document === "undefined") return;
        // apply() 同步早期（行常量尚未初始化、列表未渲染）时跳过，后续轮次收敛
        if (typeof SESSION_ROW_SELECTOR !== "string") return;
        if (!onlyActive || config.showActiveFilterEntry === false || searchViewActive()) {
          restoreAllFiltered();
          return;
        }
        var titleSets = null;
        var anyGroupVisible = false;
        var anySessionVisible = false;
        var sawAnyRow = false;

        // 1) 工作区组：fiber group.sessions 全集判活（含折叠未渲染部分）→ 隐藏整个 groupSection
        var wsRows = document.querySelectorAll(ROW_SELECTOR);
        for (var i = 0; i < wsRows.length; i++) {
          var row = wsRows[i];
          sawAnyRow = true;
          var container = (row.closest && row.closest(OFFICIAL_GROUP_SECTION_SELECTOR)) || row;
          var hasActive = true;
          var group = groupOfRow(row);
          if (group) {
            hasActive = false;
            for (var gi = 0; gi < group.sessions.length; gi++) {
              var gnode = group.sessions[gi];
              if (gnode && isTodayActive(gnode.updatedAt)) { hasActive = true; break; }
            }
          } else {
            // 回退：行标题 → workspaceItems → sessionIds → store（未知工作区 fail-open 保持可见）
            var span = titleSpanOf(row);
            var wTitle = span ? cleanTitleOf(span) : "";
            var ws = null;
            for (var wi = 0; wi < workspaceItems.length; wi++) {
              if (workspaceItems[wi].title === wTitle) { ws = workspaceItems[wi]; break; }
            }
            if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.length > 0) {
              hasActive = false;
              for (var si = 0; si < ws.sessionIds.length; si++) {
                if (metaTodayById(ws.sessionIds[si])) { hasActive = true; break; }
              }
            }
          }
          if (hasActive) { showFiltered(container); anyGroupVisible = true; } else { hideFiltered(container); }
        }

        // 2) 会话行（组内 + flat 顶层同一规则）：fiber node.updatedAt；回退标题集
        var sRows = document.querySelectorAll(SESSION_ROW_SELECTOR);
        for (var j = 0; j < sRows.length; j++) {
          var sRow = sRows[j];
          sawAnyRow = true;
          var node = sessionNodeOfRow(sRow);
          var active;
          if (node) {
            active = isTodayActive(node.updatedAt);
          } else {
            if (!titleSets) titleSets = buildTitleFallbackSets();
            var t = sessionRowTitleText(sRow);
            if (t === null) active = true;
            else {
              var inActiveSet = titleSets.active.has(t);
              var inInactiveSet = titleSets.inactive.has(t);
              active = inActiveSet || !inInactiveSet; // 两集相交或未知 → fail-open
            }
          }
          if (active) {
            showFiltered(sRow);
            var gs = sRow.closest && sRow.closest(OFFICIAL_GROUP_SECTION_SELECTOR);
            if (!gs || !gs.hasAttribute(FILTER_HIDDEN_ATTR)) anySessionVisible = true;
          } else {
            hideFiltered(sRow);
          }
        }

        // 3) 空态：列表已渲染出行但组与会话行全部被隐藏
        if (!sawAnyRow) { removeActiveFilterHints(); return; }
        if (!anyGroupVisible && !anySessionVisible) ensureEmptyHint(); else removeActiveFilterHints();
      }

      function funnelIconSvg() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3 h12 l-4.4 5.4 v3.4 l-3.2 1.8 v-5.2 Z"/></svg>';
      }

      /** 注入一次按钮样式（幂等）。dsh-sxc-filter-btn 兜底复刻官方 .searchButton 规则；
       *  按压类用 !important 压过官方 base/hover 的背景声明。 */
      function ensureActiveFilterStyle() {
        if (typeof document === "undefined") return;
        if (document.querySelector("style[data-plugin-css=\"@dsh-session-xc/active-filter\"]")) return;
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin-css", "@dsh-session-xc/active-filter");
        tag.textContent = [
          ".dsh-sxc-filter-btn{cursor:pointer;width:28px;height:28px;color:inherit;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}",
          ".dsh-sxc-filter-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
          ".dsh-sxc-active-pressed{background:rgba(79,124,255,.16)!important;color:var(--dsw-alias-interactive-primary,#4f7cff)!important}",
          ".dsh-sxc-active-pressed:hover{background:rgba(79,124,255,.24)!important}"
        ].join("");
        document.head.appendChild(tag);
      }

      /**
       * 渲染筛选按钮：直接复制官方搜索按钮的实际 className（运行时从 DOM 读取，
       * 尺寸/圆形 hover/主题变量全随官方样式表走，官方升级换哈希前缀也自动跟随），
       * 叠加插件兜底类 dsh-sxc-filter-btn 与按压态 dsh-sxc-active-pressed。
       */
      function renderActiveFilterButton(mount, iconCls) {
        var ReactMod = require("react");
        var prim = null;
        try { prim = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { prim = null; }
        var TooltipC = prim && prim.Tooltip;
        var pressed = onlyActive && config.showActiveFilterEntry !== false;
        var label = "只看活跃会话（今天有操作）";
        ensureActiveFilterStyle();
        var cls = "dsh-sxc-filter-btn" + (iconCls ? " " + iconCls : "") + (pressed ? " dsh-sxc-active-pressed" : "");
        var btnEl = ReactMod.createElement("button", {
          type: "button",
          "data-dstc-active-filter-btn": "",
          "aria-label": label,
          "aria-pressed": pressed ? "true" : "false",
          className: cls,
          onClick: function (e) {
            // div.search 整体挂了"点击展开搜索"，必须阻断冒泡
            e.stopPropagation();
            e.preventDefault();
            onlyActive = !onlyActive;
            writeOnlyActivePref(onlyActive);
            try { applyAll(); } catch (err) { /* ignore */ }
          }
        }, ReactMod.createElement("span", {
          style: { display: "inline-flex", alignItems: "center", justifyContent: "center" },
          dangerouslySetInnerHTML: { __html: funnelIconSvg() }
        }));
        if (TooltipC) {
          renderInto(mount, ReactMod.createElement(TooltipC, { label: label, side: "bottom", delayMs: 500 }, btnEl));
        } else {
          renderInto(mount, btnEl);
        }
        mount._dstkPressed = pressed;
        mount._dstkCls = iconCls || "";
      }

      /** 幂等挂载/卸载筛选按钮（紧贴官方搜索图标左侧）。 */
      function ensureFilterButton() {
        if (typeof document === "undefined") return;
        var searchBtn = null;
        if (config.showActiveFilterEntry !== false) {
          var btns = document.querySelectorAll(OFFICIAL_SEARCH_BUTTON_SELECTOR);
          for (var i = 0; i < btns.length; i++) {
            // 只挂宽栏/移动抽屉头部（折叠 rail 的搜索按钮不在 searchSlot 内且无列表）
            if (btns[i].closest && btns[i].closest(OFFICIAL_SEARCH_SLOT_SELECTOR)) { searchBtn = btns[i]; break; }
          }
        }
        var slot = searchBtn && searchBtn.closest ? searchBtn.closest(OFFICIAL_SEARCH_SLOT_SELECTOR) : null;
        var mounts = document.querySelectorAll("[" + FILTER_MOUNT_ATTR + "]");
        var mount = null;
        // 挂点必须在 sectionHeader 里、slot 之前（slot 内部折叠态仅 28px 宽、header
        // overflow:hidden，挂进去会把搜索图标挤出裁掉——0.10.0 首版故障）。但官方 slot
        // 自带 margin-left:auto（搜索框组整体靠右），直接前插会让 auto 间隙落在"本按钮与
        // slot 之间"、按钮被甩到最左（0.10.1 故障）。修正：auto 归本按钮（margin-left:auto
        // 被推到右侧、紧贴 slot 左缘），slot 的 margin-left 内联清零（官方样式表不动、
        // 卸载时还原）。展开搜索时 slot flex:1 变宽，本按钮（flex:none）自动让位。
        if (slot && slot.parentNode) {
          var host = slot.parentNode;
          for (var m = 0; m < mounts.length; m++) {
            if (!mount && mounts[m].parentNode === host) mount = mounts[m];
          }
          if (!mount) {
            mount = document.createElement("span");
            mount.setAttribute(FILTER_MOUNT_ATTR, "");
            mount.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:none;margin-left:auto;";
            host.insertBefore(mount, slot);
          } else {
            if (mount.nextSibling !== slot) host.insertBefore(mount, slot); // React 重渲染后复位到 slot 之前
            if (mount.style.marginLeft !== "auto") mount.style.marginLeft = "auto";
          }
          if (slot.style.marginLeft !== "0px") slot.style.marginLeft = "0px";
        }
        for (var d = 0; d < mounts.length; d++) {
          if (mounts[d] === mount) continue;
          if (mounts[d]._dstkRoot) { try { mounts[d]._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
          mounts[d].remove();
        }
        if (!mount) {
          // 按钮不存在（设置关闭等）：还原 slot 原始 margin-left:auto（官方无内联样式，清内联即回样式表值）
          var anySlot = document.querySelector(OFFICIAL_SEARCH_SLOT_SELECTOR);
          if (anySlot && anySlot.style.marginLeft) anySlot.style.marginLeft = "";
        }
        var wantCls = searchBtn ? String(searchBtn.className || "") : "";
        if (mount && (mount._dstkPressed !== (onlyActive && config.showActiveFilterEntry !== false) || mount._dstkCls !== wantCls)) {
          renderActiveFilterButton(mount, wantCls);
        }
      }

      // ---------- 面板 ----------

      function openPanel(title, anchor) {
        closePanel();
        openWorkspaceTitle = title;
        mobileKeepOpenTitle = null;
        mobileKeepOpenUntil = 0;
        var isPC = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(min-width: 768px)").matches;
        if (isPC) {
          // —— PC：居中 modal + 遮罩 + dialog 容器 ——
          overlay = document.createElement("div");
          overlay.setAttribute(OVERLAY_ATTR, "");
          overlay.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);";

          panel = document.createElement("div");
          panel.setAttribute(PANEL_ATTR, "");
          panel.setAttribute("role", "dialog");
          panel.setAttribute("aria-modal", "true");
          panel.setAttribute("aria-label", "已归档会话");
          panel.style.cssText = "position:relative;display:flex;flex-direction:column;width:min(640px,calc(100vw - 48px));max-height:min(620px,calc(100vh - 96px));background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.22);overflow:hidden;box-sizing:border-box;";

          // 关闭按钮（预留：绑定 closePanel；Task 2 将整合进标题区并统一样式）
          var closeBtn = document.createElement("button");
          closeBtn.setAttribute(CLOSE_ATTR, "");
          closeBtn.setAttribute("type", "button");
          closeBtn.setAttribute("aria-label", "关闭");
          closeBtn.style.cssText = "position:absolute;top:10px;right:10px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a94a6);cursor:pointer;transition:background .12s ease,color .12s ease;";
          closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 5 L15 15 M15 5 L5 15"/></svg>';
          closeBtn.addEventListener("mouseenter", function () { this.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))"; this.style.color = "var(--dsw-alias-label-primary, #1d2129)"; });
          closeBtn.addEventListener("mouseleave", function () { this.style.background = "transparent"; this.style.color = "var(--dsw-alias-label-tertiary, #8a94a6)"; });
          closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closePanel(); });

          // 内容容器：renderPanel 写入目标（可滚动，标题区/列表由 renderPanel 填充）
          contentEl = document.createElement("div");
          contentEl.setAttribute(CONTENT_ATTR, "");
          contentEl.style.cssText = "flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:14px 16px;box-sizing:border-box;font-size:13px;";

          panel.appendChild(closeBtn);
          panel.appendChild(contentEl);
          overlay.appendChild(panel);
          document.body.appendChild(overlay);

          // 遮罩点击关闭：仅当点击遮罩本体（event.target === overlay），避免点击 dialog 冒泡误关
          overlayClickHandler = function (e) { if (e.target === overlay) closePanel(); };
          overlay.addEventListener("click", overlayClickHandler);
        } else {
          // —— 移动端：保留当前固定小浮层（尺寸/行为不变） ——
          // 面板挂载到 body，避免工作区 React 重渲染时被一起卸载。
          panel = document.createElement("div");
          panel.setAttribute(PANEL_ATTR, "");
          panel.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;min-width:240px;max-width:320px;max-height:340px;overflow-y:auto;background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.18);padding:8px;box-sizing:border-box;font-size:13px;";
          // 官方移动端抽屉在 document 捕获阶段处理 outside pointer；面板自身的
          // 冒泡监听来得太晚，因此在 window 捕获阶段只拦截面板内的按下事件，
          // 不 preventDefault，让后续 click 仍能到达恢复/删除按钮。
          mobileOutsideGuard = function (e) {
            if (panel && !overlay && panel.contains(e.target)) e.stopPropagation();
          };
          window.addEventListener("pointerdown", mobileOutsideGuard, true);
          document.body.appendChild(panel);
        }
        renderPanel();
      }

      function keepMobileSurfaceOpen(title) {
        if (typeof window === "undefined" || contentEl || !panel || openWorkspaceTitle !== title) return;
        mobileKeepOpenTitle = title;
        mobileKeepOpenUntil = Date.now() + 3000;
        var sidebarRoot = null;
        var node = panel;
        while (node && node !== document.body) {
          if (node.querySelector) {
            var toggle = node.querySelector('button[aria-label="打开侧边栏"], button[aria-label="展开侧边栏"]');
            if (toggle) { sidebarRoot = node; toggle.click(); break; }
          }
          node = node.parentNode;
        }
        renderPanel();
        window.setTimeout(function () {
          if (mobileKeepOpenTitle === title && Date.now() >= mobileKeepOpenUntil) {
            mobileKeepOpenTitle = null;
            mobileKeepOpenUntil = 0;
          }
        }, 3100);
      }

      function closePanel() {
        // 操作期间忽略官方 outside-pointer 等外部关闭请求，避免状态刷新关闭移动端表面。
        if (!overlay && mobileKeepOpenTitle !== null && Date.now() < mobileKeepOpenUntil) {
          if (openWorkspaceTitle === mobileKeepOpenTitle && panel) { renderPanel(); return; }
        }
        // 清理 PC 遮罩点击 handler（避免重复绑定）
        if (overlayClickHandler && overlay) {
          try { overlay.removeEventListener("click", overlayClickHandler); } catch (e) { /* ignore */ }
        }
        if (mobileOutsideGuard && typeof window !== "undefined") {
          window.removeEventListener("pointerdown", mobileOutsideGuard, true);
          mobileOutsideGuard = null;
        }
        overlayClickHandler = null;
        // 移除所有面板节点（PC：overlay 连同 dialog/content/关闭按钮；移动端：panel）
        if (overlay) { overlay.remove(); overlay = null; }
        if (panel) { panel.remove(); panel = null; }
        contentEl = null;
        openWorkspaceTitle = null;
      }

      function timeLabel(ms) {
        if (!ms) return "";
        var MIN = 60000, HOUR = 3600000, DAY = 86400000;
        var diff = Date.now() - ms;
        if (diff < MIN) return "刚刚";
        if (diff < HOUR) return Math.floor(diff / MIN) + " 分钟前";
        if (diff < DAY) return Math.floor(diff / HOUR) + " 小时前";
        if (diff < 30 * DAY) return Math.floor(diff / DAY) + " 天前";
        var d = new Date(ms);
        var p = function (n) { return n < 10 ? "0" + n : String(n); };
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
      }

      function renderPanel() {
        if (!panel) return;
        var isPC = !!contentEl;
        var info = archiveByTitle.get(openWorkspaceTitle);
        var host = isPC ? contentEl : panel;
        if (isPC) {
          var previousHeader = panel.querySelector("[data-dstc-archive-header]");
          if (previousHeader) previousHeader.remove();
        }
        host.textContent = "";
        if (isPC) {
          var header = document.createElement("div");
          header.setAttribute("data-dstc-archive-header", "");
          header.style.cssText = "flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:24px 56px 18px 28px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.08));background:var(--dsw-alias-bg-layer-2,#ffffff);";
          var heading = document.createElement("div");
          heading.style.cssText = "min-width:0;";
          var headerTitle = document.createElement("div");
          headerTitle.style.cssText = "font-weight:650;color:var(--dsw-alias-label-primary,#1d2129);font-size:18px;line-height:26px;letter-spacing:-.01em;";
          headerTitle.textContent = "已归档会话";
          var headerMeta = document.createElement("div");
          headerMeta.style.cssText = "margin-top:5px;color:var(--dsw-alias-label-secondary,#667085);font-size:13px;line-height:20px;";
          headerMeta.textContent = (openWorkspaceTitle || "当前工作区") + " · " + (info ? info.count : 0) + " 个会话";
          var headerHint = document.createElement("div");
          headerHint.style.cssText = "margin-top:8px;color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:12px;line-height:18px;";
          headerHint.textContent = "归档会话会保留在这里，恢复后重新出现在工作区列表中";
          heading.appendChild(headerTitle);
          heading.appendChild(headerMeta);
          heading.appendChild(headerHint);
          header.appendChild(heading);

          // 全部删除按钮（PC 端）
          if (info && info.items.length > 0) {
            var deleteAllBtn = document.createElement("button");
            deleteAllBtn.type = "button";
            deleteAllBtn.textContent = "全部删除";
            deleteAllBtn.style.cssText = "flex:none;padding:6px 12px;border:1px solid #ef4444;border-radius:6px;background:transparent;color:#ef4444;font-size:13px;line-height:18px;cursor:pointer;transition:all .12s ease;white-space:nowrap;";
            deleteAllBtn.setAttribute("data-dstc-delete-all", "");
            deleteAllBtn.addEventListener("mouseenter", function () { if (!this.disabled) { this.style.background = "#ef4444"; this.style.color = "#fff"; } });
            deleteAllBtn.addEventListener("mouseleave", function () { this.style.background = "transparent"; this.style.color = "#ef4444"; });
            deleteAllBtn.addEventListener("click", function (e) {
              e.stopPropagation();
              var count = info ? info.items.length : 0;
              var confirmMsg = "确定要永久删除当前工作区的所有已归档会话吗？\n\n共 " + count + " 个会话将被永久删除，此操作不可恢复。";
              if (confirm(confirmMsg)) {
                deleteAllArchivedSessions(openWorkspaceTitle, info, deleteAllBtn);
              }
            });
            header.appendChild(deleteAllBtn);
          }

          panel.insertBefore(header, contentEl);
        } else {
          var mobileHeader = document.createElement("div");
          mobileHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px 9px;";
          var mobileTitle = document.createElement("span");
          mobileTitle.style.cssText = "font-weight:600;color:var(--dsw-alias-label-primary,#1d2129);font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
          mobileTitle.textContent = "已归档会话" + (info ? " (" + info.count + ")" : "");
          var mobileHint = document.createElement("span");
          mobileHint.style.cssText = "flex:none;color:var(--dsw-alias-label-tertiary,#9aa4b2);font-size:11px;line-height:18px;";
          mobileHint.textContent = "点击恢复";
          mobileHeader.appendChild(mobileTitle);
          mobileHeader.appendChild(mobileHint);

          // 全部删除按钮（移动端）
          if (info && info.items.length > 0) {
            var mobileDeleteAllBtn = document.createElement("button");
            mobileDeleteAllBtn.type = "button";
            mobileDeleteAllBtn.textContent = "全部删除";
            mobileDeleteAllBtn.style.cssText = "flex:none;padding:4px 8px;border:1px solid #ef4444;border-radius:4px;background:transparent;color:#ef4444;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap;";
            mobileDeleteAllBtn.setAttribute("data-dstc-delete-all", "");
            mobileDeleteAllBtn.addEventListener("click", function (e) {
              e.stopPropagation();
              var count = info ? info.items.length : 0;
              var confirmMsg = "确定要永久删除当前工作区的所有已归档会话吗？\n\n共 " + count + " 个会话将被永久删除，此操作不可恢复。";
              if (confirm(confirmMsg)) {
                deleteAllArchivedSessions(openWorkspaceTitle, info, mobileDeleteAllBtn);
              }
            });
            mobileHeader.appendChild(mobileDeleteAllBtn);
          }

          host.appendChild(mobileHeader);
        }
        if (!info || info.items.length === 0) {
          var empty = document.createElement("div");
          empty.style.cssText = isPC ? "display:flex;align-items:center;justify-content:center;min-height:220px;padding:32px;color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:13px;line-height:20px;text-align:center;" : "padding:10px 4px;color:var(--dsw-alias-label-tertiary,#9aa4b2);font-size:12px;line-height:16px;";
          empty.textContent = "无已归档会话";
          host.appendChild(empty);
          return;
        }
        info.items.forEach(function (item) {
          var row = document.createElement("div");
          row.style.cssText = isPC ? "display:flex;align-items:center;gap:16px;padding:15px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.06));" : "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;";
          row.addEventListener("mouseenter", function () { this.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))"; });
          row.addEventListener("mouseleave", function () { this.style.background = "transparent"; });
          var titleEl = document.createElement("div");
          titleEl.style.cssText = (isPC ? "" : "flex:1;min-width:0;") + "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1d2129);font-size:" + (isPC ? "14px" : "12.5px") + ";line-height:" + (isPC ? "20px" : "16px") + ";";
          titleEl.textContent = item.title;
          var timeEl = document.createElement("div");
          timeEl.style.cssText = isPC ? "margin-top:3px;color:var(--dsw-alias-label-tertiary,#9aa4b2);font-size:11px;line-height:16px;" : "flex:none;color:var(--dsw-alias-label-tertiary,#9aa4b2);font-size:11px;line-height:16px;padding-left:6px;";
          timeEl.textContent = timeLabel(item.updatedAt);
          if (isPC) {
            var textWrap = document.createElement("div");
            textWrap.style.cssText = "flex:1;min-width:0;";
            textWrap.appendChild(titleEl);
            if (timeEl.textContent) textWrap.appendChild(timeEl);
            row.appendChild(textWrap);
          } else {
            row.appendChild(titleEl);
            if (timeEl.textContent) row.appendChild(timeEl);
          }
          if (isPC) {
            // 恢复按钮
            var restoreBtn = document.createElement("button");
            restoreBtn.type = "button";
            restoreBtn.textContent = "恢复";
            restoreBtn.style.cssText = "flex:none;padding:6px 12px;border:1px solid var(--dsw-alias-interactive-primary,#4f7cff);border-radius:6px;background:transparent;color:var(--dsw-alias-interactive-primary,#4f7cff);font-size:13px;line-height:18px;cursor:pointer;transition:all .12s ease;";
            restoreBtn.addEventListener("mouseenter", function () { if (!this.disabled) this.style.background = "var(--dsw-alias-interactive-primary,#4f7cff)"; if (!this.disabled) this.style.color = "#fff"; });
            restoreBtn.addEventListener("mouseleave", function () { this.style.background = "transparent"; this.style.color = "var(--dsw-alias-interactive-primary,#4f7cff)"; });
            restoreBtn.addEventListener("click", function (e) { e.stopPropagation(); unarchiveSession(openWorkspaceTitle, item, restoreBtn); });
  
            // 删除按钮
            var deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.textContent = "删除";
            deleteBtn.style.cssText = "flex:none;padding:6px 12px;border:1px solid #ef4444;border-radius:6px;background:transparent;color:#ef4444;font-size:13px;line-height:18px;cursor:pointer;transition:all .12s ease;";
            deleteBtn.addEventListener("mouseenter", function () { if (!this.disabled) { this.style.background = "#ef4444"; this.style.color = "#fff"; } });
            deleteBtn.addEventListener("mouseleave", function () { this.style.background = "transparent"; this.style.color = "#ef4444"; });
            deleteBtn.addEventListener("click", function (e) {
              e.stopPropagation();
              var confirmMsg = "确定要永久删除会话\"" + item.title + "\"吗？\n\n此操作不可恢复，会话的所有对话历史将被永久删除。";
              if (confirm(confirmMsg)) {
                deleteSession(openWorkspaceTitle, item, deleteBtn, null);
              }
            });
  
            // 按钮容器
            var btnWrap = document.createElement("div");
            btnWrap.style.cssText = "flex:none;display:flex;gap:8px;";
            btnWrap.appendChild(restoreBtn);
            btnWrap.appendChild(deleteBtn);
            row.appendChild(btnWrap);
          } else {
            // 移动端：左滑删除 + 点击恢复
            var touchStartX = 0;
            var currentTranslateX = 0;
            var isDragging = false;
            var deleteBtnShown = false;
            var DELETE_THRESHOLD = 50;
            var MAX_TRANSLATE = 60;
  
            row.addEventListener("touchstart", function(e) {
              if (deleteBtnShown) {
                var delBtn = row.querySelector("[data-dstc-mobile-delete]");
                if (delBtn && !delBtn.contains(e.target)) {
                  resetDeleteButton(null, row);
                  deleteBtnShown = false;
                }
                return;
              }
              touchStartX = e.touches[0].clientX;
              isDragging = true;
              row.style.transition = "none";
            }, { passive: true });
  
            row.addEventListener("touchmove", function(e) {
              if (!isDragging || deleteBtnShown) return;
              var deltaX = e.touches[0].clientX - touchStartX;
    
              // 只允许左滑
              if (deltaX > 0) deltaX = 0;
              if (deltaX < -MAX_TRANSLATE) deltaX = -MAX_TRANSLATE;
    
              currentTranslateX = deltaX;
              row.style.transform = "translateX(" + deltaX + "px)";
    
              // 背景色变化
              if (deltaX < -20) {
                row.style.background = "rgba(239, 68, 68, 0.15)";
              } else {
                row.style.background = "transparent";
              }
            }, { passive: true });
  
            row.addEventListener("touchend", function(e) {
              if (deleteBtnShown) return;
              isDragging = false;
              row.style.transition = "transform 0.15s ease";
    
              if (currentTranslateX < -DELETE_THRESHOLD) {
                // 显示删除按钮
                row.style.transform = "translateX(-" + MAX_TRANSLATE + "px)";
                showMobileDeleteButton(row, item);
                deleteBtnShown = true;
              } else {
                // 回弹
                row.style.transform = "translateX(0)";
                row.style.background = "transparent";
              }
              currentTranslateX = 0;
            }, { passive: true });
  
            // 点击恢复（只有未显示删除按钮时生效）
            row.addEventListener("click", function(e) {
              if (deleteBtnShown) return;
              if (Math.abs(currentTranslateX) > 5) return;
              e.stopPropagation();
              unarchiveSession(openWorkspaceTitle, item);
            });
  
            function showMobileDeleteButton(row, item) {
              row.style.position = "relative";
              var delBtn = document.createElement("button");
              delBtn.setAttribute("data-dstc-mobile-delete", "");
              delBtn.textContent = "删除";
              delBtn.style.cssText = "position:absolute;right:-60px;top:0;bottom:0;width:60px;background:#ef4444;color:#fff;border:none;font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;";
              delBtn.addEventListener("click", function(e) {
                e.stopPropagation();
                var confirmMsg = "确定要永久删除此会话吗？\n\n此操作不可恢复。";
                if (confirm(confirmMsg)) {
                  deleteSession(openWorkspaceTitle, item, null, row);
                } else {
                  resetDeleteButton(null, row);
                  deleteBtnShown = false;
                }
              });
              row.appendChild(delBtn);
            }
          }
          host.appendChild(row);
        });
      }

      function unarchiveSession(title, item, button) {
        if (button && button.disabled) return;
        if (!connection || !connection.rpc || !connection.rpc.call) return;
        if (!contentEl) { mobileKeepOpenTitle = title; mobileKeepOpenUntil = Date.now() + 3000; }
        var originalText = button ? button.textContent : "恢复";
        if (button) {
          button.disabled = true;
          button.setAttribute("aria-busy", "true");
          button.textContent = "恢复中…";
          button.style.cursor = "wait";
          button.style.opacity = "0.65";
        }
        var resetButton = function () {
          if (!button || !button.parentNode) return;
          button.disabled = false;
          button.removeAttribute("aria-busy");
          button.textContent = originalText;
          button.style.cursor = "pointer";
          button.style.opacity = "1";
        };
        var result;
        try { result = callPluginRpc("unarchiveSession", { sessionId: item.sessionId }); }
        catch (e) { resetButton(); toast("恢复失败"); return; }
        result.then(function (res) {
          if (res && res.ok) {
            var info = archiveByTitle.get(title);
            if (info) {
              info.items = info.items.filter(function (x) { return x.sessionId !== item.sessionId; });
              info.count = info.items.length;
              if (info.count === 0) archiveByTitle.delete(title);
            }
            applyAll();
            if (openWorkspaceTitle === title) {
              renderPanel();
              keepMobileSurfaceOpen(title);
            }
            toast("已恢复会话：" + item.title);
            refresh();
          } else {
            resetButton();
            toast("恢复失败");
          }
        }).catch(function () {
          resetButton();
          toast("恢复失败");
        });
      }

      function deleteSession(title, item, button, row) {
        if (button && button.disabled) return;
        if (!connection || !connection.rpc || !connection.rpc.call) return;
        if (!contentEl) { mobileKeepOpenTitle = title; mobileKeepOpenUntil = Date.now() + 3000; }
        
        // 禁用按钮
        if (button) {
          button.disabled = true;
          button.textContent = "删除中…";
          button.style.opacity = "0.65";
          button.style.cursor = "wait";
        }
        
        // 调用 RPC
        var result;
        try {
          result = callPluginRpc("deleteSession", {
            sessionId: item.sessionId
          });
        } catch (e) {
          resetDeleteButton(button, row);
          toast("删除失败");
          return;
        }
        
        result.then(function(res) {
          if (res && res.ok) {
            // v0.5.0: 记录已删除的会话 ID
            deletedSessionIds.add(item.sessionId);

            // 从本地缓存移除
            var info = archiveByTitle.get(title);
            if (info) {
              info.items = info.items.filter(function(x) { return x.sessionId !== item.sessionId; });
              info.count = info.items.length;
              if (info.count === 0) archiveByTitle.delete(title);
            }
  
            // 移动端：行滑出消失动画
            if (row && !button) {
              row.style.transition = "transform 0.2s ease, opacity 0.2s ease";
              row.style.transform = "translateX(-100%)";
              row.style.opacity = "0";
              setTimeout(function() {
                refresh();
                if (openWorkspaceTitle === title) {
                  renderPanel();
                  keepMobileSurfaceOpen(title);
                }
              }, 200);
            } else {
              // PC 端：直接刷新
              applyAll();
              if (openWorkspaceTitle === title) {
                renderPanel();
                keepMobileSurfaceOpen(title);
              }
            }
  
            toast("已删除会话：" + item.title);
            refresh();
          } else {
            resetDeleteButton(button, row);
            toast(res && res.error && res.error.message ? res.error.message : "删除失败");
          }
        }).catch(function(err) {
          resetDeleteButton(button, row);
          toast("删除失败: " + (err.message || "未知错误"));
        });
      }

      function resetDeleteButton(button, row) {
        if (button && button.parentNode) {
          button.disabled = false;
          button.textContent = "删除";
          button.style.opacity = "1";
          button.style.cursor = "pointer";
          button.style.background = "transparent";
          button.style.color = "#ef4444";
        }
        // 移动端：行回弹
        if (row) {
          row.style.transition = "transform 0.15s ease";
          row.style.transform = "translateX(0)";
          row.style.background = "transparent";
          // 移除删除按钮
          var delBtn = row.querySelector("[data-dstc-mobile-delete]");
          if (delBtn) delBtn.remove();
        }
      }

      // 批量删除当前工作区的所有已归档会话
      function deleteAllArchivedSessions(title, info, button) {
        if (button && button.disabled) return;
        if (!connection || !connection.rpc || !connection.rpc.call) return;
        if (!contentEl) { mobileKeepOpenTitle = title; mobileKeepOpenUntil = Date.now() + 3000; }
        
        // 禁用按钮
        if (button) {
          button.disabled = true;
          button.textContent = "删除中…";
          button.style.opacity = "0.65";
          button.style.cursor = "wait";
        }
        
        // 收集所有 sessionId
        var sessionIds = info && info.items ? info.items.map(function(item) { return item.sessionId; }) : [];
        if (sessionIds.length === 0) {
          if (button) {
            button.disabled = false;
            button.textContent = "全部删除";
            button.style.opacity = "1";
            button.style.cursor = "pointer";
          }
          toast("没有可删除的会话");
          return;
        }
        
        var workspace = workspaceItems.find(function (item) { return item.title === title; });
        var workspaceId = workspace && workspace.workspaceId;
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          if (button) {
            button.disabled = false;
            button.textContent = "全部删除";
            button.style.opacity = "1";
            button.style.cursor = "pointer";
          }
          toast("无法确定当前工作区");
          return;
        }

        // 调用 RPC
        var result;
        try {
          result = callPluginRpc("deleteAllArchivedSessions", {
            sessionIds: sessionIds,
            workspaceId: workspaceId
          });
        } catch (e) {
          if (button) {
            button.disabled = false;
            button.textContent = "全部删除";
            button.style.opacity = "1";
            button.style.cursor = "pointer";
          }
          toast("批量删除失败");
          return;
        }
        
        result.then(function(res) {
          if (res && res.ok) {
            var value = res.value || {};
            var deletedIds = Array.isArray(value.deletedIds) ? value.deletedIds : [];
            var failedCount = typeof value.failedCount === "number" ? value.failedCount : 0;
            deletedIds.forEach(function(sid) { deletedSessionIds.add(sid); });

            var archiveInfo = archiveByTitle.get(title);
            if (archiveInfo) {
              archiveInfo.items = archiveInfo.items.filter(function(item) {
                return deletedIds.indexOf(item.sessionId) === -1;
              });
              archiveInfo.count = archiveInfo.items.length;
              if (archiveInfo.count === 0) archiveByTitle.delete(title);
            }

            applyAll();
            if (openWorkspaceTitle === title) {
              renderPanel();
              keepMobileSurfaceOpen(title);
            }

            var deletedCount = deletedIds.length;
            toast(failedCount > 0
              ? "已删除 " + deletedCount + " 个会话，" + failedCount + " 个删除失败"
              : "已删除 " + deletedCount + " 个会话");
            refresh();
          } else {
            if (button) {
              button.disabled = false;
              button.textContent = "全部删除";
              button.style.opacity = "1";
              button.style.cursor = "pointer";
            }
            toast(res && res.error && res.error.message ? res.error.message : "批量删除失败");
          }
        }).catch(function(err) {
          if (button) {
            button.disabled = false;
            button.textContent = "全部删除";
            button.style.opacity = "1";
            button.style.cursor = "pointer";
          }
          toast("批量删除失败: " + (err.message || "未知错误"));
        });
      }

      function toast(msg) {
        var t = document.querySelector("[" + TOAST_ATTR + "]");
        if (!t) {
          t = document.createElement("div");
          t.setAttribute(TOAST_ATTR, "");
          t.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;background:rgba(28,32,40,0.92);color:#fff;font-size:13px;line-height:20px;padding:8px 14px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.25);max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity .25s ease;";
          document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = "1";
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          t.style.opacity = "0";
          setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 280);
        }, 2600);
      }

      // ---------- "会话增强"设置卡片（settings.plugin.item，mobile-xc 同款 UI） ----------

      function installSettingsCard() {
        try {
          var face = ctx;
          var slots = face.slots;
          var scopeFace = face.settingsScope;
          if (!slots || typeof slots.inject !== "function") return;
          if (!scopeFace || typeof scopeFace.bind !== "function") return;
          var cardScope;
          try { cardScope = scopeFace.bind({ namespace: NS }); } catch (e) { return; }
          if (!cardScope || typeof cardScope.getSnapshot !== "function" || typeof cardScope.set !== "function") return;

          var CardComponent = function () {
            var openState = React.useState(false);
            var open = openState[0], setOpen = openState[1];
            var read = function () {
              try {
                var v = resolveSettings(cardScope.getSnapshot());
                return v !== null && v !== undefined && typeof v === "object" ? v : {};
              } catch (e) { return {}; }
            };
            var vs = React.useState(read);
            var values = vs[0], setValues = vs[1];
            var dirtyRef = React.useRef(false);
            React.useEffect(function () {
              var alive = true;
              var sync = function () {
                if (!alive) return;
                try { var v = read(); if (v !== null && v !== undefined && Object.keys(v).length > 0) setValues(v); } catch (e) { /* ignore */ }
              };
              sync();
              var timer = window.setTimeout(sync, 400);
              var off = typeof cardScope.subscribe === "function" ? cardScope.subscribe(function () { if (!dirtyRef.current) sync(); }) : null;
              return function () {
                alive = false;
                window.clearTimeout(timer);
                if (off) { try { off(); } catch (e) { /* ignore */ } }
              };
            }, []);
            var toggle = function (key, checked) {
              dirtyRef.current = true;
              try { setValues(Object.assign({}, values, { [key]: checked })); } catch (e) { /* ignore */ }
              try {
                var pr = cardScope.set(key, checked);
                if (pr && typeof pr.then === "function") { void pr.catch(function () { try { setValues(read()); } catch (e2) { /* ignore */ } }); }
              } catch (e) { /* ignore */ }
            };
            var rows = FIELDS.map(function (f) {
              var on = values[f.key] === true;
              return React.createElement(
                "label", { key: f.key, className: "dsh-sxc-srow", "data-dstk-row": f.key },
                React.createElement("span", { className: "dsh-sxc-srow-text" },
                  React.createElement("span", { className: "dsh-sxc-srow-title" }, f.label),
                  React.createElement("span", { className: "dsh-sxc-srow-hint" }, f.hint)),
                React.createElement("span", { className: "dsh-sxc-switch" + (on ? " on" : "") },
                  React.createElement("input", { type: "checkbox", checked: on, onChange: function (e) { toggle(f.key, e.target.checked); } }),
                  React.createElement("span", { className: "dsh-sxc-switch-track" }),
                  React.createElement("span", { className: "dsh-sxc-switch-thumb" }))
              );
            });
            return React.createElement(
              "li", { className: "dsh-sxc-card" + (open ? " dsh-sxc-cardOpen" : ""), "data-dstk-card": true },
              React.createElement("button", {
                type: "button", className: "dsh-sxc-header", "aria-expanded": open ? "true" : "false",
                "aria-label": (open ? "收起" : "展开") + ": 会话增强",
                onClick: function () { setOpen(!open); }
              },
                React.createElement("span", { className: "dsh-sxc-headText" },
                  React.createElement("span", { className: "dsh-sxc-name" }, "会话增强"),
                  React.createElement("span", { className: "dsh-sxc-description" }, "工作区可见会话数 / 已归档会话入口 / 只看活跃会话")),
                React.createElement("svg", {
                  className: "dsh-sxc-chevron" + (open ? " dsh-sxc-chevronOpen" : ""), width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true"
                },
                  React.createElement("path", { d: "M3 6L8 11L13 6", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }))),
              open ? React.createElement("div", { className: "dsh-sxc-body" }, rows) : null
            );
          };

          ctx.effect(function () {
            var styleTag = document.createElement("style");
            styleTag.setAttribute("data-plugin-css", "@dsh-session-xc/card");
            styleTag.textContent = [
              // —— 卡片外壳：与官方 PluginCard 同款（border-l2 / bg-layer-3 / 12px 圆角 / 悬停边框变亮） ——
              ".dsh-sxc-card{border:1px solid var(--dsw-alias-border-l2,#3b4557);background:var(--dsw-alias-bg-layer-3,#171d29);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
              ".dsh-sxc-card:hover{border-color:var(--dsw-alias-label-dimmed,#76839b)}",
              ".dsh-sxc-cardOpen{background:var(--dsw-alias-bg-layer-2,#1e2430);border-color:var(--dsw-alias-label-dimmed,#76839b)}",
              ".dsh-sxc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
              ".dsh-sxc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-2px}",
              ".dsh-sxc-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
              ".dsh-sxc-name{color:var(--dsw-alias-label-primary,#e2e8f0);font-size:15px;font-weight:600;line-height:1.4}",
              ".dsh-sxc-description{color:var(--dsw-alias-label-tertiary,#8a94a6);font-size:13px;line-height:1.5}",
              ".dsh-sxc-chevron{color:var(--dsw-alias-label-tertiary,#8a94a6);flex:none;transition:transform .16s var(--ds-ease-in-out,ease)}",
              ".dsh-sxc-chevronOpen{transform:rotate(180deg)}",
              ".dsh-sxc-body{border-top:1px solid var(--dsw-alias-border-l2,#3b4557);margin:0 16px;padding-bottom:8px}",
              // —— 开关行：与官方 fields 行同款（12px 上下留白 / border-l2 分隔线） ——
              ".dsh-sxc-srow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,#3b4557);cursor:pointer}",
              ".dsh-sxc-srow:first-child{border-top:none}",
              ".dsh-sxc-srow-text{display:flex;flex-direction:column;gap:2px;min-width:0;padding-right:8px}",
              ".dsh-sxc-srow-title{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#e2e8f0);font-weight:500}",
              ".dsh-sxc-srow-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a94a6)}",
              ".dsh-sxc-switch{position:relative;width:40px;height:24px;flex:none;border-radius:12px;background:var(--dsw-alias-border-l2,#3b4557);transition:background .18s var(--ds-ease-in-out,ease)}",
              ".dsh-sxc-switch.on{background:var(--dsw-alias-button-info-fill,#3b82f6)}",
              ".dsh-sxc-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}",
              ".dsh-sxc-switch-thumb{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .18s var(--ds-ease-in-out,ease);pointer-events:none}",
              ".dsh-sxc-switch.on .dsh-sxc-switch-thumb{transform:translateX(16px)}"
            ].join("");
            document.head.appendChild(styleTag);
            var remove = slots.inject("settings.plugin.item", function* () {
              yield slots.register(
                { name: "settings.plugin.item", key: NS, label: function () { return NS; } },
                CardComponent
              );
            });
            return function () {
              styleTag.remove();
              if (remove && typeof remove === "function") { try { remove(); } catch (e) { /* ignore */ } }
            };
          }, "dsh-session-xc: plugin config card");
        } catch (e) { /* 无 slots/settingsScope 时跳过设置卡片 */ }
      }

      // ---------- 生命周期 ----------

      docPointerHandler = function (e) {
        if (!panel) return;
        if (overlay) return; // PC：遮罩铺满视口，关闭由遮罩自身 click handler（event.target === overlay）处理
        if (panel.contains(e.target)) return;
        if (e.target && e.target.closest && e.target.closest("[" + BTN_ATTR + "]")) return;
        closePanel();
      };
      docKeyHandler = function (e) { if (e.key === "Escape" && panel) closePanel(); };

      installSettingsCard();

      // v0.8.0: 启动后提示仍未应用的排队移动（例如浏览器在 Host flush 前抢先重连并
      // 重新打开了目标会话，导致条目顺延）。4s 后查询一次，存在待应用条目则 toast。
      if (connection && connection.rpc && typeof connection.rpc.call === "function") {
        pendingNoticeTimer = setTimeout(function () {
          pendingNoticeTimer = null;
          try {
            callPluginRpc("listPendingMoves", {}).then(function (res) {
              var list = res && res.ok && res.value && Array.isArray(res.value.pendingMoves) ? res.value.pendingMoves : [];
              if (list.length > 0) {
                toast("有 " + list.length + " 个会话移动待应用：重启 DSH 后会自动完成（期间请勿删除相关会话文件）");
              }
            }).catch(function () { /* 瞬时失败：静默 */ });
          } catch (e) { /* ignore */ }
        }, 4000);
      }

      if (typeof document !== "undefined" && typeof window !== "undefined") {
        visibilityHandler = function () { if (!document.hidden) refreshFromStores(); };
        document.addEventListener("visibilitychange", visibilityHandler);
        document.addEventListener("pointerdown", docPointerHandler, true);
        document.addEventListener("keydown", docKeyHandler, true);
        try {
          observer = new MutationObserver(function () { scheduleApply(); injectDragListeners(); });
          observer.observe(document.body, { subtree: true, childList: true, attributes: false });
        } catch (e) { observer = null; }
        scheduleApply();
        injectDragListeners();
        // v0.10.0：60s 心跳——MutationObserver 只响应 DOM 变化，跨零点/空闲页面靠它收敛筛选态
        heartbeatTimer = setInterval(function () { scheduleApply(); }, 60000);
      }
      // v0.9.0: 删除 v0.5.0 时代的 api.workspace.list 轮询回退——DSH 0.1.5 已移除 connection.api
      // 门面（该分支永不触发）；workspaces/sessions store 订阅在全部受支持版本内始终可用。

      var cleanup = function () {
        if (typeof window !== "undefined" && window[instanceKey] === instance) window[instanceKey] = null;
        if (workspacesUnsubscribe) {
          try { workspacesUnsubscribe(); } catch (e) { /* ignore */ }
        }
        if (sessionsUnsubscribe) {
          try { sessionsUnsubscribe(); } catch (e) { /* ignore */ }
        }
        if (timer) clearInterval(timer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (observer) observer.disconnect();
        if (toastTimer) clearTimeout(toastTimer);
        if (pendingNoticeTimer) clearTimeout(pendingNoticeTimer);
        if (typeof document !== "undefined" && typeof window !== "undefined") {
          if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
          if (docPointerHandler) document.removeEventListener("pointerdown", docPointerHandler, true);
          if (docKeyHandler) document.removeEventListener("keydown", docKeyHandler, true);
          if (documentDragHandler) document.removeEventListener("dragover", documentDragHandler, true);
          if (documentDropHandler) document.removeEventListener("drop", documentDropHandler, true);
          if (documentDragLeaveHandler) document.removeEventListener("dragleave", documentDragLeaveHandler, true);
          if (documentDragEndHandler) document.removeEventListener("dragend", documentDragEndHandler, true);
          closePanel();
          try {
            var btns = document.querySelectorAll("[" + BTN_ATTR + "]");
            for (var i = 0; i < btns.length; i++) {
              var bm = btns[i].parentNode;
              if (bm && bm._dstkRoot) { try { bm._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
              if (bm) bm.remove(); else btns[i].remove();
            }
            var badges = document.querySelectorAll("[" + BADGE_ATTR + "]");
            for (var j = 0; j < badges.length; j++) badges[j].remove();
            restoreAllFiltered();
            var slotEl = document.querySelector(OFFICIAL_SEARCH_SLOT_SELECTOR);
            if (slotEl && slotEl.style.marginLeft) slotEl.style.marginLeft = "";
            var fmounts = document.querySelectorAll("[" + FILTER_MOUNT_ATTR + "]");
            for (var fi = 0; fi < fmounts.length; fi++) {
              var fm = fmounts[fi];
              if (fm._dstkRoot) { try { fm._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
              fm.remove();
            }
          } catch (e) { /* ignore */ }
        }
      };
      instance.cleanup = cleanup;
      return cleanup;

    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});