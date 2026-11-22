// A sala do servidor próprio com WebSockets, banco, relógio e TURN falsos.

import { beforeEach, describe, expect, it } from "vitest";
import { RoomCore, validSettings, type Conn, type RoomHost } from "./core";
import { sha256 } from "./crypto";
import { CLOSE, STALE_MS, SWEEP_MS, TURN_REVOKE_GRACE_MS, type ConnState } from "./protocol";
import type { TurnApi } from "./turn";

const ADMIN_KEY = "chave-do-dono-0123456789abcdef";

class FakeConn implements Conn {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Desde quando parou de responder o ping (`null`: responde sempre). */
  silentSince: number | null = null;
  constructor(
    private st: ConnState,
    private clock: { now: number },
  ) {}
  lastPing() {
    return this.silentSince ?? this.clock.now;
  }
  send(text: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  state() {
    return structuredClone(this.st);
  }
  setState(s: ConnState) {
    this.st = structuredClone(s);
  }
  /** Última mensagem de um tipo. */
  last(type: string) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

class FakeTurn implements TurnApi {
  n = 0;
  revoked: string[] = [];
  fail = false;
  async generate(ttl: number) {
    if (this.fail) throw new Error("Cloudflare caiu");
    this.n++;
    return {
      username: `user${this.n}`,
      iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: `user${this.n}`, credential: `p${this.n}:${ttl}` }],
    };
  }
  async revoke(username: string) {
    this.revoked.push(username);
  }
}

function setup(withTurn = false) {
  const conns: FakeConn[] = [];
  const store = new Map<string, unknown>();
  const clock = { now: 1_800_000_000_000 };
  const alarms: (number | null)[] = [];
  const turn = withTurn ? new FakeTurn() : null;
  const logs: string[] = [];
  const host: RoomHost = {
    conns: () => conns.filter((c) => !c.closed),
    load: async (k) => structuredClone(store.get(k)) as never,
    save: async (k, v) => void store.set(k, structuredClone(v)),
    now: () => clock.now,
    sleep: async () => {},
    setAlarm: async (at) => void alarms.push(at),
    turn,
    adminKeyHash: null,
    log: (_l, t) => void logs.push(t),
  };
  const ready = sha256(ADMIN_KEY).then((h) => (host.adminKeyHash = h));
  let core = new RoomCore(host);
  const open = (ip = "203.0.113.1") => {
    const c = new FakeConn({ ip }, clock);
    conns.push(c);
    return c;
  };
  const say = (c: FakeConn, msg: unknown) => core.message(c, JSON.stringify(msg));
  const admin = (method: string, path: string, body: unknown = null, key = ADMIN_KEY) =>
    core.http(method, path, `Bearer ${key}`, body);
  /** Entra com a senha "1234" (o dono configura antes, se ainda não configurou). */
  const join = async (name: string, ip?: string) => {
    if (!store.has("config")) await admin("POST", "/api/admin/room", { password: "1234" });
    const c = open(ip);
    await say(c, { type: "join", name, password: "1234" });
    return c;
  };
  const leave = async (c: FakeConn) => {
    c.closed = { code: 1000, reason: "bye" };
    await core.closed(c);
  };
  /** Simula a hibernação: um objeto novo, com os mesmos WebSockets e banco. */
  const wake = () => (core = new RoomCore(host));
  return { host, conns, store, clock, alarms, turn, logs, ready, open, say, admin, join, leave, wake, core: () => core };
}

let room: ReturnType<typeof setup>;

beforeEach(async () => {
  room = setup();
  await room.ready;
});

