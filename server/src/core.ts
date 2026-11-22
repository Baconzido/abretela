// A sala do servidor próprio, sem nada da Cloudflare: o Durable Object
// (`room.ts`) só entrega os eventos (mensagem, WebSocket fechado, alarme,
// pedido HTTP) e guarda as coisas. Assim dá para testar tudo no Node.
//
// Nada fica só na memória entre um evento e outro: com a hibernação o objeto
// some quando a sala fica parada. Quem está na sala fica preso a cada WebSocket
// (`ConnState`); configurações, bans e revogações pendentes ficam no banco.

import { checkAdminKey, checkPassword, hashPassword, randomId, sha256 } from "./crypto";
import {
  CLOSE,
  DEFAULT_CONFIG,
  LIMITS,
  renewAt,
  SERVER_VERSION,
  STALE_MS,
  SWEEP_MS,
  TURN_LIFETIMES,
  TURN_RETRY_MS,
  TURN_REVOKE_GRACE_MS,
  type Ban,
  type ConnState,
  type Peer,
  type PeerInfo,
  type RoomConfig,
  type RoomSettings,
} from "./protocol";
import type { TurnApi } from "./turn";

/** Um WebSocket da sala. */
export interface Conn {
  send(text: string): void;
  close(code: number, reason: string): void;
  state(): ConnState;
  setState(state: ConnState): void;
  /** Quando a Cloudflare respondeu o último `ping` desta conexão (ms), se já respondeu. */
  lastPing(): number | null;
}

/** O que a sala precisa de quem a hospeda (o Durable Object, ou um falso nos testes). */
export interface RoomHost {
  conns(): Conn[];
  load<T>(key: string): Promise<T | undefined>;
  save(key: string, value: unknown): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Próximo alarme (`null` cancela). */
  setAlarm(at: number | null): Promise<void>;
  turn: TurnApi | null;
  /** SHA-256 da chave de administrador (segredo do Worker). */
  adminKeyHash: string | null;
  log(level: "info" | "warn", text: string): void;
}

export type HttpResult = { status: number; body: unknown };

type Pending = { username: string; at: number };

const KEY = { config: "config", nextId: "nextId", bans: "bans", revoke: "revoke" } as const;

const info = (p: Peer): PeerInfo => ({ id: p.id, name: p.name, sharing: p.sharing, label: p.label, owner: p.owner });

const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (v: unknown, n: number) => str(v).trim().slice(0, n);

export class RoomCore {
  /** Senhas erradas recentes por endereço (some com a hibernação, e tudo bem). */
  private wrong = new Map<string, number[]>();

  constructor(private host: RoomHost) {}

  // ---------- estado ----------

  async config(): Promise<RoomConfig> {
    const saved = await this.host.load<Partial<RoomConfig>>(KEY.config);
    return { ...DEFAULT_CONFIG, ...saved };
  }

  private peers(): { conn: Conn; peer: Peer }[] {
    const out: { conn: Conn; peer: Peer }[] = [];
    for (const conn of this.host.conns()) {
      const peer = conn.state()?.peer;
      if (peer) out.push({ conn, peer });
    }
    return out;
  }

