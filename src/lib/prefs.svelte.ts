// Preferências do app (nome, idioma, tema...), reativas e salvas no localStorage.

import { pt, type Messages } from "./locales/pt";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { zh } from "./locales/zh";
import { ko } from "./locales/ko";
import { ja } from "./locales/ja";
import { TURN_KINDS, turnLifetime, type TurnConfig } from "./turn";
import { loadServer, type Account, type OwnedServer } from "./selfhost";
import { loadJoined, type JoinedServer } from "./servers";

export const LANGUAGES = [
  { code: "pt", name: "Português" },
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "zh", name: "中文" },
  { code: "ko", name: "한국어" },
  { code: "ja", name: "日本語" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["code"];
export type Theme = "system" | "light" | "dark";

const DICTS: Record<Lang, Messages> = { pt, en, es, zh, ko, ja };
const KEY = "abretela.prefs";

function detectLang(): Lang {
  const nav = (navigator.language || "pt").slice(0, 2).toLowerCase();
  return (LANGUAGES.find((l) => l.code === nav)?.code ?? "pt") as Lang;
}

type Prefs = {
  name: string;
  lang: Lang;
  theme: Theme;
  closeToTray: boolean;
  sounds: boolean;
  hwAccel: boolean;
  /** Envio nativo (experimental). */
  nativeSend: boolean;
  /** Servidor de repasse (TURN) das salas que eu crio (ROADMAP, seção 4.4). */
  turn: TurnConfig;
  /** Quanto dura a senha temporária do TURN, em minutos (Cloudflare e coturn). */
  turnLifetime: number;
  /** Servidor próprio (ROADMAP, seção 6): a conta da Cloudflare escolhida. */
  cloudflareAccount: Account | null;
  /** Os servidores que este PC administra (o token e as chaves ficam no Rust). */
  servers: OwnedServer[];
  /** Servidores de outras pessoas em que já entrei, com a senha (entra direto). */
  joinedServers: JoinedServer[];
};

function loadAccount(v: unknown): Account | null {
  const a = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return typeof a.id === "string" && a.id ? { id: a.id, name: typeof a.name === "string" ? a.name : "" } : null;
}

const loadServers = (v: unknown): OwnedServer[] =>
  (Array.isArray(v) ? v : []).map(loadServer).filter((s): s is OwnedServer => s !== null);

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Lê a configuração de TURN salva, completando o que faltar. */
function loadTurn(saved: unknown): TurnConfig {
  const t = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  switch (TURN_KINDS.includes(t.kind as TurnConfig["kind"]) ? t.kind : "none") {
    case "manual":
      return { kind: "manual", urls: str(t.urls), username: str(t.username), credential: str(t.credential) };
    case "cloudflare":
      return { kind: "cloudflare", keyId: str(t.keyId), token: str(t.token) };
    case "coturn":
      return { kind: "coturn", urls: str(t.urls), secret: str(t.secret) };
    default:
      return { kind: "none" };
  }
}

/** Nome salvo pela tela inicial em versões antigas (até a 0.2.0). */
function legacyName(): string {
  try {
    return JSON.parse(localStorage.getItem("abretela.name") ?? "{}").name ?? "";
  } catch {
    return "";
  }
}

function load(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {}
  return {
    name: typeof saved.name === "string" ? saved.name : legacyName(),
    lang: saved.lang && saved.lang in DICTS ? saved.lang : detectLang(),
    theme: saved.theme && ["system", "light", "dark"].includes(saved.theme) ? saved.theme : "system",
    closeToTray: saved.closeToTray ?? true,
    sounds: saved.sounds ?? true,
    hwAccel: saved.hwAccel ?? true,
    nativeSend: saved.nativeSend ?? false,
    turn: loadTurn(saved.turn),
    turnLifetime: turnLifetime(saved.turnLifetime),
    cloudflareAccount: loadAccount(saved.cloudflareAccount),
    servers: loadServers(saved.servers),
    joinedServers: loadJoined(saved.joinedServers),
  };
}

const state = $state(load());

function apply() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : state.lang;
  if (state.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}
apply();

export const prefs = {
  /** Como os outros te veem nas salas (vazio = ainda não escolheu). */
  get name() {
    return state.name;
  },
  set name(v: string) {
    const name = v.trim().slice(0, 32);
    if (!name) return;
    state.name = name;
    apply();
  },
  get lang() {
    return state.lang;
  },
  set lang(v: Lang) {
    state.lang = v;
    apply();
  },
  get theme() {
    return state.theme;
  },
  set theme(v: Theme) {
    state.theme = v;
    apply();
  },
  get closeToTray() {
    return state.closeToTray;
  },
  set closeToTray(v: boolean) {
    state.closeToTray = v;
    apply();
  },
  get sounds() {
    return state.sounds;
  },
  set sounds(v: boolean) {
    state.sounds = v;
    apply();
  },
  /** Placa de vídeo na conversão da captura e na codificação (H.264). */
  get hwAccel() {
    return state.hwAccel;
  },
  set hwAccel(v: boolean) {
    state.hwAccel = v;
    apply();
  },
  /** Envio nativo (ROADMAP, seção 2, experimental): minha tela é codificada e
   * mandada pelo próprio app. Vale a partir da próxima sala. */
  get nativeSend() {
    return state.nativeSend;
  },
  set nativeSend(v: boolean) {
    state.nativeSend = v;
    apply();
  },
  /** TURN das salas que eu crio; os segredos ficam só neste PC. Vale a partir da próxima sala. */
  get turn(): TurnConfig {
    return state.turn;
  },
  set turn(v: TurnConfig) {
    state.turn = loadTurn(v);
    apply();
  },
  /** Minutos que a senha temporária do TURN dura; vale a partir da próxima sala. */
  get turnLifetime(): number {
    return state.turnLifetime;
  },
  set turnLifetime(v: number) {
    state.turnLifetime = turnLifetime(v);
    apply();
  },
  get cloudflareAccount(): Account | null {
    return state.cloudflareAccount;
  },
  set cloudflareAccount(v: Account | null) {
    state.cloudflareAccount = loadAccount(v);
    apply();
  },
  get servers(): OwnedServer[] {
    return state.servers;
  },
  set servers(v: OwnedServer[]) {
    state.servers = loadServers(v);
    apply();
  },
  get joinedServers(): JoinedServer[] {
    return state.joinedServers;
  },
  set joinedServers(v: JoinedServer[]) {
    state.joinedServers = loadJoined(v);
    apply();
  },
};

export type MessageKey = keyof Messages;

/** Traduz uma chave; `{nome}` no texto é trocado por `params.nome`. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text = DICTS[state.lang][key] ?? pt[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}
