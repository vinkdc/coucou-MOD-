// Japanese read aloud by Fish Audio (through Rust, which holds the key and a
// disk cache). One line plays at a time; a new one replaces it. Clips heard in
// this session are also kept as blob URLs, so a replay doesn't even cross IPC.

import { Bridge, IS_TAURI } from "./bridge";

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

// A new line streams: Rust forwards Fish Audio's MP3 while it is still being
// generated, and Media Source Extensions play it as it lands, so the voice starts
// with the first piece instead of the whole clip. Where MSE can't take MP3, a
// clip is fetched whole.
const CAN_STREAM = IS_TAURI && typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");

/** A clip still arriving from Fish Audio. */
class LiveClip {
  chunks: ArrayBuffer[] = [];
  done = false;
  error: Error | null = null;
  /** The whole clip, once it is complete. */
  url: string | null = null;
  private waiting: (() => void)[] = [];

  constructor(text: string, voice: string | null, cacheKey: string) {
    Bridge.ttsStream(text, voice, (bytes) => {
      if (bytes.byteLength > 0) {
        this.chunks.push(bytes);
      } else if (!this.done) {
        this.done = true;
        this.url = URL.createObjectURL(new Blob(this.chunks, { type: "audio/mpeg" }));
        urls.set(cacheKey, this.url);
      }
      this.wake();
    }).catch((err) => {
      this.error = new Error(String(err).replace(/^Error:\s*/, ""));
      this.wake();
    });
  }

  private wake() {
    const w = this.waiting;
    this.waiting = [];
    w.forEach((f) => f());
  }

  /** Resolves at the next piece, the end, or an error. */
  next(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

type Source = string | LiveClip;

function clip(text: string, voice: string | null): Promise<Source> {
  const cacheKey = `${voice ?? ""}\u0001${text}`;
  const url = urls.get(cacheKey);
  if (url) return Promise.resolve(url);
  if (CAN_STREAM) return Promise.resolve(new LiveClip(text, voice, cacheKey));
  return Bridge.ttsSpeak(text, voice).then((bytes) => {
    const whole = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    urls.set(cacheKey, whole);
    return whole;
  });
}

/** A MediaSource fed with the clip's pieces as they arrive. */
function live(clip: LiveClip): string {
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  ms.addEventListener(
    "sourceopen",
    async () => {
      URL.revokeObjectURL(url);
      try {
        const sb = ms.addSourceBuffer("audio/mpeg");
        const append = (piece: ArrayBuffer) =>
          new Promise<void>((resolve, reject) => {
            sb.addEventListener("updateend", () => resolve(), { once: true });
            sb.addEventListener("error", () => reject(new Error("append failed")), { once: true });
            sb.appendBuffer(piece);
          });
        let sent = 0;
        for (;;) {
          while (sent < clip.chunks.length) await append(clip.chunks[sent++]);
          if (clip.error) return ms.endOfStream("network");
          if (clip.done) return ms.endOfStream();
          await clip.next();
        }
      } catch {
        // The element moved on to another clip, or was stopped: nothing left to feed.
        try {
          if (ms.readyState === "open") ms.endOfStream("decode");
        } catch {
          /* already closed */
        }
      }
    },
    { once: true },
  );
  return url;
}

/** Plays one clip to its end (or until something newer takes over). */
function play(text: string, key: string, voice: string | null, gen: number): Promise<void> {
  return playUrl(clip(text, voice), key, gen);
}

/** Same, for a clip whose fetch may already be under way. */
async function playUrl(pending: Promise<Source>, key: string, gen: number): Promise<void> {
  setPlaying(key);
  const src = await pending;
  if (gen !== generation) return;
  if (src instanceof LiveClip) {
    // The first piece is the one wait left; it also brings any error (no key, no credit).
    while (!src.chunks.length && !src.done && !src.error) await src.next();
    if (src.error) throw src.error;
    if (gen !== generation) return;
  }
  audio ??= new Audio();
  const a = audio;
  await listen(a);
  if (gen !== generation) return;
  a.src = typeof src === "string" ? src : (src.url ?? live(src));
  await new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      a.removeEventListener("ended", ended);
      a.removeEventListener("pause", ended);
      a.removeEventListener("error", failed);
      if (err) reject(err);
      else resolve();
    };
    const ended = () => finish();
    const failed = () => finish((src instanceof LiveClip && src.error) || new Error("The voice could not be played."));
    a.addEventListener("ended", ended);
    a.addEventListener("pause", ended);
    a.addEventListener("error", failed);
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
  const failure: { message?: string } = {};
  const stream = speakStream((message) => (failure.message = message));
  lines.forEach((l) => stream.push(l));
  await stream.done();
  if (failure.message) throw new Error(failure.message);
}

export interface SpeechStream {
  /** Adds a line: its clip is fetched right away and plays after the ones before it. */
  push(line: { text: string; key: string }): void;
  /** Resolves when everything pushed so far has played (or was cut off). */
  done(): Promise<void>;
}

/**
 * Reads lines aloud as they arrive, e.g. while a reply is still streaming in.
 * Every clip starts fetching the moment its line is pushed, so the next one is
 * usually ready when the current one ends. Any other speak or stop ends it.
 */
export function speakStream(onError?: (message: string) => void): SpeechStream {
  const gen = ++generation;
  audio?.pause();
  const queue: { key: string; url: Promise<Source> }[] = [];
  let running: Promise<void> | null = null;
  let failed = false;

  async function run() {
    try {
      while (queue.length && gen === generation) {
        const next = queue.shift()!;
        await playUrl(next.url, next.key, gen);
      }
    } catch (err) {
      queue.length = 0;
      failed = true;
      if (gen === generation) {
        setPlaying(null);
        onError?.(String(err).replace(/^Error:\s*/, ""));
      }
    } finally {
      running = null;
    }
  }

  return {
    push(line) {
      if (failed || gen !== generation) return;
      const url = clip(line.text, null);
      url.catch(() => {}); // reported when its turn to play comes
      queue.push({ key: line.key, url });
      running ??= run();
    },
    done: () => running ?? Promise.resolve(),
  };
}
