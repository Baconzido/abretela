import { describe, expect, it } from "vitest";
import { isOutdated, loadServer, SERVER_VERSION, tokenUrl, type ServerInfo } from "./selfhost";

const saved = {
  scriptName: "abretela-1a2b3c",
  accountId: "acc",
  name: "Sala",
  url: "https://abretela-1a2b3c.minha.workers.dev",
  turnKeyId: "k",
  turnError: null,
  configured: true,
};

describe("loadServer", () => {
  it("lê o que foi salvo", () => {
    expect(loadServer(saved)).toEqual(saved);
    expect(loadServer({ ...saved, configured: undefined, turnKeyId: "" })).toMatchObject({ configured: true, turnKeyId: null });
  });

  it("descarta o que não é um servidor nosso", () => {
    expect(loadServer(null)).toBeNull();
    expect(loadServer({ ...saved, scriptName: "outro-worker" })).toBeNull();
    expect(loadServer({ ...saved, url: "http://inseguro.dev" })).toBeNull();
    expect(loadServer({ ...saved, accountId: "" })).toBeNull();
  });
});

describe("tokenUrl", () => {
  it("abre o formulário da Cloudflare com as permissões de Workers", () => {
    const url = new URL(tokenUrl(false));
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([
      { key: "workers_scripts", type: "edit" },
      { key: "account_settings", type: "read" },
    ]);
    expect(url.searchParams.get("name")).toBe("AbreTela");
  });

  it("com repasse, tenta marcar também o Realtime", () => {
    const keys = JSON.parse(new URL(tokenUrl(true)).searchParams.get("permissionGroupKeys")!);
    expect(keys).toContainEqual({ key: "realtime", type: "edit" });
    expect(keys).toHaveLength(3);
  });
});

describe("isOutdated", () => {
  const info = (version: number) => ({ app: "abretela", version }) as ServerInfo;
  it("só quando o servidor é mais velho que o app", () => {
    expect(isOutdated(info(SERVER_VERSION - 1))).toBe(true);
    expect(isOutdated(info(SERVER_VERSION))).toBe(false);
    expect(isOutdated(null)).toBe(false);
  });
});
