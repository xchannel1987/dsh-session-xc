// dsh-session-xc 浏览器端 bundle（手写，无构建步骤）v0.2.4
//
// 思路（v0.2.4）：放弃浮层坐标定位（手机上 fixed 受 viewport zoom / transformed 祖先
// 影响而失真），徽标与按钮**直接插入工作区行内 DOM**（手机天然兼容、位置正确）。
// 闪烁根因 = React 重渲染行时清除手动子节点 + 旧版 300ms debounce 重插过慢可见；
// 修复 = MutationObserver 合并到 requestAnimationFrame **同帧立即重插** + 文本值比较，
// 重插延迟 <16ms，视觉无感。
//
// 徽标：嵌进标题 span 内部（inline，紧贴名字、同行）；按钮：插到官方操作区首位
// （"..." 左边），显隐继承官方 .rowActions hover 规则。

window.__ModuleLoader__.load({
  id: "dsh-session-xc",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var ROW_SELECTOR = '[role="treeitem"][aria-expanded]';
    var REFRESH_MS = 5000;
    var RPC_CHANNEL = "/dsh-session-xc";
    var BADGE_ATTR = "data-dstc-badge";
    var TITLE_ATTR = "data-dstc-title";
    var BTN_ATTR = "data-dstc-archive-btn";
    var PANEL_ATTR = "data-dstc-archive-panel";
    var TOAST_ATTR = "data-dstc-toast";

    var inject = ["connection"];

    function apply(ctx) {
      var connection = ctx.get("connection");
      var api = connection && connection.api;
      var canList = api && api.workspace && typeof api.workspace.list === "function";
      var canListSessions = api && api.sessions && typeof api.sessions.list === "function";

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
                } else if (!isSub) {
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

      // ---------- 行定位 ----------

      /** 工作区行标题 span：优先已标记（徽标插入后行文本被污染）；首次干净行回退文本匹配并标记。 */
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

      /** 干净标题（剔除徽标文本）。 */
      function cleanTitleOf(span) {
        var clone = span.cloneNode(true);
        var badgeEl = clone.querySelector("[" + BADGE_ATTR + "]");
        if (badgeEl) badgeEl.remove();
        return (clone.textContent || "").trim();
      }

      /** 官方操作区容器 = 行内最顶层含 button 的 span（免疫 Menu 包裹层）。
      *  即便官方菜单按钮被某 wrapper span 包裹，最顶层含按钮的 span 仍是 rowActions。 */
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

      // ---------- 图标 ----------

      function fallbackIconSvg() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.2 L4 3 h12 l1.5 1.2"/><path d="M2.5 4.2 V14 a2 2 0 0 0 2 2 h11 a2 2 0 0 0 2 -2 V4.2"/><path d="M8 10 h4"/></svg>';
      }

      function mountBtnIcon(btn) {
        var mount = document.createElement("span");
        mount.style.cssText = "display:inline-flex;align-items:center;justify-content:center;";
        btn.appendChild(mount);
        try {
          var React = require("react");
          var prim = require("@deepseek-ai/dsh-client-ui-primitives");
          if (prim && prim.IconArchiveOutline20 && React) {
            var RD = require("react-dom");
            var createRoot = (RD && RD.createRoot) || (require("react-dom/client") && require("react-dom/client").createRoot);
            if (createRoot) {
              var root = createRoot(mount);
              root.render(React.createElement(prim.IconArchiveOutline20, { size: 16 }));
              btn._dstkRoot = root;
              return;
            }
            if (RD && typeof RD.render === "function") { RD.render(React.createElement(prim.IconArchiveOutline20, { size: 16 }), mount); return; }
          }
        } catch (e) { /* 回退 */ }
        mount.innerHTML = fallbackIconSvg();
      }

      // ---------- 行内注入（幂等） ----------

      function applyAll() {
        try {
          if (typeof document === "undefined") return;
          var rows = document.querySelectorAll(ROW_SELECTOR);
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var titleSpan = titleSpanOf(row);
            if (!titleSpan) continue;
            var title = cleanTitleOf(titleSpan);
            // -- 徽标 --
            var count = countsByTitle.get(title);
            var badge = row.querySelector("[" + BADGE_ATTR + "]");
            if (count === undefined) {
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
            // -- 归档按钮（"..." 左边，显隐继承官方 .rowActions hover） --
            var info = archiveByTitle.get(title);
            var existing = row.querySelector("[" + BTN_ATTR + "]");
            if (!info || info.count === 0) {
              if (existing) { if (existing._dstkRoot) { try { existing._dstkRoot.unmount(); } catch (e) { /* ignore */ } } existing.remove(); }
              continue;
            }
            var rowActions = rowActionsOf(row);
            if (!rowActions) continue;
            var btn = existing;
            if (!btn) {
              btn = document.createElement("button");
              btn.type = "button";
              btn.setAttribute(BTN_ATTR, "");
              btn.setAttribute("data-dstc-title", title);
              btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;background:transparent;border-radius:4px;color:var(--dsw-alias-label-tertiary,#8a94a6);cursor:pointer;flex:none;transition:color .12s ease;";
              btn.addEventListener("mouseenter", function () {
                this.style.color = "var(--dsw-alias-label-primary, #1d2129)";
              });
              btn.addEventListener("mouseleave", function () {
                this.style.color = "var(--dsw-alias-label-tertiary, #8a94a6)";
              });
              btn.addEventListener("click", function (e) {
                e.stopPropagation();
                e.preventDefault();
                var t = this.getAttribute("data-dstc-title");
                if (openWorkspaceTitle === t) closePanel();
                else openPanel(t, this);
              });
              mountBtnIcon(btn);
              rowActions.insertBefore(btn, rowActions.firstChild);
            }
            var label = "已归档会话 (" + info.count + ")";
            if (btn.title !== label) { btn.title = label; btn.setAttribute("aria-label", label); }
            if (btn.getAttribute("data-dstc-title") !== title) btn.setAttribute("data-dstc-title", title);
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
        panel = document.createElement("div");
        panel.setAttribute(PANEL_ATTR, "");
        panel.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;min-width:240px;max-width:320px;max-height:340px;overflow-y:auto;background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.18);padding:8px;box-sizing:border-box;font-size:13px;";
        document.body.appendChild(panel);
        renderPanel();
      }

      function closePanel() {
        if (panel) { panel.remove(); panel = null; }
        openWorkspaceTitle = null;
      }

      function positionPanel(anchor) {
        if (!panel || !anchor) return;
        var r = anchor.getBoundingClientRect();
        var estHeight = panel.offsetHeight > 0 ? panel.offsetHeight : 320;
        var below = window.innerHeight - r.bottom;
        var top = below > estHeight + 12 ? r.bottom + 6 : Math.max(8, r.top - estHeight - 6);
        var left = Math.max(8, Math.min(r.left, window.innerWidth - 330));
        panel.style.left = left + "px";
        panel.style.top = top + "px";
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
        panel.textContent = "";
        var info = archiveByTitle.get(openWorkspaceTitle);
        var header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px 9px;";
        var headerTitle = document.createElement("span");
        headerTitle.style.cssText = "font-weight:600;color:var(--dsw-alias-label-primary,#1d2129);font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        headerTitle.textContent = "已归档会话" + (info ? " (" + info.count + ")" : "");
        var headerHint = document.createElement("span");
        headerHint.style.cssText = "flex:none;color:var(--dsw-alias-label-tertiary,#9aa4b2);font-size:11px;line-height:18px;";
        headerHint.textContent = "点击恢复";
        header.appendChild(headerTitle);
        header.appendChild(headerHint);
        panel.appendChild(header);
        if (!info || info.items.length === 0) {
          var empty = document.createElement("div");
          empty.style.cssText = "padding:10px 4px;color:var(--dsw-alias-label-tertiary,#9aa4b2);font-size:12px;line-height:16px;";
          empty.textContent = "无已归档会话";
          panel.appendChild(empty);
          return;
        }
        info.items.forEach(function (item) {
          var row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;";
          row.addEventListener("mouseenter", function () { this.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))"; });
          row.addEventListener("mouseleave", function () { this.style.background = "transparent"; });
          var titleEl = document.createElement("div");
          titleEl.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1d2129);font-size:12.5px;line-height:16px;";
          titleEl.textContent = item.title;
          var timeEl = document.createElement("div");
          timeEl.style.cssText = "flex:none;color:var(--dsw-alias-label-tertiary,#9aa4b2);font-size:11px;line-height:16px;padding-left:6px;";
          timeEl.textContent = timeLabel(item.updatedAt);
          row.appendChild(titleEl);
          row.appendChild(timeEl);
          row.addEventListener("click", function (e) {
            e.stopPropagation();
            unarchiveSession(openWorkspaceTitle, item);
          });
          panel.appendChild(row);
        });
      }

      function unarchiveSession(title, item) {
        if (!connection || !connection.rpc || !connection.rpc.call) return;
        var result;
        try { result = Promise.resolve(connection.rpc.call(RPC_CHANNEL, "unarchiveSession", { sessionId: item.sessionId })); }
        catch (e) { toast("恢复失败"); return; }
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
              if (info && info.count > 0) renderPanel();
              else closePanel();
            }
            toast("已恢复会话：" + item.title);
            refresh();
          } else {
            toast("恢复失败");
          }
        }).catch(function () { toast("恢复失败"); });
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

      // ---------- 生命周期 ----------

      docPointerHandler = function (e) {
        if (!panel) return;
        if (panel.contains(e.target)) return;
        if (e.target && e.target.hasAttribute && e.target.hasAttribute(BTN_ATTR)) return;
        closePanel();
      };
      docKeyHandler = function (e) { if (e.key === "Escape") closePanel(); };

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
              if (btns[i]._dstkRoot) { try { btns[i]._dstkRoot.unmount(); } catch (e) { /* ignore */ } }
              btns[i].remove();
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
