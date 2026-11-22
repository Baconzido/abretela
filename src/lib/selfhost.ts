// Servidor próprio (ROADMAP, seção 6): o que o frontend sabe dos servidores que
// esta pessoa montou. Montar, atualizar e apagar é no Rust (`selfhost/`), que
// guarda o token da Cloudflare e as chaves de administrador no Gerenciador de
// Credenciais. Aqui ficam só nome, endereço e conta (nas preferências).

import { invoke } from "@tauri-apps/api/core";
import { SERVER_VERSION } from "../../server/src/protocol";

export type Account = { id: string; name: string };

/** Um servidor montado (ou assumido) por este PC. */
export type OwnedServer = {
  scriptName: string;
  accountId: string;
  name: string;
  url: string;
  turnKeyId: string | null;
  /** Por que ficou sem TURN (em inglês, como no log). */
  turnError: string | null;
  /** A senha da sala já foi definida. */
  configured: boolean;
};

export type FoundServer = { scriptName: string; url: string };

/** O que `/api/info` do servidor responde (público). */
export type ServerInfo = {
  app: "abretela";
  version: number;
  name: string;
  people: number;
  live: number;
  configured: boolean;
  turn: boolean;
};

/** Etapas de `selfhost_create` (evento `selfhost-progress`). */
export type CreateStep = "subdomain" | "turn" | "upload" | "online" | "configure" | "done";

export { SERVER_VERSION };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Lê um servidor salvo nas preferências, ou `null` se não fizer sentido. */
export function loadServer(v: unknown): OwnedServer | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (!/^abretela-[a-z0-9-]+$/.test(str(s.scriptName)) || !str(s.accountId) || !/^https:\/\//.test(str(s.url))) return null;
  return {
    scriptName: str(s.scriptName),
    accountId: str(s.accountId),
    name: str(s.name) || "AbreTela",
    url: str(s.url),
    turnKeyId: str(s.turnKeyId) || null,
    turnError: str(s.turnError) || null,
    configured: s.configured !== false,
  };
}

/**
 * Link para criar o token na Cloudflare com as permissões de Workers marcadas.
 * Com `withTurn`, tenta marcar também a do Realtime (TURN): a Cloudflare não
 * documenta a chave dela e ignora em silêncio as que não conhece, então a tela
 * também explica onde marcar à mão.
 */
export function tokenUrl(withTurn: boolean): string {
  const permissions = [
    { key: "workers_scripts", type: "edit" },
    { key: "account_settings", type: "read" },
    ...(withTurn ? [{ key: "realtime", type: "edit" }] : []),
  ];
  const q = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(permissions),
    accountId: "*",
    zoneId: "all",
    name: "AbreTela",
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${q}`;
}

/** Nome e números do servidor; `null` se ele não responder. */
export async function serverInfo(url: string, timeoutMs = 8000): Promise<ServerInfo | null> {
  try {
    const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const info = (await res.json()) as ServerInfo;
    return info?.app === "abretela" ? info : null;
  } catch {
    return null;
  }
}

/** O servidor roda um código mais velho que o desta versão do app? */
export const isOutdated = (info: ServerInfo | null) => !!info && info.version < SERVER_VERSION;

export const selfhost = {
  connect: (token: string) => invoke<Account[]>("selfhost_connect", { token }),
  hasToken: () => invoke<boolean>("selfhost_has_token"),
  accounts: () => invoke<Account[]>("selfhost_accounts"),
  forgetToken: () => invoke<void>("selfhost_forget_token"),
  create: (accountId: string, name: string, password: string) =>
    invoke<OwnedServer>("selfhost_create", { accountId, name, password }),
  configure: (s: OwnedServer, name: string, password: string) =>
    invoke<void>("selfhost_configure", { scriptName: s.scriptName, url: s.url, name, password }),
  update: (s: OwnedServer) => invoke<void>("selfhost_update", { accountId: s.accountId, scriptName: s.scriptName }),
  remove: (s: OwnedServer) =>
    invoke<void>("selfhost_delete", { accountId: s.accountId, scriptName: s.scriptName, turnKeyId: s.turnKeyId }),
  find: (accountId: string) => invoke<FoundServer[]>("selfhost_find", { accountId }),
  claim: (accountId: string, scriptName: string) => invoke<OwnedServer>("selfhost_claim", { accountId, scriptName }),
  /** Cria a chave do TURN e põe no servidor; devolve o id da chave. */
  addTurn: (s: OwnedServer) => invoke<string>("selfhost_add_turn", { accountId: s.accountId, scriptName: s.scriptName }),
};
