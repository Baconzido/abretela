// Onde este código está rodando: dentro do app (Tauri) ou numa aba do navegador
// (a página de assistir, ROADMAP seção 5). O núcleo da sala é o mesmo; só o
// que é do app (log em arquivo, tela cheia da janela, captura) muda.

/** Estamos dentro do app? */
export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
