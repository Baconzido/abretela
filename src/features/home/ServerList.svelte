<script lang="ts">
  // Os servidores de que a pessoa faz parte (ROADMAP, seção 6), como a lista de
  // servidores do Discord: um clique entra (com a senha guardada ou como dono).
  import { serverInfo, type ServerInfo } from "../../lib/selfhost";
  import type { ServerEntry } from "../../lib/servers";
  import { t } from "../../lib/prefs.svelte";
  import Icon from "../../ui/Icon.svelte";

  type Props = {
    entries: ServerEntry[];
    disabled: boolean;
    onjoin: (entry: ServerEntry) => void;
    onforget: (entry: ServerEntry) => void;
  };
  let { entries, disabled, onjoin, onforget }: Props = $props();

  /** `undefined`: carregando; `null`: não respondeu. */
  let infos = $state<Record<string, ServerInfo | null | undefined>>({});

  $effect(() => {
    for (const e of entries) {
      if (e.url in infos) continue;
      infos[e.url] = undefined;
      serverInfo(e.url).then((info) => (infos[e.url] = info));
    }
  });
</script>

<div class="card server-list">
  <div class="list-title"><Icon name="globe" size={14} /> {t("serversTitle")}</div>
  {#each entries as e (e.url)}
    {@const info = infos[e.url]}
    <div class="server-row">
      <button class="server-main" {disabled} onclick={() => onjoin(e)} title={e.url}>
        <span class="server-avatar">{(info?.name ?? e.name).slice(0, 1).toUpperCase()}</span>
        <span class="server-text">
          <span class="server-name">
            {info?.name ?? e.name}
            {#if e.owned}<span class="owner" title={t("serverOwnerHint")}><Icon name="crown" size={12} /></span>{/if}
          </span>
          <span class="server-sub">
            {#if info === undefined}
              <span class="spinner small"></span>
            {:else if info}
              {#if info.live > 0}<span class="live-dot"></span>{/if}
              {t("selfhostPeople", { people: info.people, live: info.live })}
            {:else}
              {t("selfhostOffline")}
            {/if}
          </span>
        </span>
      </button>
      {#if !e.owned}
        <button class="icon-btn small" title={t("serverForget")} {disabled} onclick={() => onforget(e)}>
          <Icon name="x" size={15} />
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .server-list {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .list-title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .server-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .server-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border: none;
    border-radius: var(--r);
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .server-main:hover:not(:disabled) {
    background: var(--primary-soft);
  }
  .server-main:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .server-avatar {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-weight: 800;
    background: var(--primary);
    color: #fff;
    flex: none;
  }
  .server-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .server-name {
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .owner {
    color: var(--sun-text);
    display: inline-flex;
  }
  .server-sub {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--live);
  }
</style>
