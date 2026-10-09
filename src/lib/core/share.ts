/**
 * Compact, URL-safe scene encoding for share links: JSON, deflate (when the
 * browser supports CompressionStream), then base64url. Prefix "z" marks
 * compressed payloads and "j" plain JSON.
 */

import { normalizeScene, type Scene } from "./scene";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const response = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

/** Rounds numbers so the payload stays short without visible changes. */
function compact(scene: Scene): string {
  return JSON.stringify(scene, (_key, value) => (typeof value === "number" ? Math.round(value * 1e4) / 1e4 : value));
}

export async function encodeScene(scene: Scene): Promise<string> {
  const json = new TextEncoder().encode(compact(scene));
  if (typeof CompressionStream !== "undefined") {
    return "z" + toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
  }
  return "j" + toBase64Url(json);
}

export async function decodeScene(payload: string): Promise<Scene> {
  const kind = payload[0];
  let bytes = fromBase64Url(payload.slice(1));
  if (kind === "z") bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
  else if (kind !== "j") throw new Error("Unknown scene encoding");
  return normalizeScene(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Reads a scene from a location hash such as "#s=z...". Returns null when there is none. */
export async function sceneFromHash(hash: string): Promise<Scene | null> {
  const match = /[#&]s=([A-Za-z0-9_-]+)/.exec(hash);
  if (!match) return null;
  try {
    return await decodeScene(match[1]);
  } catch {
    return null;
  }
}