  private send(conn: Conn, msg: unknown) {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // fechou no meio do caminho
    }
  }

  private broadcast(msg: unknown, exceptId?: string) {
    const text = JSON.stringify(msg);
    for (const { conn, peer } of this.peers()) {
      if (peer.id === exceptId) continue;
      try {
        conn.send(text);
      } catch {
        // fechou no meio do caminho
      }
    }
  }

  private setPeer(conn: Conn, peer: Peer | undefined) {
    try {
      conn.setState({ ip: conn.state().ip, peer });
    } catch {
      // WebSocket já fechado
    }
  }

  private refuse(conn: Conn, reason: string) {
    this.send(conn, { type: "error", reason });
    conn.close(CLOSE.refused, reason);
  }

  private async nextId(): Promise<string> {
    const id = (await this.host.load<number>(KEY.nextId)) ?? 1;
    await this.host.save(KEY.nextId, id + 1);
    return String(id);
  }

  private tooManyWrong(ip: string): boolean {
    const since = this.host.now() - LIMITS.wrongPasswordWindowMs;
    const recent = (this.wrong.get(ip) ?? []).filter((t) => t > since);
    this.wrong.set(ip, recent);
    return recent.length >= LIMITS.maxWrongPasswords;
  }

  private noteWrong(ip: string) {
    this.wrong.set(ip, [...(this.wrong.get(ip) ?? []), this.host.now()]);
  }

  private async activeBans(): Promise<Ban[]> {
    const now = this.host.now();
    return ((await this.host.load<Ban[]>(KEY.bans)) ?? []).filter((b) => b.until > now);
  }

  // ---------- mensagens ----------

  async message(conn: Conn, text: string) {
    if (text.length > LIMITS.maxMessageBytes) {
      conn.close(1009, "message too big");
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const me = conn.state()?.peer;
    switch (msg.type) {
      case "join":
        if (!me) await this.join(conn, msg);
        return;
      case "ping":
        // normalmente respondido pela própria Cloudflare, sem acordar a sala
        this.send(conn, { type: "pong" });
        return;
    }
    if (!me) return; // o resto só depois de entrar
    switch (msg.type) {
      case "sharing": {
        const sharing = !!msg.sharing;
        const label = sharing ? clip(msg.label, LIMITS.labelLength) || null : null;
        this.setPeer(conn, { ...me, sharing, label });
        this.broadcast({ type: "peer-updated", id: me.id, sharing, label });
        return;
      }
      case "signal": {
        const target = this.peers().find((p) => p.peer.id === msg.to);
        if (target) this.send(target.conn, { type: "signal", from: me.id, data: msg.data });
        return;
      }
      case "kick":
        if (me.owner) await this.kick(str(msg.id), Number(msg.banMinutes) || 0);
        return;
    }
  }

  /**
   * Tira da sala quem ficou sem `ping` por mais de `STALE_MS`: a conexão caiu
   * sem avisar e a Cloudflare não mandou o fechamento (um "fantasma").
   */
  async sweep() {
    const now = this.host.now();
    for (const { conn, peer } of this.peers()) {
      const seen = Math.max(conn.lastPing() ?? 0, peer.joinedAt);
      if (now - seen <= STALE_MS) continue;
      this.host.log("info", `${peer.name} stopped answering; removing them from the room`);
      await this.leave(conn, peer);
      try {
        conn.close(CLOSE.timeout, "no ping");
      } catch {
        // já fechado
      }
    }
  }

  private async join(conn: Conn, msg: Record<string, unknown>) {
    await this.sweep();
    const { ip } = conn.state();
    const ipHash = await sha256(ip);
    if ((await this.activeBans()).some((b) => b.ipHash === ipHash)) {
      this.refuse(conn, "banned");
      return;
    }
    const config = await this.config();
    const owner = await checkAdminKey(msg.admin, this.host.adminKeyHash);
    if (!owner) {
      if (this.tooManyWrong(ip)) {
        this.refuse(conn, "too-many-attempts");
        return;
      }
      // chave de dono errada conta como senha errada
      if (msg.admin === undefined && !config.password) {
        this.refuse(conn, "not-configured");
        return;
      }
      const password = str(msg.password).trim();
      const right =
        msg.admin === undefined &&
        !!config.password &&
        password.length <= LIMITS.passwordLength &&
        (await checkPassword(password, config.password));
      if (!right) {
        this.noteWrong(ip);
        await this.host.sleep(LIMITS.wrongPasswordDelayMs);
        this.refuse(conn, "wrong-password");
        return;
      }
    }
    if (this.peers().length >= LIMITS.maxPeers) {
      this.refuse(conn, "room-full");
      return;
    }

    const id = await this.nextId();
    const peer: Peer = {
      id,
      name: clip(msg.name, LIMITS.nameLength) || `Convidado ${id}`,
      sharing: false,
      label: null,
      owner,
      joinedAt: this.host.now(),
    };
    let iceServers: unknown;
    if (this.host.turn) {
      try {
        const grant = await this.host.turn.generate(config.turnLifetime * 60);
        peer.turn = { username: grant.username, expiresAt: this.host.now() + config.turnLifetime * 60_000 };
        iceServers = grant.iceServers;
      } catch (e) {
        this.host.log("warn", `No relay server (TURN) for ${peer.name}: ${String(e)}`);
      }
    }

    const others = this.peers().map((p) => info(p.peer));
    this.setPeer(conn, peer);
    this.send(conn, {
      type: "welcome",
      id,
      peers: others,
      settings: config.settings,
      ...(iceServers ? { iceServers } : {}),
      owner,
      room: { name: config.name },
      version: SERVER_VERSION,
    });
    this.broadcast({ type: "peer-joined", peer: info(peer) }, id);
    await this.scheduleAlarm();
  }

  /** O WebSocket fechou (a pessoa saiu ou caiu). */
  async closed(conn: Conn) {
    const peer = conn.state()?.peer;
    if (!peer) return;
    await this.leave(conn, peer);
  }

  private async leave(conn: Conn, peer: Peer) {
    this.setPeer(conn, undefined);
    this.broadcast({ type: "peer-left", id: peer.id }, peer.id);
    if (peer.turn) await this.revoke([peer.turn.username]);
    await this.scheduleAlarm();
  }

  /** Tira alguém da sala; com `banMinutes`, o mesmo endereço não volta por esse tempo. */
  async kick(id: string, banMinutes: number): Promise<boolean> {
    const target = this.peers().find((p) => p.peer.id === id);
    if (!target || target.peer.owner) return false;
    const ban = Math.min(Math.max(0, Math.floor(banMinutes)), 60 * 24 * 365);
    if (ban > 0) {
      const bans = await this.activeBans();
      bans.push({
        id: randomId(),
        name: target.peer.name,
        ipHash: await sha256(target.conn.state().ip),
        until: this.host.now() + ban * 60_000,
      });
      await this.host.save(KEY.bans, bans);
    }
    this.send(target.conn, { type: "kicked", banned: ban > 0 });
    await this.leave(target.conn, target.peer);
    target.conn.close(CLOSE.kicked, "kicked");
    this.host.log("info", `Kicked ${target.peer.name}${ban ? ` (banned for ${ban} min)` : ""}`);
    return true;
  }

  // ---------- TURN ----------

  private async revoke(usernames: string[]) {
    const turn = this.host.turn;
    if (!turn) return;
    for (const username of usernames) {
      try {
        await turn.revoke(username);
      } catch (e) {
        this.host.log("warn", `Could not revoke a relay server (TURN) credential: ${String(e)}`);
      }
    }
  }

  /** Renova as credenciais que vão vencer e revoga as antigas cujo prazo passou. */
  async alarm() {
    await this.sweep();
    const now = this.host.now();
    const turn = this.host.turn;
    const pending = (await this.host.load<Pending[]>(KEY.revoke)) ?? [];
    if (turn) {
      const { turnLifetime } = await this.config();
      for (const { conn, peer } of this.peers()) {
        if (!peer.turn) continue;
        const due = peer.turn.retryAt ?? renewAt(peer.turn.expiresAt, turnLifetime);
        if (due > now) continue;
        try {
          const grant = await turn.generate(turnLifetime * 60);
          pending.push({ username: peer.turn.username, at: now + TURN_REVOKE_GRACE_MS });
          this.setPeer(conn, {
            ...peer,
            turn: { username: grant.username, expiresAt: now + turnLifetime * 60_000 },
          });
          this.send(conn, { type: "ice-servers", iceServers: grant.iceServers });
        } catch (e) {
          this.host.log("warn", `Could not renew the relay server (TURN) credential of ${peer.name}: ${String(e)}`);
          this.setPeer(conn, { ...peer, turn: { ...peer.turn, retryAt: now + TURN_RETRY_MS } });
        }
      }
    }
    const due = pending.filter((p) => p.at <= now);
    const later = pending.filter((p) => p.at > now);
    await this.host.save(KEY.revoke, later);
    await this.revoke(due.map((p) => p.username));
    await this.scheduleAlarm();
  }

  private async scheduleAlarm() {
    const times: number[] = [];
    const pending = (await this.host.load<Pending[]>(KEY.revoke)) ?? [];
    times.push(...pending.map((p) => p.at));
    if (this.host.turn) {
      const { turnLifetime } = await this.config();
      for (const { peer } of this.peers()) {
        if (peer.turn) times.push(peer.turn.retryAt ?? renewAt(peer.turn.expiresAt, turnLifetime));
      }
    }
    // com gente na sala, procura conexões mortas de tempos em tempos
    if (this.peers().length) times.push(this.host.now() + SWEEP_MS);
    await this.host.setAlarm(times.length ? Math.min(...times) : null);
  }

  // ---------- HTTP (informações e administração) ----------

  async http(method: string, path: string, authorization: string | null, body: unknown): Promise<HttpResult> {
    await this.sweep();
    if (method === "GET" && path === "/api/info") return { status: 200, body: await this.publicInfo() };
    if (!path.startsWith("/api/admin/")) return { status: 404, body: { error: "not-found" } };

    const key = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!(await checkAdminKey(key, this.host.adminKeyHash))) {
      await this.host.sleep(LIMITS.wrongPasswordDelayMs);
      return { status: 401, body: { error: "wrong-admin-key" } };
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    switch (`${method} ${path}`) {
      case "GET /api/admin/room":
        return { status: 200, body: await this.adminView() };
      case "POST /api/admin/room":
        return this.configure(b);
      case "POST /api/admin/kick":
        return (await this.kick(str(b.id), Number(b.banMinutes) || 0))
          ? { status: 200, body: await this.adminView() }
          : { status: 404, body: { error: "no-such-person" } };
      case "POST /api/admin/unban": {
        const bans = await this.activeBans();
        const left = bans.filter((ban) => ban.id !== b.id);
        if (left.length === bans.length) return { status: 404, body: { error: "no-such-ban" } };
        await this.host.save(KEY.bans, left);
        return { status: 200, body: await this.adminView() };
      }
    }
    return { status: 404, body: { error: "not-found" } };
  }

  /** O que qualquer um vê (a lista de servidores do app mostra isto). */
  private async publicInfo() {
    const config = await this.config();
    const peers = this.peers().map((p) => p.peer);
    return {
      app: "abretela",
      version: SERVER_VERSION,
      name: config.name,
      people: peers.length,
      live: peers.filter((p) => p.sharing).length,
      configured: !!config.password,
      turn: !!this.host.turn,
    };
  }

  private async adminView() {
    const config = await this.config();
    return {
      ...(await this.publicInfo()),
      settings: config.settings,
      turnLifetime: config.turnLifetime,
      peers: this.peers().map((p) => ({ ...info(p.peer), joinedAt: p.peer.joinedAt })),
      bans: (await this.activeBans()).map(({ id, name, until }) => ({ id, name, until })),
    };
  }

  private async configure(b: Record<string, unknown>): Promise<HttpResult> {
    const config = await this.config();
    const next: RoomConfig = { ...config };
    if (b.name !== undefined) {
      const name = clip(b.name, LIMITS.roomNameLength);
      if (!name) return { status: 400, body: { error: "invalid-name" } };
      next.name = name;
    }
    if (b.password !== undefined) {
      const password = str(b.password).trim();
      if (!password || password.length > LIMITS.passwordLength) return { status: 400, body: { error: "invalid-password" } };
      next.password = await hashPassword(password);
    }
    if (b.settings !== undefined) {
      const settings = validSettings(b.settings);
      if (!settings) return { status: 400, body: { error: "invalid-settings" } };
      next.settings = settings;
    }
    if (b.turnLifetime !== undefined) {
      if (!TURN_LIFETIMES.includes(b.turnLifetime as number)) return { status: 400, body: { error: "invalid-turn-lifetime" } };
      next.turnLifetime = b.turnLifetime as number;
    }
    await this.host.save(KEY.config, next);
    if (next.name !== config.name) this.broadcast({ type: "room", name: next.name });
    if (JSON.stringify(next.settings) !== JSON.stringify(config.settings)) {
      this.broadcast({ type: "settings", settings: next.settings });
    }
    return { status: 200, body: await this.adminView() };
  }
}

/** Limites de qualidade válidos (números inteiros, mínimo até o máximo). */
export function validSettings(value: unknown): RoomSettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const n = (k: string, lo: number, hi: number) => {
    const x = v[k];
    return Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi ? (x as number) : null;
  };
  const s = { minHeight: n("minHeight", 144, 4320), maxHeight: n("maxHeight", 144, 4320), minFps: n("minFps", 1, 240), maxFps: n("maxFps", 1, 240) };
  if (Object.values(s).some((x) => x === null)) return null;
  const r = s as RoomSettings;
  return r.minHeight <= r.maxHeight && r.minFps <= r.maxFps ? r : null;
}
