// Servidor TURN do anfitrião (ROADMAP, seção 4.4): repassa o vídeo quando os
// dois PCs não conseguem se conectar direto. Não há TURN fixo do app: quem
// cria a sala configura o próprio, e os espectadores recebem os `iceServers`
// pela sala. Cada tipo de TURN é um provedor atrás do mesmo contrato; o
// segredo (token, segredo do coturn) nunca sai do PC do anfitrião.

import { invoke } from "@tauri-apps/api/core";
import { describeError, log } from "./log";

export type TurnConfig =
  | { kind: "none" }
  /** Usuário e senha fixos (coturn com senha, ExpressTURN, Metered...). */
  | { kind: "manual"; urls: string; username: string; credential: string }
  /** Cloudflare Realtime TURN: o app pede uma credencial temporária à API. */
  | { kind: "cloudflare"; keyId: string; token: string }
  /** coturn com `use-auth-secret`: a credencial temporária é calculada aqui. */
  | { kind: "coturn"; urls: string; secret: string };

export type TurnKind = TurnConfig["kind"];

export const TURN_KINDS: TurnKind[] = ["none", "manual", "cloudflare", "coturn"];

/** Por quanto tempo vale a credencial temporária (Cloudflare e coturn). */
export const TURN_TTL_SECONDS = 24 * 60 * 60;

/** Um tipo de TURN: transforma a configuração nos `iceServers` da sala. */
type TurnProvider<C extends TurnConfig> = {
  /** Nome para os logs. */
  label: string;
  /** Falta algum campo? */
  isComplete: (config: C) => boolean;
  resolve: (config: C) => Promise<RTCIceServer[]>;
};

/** "turn:a.com:3478, turns:a.com:443" (vírgula, espaço ou linha) -> lista. */
export function parseUrls(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((u) => u.trim())
    .filter((u) => /^(turns?|stun):/i.test(u));
}

const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** Credencial temporária do coturn (`use-auth-secret`, a "TURN REST API"). */
export async function coturnCredential(secret: string, nowSeconds: number, ttl = TURN_TTL_SECONDS) {
  const username = `${Math.floor(nowSeconds) + ttl}:abretela`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const credential = base64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)));
  return { username, credential };
}

const PROVIDERS: { [K in TurnKind]: TurnProvider<Extract<TurnConfig, { kind: K }>> } = {
  none: {
    label: "none",
    isComplete: () => true,
    resolve: async () => [],
  },
  manual: {
    label: "manual",
    isComplete: (c) => parseUrls(c.urls).length > 0 && !!c.username.trim() && !!c.credential,
    resolve: async (c) => [{ urls: parseUrls(c.urls), username: c.username.trim(), credential: c.credential }],
  },
  cloudflare: {
    label: "Cloudflare",
    isComplete: (c) => !!c.keyId.trim() && !!c.token.trim(),
    resolve: async (c) => {
      const servers = await invoke<unknown>("turn_cloudflare", {
        keyId: c.keyId.trim(),
        token: c.token.trim(),
        ttl: TURN_TTL_SECONDS,
      });
      // a Cloudflare também lista endereços na porta 53, que os navegadores
      // bloqueiam (só atrasam a busca de rotas)
      return cleanIceServers(servers)
        .map((s) => ({ ...s, urls: toList(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
        .filter((s) => s.urls.length > 0);
    },
  },
  coturn: {
    label: "coturn",
    isComplete: (c) => parseUrls(c.urls).length > 0 && !!c.secret,
    resolve: async (c) => {
      const { username, credential } = await coturnCredential(c.secret, Date.now() / 1000);
      return [{ urls: parseUrls(c.urls), username, credential }];
    },
  },
};

export const turnLabel = (kind: TurnKind) => PROVIDERS[kind].label;

export function isTurnComplete(config: TurnConfig): boolean {
  const provider = PROVIDERS[config.kind] as TurnProvider<TurnConfig>;
  return provider.isComplete(config);
}

const toList = (urls: string | string[] | undefined) => (Array.isArray(urls) ? urls : urls ? [urls] : []);

/**
 * Os `iceServers` para a sala que vou criar. Nunca falha: sem TURN, com
 * campos faltando ou se der erro, a sala sai só com conexão direta (e o log diz).
 */
export async function turnServersForRoom(config: TurnConfig): Promise<RTCIceServer[]> {
  if (config.kind === "none") return [];
  const provider = PROVIDERS[config.kind] as TurnProvider<TurnConfig>;
  if (!provider.isComplete(config)) {
    log.warn("room", `The relay server (TURN, ${provider.label}) is missing some fields; the room will use direct connections only`);
    return [];
  }
  try {
    const servers = await provider.resolve(config);
    const urls = servers.flatMap((s) => toList(s.urls));
    log.info("room", `Relay server (TURN, ${provider.label}) for this room: ${describeUrls(urls)}`);
    return servers;
  } catch (e) {
    log.warn(
      "room",
      `Could not get the relay server (TURN, ${provider.label}) ready: ${describeError(e)}. The room will use direct connections only`,
    );
    return [];
  }
}

/** Ex.: "turn:a.com:3478 and 2 more" (sem usuário nem senha). */
export function describeUrls(urls: string[]): string {
  if (!urls.length) return "none";
  return urls.length === 1 ? urls[0] : `${urls[0]} and ${urls.length - 1} more`;
}

const MAX_SERVERS = 8;
const MAX_URLS = 12;

/**
 * Confere os `iceServers` que vieram da sala (ou da API): só fica o que tem
 * endereço stun:/turn:/turns: e, no TURN, usuário e senha em texto. Um item
 * inválido faria o `RTCPeerConnection` recusar a configuração inteira.
 */
export function cleanIceServers(value: unknown): RTCIceServer[] {
  if (value && !Array.isArray(value) && typeof value === "object") value = [value]; // formato antigo da Cloudflare
  if (!Array.isArray(value)) return [];
  const out: RTCIceServer[] = [];
  for (const item of value.slice(0, MAX_SERVERS)) {
    if (!item || typeof item !== "object") continue;
    const { urls, username, credential } = item as Record<string, unknown>;
    const list = (Array.isArray(urls) ? urls : [urls])
      .filter((u): u is string => typeof u === "string" && /^(turns?|stun):\S+$/i.test(u))
      .slice(0, MAX_URLS);
    if (!list.length) continue;
    const needsAuth = list.some((u) => /^turns?:/i.test(u));
    if (needsAuth) {
      if (typeof username !== "string" || typeof credential !== "string") continue;
      out.push({ urls: list, username, credential });
    } else {
      out.push({ urls: list });
    }
  }
  return out;
}

/** Endereços TURN numa lista de `iceServers` (para os logs). */
export const relayUrls = (servers: RTCIceServer[]) =>
  servers.flatMap((s) => toList(s.urls)).filter((u) => /^turns?:/i.test(u));
