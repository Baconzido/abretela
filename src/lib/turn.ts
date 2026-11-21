// Servidor TURN do anfitrião (ROADMAP, seção 4.4): repassa o vídeo quando os
// dois PCs não conseguem se conectar direto. Não há TURN fixo do app: quem
// cria a sala configura o próprio, e os espectadores recebem os `iceServers`
// pela sala. Cada tipo de TURN é um provedor atrás do mesmo contrato; o
// segredo (token, segredo do coturn) nunca sai do PC do anfitrião.
//
// Na Cloudflare e no coturn a senha da sala é temporária (o anfitrião escolhe
// quanto dura). `TurnRenewal` gera outra antes de ela vencer e a sala manda a
// nova para todos; na Cloudflare a antiga é revogada logo depois (no Rust).

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

/** Quanto pode durar a senha temporária (minutos), para escolher nas Configurações. */
export const TURN_LIFETIMES = [15, 30, 60, 120, 360, 1440];
export const DEFAULT_TURN_LIFETIME = 60;

/** Minutos salvos -> um dos valores da lista (o padrão se for outra coisa). */
export function turnLifetime(minutes: unknown): number {
  return TURN_LIFETIMES.includes(minutes as number) ? (minutes as number) : DEFAULT_TURN_LIFETIME;
}

/** Tipos cuja senha é temporária (e por isso é renovada durante a sala). */
export const renewsPassword = (kind: TurnKind) => kind === "cloudflare" || kind === "coturn";

/** Um tipo de TURN: transforma a configuração nos `iceServers` da sala. */
type TurnProvider<C extends TurnConfig> = {
  /** Nome para os logs. */
  label: string;
  /** Falta algum campo? */
  isComplete: (config: C) => boolean;
  /** `ttl`: quanto a senha deve durar, em segundos (só nos tipos temporários). */
  resolve: (config: C, ttl: number) => Promise<RTCIceServer[]>;
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
export async function coturnCredential(secret: string, nowSeconds: number, ttl: number) {
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
    resolve: async (c, ttl) => {
      const servers = await invoke<unknown>("turn_cloudflare", {
        keyId: c.keyId.trim(),
        token: c.token.trim(),
        ttl,
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
    resolve: async (c, ttl) => {
      const { username, credential } = await coturnCredential(c.secret, Date.now() / 1000, ttl);
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
 * `lifetime`: quanto dura a senha temporária, em minutos.
 */
export async function turnServersForRoom(config: TurnConfig, lifetime: number): Promise<RTCIceServer[]> {
  if (config.kind === "none") return [];
  const provider = PROVIDERS[config.kind] as TurnProvider<TurnConfig>;
  if (!provider.isComplete(config)) {
    log.warn("room", `The relay server (TURN, ${provider.label}) is missing some fields; the room will use direct connections only`);
    return [];
  }
  try {
    const servers = await provider.resolve(config, lifetime * 60);
    const urls = servers.flatMap((s) => toList(s.urls));
    const expiry = renewsPassword(config.kind) ? ` (password renewed every ${describeMinutes(lifetime)})` : "";
    log.info("room", `Relay server (TURN, ${provider.label}) for this room: ${describeUrls(urls)}${expiry}`);
    return servers;
  } catch (e) {
    log.warn(
      "room",
      `Could not get the relay server (TURN, ${provider.label}) ready: ${describeError(e)}. The room will use direct connections only`,
    );
    return [];
  }
}

/** 90 -> "1 h 30 min" (para os logs). */
export function describeMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ") || "0 min";
}

/**
 * Quando gerar a senha nova, em ms depois da anterior: uns minutos antes de
 * ela vencer, para dar tempo de todos trocarem de rota (e de revogar a antiga).
 */
export function renewDelay(lifetime: number): number {
  const margin = Math.min(5, lifetime / 4);
  return (lifetime - margin) * 60_000;
}

/** Se a Cloudflare ou a rede falharem, tenta de novo depois deste tempo. */
const RETRY_MS = 60_000;

/**
 * Renova a senha temporária do TURN enquanto a sala estiver aberta (só o
 * anfitrião). `push` manda os servidores novos para a sala.
 */
export class TurnRenewal {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Quando a senha que a sala usa agora vence (ms). */
  private expiresAt: number;

  constructor(
    private config: TurnConfig,
    private lifetime: number,
    private push: (servers: RTCIceServer[]) => Promise<void>,
    now = Date.now(),
  ) {
    this.expiresAt = now + lifetime * 60_000;
  }

  /** Começa a contar (só nos tipos com senha temporária). */
  start() {
    if (!renewsPassword(this.config.kind) || !isTurnComplete(this.config)) return;
    this.schedule(renewDelay(this.lifetime));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.renew(), ms);
  }

  private async renew() {
    const provider = PROVIDERS[this.config.kind] as TurnProvider<TurnConfig>;
    try {
      const servers = await provider.resolve(this.config, this.lifetime * 60);
      if (this.stopped) return;
      if (!servers.length) throw new Error("no relay servers came back");
      await this.push(servers);
      this.expiresAt = Date.now() + this.lifetime * 60_000;
      this.schedule(renewDelay(this.lifetime));
    } catch (e) {
      if (this.stopped) return;
      const left = this.expiresAt - Date.now();
      log.warn(
        "room",
        `Could not renew the relay server (TURN, ${provider.label}) password: ${describeError(e)}. ` +
          (left > 0
            ? `The current one still works for ${describeMinutes(Math.ceil(left / 60_000))}; trying again in 1 minute`
            : "The current one has expired; trying again in 1 minute"),
      );
      this.schedule(RETRY_MS);
    }
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
