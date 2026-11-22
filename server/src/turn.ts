// TURN da Cloudflare por pessoa: a chave fica nos segredos do Worker
// (`TURN_KEY_ID`, `TURN_KEY_TOKEN`) e cada pessoa que entra recebe uma
// credencial só dela, revogada quando ela sai ou é kikada.

const API = "https://rtc.live.cloudflare.com/v1/turn/keys";

export type IceServer = { urls: string[]; username?: string; credential?: string };

export type TurnGrant = { iceServers: IceServer[]; username: string };

/** O que a sala precisa do TURN (nos testes, um falso). */
export interface TurnApi {
  generate(ttlSeconds: number): Promise<TurnGrant>;
  revoke(username: string): Promise<void>;
}

const URL_OK = /^(turns?|stun):\S+$/i;
// a Cloudflare também lista endereços na porta 53, que os navegadores bloqueiam
const PORT_53 = /:53(\?|$)/;
const USERNAME_OK = /^[A-Za-z0-9]{1,256}$/;

/** Fica só o que o `RTCPeerConnection` aceita; acha o usuário da credencial. */
export function cleanGrant(body: unknown): TurnGrant {
  const raw = (body as { iceServers?: unknown })?.iceServers;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const iceServers: IceServer[] = [];
  let username = "";
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
      (u): u is string => typeof u === "string" && URL_OK.test(u) && !PORT_53.test(u),
    );
    if (!urls.length) continue;
    if (urls.some((u) => /^turns?:/i.test(u))) {
      if (typeof s.username !== "string" || typeof s.credential !== "string") continue;
      iceServers.push({ urls, username: s.username, credential: s.credential });
      username ||= s.username;
    } else {
      iceServers.push({ urls });
    }
  }
  if (!USERNAME_OK.test(username)) throw new Error("Cloudflare's answer has no usable TURN credential");
  return { iceServers, username };
}

export class CloudflareTurn implements TurnApi {
  constructor(
    private keyId: string,
    private token: string,
  ) {}

  async generate(ttlSeconds: number): Promise<TurnGrant> {
    const res = await fetch(`${API}/${this.keyId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: ttlSeconds }),
    });
    if (!res.ok) throw new Error(`Cloudflare answered HTTP ${res.status} when creating a TURN credential`);
    return cleanGrant(await res.json());
  }

  async revoke(username: string): Promise<void> {
    if (!USERNAME_OK.test(username)) return;
    const res = await fetch(`${API}/${this.keyId}/credentials/${username}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    // 404: já venceu ou já foi revogada
    if (!res.ok && res.status !== 404) {
      throw new Error(`Cloudflare answered HTTP ${res.status} when revoking a TURN credential`);
    }
  }
}
