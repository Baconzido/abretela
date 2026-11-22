import { describe, expect, it } from "vitest";
import { forget, loadJoined, remember, sameServer, serverEntries } from "./servers";
import type { OwnedServer } from "./selfhost";

const owned: OwnedServer = {
  scriptName: "abretela-aaa111",
  accountId: "acc",
  name: "Meu",
  url: "https://abretela-aaa111.eu.workers.dev",
  turnKeyId: null,
  turnError: null,
  configured: true,
};

describe("servidores em que entrei", () => {
  it("lembra o mais recente no topo, sem repetir", () => {
    let list = remember([], { url: "https://a.workers.dev", name: "A" });
    list = remember(list, { url: "https://b.workers.dev", name: "B" });
    list = remember(list, { url: "https://A.workers.dev/", name: "A2" });
    expect(list).toEqual([
      { url: "https://A.workers.dev/", name: "A2" },
      { url: "https://b.workers.dev", name: "B" },
    ]);
    expect(forget(list, "https://a.workers.dev")).toHaveLength(1);
  });

  it("nunca guarda senha: as de versões anteriores somem ao ler", () => {
    const saved = [{ url: "https://a.workers.dev", name: "A", password: "1" }, { url: "javascript:x" }, null];
    expect(loadJoined(saved)).toEqual([{ url: "https://a.workers.dev", name: "A" }]);
    expect(loadJoined("lixo")).toEqual([]);
  });

  it("na lista, os meus primeiro, e o meu não aparece de novo como 'entrei'", () => {
    const entries = serverEntries([owned], [
      { url: owned.url + "/", name: "Meu (velho)" },
      { url: "https://outro.workers.dev", name: "Outro" },
    ]);
    expect(entries.map((e) => [e.name, !!e.owned])).toEqual([
      ["Meu", true],
      ["Outro", false],
    ]);
    expect(sameServer("https://X.dev/", "https://x.dev")).toBe(true);
  });
});
