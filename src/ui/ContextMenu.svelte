<script lang="ts" module>
  import type { IconName } from "./Icon.svelte";

  export type MenuItem = {
    label: string;
    icon: IconName;
    onclick: () => void;
    danger?: boolean;
    disabled?: boolean;
    /** Fecha o menu ao clicar (padrão: sim). */
    keepOpen?: boolean;
  };
</script>

<script lang="ts">
  // Menu do botão direito: aparece onde o mouse está e fecha ao clicar fora,
  // apertar Esc ou a janela perder o foco.
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";

  type Props = { x: number; y: number; title?: string; items: MenuItem[]; onclose: () => void };
  let { x, y, title, items, onclose }: Props = $props();

  let el: HTMLDivElement;
  // não deixa o menu sair da janela
  let pos = $state({ left: 0, top: 0 });
  $effect(() => {
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 120;
    pos = { left: Math.min(x, window.innerWidth - w - 8), top: Math.min(y, window.innerHeight - h - 8) };
  });

  onMount(() => {
    const close = () => onclose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onclose();
    // o mesmo clique que abriu o menu não pode fechá-lo
    setTimeout(() => window.addEventListener("click", close));
    window.addEventListener("contextmenu", close, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="menu"
  role="menu"
  tabindex="-1"
  bind:this={el}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  onclick={(e) => e.stopPropagation()}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#if title}<div class="menu-title">{title}</div>{/if}
  {#each items as item (item.label)}
    <button
      role="menuitem"
      class:danger={item.danger}
      disabled={item.disabled}
      onclick={() => {
        item.onclick();
        if (!item.keepOpen) onclose();
      }}
    >
      <Icon name={item.icon} size={14} />
      {item.label}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 30;
    min-width: 180px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    border-radius: var(--r-sm);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    box-shadow: var(--shadow-lg);
    animation: pop-in 0.1s ease-out;
  }
  .menu-title {
    padding: 6px 10px 4px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
  }
  button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--primary-soft);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.danger {
    color: var(--danger);
  }
  button.danger:hover:not(:disabled) {
    background: var(--danger-soft);
  }
</style>
