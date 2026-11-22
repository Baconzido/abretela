import { describe, expect, it } from "vitest";
import { appLink, roomFromPage } from "./page";

const loc = (url: string) => {
  const u = new URL(url);
  return { protocol: u.protocol, host: u.host, hash: u.hash, search: u.search };
};

describe("roomFromPage", () => {
  it("túnel: a sala é o próprio endereço, e a senha vem depois do #", () => {
    expect(roomFromPage(loc("https://abc-def-ghi.trycloudflare.com/watch#123%20456"))).toEqual({
      room: "https://abc-def-ghi.trycloudflare.com",
      ws: "wss://abc-def-ghi.trycloudflare.com/ws",
      password: "123 456",
      label: "abc-def-ghi",
    });
  });

  it("servidor próprio: sem senha no link", () => {
    const p = roomFromPage(loc("https://abretela-1a2b3c.breno.workers.dev/"));
    expect(p.password).toBeNull();
    expect(p.ws).toBe("wss://abretela-1a2b3c.breno.workers.dev/ws");
  });

  it("?room= aponta para outra sala (desenvolvimento), só se for um endereço http(s)", () => {
    expect(roomFromPage(loc("http://localhost:1430/watch.html?room=http://127.0.0.1:8787")).ws).toBe("ws://127.0.0.1:8787/ws");
    expect(roomFromPage(loc("http://localhost:1430/watch.html?room=javascript:alert(1)")).ws).toBe("ws://localhost:1430/ws");
  });

  it("link para abrir no app leva o endereço e a senha", () => {
    expect(appLink(roomFromPage(loc("https://x.trycloudflare.com/watch#4321")))).toBe("abretela://join/x.trycloudflare.com#4321");
    expect(appLink(roomFromPage(loc("https://s.workers.dev/")))).toBe("abretela://join/s.workers.dev");
  });
});
