// A lista de servidores da tela inicial (ROADMAP, seção 6): os que esta pessoa
// administra (`OwnedServer`, montados por este PC) e os em que ela já entrou
// com a senha (`JoinedServer`). A senha fica guardada para entrar direto das
// próximas vezes: ela só abre a sala, não dá poder nenhum.

import type { OwnedServer } from "./selfhost";

export type JoinedServer = { url: string; name: string; password: string };

/** Um item da lista: como entrar e o que mostrar. */
export type ServerEntry = {
  url: string;
  name: string;
  /** Este PC administra: entra como dono, pela chave de administrador. */
  owned: OwnedServer | null;
  /** Senha guardada (servidores de outras pessoas). */
  password: string | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Mesmo servidor, escrito de jeitos diferentes (barra no fim, maiúsculas). */
export const sameServer = (a: string, b: string) =>
  a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

export function loadJoined(v: unknown): JoinedServer[] {
  return (Array.isArray(v) ? v : [])
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .filter((x) => /^https:\/\/[^\s/]+$/.test(str(x.url)))
    .map((x) => ({ url: str(x.url), name: str(x.name) || "AbreTela", password: str(x.password) }))
    .slice(0, 50);
}

/** Lembra (ou atualiza) um servidor em que entrei; o mais recente vai para o topo. */
export function remember(list: JoinedServer[], server: JoinedServer): JoinedServer[] {
  return [server, ...list.filter((s) => !sameServer(s.url, server.url))].slice(0, 50);
}

export const forget = (list: JoinedServer[], url: string) => list.filter((s) => !sameServer(s.url, url));

/** Os meus servidores primeiro, depois os em que entrei (sem repetir). */
export function serverEntries(owned: OwnedServer[], joined: JoinedServer[]): ServerEntry[] {
  const mine = owned.map((s) => ({ url: s.url, name: s.name, owned: s, password: null }));
  const others = joined
    .filter((j) => !owned.some((o) => sameServer(o.url, j.url)))
    .map((j) => ({ url: j.url, name: j.name, owned: null, password: j.password || null }));
  return [...mine, ...others];
}
