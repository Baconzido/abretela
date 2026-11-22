// De onde a página de assistir tira a sala: do próprio endereço da página (o
// servidor que a serviu é a sala), com a senha depois do "#" no link do túnel.
// `?room=<url>` aponta para outra sala (testes e desenvolvimento).

export type PageRoom = {
  /** URL https da sala, sem barra no fim. */
  room: string;
  /** WebSocket da sala. */
  ws: string;
  /** Senha do link (túnel); o servidor próprio nunca manda. */
  password: string | null;
  /** Nome curto para mostrar enquanto não sabe o nome da sala. */
  label: string;
};

type Loc = { protocol: string; host: string; hash: string; search: string };

export function roomFromPage(loc: Loc): PageRoom {
  let base = `${loc.protocol}//${loc.host}`;
  const override = new URLSearchParams(loc.search).get("room");
  if (override && /^https?:\/\/[^\s/]+\/?$/i.test(override)) base = override.replace(/\/+$/, "");
  let password: string | null = null;
  if (loc.hash.length > 1) {
    try {
      password = decodeURIComponent(loc.hash.slice(1)).trim() || null;
    } catch {
      password = loc.hash.slice(1).trim() || null;
    }
  }
  const host = new URL(base).hostname;
  return {
    room: base,
    ws: `${base.replace(/^http/i, "ws")}/ws`,
    password,
    label: host.split(".")[0] || host,
  };
}

/** Link que abre a mesma sala no app (o protocolo abretela://). */
export const appLink = (p: PageRoom) =>
  `abretela://join/${p.room.replace(/^https?:\/\//i, "")}${p.password ? `#${encodeURIComponent(p.password)}` : ""}`;

export const DOWNLOAD_URL = "https://github.com/beqm/abretela/releases/latest";
