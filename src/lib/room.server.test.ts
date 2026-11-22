// O RoomClient do app falando com a lógica de verdade do servidor próprio
// (`server/src/core.ts`), por WebSockets falsos: entrar, dono, recusas, kick,
// limites mudando e o ping que mantém a conexão viva.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomClient } from "./room";
import { PING_MS, RoomRefusedError, WrongPasswordError } from "./signaling";
import { installFakeRtc, settle } from "./testing/fakeRtc";
import { RoomCore, type Conn, type RoomHost } from "../../server/src/core";
import { sha256 } from "../../server/src/crypto";
import type { ConnState } from "../../server/src/protocol";
import { serverAdmin } from "./serverAdmin";
import type { OwnedServer } from "./selfhost";

// a chave de administrador vem do Rust (Gerenciador de Credenciais)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "selfhost_admin_key" ? "chave-do-dono-0123456789abcdef" : null),
}));

vi.mock("./log", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  describeError: (e: unknown) => String(e),
  logNetwork: () => {},
}));

const URL = "wss://abretela-teste.exemplo.workers.dev/ws";
const PASSWORD = "senha-da-sala";
const ADMIN_KEY = "chave-do-dono-0123456789abcdef";

let core: RoomCore;
let host: RoomHost;
const sockets: FakeWS[] = [];
/** Endereço da próxima conexão (cada uma ganha um diferente, se não for definido). */
let nextIp: string | null = null;

/** WebSocket falso que entrega as mensagens ao `RoomCore` (e as dele ao app). */
class FakeWS {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  state: ConnState;
  conn: Conn;
  constructor(public url: string) {
    this.state = { ip: nextIp ?? `198.51.100.${sockets.length + 1}` };
    sockets.push(this);
    this.conn = {
      lastPing: () => Date.now(),
      send: (text) => setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: text })),
      close: () => setTimeout(() => this.drop()),
      state: () => structuredClone(this.state),
      setState: (s) => (this.state = structuredClone(s)),
    };
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
    setTimeout(() => core.message(this.conn, text));
  }
  close() {
    this.drop();
  }
  private drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    core.closed(this.conn);
    setTimeout(() => this.onclose?.());
  }
}

beforeEach(async () => {
  installFakeRtc();
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, hidden: false });
  sockets.length = 0;
  nextIp = null;
  const store = new Map<string, unknown>();
  host = {
    conns: () => sockets.filter((s) => s.readyState !== 3).map((s) => s.conn),
    load: async (k) => structuredClone(store.get(k)) as never,
    save: async (k, v) => void store.set(k, structuredClone(v)),
    now: () => Date.now(),
    sleep: async () => {},
    setAlarm: async () => {},
    turn: null,
    adminKeyHash: await sha256(ADMIN_KEY),
    log: () => {},
  };
  core = new RoomCore(host);
  await core.http("POST", "/api/admin/room", `Bearer ${ADMIN_KEY}`, { name: "Sala do Breno", password: PASSWORD });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function join(name: string, password = PASSWORD, admin?: string) {
  const client = new RoomClient(URL, name, password, { admin });
  await client.connect();
  return client;
}

describe("RoomClient no servidor próprio", () => {
  it("entra com a senha e sabe que é um servidor (nome, sem ser dono)", async () => {
    const ana = await join("Ana");
    expect(ana.status).toBe("connected");
    expect(ana.server).toEqual({ name: "Sala do Breno", owner: false, version: 1 });
    ana.leave();
  });

  it("o dono entra pela chave, sem senha", async () => {
    const dono = await join("Breno", "", ADMIN_KEY);
    expect(dono.server?.owner).toBe(true);
    dono.leave();
  });

  it("senha errada vira WrongPasswordError", async () => {
    await expect(join("Intruso", "errada")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("recusa (ban) não fica tentando de novo", async () => {
    const ana = await join("Ana");
    await core.http("POST", "/api/admin/kick", `Bearer ${ADMIN_KEY}`, { id: ana.selfId, banMinutes: 10 });
    await settle();
    // volta do mesmo endereço
    nextIp = sockets[0].state.ip;
    const before = sockets.length;
    const promise = new RoomClient(URL, "Ana", PASSWORD).connect();
    await expect(promise).rejects.toBeInstanceOf(RoomRefusedError);
    await expect(promise).rejects.toMatchObject({ reason: "banned" });
    expect(sockets.length).toBe(before + 1); // uma tentativa só
  });

  it("kikado: fica sabendo, a sala fecha e marca se foi banido", async () => {
    const dono = await join("Breno", "", ADMIN_KEY);
    const ana = await join("Ana");
    await settle();
    ana.kick(dono.selfId); // quem não é dono não consegue
    await settle(10);
    expect(dono.status).toBe("connected");
    dono.kick(ana.selfId, 5);
    await settle(30);
    expect(ana.kicked).toEqual({ banned: true });
    expect(ana.status).toBe("closed");
    expect(dono.peers.has(ana.selfId)).toBe(false);
    dono.leave();
  });

  it("o dono muda os limites e o nome: quem está na sala recebe na hora", async () => {
    const ana = await join("Ana");
    const settings = { minHeight: 480, maxHeight: 720, minFps: 30, maxFps: 30 };
    await core.http("POST", "/api/admin/room", `Bearer ${ADMIN_KEY}`, { name: "Sala nova", settings });
    await settle();
    expect(ana.settings).toEqual(settings);
    expect(ana.server?.name).toBe("Sala nova");
    ana.leave();
  });

  it("depois de entrar, manda ping de tempos em tempos", async () => {
    const every = vi.spyOn(globalThis, "setInterval");
    const ana = await join("Ana");
    const call = every.mock.calls.find(([, ms]) => ms === PING_MS);
    expect(call).toBeTruthy();
    (call![0] as () => void)();
    expect(sockets[0].sent.at(-1)).toEqual({ type: "ping" });
    ana.leave();
  });
});

describe("painel do dono (serverAdmin)", () => {
  const server: OwnedServer = {
    scriptName: "abretela-teste",
    accountId: "acc",
    name: "Sala do Breno",
    url: "https://abretela-teste.exemplo.workers.dev",
    turnKeyId: null,
    turnError: null,
    configured: true,
  };

  beforeEach(() => {
    // o fetch do app chega na mesma lógica do Worker
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const path = new globalThis.URL(url).pathname;
      const auth = (init.headers as Record<string, string>)?.Authorization ?? null;
      const body = init.body ? JSON.parse(String(init.body)) : null;
      const r = await core.http(init.method ?? "GET", path, auth, body);
      return new Response(JSON.stringify(r.body), { status: r.status });
    });
  });

  it("vê quem está, muda a senha, bane e desbane", async () => {
    const ana = await join("Ana");
    let view = await serverAdmin.view(server);
    expect(view.peers.map((p) => p.name)).toEqual(["Ana"]);

    view = await serverAdmin.configure(server, { password: "nova" });
    await expect(join("Bia")).rejects.toBeInstanceOf(WrongPasswordError);

    view = await serverAdmin.kick(server, ana.selfId, 60);
    await settle(10);
    expect(ana.kicked).toEqual({ banned: true });
    expect(view.bans).toHaveLength(1);

    view = await serverAdmin.unban(server, view.bans[0].id);
    expect(view.bans).toHaveLength(0);
  });
});
