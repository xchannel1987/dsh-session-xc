// dsh-session-xc 浏览器端 bundle（手写，无构建步骤）v0.7.1
//
// 功能：
//   徽标：工作区名称旁显示可见会话数 (N)（嵌入标题 span，同一行、0 不显示）
//   归档按钮：工作区行操作区 "..." 左侧（行内注入，显隐继承官方 rowActions hover）
//   面板：已归档会话列表，点击恢复（/dsh-session-xc unarchiveSession RPC）+ toast
//   拖拽：跨工作区移动会话（拖拽会话行到目标工作区行）
//   配置："会话增强"设置卡片（settings.plugin.item，官方 PluginCard 同款 UI）：
//     showSessionCount / showArchiveEntry / enableSessionMove，live 生效。
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
    var CONFIG_DEFAULTS = { showSessionCount: true, showArchiveEntry: true, enableSessionMove: true };
    var FIELDS = [
      { key: "showSessionCount", label: "会话数展示", hint: "工作区名称旁显示可见会话数和已完成未读数 (N活跃, M未读)，为 0 时不显示" },
      { key: "showArchiveEntry", label: "已归档会话按钮", hint: "工作区操作区显示归档按钮，点击可查看并恢复已归档会话" },
      { key: "enableSessionMove", label: "跨工作区移动会话", hint: "启用后可拖拽会话到其他工作区" }
    ];

    var ROW_SELECTOR = '[role="treeitem"][aria-expanded]';
    var REFRESH_MS = 5000;
    var RPC_CHANNEL = "/dsh-session-xc";
    var BADGE_ATTR = "data-dstc-badge";
    var TITLE_ATTR = "data-dstc-title";
    var BTN_ATTR = "data-dstc-archive-btn";
    var MOUNT_ATTR = "data-dstc-archive-mount";
    var PANEL_ATTR = "data-dstc-archive-panel";
    var OVERLAY_ATTR = "data-dstc-archive-overlay";
    var CONTENT_ATTR = "data-dstc-archive-content";
    var CLOSE_ATTR = "data-dstc-archive-close";
    var TOAST_ATTR = "data-dstc-toast";

    var inject = ["connection", "slots", "settingsScope"];

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
      var api = connection && connection.api;

      // v0.5.0: 获取 DSH 核心的 workspaces 服务
      var workspacesService = ctx.get("workspaces");
      var workspacesList = workspacesService && workspacesService.list;

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
      var panel = null;
      var openWorkspaceTitle = null;
      var timer = null;
      var visibilityHandler = null;
      var observer = null;
      var rafPending = false;
      var toastTimer = null;
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

        workspaceItems = items;
        // WorkspaceRuntime 的 baselinesReady 只在 workspace.list 与 session.list
        // 都完成后为 true。未完成时清空展示数据，避免把临时 blank 会话算进数量。
        var baselinesReady = !!(workspaceSnapshot && workspaceSnapshot.baselinesReady === true);
        if (!baselinesReady) {
          countsByTitle = new Map();
          archiveByTitle = new Map();
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
        if (wsSnapshot.baselinesReady !== undefined && wsSnapshot.baselinesReady !== true) return false;
        if (wsSnapshot.baselinesReady === undefined && wsSnapshot.phase !== "ready") return false;
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
          var sessionsList = workspacesService && workspacesService.sessions && workspacesService.sessions.list;
          var sessionsSnapshot = sessionsList && typeof sessionsList.getSnapshot === "function" ? sessionsList.getSnapshot() : null;
          if (snapshotsAreReady(wsSnapshot, sessionsSnapshot)) computeArchiveData(wsSnapshot, sessionsSnapshot);
          else computeArchiveData({ items: [], archivedSessionIds: [], baselinesReady: false }, null);
        } catch (e) { /* ignore */ }
      }
      if (workspacesList && typeof workspacesList.subscribe === "function") workspacesUnsubscribe = workspacesList.subscribe(refreshFromStores);
      var sessionsListForSubscription = workspacesService && workspacesService.sessions && workspacesService.sessions.list;
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
              var labelText = (labelEl.textContent || "").trim();
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

      /** 官方 SessionNodeItem 在 dragstart 时写入 text/plain = node.id。 */
      function getSessionIdFromTransfer(dataTransfer) {
        if (!dataTransfer || typeof dataTransfer.getData !== "function") return null;
        var value = dataTransfer.getData("text/plain");
        return typeof value === "string" && value.length > 0 ? value : null;
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
        connection.rpc.call(RPC_CHANNEL, "moveSession", {
          sessionId: sessionId,
          targetWorkspaceId: targetWorkspaceId
        }).then(function (res) {
          if (res && res.ok) {
            var targetWs = workspaceItems.find(function (ws) { return ws.workspaceId === targetWorkspaceId; });
            toast("已移动会话到 " + (targetWs ? targetWs.title : "目标工作区"));
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
            var toggle = node.querySelector('button[aria-label="展开侧边栏"]');
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