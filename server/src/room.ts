// A sala como Durable Object: liga os eventos da Cloudflare à lógica de
// `core.ts`. Usa a API de hibernação de WebSocket: com a sala parada (ninguém
// mandando nada), o objeto dorme e não gasta tempo. O `ping` do app é
// respondido pela própria Cloudflare (`setWebSocketAutoResponse`), sem acordar.

import { DurableObject } from "cloudflare:workers";
import { RoomCore, type Conn, type RoomHost } from "./core";
import { LIMITS, type ConnState } from "./protocol";
import { CloudflareTurn } from "./turn";

export type Env = {
  ROOM: DurableObjectNamespace<Room>;
  /** Segredos do Worker, postos pelo app ao montar o servidor (fase S2). */
  ADMIN_KEY_HASH?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
};

function wrap(ws: WebSocket, ctx: DurableObjectState): Conn {
  return {
    lastPing: () => ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    state: () => (ws.deserializeAttachment() as ConnState | null) ?? { ip: "" },
    setState: (state) => ws.serializeAttachment(state),
  };
}

export class Room extends DurableObject<Env> {
  private core: RoomCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    const turn = env.TURN_KEY_ID && env.TURN_KEY_TOKEN ? new CloudflareTurn(env.TURN_KEY_ID, env.TURN_KEY_TOKEN) : null;
    const host: RoomHost = {
      conns: () => ctx.getWebSockets().map((ws) => wrap(ws, ctx)),
      load: (key) => ctx.storage.get(key),
      save: (key, value) => ctx.storage.put(key, value),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      setAlarm: async (at) => {
        if (at === null) await ctx.storage.deleteAlarm();
        else await ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
      },
      turn,
      adminKeyHash: env.ADMIN_KEY_HASH ?? null,
      log: (level, text) => (level === "warn" ? console.warn(text) : console.log(text)),
    };
    this.core = new RoomCore(host);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      const state: ConnState = { ip: request.headers.get("CF-Connecting-IP") ?? "" };
      server.serializeAttachment(state);
      return new Response(null, { status: 101, webSocket: client });
    }
    let body: unknown = null;
    if (request.method === "POST") {
      const text = await request.text();
      if (text.length > 64 * 1024) return Response.json({ error: "too-big" }, { status: 413 });
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        return Response.json({ error: "invalid-json" }, { status: 400 });
      }
    }
    const result = await this.core.http(request.method, url.pathname, request.headers.get("Authorization"), body);
    return Response.json(result.body, { status: result.status });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    if (message.length > LIMITS.maxMessageBytes) {
      ws.close(1009, "message too big");
      return;
    }
    await this.core.message(wrap(ws, this.ctx), message);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    await this.core.closed(wrap(ws, this.ctx));
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // já fechado
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.core.closed(wrap(ws, this.ctx));
  }

  async alarm() {
    await this.core.alarm();
  }
}
