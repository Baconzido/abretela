// Página de assistir pelo navegador (ROADMAP, seção 5): quem recebe o link e não
// tem o app assiste por aqui, sem instalar nada. Só assistir; transmitir é pelo app.
import { mount } from "svelte";
import "./fonts.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/controls.css";
import Watch from "./Watch.svelte";

mount(Watch, { target: document.getElementById("root")! });
