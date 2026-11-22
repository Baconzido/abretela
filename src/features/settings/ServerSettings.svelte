<script lang="ts">
  // Servidor próprio (ROADMAP, seção 6): conectar a conta da Cloudflare com um
  // token e montar, atualizar, assumir e apagar servidores, sem abrir a Cloudflare.
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { prefs, t, type MessageKey } from "../../lib/prefs.svelte";
  import { describeError, log } from "../../lib/log";
  import {
    isOutdated,
    selfhost,
    serverInfo,
    tokenUrl,
    type Account,
    type CreateStep,
    type FoundServer,
    type OwnedServer,
    type ServerInfo,
  } from "../../lib/selfhost";
  import Icon from "../../ui/Icon.svelte";
  import ConfirmModal from "../../ui/ConfirmModal.svelte";
  import ServerAdmin from "./ServerAdmin.svelte";

  let hasToken = $state<boolean | null>(null);
  let accounts = $state<Account[]>([]);
  let tokenDraft = $state("");
  /** O token vai ter a permissão do Realtime (TURN)? */
  let withTurn = $state(true);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);

  let infos = $state<Record<string, ServerInfo | null | undefined>>({});
  let newName = $state("");
  let newPassword = $state("");
  let step = $state<CreateStep | null>(null);
  let found = $state<FoundServer[] | null>(null);
  let deleting = $state<OwnedServer | null>(null);
  /** Servidor com a senha por definir: o formulário aberto e os campos. */
  let fixing = $state<{ server: OwnedServer; name: string; password: string } | null>(null);
  let copied = $state<string | null>(null);
  /** Servidor com o painel do dono aberto. */
  let managing = $state<string | null>(null);

  const account = $derived(prefs.cloudflareAccount);
  const servers = $derived(prefs.servers);
  const others = $derived((found ?? []).filter((f) => !servers.some((s) => s.scriptName === f.scriptName)));

  const STEP_TEXT: Record<CreateStep, MessageKey> = {
    subdomain: "selfhostStepSubdomain",
    turn: "selfhostStepTurn",
    upload: "selfhostStepUpload",
    online: "selfhostStepOnline",
    configure: "selfhostStepConfigure",
    done: "selfhostStepConfigure",
  };

  const errText = (e: unknown) => describeError(e);

  async function run(label: string, fn: () => Promise<void>) {
    busy = label;
    error = null;
    try {
      await fn();
    } catch (e) {
      error = errText(e);
      log.warn("selfhost", `${label} failed: ${error}`);
    } finally {
      busy = null;
    }
  }

  function pickAccount(list: Account[]) {
    accounts = list;
    if (!list.some((a) => a.id === prefs.cloudflareAccount?.id)) prefs.cloudflareAccount = list[0] ?? null;
  }

  const connect = () =>
    run("connect", async () => {
      pickAccount(await selfhost.connect(tokenDraft));
      tokenDraft = "";
      hasToken = true;
      refreshAll();
    });

  const disconnect = () =>
    run("disconnect", async () => {
      await selfhost.forgetToken();
      hasToken = false;
      accounts = [];
      found = null;
    });

  async function refresh(s: OwnedServer) {
    infos[s.scriptName] = undefined;
    infos[s.scriptName] = await serverInfo(s.url);
  }
  const refreshAll = () => servers.forEach(refresh);

  function saveServer(s: OwnedServer) {
    prefs.servers = [...prefs.servers.filter((x) => x.scriptName !== s.scriptName), s];
  }

  const create = () =>
    run("create", async () => {
      if (!account) return;
      const stop = await listen<CreateStep>("selfhost-progress", (e) => (step = e.payload));
      try {
        const s = await selfhost.create(account.id, newName, newPassword);
        saveServer(s);
        if (!s.configured) fixing = { server: s, name: s.name, password: newPassword };
        newName = "";
        newPassword = "";
        refresh(s);
      } finally {
        stop();
        step = null;
      }
    });

  const configure = () =>
    run("configure", async () => {
      if (!fixing) return;
      await selfhost.configure(fixing.server, fixing.name, fixing.password);
      saveServer({ ...fixing.server, name: fixing.name.trim(), configured: true });
      const s = fixing.server;
      fixing = null;
      refresh(s);
    });

  const update = (s: OwnedServer) =>
    run("update", async () => {
      await selfhost.update(s);
      refresh(s);
    });

  const remove = (s: OwnedServer) =>
    run("delete", async () => {
      deleting = null;
      await selfhost.remove(s);
      prefs.servers = prefs.servers.filter((x) => x.scriptName !== s.scriptName);
      if (found) found = found.filter((f) => f.scriptName !== s.scriptName);
    });

  const addTurn = (s: OwnedServer) =>
    run("addTurn", async () => {
      const turnKeyId = await selfhost.addTurn(s);
      saveServer({ ...s, turnKeyId, turnError: null });
      refresh(s);
    });

  const find = () =>
    run("find", async () => {
      if (account) found = await selfhost.find(account.id);
    });

  const claim = (f: FoundServer) =>
    run("claim", async () => {
      if (!account) return;
      const s = await selfhost.claim(account.id, f.scriptName);
      saveServer(s);
      refresh(s);
    });

  async function copy(url: string) {
    await navigator.clipboard.writeText(url).catch(() => {});
    copied = url;
    setTimeout(() => copied === url && (copied = null), 1500);
  }

  onMount(async () => {
    try {
      hasToken = await selfhost.hasToken();
      if (hasToken) pickAccount(await selfhost.accounts());
    } catch (e) {
      error = errText(e);
    }
    refreshAll();
  });
