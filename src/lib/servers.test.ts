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
  it("lembra com a senha, o mais recente no topo, sem repetir", () => {
    let list = remember([], { url: "https://a.workers.dev", name: "A", password: "1" });
    list = remember(list, { url: "https://b.workers.dev", name: "B", password: "2" });
    list = remember(list, { url: "https://A.workers.dev/", name: "A2", password: "3" });
    expect(list).toEqual([
      { url: "https://A.workers.dev/", name: "A2", password: "3" },
      { url: "https://b.workers.dev", name: "B", password: "2" },
    ]);
    expect(forget(list, "https://a.workers.dev")).toHaveLength(1);
  });

  it("lê o que foi salvo e descarta o inválido", () => {
    expect(loadJoined([{ url: "https://a.workers.dev", name: "A", password: "1" }, { url: "javascript:x" }, null])).toEqual([
      { url: "https://a.workers.dev", name: "A", password: "1" },
    ]);
    expect(loadJoined("lixo")).toEqual([]);
  });

  it("na lista, os meus primeiro, e o meu não aparece de novo como 'entrei'", () => {
    const entries = serverEntries([owned], [
      { url: owned.url + "/", name: "Meu (velho)", password: "x" },
      { url: "https://outro.workers.dev", name: "Outro", password: "y" },
    ]);
    expect(entries.map((e) => [e.name, !!e.owned, e.password])).toEqual([
      ["Meu", true, null],
      ["Outro", false, "y"],
    ]);
    expect(sameServer("https://X.dev/", "https://x.dev")).toBe(true);
  });
});
