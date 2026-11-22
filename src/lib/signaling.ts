// Conexão com o servidor da sala (WebSocket): entrar com nome e senha, tentar
// de novo enquanto o túnel ainda não responde e trocar mensagens. Não sabe
// nada de vídeo; quem decide o que fazer com cada mensagem é o `room.ts`.

import { describeError, log } from "./log";
import type { RoomSettings } from "./quality";
import type { ThumbSignal } from "./thumbs";
import type { TransportSignal } from "./transport/types";

/** `owner`: dono do servidor próprio (o túnel não manda). */
export type PeerInfo = { id: string; name: string; sharing: boolean; label?: string | null; owner?: boolean };

/** O que uma pessoa manda para outra pela sala. */
export type SignalData = TransportSignal | ThumbSignal;

export type ServerMsg =
  /**
   * `iceServers`: o TURN do anfitrião (salas de versões antigas não mandam).
   * `version`, `room` e `owner`: só o servidor próprio manda (ROADMAP, seção 6).
   */
  | {
      type: "welcome";
      id: string;
      peers: PeerInfo[];
      settings: RoomSettings;
      iceServers?: unknown;
      version?: number;
      room?: { name?: string };
      owner?: boolean;
    }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; id: string }
  | { type: "peer-updated"; id: string; sharing: boolean; label?: string | null }
  /** O anfitrião renovou a senha do TURN. */
  | { type: "ice-servers"; iceServers?: unknown }
  | { type: "signal"; from: string; data: SignalData }
  /** Servidor próprio: o dono mudou o nome ou os limites; ou me tirou da sala. */
  | { type: "room"; name: string }
  | { type: "settings"; settings: RoomSettings }
  | { type: "kicked"; banned?: boolean };

type ClientMsg =
  | { type: "join"; name: string; password: string; admin?: string }
  | { type: "ping" }
  /** Só o dono do servidor próprio; os outros servidores ignoram. */
  | { type: "kick"; id: string; banMinutes: number }
  | { type: "sharing"; sharing: boolean; label?: string }
  | { type: "signal"; to: string; data: SignalData };

export class WrongPasswordError extends Error {
  constructor() {
    super("Senha incorreta.");
  }
}

/** Por que o servidor próprio recusou a entrada (tentar de novo não adianta). */
export type RefusedReason = "banned" | "not-configured" | "too-many-attempts" | "room-full";
const REFUSED: string[] = ["banned", "not-configured", "too-many-attempts", "room-full"];

export class RoomRefusedError extends Error {
  constructor(public reason: RefusedReason) {
    super(`refused: ${reason}`);
  }
}

/**
 * De quanto em quanto tempo mando um `ping`. O servidor próprio não pinga
 * (dormiria acordado): quem mantém a conexão viva é o app, e a Cloudflare
 * responde sem acordar a sala. O servidor do túnel ignora a mensagem.
 */
export const PING_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Signaling {
  /** Cada mensagem do servidor (o "welcome" chega antes de `connect` terminar). */
  onMessage: (msg: ServerMsg) => void = () => {};
  /** A conexão caiu depois de já ter entrado na sala. */
  onClosed: () => void = () => {};

  private ws: WebSocket | null = null;
  private joined = false;
  private disposed = false;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(
    private url: string,
    private name: string,
    private password: string,
    /** Chave de administrador: entra como dono do servidor próprio, sem senha. */
    private admin?: string,
  ) {}

  /** Tenta conectar por até ~45s (o DNS de túneis novos pode demorar). */
  async connect(onAttempt?: (n: number) => void): Promise<void> {
    const deadline = Date.now() + 45_000;
    const where = this.url.startsWith("ws://127.0.0.1") ? "my own room" : this.url;
    log.info("room", `Joining ${where} as "${this.name}"`);
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      if (this.disposed) throw new Error("cancelado");
      onAttempt?.(attempt);
      try {
        await this.open();
        return;
      } catch (e) {
        if (e instanceof WrongPasswordError) {
          log.warn("room", "Wrong room password");
          throw e;
        }
        if (e instanceof RoomRefusedError) {
          log.warn("room", `The room refused to let me in (${e.reason})`);
          throw e;
        }
        if (attempt === 1 || attempt % 5 === 0) {
          log.info("room", `Could not reach the room yet (attempt ${attempt}), trying again`);
        }
        await sleep(2000);
      }
    }
    log.error("room", "Gave up joining the room after 45s");
    throw new Error("connect-failed");
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let refusal: Error | null = null;
      ws.onopen = () => {
        this.ws = ws;
        this.send({
          type: "join",
          name: this.name,
          password: this.password,
          ...(this.admin ? { admin: this.admin } : {}),
        });
      };
      ws.onmessage = (ev) => {
        let msg: ServerMsg | { type: "error"; reason: string };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          log.warn("room", "Got an unreadable message from the room server");
          return;
        }
        if (msg.type === "error") {
          if (msg.reason === "wrong-password") refusal = new WrongPasswordError();
          else if (REFUSED.includes(msg.reason)) refusal = new RoomRefusedError(msg.reason as RefusedReason);
          return;
        }
        if ((msg as { type: string }).type === "pong") return;
        if (msg.type === "welcome") {
          this.joined = true;
          this.ping = setInterval(() => this.send({ type: "ping" }), PING_MS);
        }
        try {
          this.onMessage(msg);
        } catch (e) {
          log.error("room", `Something broke while handling "${msg.type}": ${describeError(e)}`);
        }
        if (msg.type === "welcome") resolve();
      };
      ws.onclose = () => {
        this.stopPing();
        if (!this.joined) reject(refusal ?? new Error("fechado"));
        else this.onClosed();
      };
    });
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  signal(to: string, data: SignalData) {
    this.send({ type: "signal", to, data });
  }

  private stopPing() {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }

  /** Sai de vez: fecha a conexão e cancela as tentativas em andamento. */
  close() {
    this.disposed = true;
    this.stopPing();
    this.ws?.close();
  }
}