describe("entrar", () => {
  it("com a senha certa: welcome com quem já estava, e os outros ficam sabendo", async () => {
    const ana = await room.join("Ana");
    expect(ana.last("welcome")).toMatchObject({ id: "1", peers: [], owner: false, room: { name: "AbreTela" } });
    const bia = await room.join("  Bia  ");
    expect(bia.last("welcome")).toMatchObject({
      id: "2",
      peers: [{ id: "1", name: "Ana", sharing: false, label: null, owner: false, web: false }],
      settings: { minHeight: 360, maxHeight: 1080, minFps: 15, maxFps: 60 },
    });
    expect(ana.last("peer-joined")).toEqual({
      type: "peer-joined",
      peer: { id: "2", name: "Bia", sharing: false, label: null, owner: false, web: false },
    });
  });

  it("senha errada: erro e desconecta; depois de 5 erradas, nem tenta", async () => {
    await room.admin("POST", "/api/admin/room", { password: "1234" });
    for (let i = 0; i < 5; i++) {
      const c = room.open();
      await room.say(c, { type: "join", name: "X", password: "errada" });
      expect(c.sent).toEqual([{ type: "error", reason: "wrong-password" }]);
      expect(c.closed?.code).toBe(CLOSE.refused);
    }
    const c = room.open();
    await room.say(c, { type: "join", name: "X", password: "1234" });
    expect(c.sent).toEqual([{ type: "error", reason: "too-many-attempts" }]);
    // outro endereço não é afetado; e passado o minuto, volta a poder
    expect((await room.join("Ana", "198.51.100.7")).last("welcome")).toBeTruthy();
    room.clock.now += 61_000;
    expect((await room.join("Ana")).last("welcome")).toBeTruthy();
  });

  it("sem senha configurada, só o dono entra (e não precisa de senha)", async () => {
    const c = room.open();
    await room.say(c, { type: "join", name: "Ana", password: "" });
    expect(c.sent).toEqual([{ type: "error", reason: "not-configured" }]);

    const dono = room.open();
    await room.say(dono, { type: "join", name: "Breno", admin: ADMIN_KEY });
    expect(dono.last("welcome")).toMatchObject({ id: "1", owner: true });

    const falso = room.open("198.51.100.9");
    await room.say(falso, { type: "join", name: "Falso", admin: "chave-errada-0123456789" });
    expect(falso.sent).toEqual([{ type: "error", reason: "wrong-password" }]);
  });

  it("quem entra pelo navegador aparece marcado", async () => {
    const ana = await room.join("Ana");
    await room.say(room.open("198.51.100.4"), { type: "join", name: "Bia", password: "1234", client: "web" });
    expect(ana.last("peer-joined")).toMatchObject({ peer: { name: "Bia", web: true } });
  });

  it("nome vazio vira 'Convidado N' e nome longo é cortado", async () => {
    await room.join("   ");
    const c = await room.join("x".repeat(50));
    expect(c.last("welcome")).toMatchObject({ peers: [{ name: "Convidado 1" }] });
    expect(room.conns[1].state().peer?.name).toBe("x".repeat(32));
  });

  it("mensagens antes de entrar são ignoradas", async () => {
    const c = room.open();
    await room.say(c, { type: "signal", to: "1", data: {} });
    await room.say(c, { type: "sharing", sharing: true });
    expect(c.sent).toEqual([]);
  });
});

describe("na sala", () => {
  it("sinais vão só para quem foi endereçado", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    const caio = await room.join("Caio");
    await room.say(ana, { type: "signal", to: "2", data: { kind: "watch" } });
    expect(bia.last("signal")).toEqual({ type: "signal", from: "1", data: { kind: "watch" } });
    expect(caio.last("signal")).toBeUndefined();
  });

  it("transmitir avisa todos, com o rótulo cortado", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    await room.say(ana, { type: "sharing", sharing: true, label: "1080p 60fps · " + "y".repeat(80) });
    const update = bia.last("peer-updated")!;
    expect(update).toMatchObject({ id: "1", sharing: true });
    expect((update.label as string).length).toBe(48);
    expect((await room.admin("GET", "/api/info")).body).toMatchObject({ people: 2, live: 1 });
  });

  it("quem sai é anunciado aos outros", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    await room.leave(bia);
    expect(ana.last("peer-left")).toEqual({ type: "peer-left", id: "2" });
  });

  it("depois de hibernar, a sala continua: mesmas pessoas e ids seguindo", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    room.wake();
    await room.say(bia, { type: "signal", to: "1", data: { kind: "offer" } });
    expect(ana.last("signal")).toMatchObject({ from: "2" });
    const caio = await room.join("Caio");
    expect(caio.last("welcome")).toMatchObject({ id: "3", peers: [{ name: "Ana" }, { name: "Bia" }] });
  });

  it("quem para de responder o ping some da sala (conexão fantasma)", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    bia.silentSince = room.clock.now; // a janela dela recarregou e o fechamento não chegou
    room.clock.now += STALE_MS - 1000;
    await room.core().alarm();
    expect(ana.last("peer-left")).toBeUndefined(); // ainda dentro do prazo

    room.clock.now += 2000;
    await room.core().alarm();
    expect(ana.last("peer-left")).toEqual({ type: "peer-left", id: "2" });
    expect(bia.closed?.code).toBe(CLOSE.timeout);
    // quem entra depois não vê o fantasma
    const caio = await room.join("Caio");
    expect(caio.last("welcome")).toMatchObject({ peers: [{ name: "Ana" }] });
  });

  it("procura fantasmas também quando alguém entra ou o app pede as informações", async () => {
    const ana = await room.join("Ana");
    ana.silentSince = room.clock.now;
    room.clock.now += STALE_MS + 1000;
    expect((await room.admin("GET", "/api/info")).body).toMatchObject({ people: 0 });
  });

  it("responde ao ping (quando a Cloudflare não respondeu sozinha)", async () => {
    const c = room.open();
    await room.say(c, { type: "ping" });
    expect(c.sent).toEqual([{ type: "pong" }]);
  });

  it("mensagem grande demais fecha a conexão", async () => {
    const c = await room.join("Ana");
    await room.core().message(c, "x".repeat(1024 * 1024 + 1));
    expect(c.closed?.code).toBe(1009);
  });
});

