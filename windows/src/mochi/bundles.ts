// Skin bundles the user imported: listing, loading and the chat persona. A
// bundle is only data — hair pictures and a manifest (see src-tauri/src/skins.rs
// and docs/SKINS.md) — so it works in every build.

import { Bridge, type SkinInfo } from "../core/bridge";
import { HairSkin } from "./hair";
import { parseManifest, type Manifest } from "./manifest";

/** Settings value for an imported skin: `bundle:<id>`, so it can't clash with a built-in name. */
export const BUNDLE_PREFIX = "bundle:";
export const bundleId = (skin: string): string | null =>
  skin.startsWith(BUNDLE_PREFIX) ? skin.slice(BUNDLE_PREFIX.length) : null;

export async function listBundles(): Promise<SkinInfo[]> {
  return (await Bridge.skinsList()) ?? [];
}

async function readManifest(id: string): Promise<Manifest | string> {
  const text = await Bridge.skinManifest(id);
  if (!text) return "the skin is not installed";
  try {
    return parseManifest(JSON.parse(text));
  } catch {
    return "the manifest is not valid JSON";
  }
}

/** The skin ready to draw, or null (the character then stays Mochi). */
export async function loadBundle(id: string): Promise<HairSkin | null> {
  try {
    const m = await readManifest(id);
    if (typeof m === "string") {
      console.warn(`[coucou] skin ${id}: ${m}`);
      return null;
    }
    const names = new Set(m.layers.map((l) => l.src));
    const images = new Map<string, ImageBitmap>();
    for (const name of names) {
      const bytes = await Bridge.skinLayer(id, name);
      if (!bytes) throw new Error(`missing ${name}`);
      images.set(name, await createImageBitmap(new Blob([bytes], { type: "image/png" })));
    }
    const skin = new HairSkin(m, images);
    // Wear it only once it can draw, so the character never blinks out.
    await skin.ready;
    return skin;
  } catch (err) {
    console.warn(`[coucou] skin ${id} failed to load`, err);
    return null;
  }
}

/** A character card's `{{char}}` is the character itself. ({{user}} is filled in by Rust.) */
export function fillChar(persona: string, name: string): string {
  return persona.replace(/\{\{char\}\}|<BOT>/gi, name || "the character");
}

/** The chat personality a bundle carries, if any. */
export async function bundlePersona(skin: string): Promise<string | null> {
  const id = bundleId(skin);
  if (!id) return null;
  const m = await readManifest(id);
  return typeof m !== "string" && m.persona ? fillChar(m.persona, m.name) : null;
}
