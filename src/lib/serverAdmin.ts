// Administração do servidor próprio pelo app (ROADMAP, seção 6, fase S4): fala
// com a API do Worker (`/api/admin/*`) usando a chave de administrador deste PC,
// que o Rust guarda no Gerenciador de Credenciais.

import { selfhost, type OwnedServer } from "./selfhost";
import type { RoomSettings } from "./quality";

export type AdminPeer = {
  id: string;
  name: string;
  sharing: boolean;
  label: string | null;
  owner: boolean;
  joinedAt: number;
};

export type AdminBan = { id: string; name: string; until: number };

/** Tudo da sala, como o dono vê. */
export type AdminView = {
  name: string;
  people: number;
  live: number;
  configured: boolean;
  turn: boolean;
  settings: RoomSettings;
  turnLifetime: number;
  peers: AdminPeer[];
  bans: AdminBan[];
};

export type RoomPatch = Partial<{ name: string; password: string; settings: RoomSettings; turnLifetime: number }>;

/** Por quanto tempo banir (minutos): 1 hora, 1 dia, 1 semana. */
export const BAN_OPTIONS = [60, 24 * 60, 7 * 24 * 60] as const;

export class AdminError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`${code} (HTTP ${status})`);
  }
}

async function call(server: OwnedServer, method: "GET" | "POST", path: string, body?: unknown): Promise<AdminView> {
  const key = await selfhost.adminKey(server);
  if (!key) throw new AdminError(401, "no-admin-key");
  let res: Response;
  try {
    res = await fetch(`${server.url}/api/admin/${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AdminError(0, "offline");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AdminError(res.status, typeof data?.error === "string" ? data.error : "failed");
  return data as AdminView;
}

export const serverAdmin = {
  view: (s: OwnedServer) => call(s, "GET", "room"),
  configure: (s: OwnedServer, patch: RoomPatch) => call(s, "POST", "room", patch),
  kick: (s: OwnedServer, id: string, banMinutes = 0) => call(s, "POST", "kick", { id, banMinutes }),
  unban: (s: OwnedServer, id: string) => call(s, "POST", "unban", { id }),
};
