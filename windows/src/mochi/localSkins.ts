// Skins kept outside git in src/mochi/local/ — for a developer's own build,
// never shipped. Each file default-exports a function returning a FullSkin.
//
// Both functions bail out unless this is a dev build: Vite replaces
// `import.meta.env.DEV` with `false` in release builds, the code after the
// guard becomes dead, and the glob's imports are dropped with it — so nothing
// in local/ can reach a shipped bundle even if the folder exists.

import type { FullSkin } from "./skin";

/** Names of the local skins present ("monika" for local/monika.ts). */
export function localSkinNames(): string[] {
  if (!import.meta.env.DEV) return [];
  return Object.keys(import.meta.glob("./local/*.ts")).map((p) => p.slice("./local/".length, -".ts".length));
}

export async function loadLocalSkin(name: string): Promise<FullSkin | null> {
  if (!import.meta.env.DEV) return null;
  const modules = import.meta.glob<{ default: () => FullSkin }>("./local/*.ts");
  const load = modules[`./local/${name}.ts`];
  if (!load) return null;
  const skin = (await load()).default();
  // Wear it only once it can draw, so the character never blinks out.
  await skin.ready;
  return skin;
}

/**
 * The chat persona a local skin carries, if any: its module's named export
 * `persona`, a description of how the character talks and behaves. Same
 * dev-only gate as the skins themselves.
 */
export async function localPersona(name: string): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  const modules = import.meta.glob<{ persona?: unknown }>("./local/*.ts");
  const load = modules[`./local/${name}.ts`];
  if (!load) return null;
  const persona = (await load()).persona;
  if (typeof persona !== "string" || !persona.trim()) return null;
  return persona.replace(/\{\{char\}\}|<BOT>/gi, name[0].toUpperCase() + name.slice(1));
}
