// dsh-session-xc 插件入口（Host / Node 侧）
//
// 职责：
//   功能 1（工作区可见会话数）为纯客户端功能（lib/client.js 调官方 workspace.list RPC）。
//   功能 2（已归档会话入口 + 恢复）：官方只有单向 workspace.archiveSession，没有
//   unarchive；本插件注册 /dsh-session-xc RPC 的 unarchiveSession 端点，从
//   workspaceRegistry 的全局 archivedSessionIds 移除目标会话（等价于官方
//   WorkspaceRegistry.setState 的逆操作），global.set 会触发 domain/changed →
//   host/archived-sessions-changed 推送，前端工作区列表自动刷新。

export const name = "dsh-session-xc";
export const inject = [];

/**
* @param ctx - cordis 上下文（web profile 的 host 合成）。
* @param config - bundle 配置（当前无）。
*/
export function apply(ctx, config = {}) {
  ctx.inject(["connection", "workspaceRegistry"], (c) => {
    c.connection.rpc.handle(
      "/dsh-session-xc",
      async (endpoint, payload) => {
        if (endpoint !== "unarchiveSession") {
          return { ok: false, error: { code: "bad-request", message: "unknown endpoint", details: {} } };
        }
        const sessionId = payload && typeof payload === "object" ? payload.sessionId : void 0;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return { ok: false, error: { code: "bad-request", message: "sessionId required", details: {} } };
        }
        const registry = c.workspaceRegistry;
        const state = registry.state;
        const archived = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
        if (archived.includes(sessionId)) {
          const next = { ...state, archivedSessionIds: archived.filter((id) => id !== sessionId) };
          // 持久化 + 触发 domain/changed（apiproxy 检测变化后推送 host/archived-sessions-changed）
          await registry.global.set(next);
          // 同步内存态（官方 WorkspaceRegistry.setState 同款两步）
          registry.state = next;
        }
        return { ok: true, value: { archivedSessionIds: [...registry.state.archivedSessionIds] } };
      },
      { authority: "trusted-host" }
    );
  });
  return function cleanup() {};
}