</script>

<section class="settings-group">
  <div class="group-label"><Icon name="globe" size={15} /> {t("selfhostCloudflare")}</div>
  <p class="hint">{t("selfhostIntro")}</p>

  {#if hasToken === false}
    <div class="stack">
      <label class="field">
        <span>{t("selfhostTokenKind")}</span>
        <select value={withTurn ? "turn" : "plain"} onchange={(e) => (withTurn = e.currentTarget.value === "turn")}>
          <option value="turn">{t("selfhostTokenWithTurn")}</option>
          <option value="plain">{t("selfhostTokenWithoutTurn")}</option>
        </select>
      </label>
      <button class="btn" onclick={() => openUrl(tokenUrl(withTurn)).catch((e) => (error = errText(e)))}>
        <Icon name="link" size={15} />
        {t("selfhostCreateToken")}
      </button>
      <p class="hint">{t(withTurn ? "selfhostTokenHint" : "selfhostTokenHintNoTurn")}</p>
      <form
        class="row"
        onsubmit={(e) => {
          e.preventDefault();
          connect();
        }}
      >
        <label class="field grow">
          <span>{t("selfhostToken")}</span>
          <input type="password" bind:value={tokenDraft} autocomplete="off" spellcheck="false" />
        </label>
        <button class="btn primary" disabled={!tokenDraft.trim() || !!busy}>
          {#if busy === "connect"}<span class="spinner small"></span>{/if}
          {t("selfhostConnect")}
        </button>
      </form>
    </div>
  {:else if hasToken}
    <div class="row connected">
      <span class="ok-dot"></span>
      <span>{t("selfhostConnected")}</span>
      {#if accounts.length > 1}
        <select
          value={account?.id}
          onchange={(e) => {
            prefs.cloudflareAccount = accounts.find((a) => a.id === e.currentTarget.value) ?? null;
            found = null;
          }}
        >
          {#each accounts as a (a.id)}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
      {:else if account}
        <strong>{account.name}</strong>
      {/if}
      <span class="spacer"></span>
      <button class="btn small" disabled={!!busy} onclick={disconnect}>{t("selfhostDisconnect")}</button>
    </div>
  {/if}

  {#if error}<p class="error-text">{error}</p>{/if}
</section>

{#if servers.length || hasToken}
  <section class="settings-group">
    <div class="group-label"><Icon name="monitor" size={15} /> {t("selfhostYourServers")}</div>
    {#if !servers.length}
      <p class="hint">{t("selfhostNone")}</p>
    {/if}
    {#each servers as s (s.scriptName)}
      {@const info = infos[s.scriptName]}
      <div class="server-card">
        <div class="server-head">
          <div class="server-avatar">{s.name.slice(0, 1).toUpperCase()}</div>
          <div class="server-text">
            <strong>{info?.name ?? s.name}</strong>
            <span class="muted small">
              {#if info === undefined}
                <span class="spinner small"></span>
              {:else if info}
                {t("selfhostPeople", { people: info.people, live: info.live })}
              {:else}
                {t("selfhostOffline")}
              {/if}
            </span>
          </div>
          <button class="btn small" title={s.url} onclick={() => copy(s.url)}>
            <Icon name={copied === s.url ? "check" : "copy"} size={14} />
            {copied === s.url ? t("copied") : t("selfhostCopyLink")}
          </button>
        </div>

        {#if info && !info.configured && !fixing}
          <p class="hint warn">{t("selfhostNotConfigured")}</p>
          <button class="btn small" onclick={() => (fixing = { server: s, name: s.name, password: "" })}>
            {t("selfhostSetPassword")}
          </button>
        {/if}
        {#if fixing?.server.scriptName === s.scriptName}
          <form
            class="row"
            onsubmit={(e) => {
              e.preventDefault();
              configure();
            }}
          >
            <label class="field grow">
              <span>{t("selfhostName")}</span>
              <input bind:value={fixing.name} maxlength="40" />
            </label>
            <label class="field grow">
              <span>{t("selfhostPassword")}</span>
              <input type="password" bind:value={fixing.password} maxlength="64" autocomplete="new-password" />
            </label>
            <button class="btn primary" disabled={!fixing.name.trim() || !fixing.password.trim() || !!busy}>
              {#if busy === "configure"}<span class="spinner small"></span>{/if}
              {t("selfhostSetPassword")}
            </button>
          </form>
        {/if}
        {#if info ? !info.turn : !!s.turnError}
          <p class="hint warn">{t("selfhostNoTurn")}</p>
          <button class="btn small" disabled={!!busy || !hasToken} onclick={() => addTurn(s)}>
            {#if busy === "addTurn"}<span class="spinner small"></span>{/if}
            {t("selfhostAddTurn")}
          </button>
        {/if}
        {#if isOutdated(info ?? null)}
          <p class="hint">{t("selfhostOutdated")}</p>
        {/if}

        {#if managing === s.scriptName}
          <ServerAdmin
            server={s}
            onrename={(name) => {
              saveServer({ ...s, name });
              refresh(s);
            }}
          />
        {/if}

        <div class="row actions">
          {#if isOutdated(info ?? null)}
            <button class="btn small primary" disabled={!!busy || !hasToken} onclick={() => update(s)}>
              {#if busy === "update"}<span class="spinner small"></span>{/if}
              {t("selfhostUpdate")}
            </button>
          {/if}
          <button
            class="btn small"
            class:primary={managing !== s.scriptName}
            disabled={!info}
            onclick={() => (managing = managing === s.scriptName ? null : s.scriptName)}
          >
            <Icon name="sliders" size={14} />
            {t("adminManage")}
          </button>
          <button class="btn small" disabled={!!busy} onclick={() => refresh(s)}>
            <Icon name="refresh" size={14} />
          </button>
          <span class="spacer"></span>
          <button class="btn small danger-soft" disabled={!!busy || !hasToken} onclick={() => (deleting = s)}>
            {t("selfhostDelete")}
          </button>
        </div>
      </div>
    {/each}
  </section>
{/if}

{#if hasToken && account}
  <section class="settings-group">
    <div class="group-label"><Icon name="plus" size={15} /> {t("selfhostNew")}</div>
    <form
      class="stack"
      onsubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <div class="row">
        <label class="field grow">
          <span>{t("selfhostName")}</span>
          <input bind:value={newName} maxlength="40" placeholder={t("selfhostNamePlaceholder")} disabled={!!busy} />
        </label>
        <label class="field grow">
          <span>{t("selfhostPassword")}</span>
          <input type="password" bind:value={newPassword} maxlength="64" autocomplete="new-password" disabled={!!busy} />
        </label>
      </div>
      <p class="hint">{t("selfhostPasswordHint")}</p>
      <div class="row">
        <button class="btn primary" disabled={!newName.trim() || !newPassword.trim() || !!busy}>
          {#if busy === "create"}<span class="spinner small"></span>{/if}
          {t("selfhostCreate")}
        </button>
        {#if step}<span class="muted">{t(STEP_TEXT[step])}</span>{/if}
      </div>
    </form>
  </section>

  <section class="settings-group">
    <div class="group-label"><Icon name="lock" size={15} /> {t("selfhostOtherPc")}</div>
    <p class="hint">{t("selfhostClaimHint")}</p>
    <button class="btn small" disabled={!!busy} onclick={find}>
      {#if busy === "find"}<span class="spinner small"></span>{/if}
      {t("selfhostFind")}
    </button>
    {#if found && !others.length}
      <p class="hint">{t("selfhostNothingFound")}</p>
    {/if}
    {#each others as f (f.scriptName)}
      <div class="row found">
        <span class="grow">{f.url.replace(/^https:\/\//, "")}</span>
        <button class="btn small" disabled={!!busy} onclick={() => claim(f)}>
          {#if busy === "claim"}<span class="spinner small"></span>{/if}
          {t("selfhostClaim")}
        </button>
      </div>
    {/each}
  </section>
{/if}

{#if deleting}
  {@const target = deleting}
  <ConfirmModal
    title={t("selfhostDeleteTitle")}
    message={t("selfhostDeleteBody", { name: target.name })}
    confirmLabel={t("selfhostDelete")}
    cancelLabel={t("cancel")}
    danger
    onconfirm={() => remove(target)}
    oncancel={() => (deleting = null)}
  />
{/if}

<style>
  /* as mesmas da página de Configurações (lá elas são locais) */
  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .group-label {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .settings-group > .btn,
  .server-card > .btn {
    align-self: flex-start;
  }
  .hint.warn {
    color: var(--warn-text);
  }
  .error-text {
    color: var(--danger);
    margin: 0;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
  }
  .stack > .row,
  .stack > form {
    align-self: stretch;
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    min-width: 180px;
  }
  .spacer {
    flex: 1;
  }
  .connected {
    align-items: center;
  }
  .ok-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--mint);
  }
  .server-card {
    border: 1px solid var(--line);
    border-radius: var(--r);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .server-card + .server-card {
    margin-top: 10px;
  }
  .server-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .server-avatar {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-weight: 700;
    background: var(--primary);
    color: #fff;
    flex: none;
  }
  .server-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .server-text strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small {
    font-size: 0.85em;
  }
  .actions {
    align-items: center;
  }
  .found {
    align-items: center;
    margin-top: 8px;
  }
  .found span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
