// Teste manual do servidor rodando de verdade (wrangler dev ou publicado):
//   npx wrangler dev -c server/wrangler.jsonc --port 8787
//   node server/scripts/smoke.mjs http://127.0.0.1:8787 <chave-de-administrador>
// Configura a senha, entra com duas pessoas, troca sinais, kika e confere o ping.

const [base = "http://127.0.0.1:8787", adminKey] = process.argv.slice(2);
if (!adminKey) throw new Error("uso: node smoke.mjs <url> <chave-de-administrador>");
const wsUrl = base.replace(/^http/, "ws") + "/ws";

const api = async (method, path, body, key = adminKey) => {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

/** Abre um WebSocket e devolve funções para mandar e esperar mensagens. */
function client() {
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];
  let closed = null;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  };
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  const opened = new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  return {
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (type, ms = 5000) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`não chegou "${type}" em ${ms} ms`)), ms);
      });
    },
    closed: () => closed,
    close: () => ws.close(),
  };
}

const ok = (cond, what) => {
  if (!cond) throw new Error(`FALHOU: ${what}`);
  console.log(`ok - ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ok((await api("GET", "/api/admin/room", null, "chave-errada-0123456789")).status === 401, "admin com chave errada: 401");
const conf = await api("POST", "/api/admin/room", { name: "Sala de teste", password: "1234" });
ok(conf.status === 200 && conf.body.configured, "dono configura nome e senha");

const errada = client();
await errada.opened;
errada.send({ type: "join", name: "Intruso", password: "0000" });
ok((await errada.next("error")).reason === "wrong-password", "senha errada: recusado");

const ana = client();
await ana.opened;
ana.send({ type: "join", name: "Ana", password: "1234" });
const w1 = await ana.next("welcome");
ok(w1.peers.length === 0 && w1.room.name === "Sala de teste", "Ana entra");

const dono = client();
await dono.opened;
dono.send({ type: "join", name: "Breno", admin: adminKey });
const w2 = await dono.next("welcome");
ok(w2.owner === true && w2.peers[0].name === "Ana", "dono entra sem senha e vê a Ana");
ok((await ana.next("peer-joined")).peer.owner === true, "Ana vê o dono entrar");

ana.send({ type: "signal", to: w2.id, data: { kind: "watch" } });
ok((await dono.next("signal")).from === w1.id, "sinal chega só a quem foi endereçado");

ana.send({ type: "sharing", sharing: true, label: "1080p 60fps · Jogo" });
ok((await dono.next("peer-updated")).sharing === true, "transmitir é anunciado");
ok((await api("GET", "/api/info", null, "")).body.live === 1, "/api/info mostra 1 ao vivo");

ana.send({ type: "ping" });
ok((await ana.next("pong")).type === "pong", "ping respondido");

// deixa a sala hibernar e confere que tudo continua
await sleep(12_000);
ana.send({ type: "signal", to: w2.id, data: { kind: "depois-de-dormir" } });
ok((await dono.next("signal")).data.kind === "depois-de-dormir", "depois de 12 s parada, a sala continua");

dono.send({ type: "kick", id: w1.id, banMinutes: 1 });
ok((await ana.next("kicked")).banned === true, "Ana é kikada com ban");
ok((await dono.next("peer-left")).id === w1.id, "dono vê a Ana sair");
await sleep(300);
ok(ana.closed()?.code === 4001, "conexão da Ana fechada com o código de kick");

const volta = client();
await volta.opened;
volta.send({ type: "join", name: "Ana", password: "1234" });
ok((await volta.next("error")).reason === "banned", "banida não volta");
const bans = (await api("GET", "/api/admin/room")).body.bans;
ok(bans.length === 1, "o ban aparece para o dono");
await api("POST", "/api/admin/unban", { id: bans[0].id });

dono.close();
console.log("tudo certo");
process.exit(0);
