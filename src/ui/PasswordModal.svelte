<script lang="ts">
  // Pede a senha de uma sala cujo link não trouxe a senha (sala do servidor
  // próprio, ou link do túnel sem o "#senha").
  import { onMount } from "svelte";
  import { t } from "../lib/prefs.svelte";

  type Props = {
    /** Nome curto da sala, para a pessoa saber onde está entrando. */
    room: string;
    /** Erro da tentativa anterior (ex.: senha incorreta). */
    error?: string | null;
    onsubmit: (password: string) => void;
    oncancel: () => void;
  };
  let { room, error = null, onsubmit, oncancel }: Props = $props();

  let password = $state("");
  let input: HTMLInputElement;

  onMount(() => {
    input.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") oncancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal" role="dialog" aria-labelledby="password-title">
    <form
      class="password-modal"
      onsubmit={(e) => {
        e.preventDefault();
        if (password.trim()) onsubmit(password.trim());
      }}
    >
      <img class="mascot" src="/logo.svg" alt="" />
      <h2 id="password-title">{t("passwordTitle")}</h2>
      <p class="muted">{t("passwordHint", { room })}</p>
      <input
        bind:this={input}
        bind:value={password}
        type="password"
        placeholder={t("password")}
        autocomplete="off"
        aria-invalid={!!error}
      />
      {#if error}<p class="error">{error}</p>{/if}
      <div class="actions">
        <button type="button" class="btn" onclick={oncancel}>{t("cancel")}</button>
        <button class="btn primary" disabled={!password.trim()}>{t("join")}</button>
      </div>
    </form>
  </div>
</div>

<style>
  .password-modal {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
    width: min(380px, calc(100vw - 32px));
    padding: 24px;
  }
  .mascot {
    width: 56px;
    height: 56px;
  }
  h2 {
    margin: 0;
  }
  p {
    margin: 0;
  }
  input {
    width: 100%;
  }
  .error {
    color: var(--danger);
    font-size: 0.9em;
  }
  .actions {
    display: flex;
    gap: 8px;
    width: 100%;
  }
  .actions .btn {
    flex: 1;
  }
</style>
