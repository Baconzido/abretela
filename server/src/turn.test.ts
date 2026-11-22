import { describe, expect, it } from "vitest";
import { cleanGrant } from "./turn";

describe("cleanGrant", () => {
  it("tira a porta 53 e o que não é stun/turn, e acha o usuário", () => {
    const grant = cleanGrant({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "javascript:x"],
          username: "abc123",
          credential: "segredo",
        },
      ],
    });
    expect(grant).toEqual({
      username: "abc123",
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "abc123", credential: "segredo" },
      ],
    });
  });

  it("aceita o formato antigo (um objeto só)", () => {
    expect(cleanGrant({ iceServers: { urls: "turn:t.com", username: "u1", credential: "p" } }).username).toBe("u1");
  });

  it("sem credencial utilizável, falha (a pessoa entra sem TURN)", () => {
    expect(() => cleanGrant({ iceServers: [{ urls: ["stun:x"] }] })).toThrow();
    expect(() => cleanGrant({ iceServers: [{ urls: ["turn:x"], username: "a/../b", credential: "p" }] })).toThrow();
  });
});
