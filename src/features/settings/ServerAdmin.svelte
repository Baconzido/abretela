<script lang="ts">
  // Painel do dono de um servidor próprio (ROADMAP, seção 6, fase S4): nome,
  // senha, limites de qualidade, duração do TURN, quem está na sala (remover e
  // banir) e os banidos. Tudo pela API do Worker, com a chave deste PC.
  import { onMount } from "svelte";
  import { prefs, t } from "../../lib/prefs.svelte";
  import { FPS_OPTIONS, HEIGHTS, type RoomSettings } from "../../lib/quality";
  import { TURN_LIFETIMES } from "../../lib/turn";
  import { AdminError, BAN_OPTIONS, serverAdmin, type AdminPeer, type AdminView, type RoomPatch } from "../../lib/serverAdmin";
  import type { OwnedServer } from "../../lib/selfhost";
  import Icon from "../../ui/Icon.svelte";
  import ContextMenu, { type MenuItem } from "../../ui/ContextMenu.svelte";

  type Props = { server: OwnedServer; onrename: (name: string) => void };
  let { server, onrename }: Props = $props();

  let view = $state<AdminView | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let saved = $state(false);
  let name = $state("");
  let password = $state("");
  let settings = $state<RoomSettings>({ minHeight: 360, maxHeight: 1080, minFps: 15, maxFps: 60 });
  let turnLifetime = $state(60);
  let menu = $state<{ peer: AdminPeer; x: number; y: number } | null>(null);

  const others = $derived(view?.peers.filter((p) => !p.owner) ?? []);
  const owners = $derived(view?.peers.filter((p) => p.owner) ?? []);

  function errText(e: unknown): string {
    if (e instanceof AdminError) {
      if (e.status === 0) return t("selfhostOffline");
      if (e.status === 401) return t("adminNoKey");
      return t("adminFailed", { code: e.code });
    }
    return String(e);
  }

  function show(v: AdminView) {
    view = v;
    name = v.name;
    settings = { ...v.settings };
    turnLifetime = v.turnLifetime;
  }

  async function run(fn: () => Promise<AdminView>) {
    busy = true;
    error = null;
    try {
      show(await fn());
    } catch (e) {
      error = errText(e);
    } finally {
      busy = false;
    }
  }

  const refresh = () => run(() => serverAdmin.view(server));

  /** Manda só o que mudou. */
  async function save() {
    if (!view) return;
    const patch: RoomPatch = {};
    if (name.trim() && name.trim() !== view.name) patch.name = name.trim();
    if (password.trim()) patch.password = password.trim();
    if (JSON.stringify(settings) !== JSON.stringify(view.settings)) patch.settings = { ...settings };
    if (turnLifetime !== view.turnLifetime) patch.turnLifetime = turnLifetime;
    if (!Object.keys(patch).length) return;
    await run(() => serverAdmin.configure(server, patch));
    if (!error) {
      password = "";
      saved = true;
      setTimeout(() => (saved = false), 1500);
      if (patch.name) onrename(patch.name);
    }
  }

  // mínimo nunca acima do máximo (como nas opções da sala do túnel)
  function setSetting(key: keyof RoomSettings, v: number) {
    settings[key] = v;
    if (settings.minHeight > settings.maxHeight) {
      if (key === "minHeight") settings.maxHeight = v;
      else settings.minHeight = v;
    }
    if (settings.minFps > settings.maxFps) {
      if (key === "minFps") settings.maxFps = v;
      else settings.minFps = v;
    }
  }

  /** 60 -> "1 h", 1440 -> "1 dia" (no idioma do app). */
  function duration(minutes: number) {
    const [unit, n] =
      minutes % (7 * 1440) === 0
        ? (["week", minutes / (7 * 1440)] as const)
        : minutes % 1440 === 0
          ? (["day", minutes / 1440] as const)
          : minutes % 60 === 0
            ? (["hour", minutes / 60] as const)
            : (["minute", minutes] as const);
    return new Intl.NumberFormat(prefs.lang, { style: "unit", unit, unitDisplay: "long" }).format(n);
  }

  const until = (ms: number) =>
    new Intl.DateTimeFormat(prefs.lang, { dateStyle: "short", timeStyle: "short" }).format(new Date(ms));

  function peerMenu(peer: AdminPeer): MenuItem[] {
    return [
      { label: t("adminKick"), icon: "logout", onclick: () => run(() => serverAdmin.kick(server, peer.id)) },
      ...BAN_OPTIONS.map((m) => ({
        label: t("adminBan", { time: duration(m) }),
        icon: "lock" as const,
        danger: true,
        onclick: () => run(() => serverAdmin.kick(server, peer.id, m)),
      })),
    ];
  }

  onMount(refresh);
</script>

