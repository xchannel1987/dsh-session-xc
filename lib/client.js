// dsh-session-xc 浏览器端 bundle（手写，无构建步骤）v0.2.11
//
// 功能：
//   徽标：工作区名称旁显示可见会话数 (N)（嵌入标题 span，同一行、0 不显示）
//   归档按钮：工作区行操作区 "..." 左侧（行内注入，显隐继承官方 rowActions hover）
//   面板：已归档会话列表，点击恢复（/dsh-session-xc unarchiveSession RPC）+ toast
//   配置："会话增强"设置卡片（settings.plugin.item，官方 PluginCard 同款 UI）：
//     showSessionCount（活跃会话数展示）/ showArchiveEntry（已归档会话按钮），live 生效。
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
    var CONFIG_DEFAULTS = { showSessionCount: true, showArchiveEntry: true };
    var FIELDS = [
      { key: "showSessionCount", label: "活跃会话数展示", hint: "工作区名称旁显示可见会话数 (N)，为 0 时不显示" },
      { key: "showArchiveEntry", label: "已归档会话按钮", hint: "工作区操作区显示归档按钮，点击可查看并恢复已归档会话" }
    ];

    var ROW_SELECTOR = '[role="treeitem"][aria-expanded]';
    var REFRESH_MS = 5000;
    var RPC_CHANNEL = "/dsh-session-xc";
    var BADGE_ATTR = "data-dstc-badge";
    var TITLE_ATTR = "data-dstc-title";
    var BTN_ATTR = "data-dstc-archive-btn";
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
      var connection = ctx.get("connection");
      var api = connection && connection.api;
      var canList = api && api.workspace && typeof api.workspace.list === "function";
      var canListSessions = api && api.sessions && typeof api.sessions.list === "function";

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
      var panel = null;
      var openWorkspaceTitle = null;
      var timer = null;
      var visibilityHandler = null;
      var observer = null;
      var rafPending = false;
      var toastTimer = null;
      var docPointerHandler = null;
      var docKeyHandler = null;
      var overlay = null; // PC 遮罩层（移动端为 null）
      var contentEl = null; // PC 内容容器（renderPanel 写入目标；移动端为 null，写入 panel）
      var overlayClickHandler = null; // PC 遮罩点击关闭 handler（closePanel 清理，避免重复绑定）

      // ---------- 数据层 ----------

      function sessionTitleOf(meta, sid) {
        if (meta) {
          var p = meta.projections && meta.projections.values;
          var t = p ? p.title : void 0;
          if (typeof t === "string" && t.length > 0) return t;
          if (t && typeof t === "object" && typeof t.val === "string" && t.val.length > 0) return t.val;
        }
        return sid;
      }

      function refresh() {
        if (!canList) return;
        var res;
        try { res = Promise.resolve(api.workspace.list({})); } catch (e) { return; }
        res.then(function (r) {
          if (!r || !r.result || !r.result.ok) return;
          var value = r.result.value || {};
          var items = Array.isArray(value.items) ? value.items : [];
          var archived = new Set(Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds : []);
          var sReq = null;
          if (canListSessions) { try { sReq = Promise.resolve(api.sessions.list({})); } catch (e) { sReq = null; } }
          Promise.resolve(sReq).then(function (sr) {
            var byId = new Map();
            // 当前会话 id（官方 SessionRuntime.selection 的持久化副本，list.current 的来源）
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
            if (sr && sr.result && sr.result.ok && sr.result.value && Array.isArray(sr.result.value.items)) {
              for (var i = 0; i < sr.result.value.items.length; i++) {
                var it = sr.result.value.items[i];
                if (it && it.sessionId != null) byId.set(it.sessionId, it);
              }
            }
            var counts = new Map();
            var archive = new Map();
            for (var k = 0; k < items.length; k++) {
              var ws = items[k];
              if (!ws || typeof ws.title !== "string" || ws.title.length === 0) continue;
              var ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
              var visible = 0;
              var archivedItems = [];
              for (var j = 0; j < ids.length; j++) {
                var sid = ids[j];
                var meta = byId.get(sid);
                var isSub = !!(meta && meta.origin === "subagent");
                var isBlank = !!(meta && meta.blank);
                if (archived.has(sid)) {
                  if (!isSub && !isBlank) {
                    archivedItems.push({ sessionId: sid, title: sessionTitleOf(meta, sid), updatedAt: meta ? meta.updatedAt : null });
                  }
                } else if (!isSub && (!isBlank || sid === currentId)) {
                  // 官方 sessionVisible：blank 会话仅当前会话可见；其余空白占位不计数
                  visible++;
                }
              }
              if (visible > 0) counts.set(ws.title, visible);
              if (archivedItems.length > 0) archive.set(ws.title, { count: archivedItems.length, items: archivedItems });
            }
            countsByTitle = counts;
            archiveByTitle = archive;
            applyAll();
            if (openWorkspaceTitle !== null) renderPanel();
          }).catch(function () {
            applyAll();
          });
        }).catch(function () { /* 瞬时失败，下周期重试 */ });
      }

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
            else openPanel(title, null);
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
            // —— 徽标（活跃会话数，受 showSessionCount 控制） ——
            var count = countsByTitle.get(title);
            var badge = row.querySelector("[" + BADGE_ATTR + "]");
            if (count === undefined || !config.showSessionCount) {
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
              if (badge._last !== count) { badge.textContent = " (" + count + ")"; badge._last = count; }
            }
            // —— 归档按钮（受 showArchiveEntry 控制） ——
            var info = archiveByTitle.get(title);
            var existing = row.querySelector("[" + BTN_ATTR + "]");
            if (!info || info.count === 0 || !config.showArchiveEntry) {
              if (existing) {
                var oldMount = existing.parentNode;
                if (oldMount && oldMount._dstkRoot) { try { oldMount._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
                if (oldMount) oldMount.remove(); else existing.remove();
              }
              continue;
            }
            var rowActions = rowActionsOf(row);
            if (!rowActions) continue;
            var label = "已归档会话 (" + info.count + ")";
            var mount = existing ? existing.parentNode : null;
            if (!mount) {
              mount = document.createElement("span");
              mount.style.cssText = "display:inline-flex;align-items:center;justify-content:center;";
              rowActions.insertBefore(mount, rowActions.firstChild);
            }
            if (mount._dstkLabel !== label) {
              mount._dstkLabel = label;
              renderArchiveButton(mount, label, title);
            }
            var btn = existing || mount.querySelector("[" + BTN_ATTR + "]");
            if (btn && btn.getAttribute("data-dstc-title") !== title) btn.setAttribute("data-dstc-title", title);
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

      // ---------- 面板 ----------

      function openPanel(title, anchor) {
        closePanel();
        openWorkspaceTitle = title;
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
          panel = document.createElement("div");
          panel.setAttribute(PANEL_ATTR, "");
          panel.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;min-width:240px;max-width:320px;max-height:340px;overflow-y:auto;background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.18);padding:8px;box-sizing:border-box;font-size:13px;";
          document.body.appendChild(panel);
        }
        renderPanel();
      }

      function closePanel() {
        // 清理 PC 遮罩点击 handler（避免重复绑定）
        if (overlayClickHandler && overlay) {
          try { overlay.removeEventListener("click", overlayClickHandler); } catch (e) { /* ignore */ }
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
          titleEl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1d2129);font-size:" + (isPC ? "14px" : "12.5px") + ";line-height:" + (isPC ? "20px" : "16px") + ";";
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
            var restoreBtn = document.createElement("button");
            restoreBtn.type = "button";
            restoreBtn.textContent = "恢复";
            restoreBtn.style.cssText = "flex:none;padding:6px 12px;border:1px solid var(--dsw-alias-interactive-primary,#4f7cff);border-radius:6px;background:transparent;color:var(--dsw-alias-interactive-primary,#4f7cff);font-size:13px;line-height:18px;cursor:pointer;";
            restoreBtn.addEventListener("mouseenter", function () { if (!this.disabled) this.style.background = "var(--dsw-alias-interactive-primary,#4f7cff)"; if (!this.disabled) this.style.color = "#fff"; });
            restoreBtn.addEventListener("mouseleave", function () { this.style.background = "transparent"; this.style.color = "var(--dsw-alias-interactive-primary,#4f7cff)"; });
            restoreBtn.addEventListener("click", function (e) { e.stopPropagation(); unarchiveSession(openWorkspaceTitle, item, restoreBtn); });
            row.appendChild(restoreBtn);
          } else {
            row.addEventListener("click", function (e) { e.stopPropagation(); unarchiveSession(openWorkspaceTitle, item); });
          }
          host.appendChild(row);
        });
      }

      function unarchiveSession(title, item, button) {
        if (button && button.disabled) return;
        if (!connection || !connection.rpc || !connection.rpc.call) return;
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
        try { result = Promise.resolve(connection.rpc.call(RPC_CHANNEL, "unarchiveSession", { sessionId: item.sessionId })); }
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
              if (contentEl) renderPanel();
              else closePanel();
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
                  React.createElement("span", { className: "dsh-sxc-description" }, "工作区可见会话数 / 已归档会话入口")),
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

      if (typeof document !== "undefined" && typeof window !== "undefined") {
        visibilityHandler = function () { if (!document.hidden) refresh(); };
        document.addEventListener("visibilitychange", visibilityHandler);
        document.addEventListener("pointerdown", docPointerHandler, true);
        document.addEventListener("keydown", docKeyHandler, true);
        try {
          observer = new MutationObserver(function () { scheduleApply(); });
          observer.observe(document.body, { subtree: true, childList: true, attributes: false });
        } catch (e) { observer = null; }
        scheduleApply();
      }
      if (canList) {
        timer = setInterval(refresh, REFRESH_MS);
        refresh();
      }

      return function cleanup() {
        if (timer) clearInterval(timer);
        if (observer) observer.disconnect();
        if (toastTimer) clearTimeout(toastTimer);
        if (typeof document !== "undefined" && typeof window !== "undefined") {
          if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
          if (docPointerHandler) document.removeEventListener("pointerdown", docPointerHandler, true);
          if (docKeyHandler) document.removeEventListener("keydown", docKeyHandler, true);
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
          } catch (e) { /* ignore */ }
        }
      };
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
