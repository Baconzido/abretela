// Senhas e chaves. A senha da sala fica com PBKDF2 (com sal); a chave de
// administrador é longa e aleatória, então um SHA-256 basta. Tudo pela
// WebCrypto, que existe no Worker e no Node (testes).

import type { PasswordHash } from "./protocol";

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** Compara sem revelar pelo tempo onde a diferença está. */
export function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Poucas iterações de propósito: o processador da sala é pago por tempo, e a
// senha só abre a sala (o banco só é lido pelo dono)
const ITERATIONS = 20_000;

async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    key,
    256,
  );
  return hex(bits);
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await pbkdf2(password, salt, ITERATIONS), iterations: ITERATIONS };
}

export async function checkPassword(password: string, stored: PasswordHash): Promise<boolean> {
  return sameText(await pbkdf2(password, stored.salt, stored.iterations), stored.hash);
}

/** A chave de administrador confere com o hash guardado no Worker? */
export async function checkAdminKey(key: unknown, storedHash: string | null): Promise<boolean> {
  if (!storedHash || typeof key !== "string" || key.length < 16 || key.length > 256) return false;
  return sameText(await sha256(key), storedHash.toLowerCase());
}

/** Id curto e aleatório (para os bans). */
export const randomId = () => hex(crypto.getRandomValues(new Uint8Array(8)));