<div class="admin">
  {#if !view}
    <div class="row muted">
      {#if busy}<span class="spinner small"></span>{/if}
      {#if error}<span class="error-text">{error}</span>
        <button class="btn small" onclick={refresh}>{t("tryAgain")}</button>{/if}
    </div>
  {:else}
    <div class="block">
      <div class="block-title">{t("adminRoom")}</div>
      <div class="row">
        <label class="field grow">
          <span>{t("selfhostName")}</span>
          <input bind:value={name} maxlength="40" />
        </label>
        <label class="field grow">
          <span>{t("adminNewPassword")}</span>
          <input type="password" bind:value={password} maxlength="64" autocomplete="new-password" />
        </label>
      </div>
      <p class="hint">{t("adminNewPasswordHint")}</p>
      <div class="row">
        <label class="field">
          <span>{t("resolution")}</span>
          <span class="range">
            <select value={settings.minHeight} onchange={(e) => setSetting("minHeight", +e.currentTarget.value)}>
              {#each HEIGHTS as h (h)}<option value={h}>{h}p</option>{/each}
            </select>
            {t("rangeTo")}
            <select value={settings.maxHeight} onchange={(e) => setSetting("maxHeight", +e.currentTarget.value)}>
              {#each HEIGHTS as h (h)}<option value={h}>{h}p</option>{/each}
            </select>
          </span>
        </label>
        <label class="field">
          <span>{t("fps")}</span>
          <span class="range">
            <select value={settings.minFps} onchange={(e) => setSetting("minFps", +e.currentTarget.value)}>
              {#each FPS_OPTIONS as f (f)}<option value={f}>{f}</option>{/each}
            </select>
            {t("rangeTo")}
            <select value={settings.maxFps} onchange={(e) => setSetting("maxFps", +e.currentTarget.value)}>
              {#each FPS_OPTIONS as f (f)}<option value={f}>{f}</option>{/each}
            </select>
          </span>
        </label>
        {#if view.turn}
          <label class="field">
            <span>{t("turnLifetime")}</span>
            <select bind:value={turnLifetime}>
              {#each TURN_LIFETIMES as m (m)}<option value={m}>{duration(m)}</option>{/each}
            </select>
          </label>
        {/if}
      </div>
      <div class="row">
        <button class="btn small primary" disabled={busy} onclick={save}>
          <Icon name="check" size={14} />
          {saved ? t("adminSaved") : t("adminSave")}
        </button>
      </div>
    </div>

    <div class="block">
      <div class="block-title row">
        <span>{t("adminPeople", { n: view.peers.length })}</span>
        <span class="spacer"></span>
        <button class="icon-btn small" title={t("tryAgain")} disabled={busy} onclick={refresh}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {#if !view.peers.length}
        <p class="hint">{t("adminNobody")}</p>
      {/if}
      {#each [...owners, ...others] as p (p.id)}
        <div class="person">
          <span class="dot" class:live={p.sharing}></span>
          <span class="person-name">{p.name}</span>
          {#if p.owner}<span class="tag owner"><Icon name="crown" size={11} /> {t("adminOwner")}</span>{/if}
          {#if p.sharing}<span class="tag live" title={p.label ?? ""}>{t("live")}</span>{/if}
          <span class="spacer"></span>
          {#if !p.owner}
            <button
              class="btn small"
              disabled={busy}
              onclick={(e) => {
                e.stopPropagation();
                menu = { peer: p, x: e.clientX, y: e.clientY };
              }}
            >
              {t("adminActions")}
            </button>
          {/if}
        </div>
      {/each}
    </div>

    <div class="block">
      <div class="block-title">{t("adminBans")}</div>
      {#if !view.bans.length}
        <p class="hint">{t("adminNoBans")}</p>
      {/if}
      {#each view.bans as b (b.id)}
        <div class="person">
          <span class="person-name">{b.name}</span>
          <span class="muted small">{t("adminBannedUntil", { when: until(b.until) })}</span>
          <span class="spacer"></span>
          <button class="btn small" disabled={busy} onclick={() => run(() => serverAdmin.unban(server, b.id))}>
            {t("adminUnban")}
          </button>
        </div>
      {/each}
    </div>

    {#if error}<p class="error-text">{error}</p>{/if}
  {/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} title={menu.peer.name} items={peerMenu(menu.peer)} onclose={() => (menu = null)} />
{/if}

<style>
  .admin {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .block-title {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .block-title.row {
    align-items: center;
  }
  .grow {
    flex: 1;
    min-width: 160px;
  }
  .spacer {
    flex: 1;
  }
  .range {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
  }
  .person {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    background: var(--bg);
  }
  .person-name {
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--line-strong);
    flex: none;
  }
  .dot.live {
    background: var(--live);
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
  }
  .tag.owner {
    background: var(--sun-soft);
    color: var(--sun-text);
  }
  .tag.live {
    background: var(--live-soft);
    color: var(--live);
  }
  .small {
    font-size: 12px;
  }
  .error-text {
    color: var(--danger);
    margin: 0;
  }
</style>
