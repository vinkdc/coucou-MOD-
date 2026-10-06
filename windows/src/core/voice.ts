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

// How loud the voice is, so the character can move with it. Wired once, on the
// first clip, and only when the audio context is running: routing the element
// through a suspended context would silence it.
let analyser: AnalyserNode | null = null;
let context: AudioContext | null = null;
const samples = new Uint8Array(512);

async function listen(a: HTMLAudioElement) {
  if (analyser) return;
  try {
    context ??= new AudioContext();
    if (context.state !== "running") {
      // resume() waits for a user gesture when there was none: don't hold the clip back for it.
      await Promise.race([context.resume(), new Promise((r) => setTimeout(r, 150))]);
    }
    if (context.state !== "running") return;
    const source = context.createMediaElementSource(a);
    const node = context.createAnalyser();
    node.fftSize = samples.length;
    node.smoothingTimeConstant = 0.3;
    source.connect(node);
    node.connect(context.destination);
    analyser = node;
  } catch {
    analyser = null;
  }
}

/** Loudness of the voice right now, 0..1; -1 when it can't be measured. */
export function level(): number {
  if (!analyser) return -1;
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const v of samples) sum += ((v - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

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
  await listen(a);
  if (gen !== generation) return;
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
