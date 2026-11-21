import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanIceServers,
  coturnCredential,
  describeMinutes,
  describeUrls,
  isTurnComplete,
  parseUrls,
  relayUrls,
  renewDelay,
  turnLifetime,
  TurnRenewal,
} from "./turn";

vi.mock("./log", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  describeError: (e: unknown) => String(e),
}));

describe("parseUrls", () => {
  it("aceita vírgula, espaço e linha e ignora o que não é stun/turn", () => {
    expect(parseUrls("turn:a.com:3478, turns:a.com:443?transport=tcp\nhttp://x  stun:b.com")).toEqual([
      "turn:a.com:3478",
      "turns:a.com:443?transport=tcp",
      "stun:b.com",
    ]);
  });
});

describe("coturnCredential", () => {
  it("segue a TURN REST API do coturn (HMAC-SHA1 em base64)", async () => {
    const c = await coturnCredential("segredo", 1_700_000_000, 3600);
    expect(c.username).toBe("1700003600:abretela");
    // openssl: printf '1700003600:abretela' | openssl dgst -sha1 -hmac segredo -binary | base64
    expect(c.credential).toBe("RbebssW+Kviqku2a1ep6NT6+ok8=");
  });
});

describe("isTurnComplete", () => {
  it("pede todos os campos de cada tipo", () => {
    expect(isTurnComplete({ kind: "none" })).toBe(true);
    expect(isTurnComplete({ kind: "manual", urls: "turn:a.com", username: "u", credential: "" })).toBe(false);
    expect(isTurnComplete({ kind: "manual", urls: "a.com", username: "u", credential: "p" })).toBe(false);
    expect(isTurnComplete({ kind: "manual", urls: "turn:a.com", username: "u", credential: "p" })).toBe(true);
    expect(isTurnComplete({ kind: "cloudflare", keyId: "k", token: " " })).toBe(false);
    expect(isTurnComplete({ kind: "coturn", urls: "turn:a.com", secret: "s" })).toBe(true);
  });
});

describe("cleanIceServers", () => {
  it("mantém só servidores válidos", () => {
    expect(
      cleanIceServers([
        { urls: "stun:s.com" },
        { urls: ["turn:t.com:3478", "javascript:x"], username: "u", credential: "p" },
        { urls: ["turn:sem-senha.com"] },
        { urls: 42 },
        null,
        "lixo",
      ]),
    ).toEqual([{ urls: ["stun:s.com"] }, { urls: ["turn:t.com:3478"], username: "u", credential: "p" }]);
  });

  it("aceita o formato antigo da Cloudflare (um objeto só) e recusa o resto", () => {
    expect(cleanIceServers({ urls: ["turn:c.com"], username: "u", credential: "p" })).toHaveLength(1);
    expect(cleanIceServers(undefined)).toEqual([]);
    expect(cleanIceServers("turn:x")).toEqual([]);
  });

  it("lista os endereços de repasse sem mostrar senha", () => {
    const servers = cleanIceServers([
      { urls: "stun:s.com" },
      { urls: ["turn:t.com", "turns:t.com:443"], username: "u", credential: "p" },
    ]);
    expect(describeUrls(relayUrls(servers))).toBe("turn:t.com and 1 more");
  });
});

describe("duração da senha temporária", () => {
  it("só aceita os valores da lista", () => {
    expect(turnLifetime(30)).toBe(30);
    expect(turnLifetime(7)).toBe(60);
    expect(turnLifetime("60")).toBe(60);
    expect(turnLifetime(undefined)).toBe(60);
  });

  it("renova uns minutos antes de vencer", () => {
    expect(renewDelay(60)).toBe(55 * 60_000);
    expect(renewDelay(15)).toBe(11.25 * 60_000);
    expect(renewDelay(1440)).toBe(1435 * 60_000);
  });

  it("escreve os minutos para os logs", () => {
    expect(describeMinutes(90)).toBe("1 h 30 min");
    expect(describeMinutes(60)).toBe("1 h");
    expect(describeMinutes(4)).toBe("4 min");
  });
});

describe("TurnRenewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const coturn = { kind: "coturn", urls: "turn:a.com:3478", secret: "s" } as const;

  /** Só o relógio e o setTimeout são falsos: o HMAC do coturn roda de verdade. */
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  /** Espera a renovação terminar (o HMAC não anda com o relógio falso). */
  const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 5 });

  it("manda uma senha nova antes de vencer, de novo e de novo, até parar", async () => {
    fakeClock();
    const pushed: RTCIceServer[][] = [];
    const renewal = new TurnRenewal(coturn, 60, async (s) => void pushed.push(s));
    renewal.start();
    await advance(54 * 60_000);
    expect(pushed).toHaveLength(0);
    await advance(60_000);
    await until(() => expect(pushed).toHaveLength(1));
    expect(pushed[0][0].urls).toEqual(["turn:a.com:3478"]);
    expect(pushed[0][0].username).toMatch(/^\d+:abretela$/);
    await advance(55 * 60_000);
    await until(() => expect(pushed).toHaveLength(2));
    renewal.stop();
    await advance(120 * 60_000);
    expect(pushed).toHaveLength(2);
  });

  it("se a sala recusar, tenta de novo em 1 minuto", async () => {
    fakeClock();
    let calls = 0;
    const renewal = new TurnRenewal(coturn, 15, async () => {
      calls++;
      if (calls === 1) throw new Error("sala fechou");
    });
    renewal.start();
    await advance(renewDelay(15));
    await until(() => expect(calls).toBe(1));
    await advance(60_000);
    await until(() => expect(calls).toBe(2));
    renewal.stop();
  });

  it("senha fixa (manual) não é renovada", async () => {
    fakeClock();
    const push = vi.fn(async () => {});
    new TurnRenewal({ kind: "manual", urls: "turn:a.com", username: "u", credential: "p" }, 15, push).start();
    await advance(60 * 60_000);
    expect(push).not.toHaveBeenCalled();
  });
});
