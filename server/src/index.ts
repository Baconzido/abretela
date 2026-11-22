// Entrada do Worker do servidor próprio (ROADMAP, seção 6). Cada Worker é um
// servidor com uma sala só: tudo vai para o mesmo Durable Object.
//
//   GET  /ws                 WebSocket da sala (mesmo protocolo do túnel)
//   GET  /api/info           nome, quantas pessoas e quantas ao vivo (público)
//   GET  /api/admin/room     tudo da sala (chave de administrador)
//   POST /api/admin/room     nome, senha, limites, duração do TURN
//   POST /api/admin/kick     { id, banMinutes? }
//   POST /api/admin/unban    { id }
//   GET  /  (e /watch)       a página de assistir pelo navegador
//
// A página (`npm run build` gera dist-web/watch.html, com tudo dentro) vai
// embutida no código do Worker: abrir o link custa uma requisição só.

import type { Env } from "./room";
import WATCH_HTML from "../../dist-web/watch.html";

export { Room } from "./room";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = env.ROOM.get(env.ROOM.idFromName("room"));

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket", { status: 426 });
      }
      return room.fetch(request);
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      return withCors(await room.fetch(request));
    }
    if (url.pathname === "/" || url.pathname === "/watch") {
      return new Response(WATCH_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
