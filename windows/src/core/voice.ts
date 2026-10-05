// Japanese read aloud by Fish Audio (through Rust, which holds the key and a
// disk cache). One line plays at a time; a new one replaces it. Clips heard in
// this session are also kept as blob URLs, so a replay doesn't even cross IPC.

import { Bridge } from "./bridge";

const urls = new Map<string, string>();
let audio: HTMLAudioElement | null = null;
let playingKey: string | null = null;
/** Bumped by every speak/stop, so a slow fetch or an old queue never plays over newer audio. */
let generation = 0;
const listeners = new Set<(key: string | null) => void>();

function setPlaying(key: string | null) {
  playingKey = key;
  for (const fn of listeners) fn(key);
}

/** Called with the key of the line playing now, or null when it stops. */
export function onVoiceChange(fn: (key: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function nowPlaying(): string | null {
  return playingKey;
}

export function stop() {
  generation++;
  audio?.pause();
  setPlaying(null);
}

async function clip(text: string, voice: string | null): Promise<string> {
  const cacheKey = `${voice ?? ""}\u0001${text}`;
  let url = urls.get(cacheKey);
  if (!url) {
    const bytes = await Bridge.ttsSpeak(text, voice);
    url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    urls.set(cacheKey, url);
  }
  return url;
}

/** Plays one clip to its end (or until something newer takes over). */
async function play(text: string, key: string, voice: string | null, gen: number): Promise<void> {
  setPlaying(key);
  const url = await clip(text, voice);
  if (gen !== generation) return;
  audio ??= new Audio();
  const a = audio;
  a.src = url;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      a.removeEventListener("ended", done);
      a.removeEventListener("pause", done);
      resolve();
    };
    a.addEventListener("ended", done);
    a.addEventListener("pause", done);
    a.play().catch(reject);
  });
  if (gen === generation) setPlaying(null);
}

/**
 * Reads `text` aloud. `key` identifies the line for the play buttons (defaults
 * to the text). Rejects with a message the page can show (no key, no credit…).
 */
export async function speak(text: string, opts: { key?: string; voice?: string | null } = {}): Promise<void> {
  const gen = ++generation;
  audio?.pause();
  try {
    await play(text, opts.key ?? text, opts.voice ?? null, gen);
  } catch (err) {
    if (gen === generation) setPlaying(null);
    throw new Error(String(err).replace(/^Error:\s*/, ""));
  }
}

/** Plays lines one after another (auto-play of a new reply); any other speak or stop ends it. */
export async function speakAll(lines: { text: string; key: string }[]): Promise<void> {
  const gen = ++generation;
  audio?.pause();
  try {
    for (const line of lines) {
      if (gen !== generation) return;
      await play(line.text, line.key, null, gen);
    }
  } catch (err) {
    if (gen === generation) setPlaying(null);
    throw new Error(String(err).replace(/^Error:\s*/, ""));
  }
}