describe("dono", () => {
  it("kika pela sala: a pessoa recebe 'kicked', sai, e os outros veem", async () => {
    const dono = room.open();
    await room.admin("POST", "/api/admin/room", { password: "1234" });
    await room.say(dono, { type: "join", name: "Breno", admin: ADMIN_KEY });
    const ana = await room.join("Ana", "198.51.100.1");
    await room.say(dono, { type: "kick", id: "2" });
    expect(ana.last("kicked")).toEqual({ type: "kicked", banned: false });
    expect(ana.closed?.code).toBe(CLOSE.kicked);
    expect(dono.last("peer-left")).toEqual({ type: "peer-left", id: "2" });
    // sem ban, pode voltar
    expect((await room.join("Ana", "198.51.100.1")).last("welcome")).toBeTruthy();
  });

  it("quem não é dono não kika", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    await room.say(ana, { type: "kick", id: "2" });
    expect(bia.closed).toBeNull();
  });

  it("ban pelo app: o mesmo endereço não volta até o ban acabar ou ser tirado", async () => {
    await room.join("Ana", "198.51.100.1");
    const res = await room.admin("POST", "/api/admin/kick", { id: "1", banMinutes: 30 });
    expect(res.status).toBe(200);
    const view = res.body as { bans: { id: string; name: string }[]; people: number };
    expect(view.people).toBe(0);
    expect(view.bans).toMatchObject([{ name: "Ana" }]);
    expect(JSON.stringify(room.store.get("bans"))).not.toContain("198.51.100.1"); // só o hash do endereço

    const volta = await room.join("Ana", "198.51.100.1");
    expect(volta.sent).toEqual([{ type: "error", reason: "banned" }]);

    await room.admin("POST", "/api/admin/unban", { id: view.bans[0].id });
    expect((await room.join("Ana", "198.51.100.1")).last("welcome")).toBeTruthy();

    await room.admin("POST", "/api/admin/kick", { id: "2", banMinutes: 30 });
    room.clock.now += 31 * 60_000;
    expect((await room.join("Ana", "198.51.100.1")).last("welcome")).toBeTruthy();
  });

  it("administração exige a chave certa", async () => {
    expect((await room.admin("GET", "/api/admin/room", null, "chave-errada-0123456789")).status).toBe(401);
    expect((await room.core().http("GET", "/api/admin/room", null, null)).status).toBe(401);
    expect((await room.admin("GET", "/api/admin/room")).status).toBe(200);
    expect((await room.admin("GET", "/api/info", null, "")).status).toBe(200); // público
  });

  it("muda nome, senha, limites e duração do TURN; quem está na sala fica sabendo", async () => {
    const ana = await room.join("Ana");
    const settings = { minHeight: 480, maxHeight: 720, minFps: 30, maxFps: 30 };
    const res = await room.admin("POST", "/api/admin/room", { name: "Sala do Breno", password: "nova", settings, turnLifetime: 15 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Sala do Breno", settings, turnLifetime: 15, configured: true });
    expect(ana.last("room")).toEqual({ type: "room", name: "Sala do Breno" });
    expect(ana.last("settings")).toEqual({ type: "settings", settings });
    expect(JSON.stringify(room.store.get("config"))).not.toContain("nova"); // só o hash

    const velha = room.open("198.51.100.2");
    await room.say(velha, { type: "join", name: "Bia", password: "1234" });
    expect(velha.sent).toEqual([{ type: "error", reason: "wrong-password" }]);
    const nova = room.open("198.51.100.3");
    await room.say(nova, { type: "join", name: "Bia", password: " nova " });
    expect(nova.last("welcome")).toBeTruthy();
  });

  it("recusa configurações inválidas", async () => {
    const bad = [
      { name: "  " },
      { password: "" },
      { settings: { minHeight: 1080, maxHeight: 720, minFps: 15, maxFps: 60 } },
      { turnLifetime: 7 },
    ];
    for (const b of bad) expect((await room.admin("POST", "/api/admin/room", b)).status).toBe(400);
    expect(validSettings({ minHeight: 360, maxHeight: 1080, minFps: 15, maxFps: 60.5 })).toBeNull();
  });
});

describe("TURN por pessoa", () => {
  beforeEach(async () => {
    room = setup(true);
    await room.ready;
  });

  it("cada pessoa recebe a própria credencial no welcome", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    expect(ana.last("welcome")).toMatchObject({ iceServers: [{ username: "user1", credential: "p1:3600" }] });
    expect(bia.last("welcome")).toMatchObject({ iceServers: [{ username: "user2" }] });
    // com gente na sala, o alarme volta a cada minuto (procura conexões mortas)
    expect(room.alarms.at(-1)).toBe(room.clock.now + SWEEP_MS);
  });

  it("renova antes de vencer, manda a nova só para a pessoa e revoga a velha depois", async () => {
    const ana = await room.join("Ana");
    const bia = await room.join("Bia");
    room.clock.now += 55 * 60_000;
    await room.core().alarm();
    expect(ana.last("ice-servers")).toMatchObject({ iceServers: [{ username: "user3" }] });
    expect(bia.last("ice-servers")).toMatchObject({ iceServers: [{ username: "user4" }] });
    expect(room.turn!.revoked).toEqual([]); // ainda no prazo de troca

    room.clock.now += TURN_REVOKE_GRACE_MS;
    await room.core().alarm();
    expect(room.turn!.revoked).toEqual(["user1", "user2"]);
  });

  it("revoga quando a pessoa sai ou é kikada", async () => {
    const ana = await room.join("Ana");
    await room.join("Bia");
    await room.leave(ana);
    expect(room.turn!.revoked).toEqual(["user1"]);
    await room.admin("POST", "/api/admin/kick", { id: "2" });
    expect(room.turn!.revoked).toEqual(["user1", "user2"]);
    expect(room.alarms.at(-1)).toBeNull(); // ninguém mais: sem alarme
  });

  it("se a Cloudflare falhar: entra sem TURN; na renovação, tenta de novo em 1 minuto", async () => {
    room.turn!.fail = true;
    const ana = await room.join("Ana");
    expect(ana.last("welcome")).toBeTruthy();
    expect(ana.last("welcome")!.iceServers).toBeUndefined();

    room.turn!.fail = false;
    const bia = await room.join("Bia");
    room.turn!.fail = true;
    room.clock.now += 55 * 60_000;
    await room.core().alarm();
    expect(bia.last("ice-servers")).toBeUndefined();
    room.turn!.fail = false;
    room.clock.now += 60_000;
    await room.core().alarm();
    expect(bia.last("ice-servers")).toMatchObject({ iceServers: [{ username: "user2" }] });
  });

  it("a duração escolhida pelo dono vale para quem entra depois", async () => {
    await room.admin("POST", "/api/admin/room", { password: "1234", turnLifetime: 15 });
    const ana = await room.join("Ana");
    expect(ana.last("welcome")).toMatchObject({ iceServers: [{ credential: "p1:900" }] });
  });
});
