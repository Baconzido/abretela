<script lang="ts">
  // Os servidores de que a pessoa faz parte (ROADMAP, seção 6) numa barra de
  // ícones à esquerda, como a do Discord: cabe uma lista grande e rola. Passar o
  // mouse mostra nome e quem está lá; o botão direito tem copiar e tirar da lista.
  import { onMount } from "svelte";
  import { serverInfo, type ServerInfo } from "../../lib/selfhost";
  import type { ServerEntry } from "../../lib/servers";
  import { t } from "../../lib/prefs.svelte";
  import Icon from "../../ui/Icon.svelte";
  import ContextMenu, { type MenuItem } from "../../ui/ContextMenu.svelte";

  type Props = {
    entries: ServerEntry[];
    disabled: boolean;
    onjoin: (entry: ServerEntry) => void;
    onforget: (entry: ServerEntry) => void;
  };
  let { entries, disabled, onjoin, onforget }: Props = $props();

  /** `undefined`: carregando; `null`: não respondeu. */
  let infos = $state<Record<string, ServerInfo | null | undefined>>({});
  let hover = $state<{ entry: ServerEntry; top: number } | null>(null);
  let menu = $state<{ entry: ServerEntry; x: number; y: number } | null>(null);

  /** De quanto em quanto tempo atualiza quem está em cada servidor. */
  const REFRESH_MS = 60_000;

  function load(urls: string[]) {
    for (const url of urls) serverInfo(url).then((info) => (infos[url] = info));
  }

  // servidores novos na lista: busca na hora
  $effect(() => {
    const fresh = entries.map((e) => e.url).filter((url) => !(url in infos));
    for (const url of fresh) infos[url] = undefined;
    load(fresh);
  });

  onMount(() => {
    const timer = setInterval(() => load(entries.map((e) => e.url)), REFRESH_MS);
    return () => clearInterval(timer);
  });

  const nameOf = (e: ServerEntry) => infos[e.url]?.name ?? e.name;
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";

  function showTip(entry: ServerEntry, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    hover = { entry, top: r.top + r.height / 2 };
  }

  function openMenu(e: MouseEvent, entry: ServerEntry) {
    e.preventDefault();
    hover = null;
    menu = { entry, x: e.clientX, y: e.clientY };
  }

  function menuItems(entry: ServerEntry): MenuItem[] {
    return [
      { label: t("join"), icon: "play", disabled, onclick: () => onjoin(entry) },
      { label: t("selfhostCopyLink"), icon: "copy", onclick: () => navigator.clipboard.writeText(entry.url).catch(() => {}) },
      ...(entry.owned
        ? []
        : [{ label: t("serverForget"), icon: "x" as const, danger: true, onclick: () => onforget(entry) }]),
    ];
  }
</script>

<nav class="rail" aria-label={t("serversTitle")}>
  <div class="rail-head" title={t("serversTitle")}><Icon name="globe" size={18} /></div>
  <div class="rail-sep"></div>
  {#each entries as e (e.url)}
    {@const info = infos[e.url]}
    <button
      class="rail-item"
      class:offline={info === null}
      {disabled}
      aria-label={nameOf(e)}
      onclick={() => onjoin(e)}
      oncontextmenu={(ev) => openMenu(ev, e)}
      onmouseenter={(ev) => showTip(e, ev.currentTarget)}
      onmouseleave={() => (hover = null)}
      onfocus={(ev) => showTip(e, ev.currentTarget)}
      onblur={() => (hover = null)}
    >
      <span class="pill"></span>
      <span class="avatar">{initials(nameOf(e))}</span>
      {#if e.owned}<span class="badge owner"><Icon name="crown" size={10} /></span>{/if}
      {#if info && info.live > 0}<span class="badge live">{info.live}</span>{/if}
    </button>
  {/each}
</nav>

{#if hover && !menu}
  {@const info = infos[hover.entry.url]}
  <div class="tip" style:top="{hover.top}px">
    <strong>{nameOf(hover.entry)}</strong>
    <span>
      {#if info === undefined}…{:else if info}{t("selfhostPeople", { people: info.people, live: info.live })}{:else}{t(
          "selfhostOffline",
        )}{/if}
    </span>
    {#if hover.entry.owned}<span class="tip-owner"><Icon name="crown" size={11} /> {t("serverOwnerHint")}</span>{/if}
  </div>
{/if}

{#if menu}
  <ContextMenu
    x={menu.x}
    y={menu.y}
    title={nameOf(menu.entry)}
    items={menuItems(menu.entry)}
    onclose={() => (menu = null)}
  />
{/if}

<style>
  .rail {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: 72px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    background: var(--surface);
    border-right: 1px solid var(--line);
    overflow-y: auto;
    scrollbar-width: none;
  }
  .rail::-webkit-scrollbar {
    display: none;
  }
  .rail-head {
    width: 48px;
    height: 32px;
    display: grid;
    place-items: center;
    color: var(--muted);
    flex: none;
  }
  .rail-sep {
    width: 32px;
    height: 2px;
    border-radius: 1px;
    background: var(--line);
    flex: none;
  }
  .rail-item {
    position: relative;
    width: 48px;
    height: 48px;
    flex: none;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }
  .rail-item:disabled {
    cursor: default;
  }
  .avatar {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary-text);
    font-weight: 800;
    font-size: 16px;
    transition:
      border-radius 0.15s,
      background 0.15s,
      color 0.15s;
  }
  .rail-item:hover:not(:disabled) .avatar,
  .rail-item:focus-visible .avatar {
    border-radius: 16px;
    background: var(--primary);
    color: #fff;
  }
  .rail-item.offline .avatar {
    opacity: 0.45;
  }
  /* a barrinha à esquerda, como no Discord */
  .pill {
    position: absolute;
    left: -12px;
    top: 50%;
    width: 4px;
    height: 0;
    border-radius: 0 4px 4px 0;
    background: var(--text);
    transform: translateY(-50%);
    transition: height 0.15s;
  }
  .rail-item:hover:not(:disabled) .pill {
    height: 20px;
  }
  .badge {
    position: absolute;
    display: grid;
    place-items: center;
    border: 3px solid var(--surface);
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
  }
  .badge.owner {
    top: -4px;
    right: -4px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--sun-soft);
    color: var(--sun-text);
  }
  .badge.live {
    bottom: -4px;
    right: -4px;
    min-width: 20px;
    height: 20px;
    padding: 0 4px;
    border-radius: 10px;
    background: var(--live);
    color: #fff;
  }
  .tip {
    position: fixed;
    left: 80px;
    transform: translateY(-50%);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 260px;
    padding: 8px 12px;
    border-radius: var(--r-sm);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    box-shadow: var(--shadow);
    pointer-events: none;
    font-size: 12px;
    color: var(--muted);
    animation: fade-in 0.1s ease-out;
  }
  .tip strong {
    color: var(--text);
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tip-owner {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--sun-text);
  }
</style>
