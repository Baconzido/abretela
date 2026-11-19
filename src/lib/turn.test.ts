import { describe, expect, it } from "vitest";
import { cleanIceServers, coturnCredential, describeUrls, isTurnComplete, parseUrls, relayUrls } from "./turn";

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
