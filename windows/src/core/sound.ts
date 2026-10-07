// SoundEngine — port of SoundEngine.swift.
// The 28 WAVs are the macOS app's own files (see SOUNDS_DIR in vite.config.ts);
// they are served at /sounds/<name>.wav. Default volume 0.12, slider range 0–0.2,
// exactly like the Mac player, and several sounds may overlap.

import { setVoiceVolume } from "./voice";

export const SOUND_NAMES = [
  "peek", "open", "close", "hover", "blip", "slap", "annoyed", "dizzy", "greet",
  "work", "finish", "error", "approval", "question", "approve", "gulp", "tick",
  "send", "love", "pop", "proud", "wink", "yawn", "attach", "think", "search",
  "rate", "sleep",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/** How loud a sound should be played so that all of them match: its RMS brought to a common target. */
const TARGET_RMS = 0.1;
function levelGain(buf: AudioBuffer): number {
  const data = buf.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / Math.max(1, data.length));
  if (rms < 1e-4) return 1;
  // Never boost past the point where the loudest sample would clip.
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[i]));
  const clipLimit = peak > 0 ? 0.95 / peak : 4;
  return Math.max(0.25, Math.min(4, TARGET_RMS / rms, clipLimit));
}

class SoundEngine {
  enabled = true;
  volume = 0.12;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  /** Per-sound gain that brings every effect to the same loudness (the WAVs were mastered unevenly). */
  private gains = new Map<string, number>();
  private loading: Promise<void> | null = null;
  private idleTimer: number | null = null;

  /** Creates the context and decodes every WAV. Safe to call more than once. */
  preload(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.master = master;
      await Promise.all(
        SOUND_NAMES.map(async (name) => {
          try {
            const res = await fetch(`/sounds/${name}.wav`);
            if (!res.ok) return;
            const buf = await ctx.decodeAudioData(await res.arrayBuffer());
            this.buffers.set(name, buf);
            this.gains.set(name, levelGain(buf));
          } catch {
            /* a missing sound must never break the island */
          }
        }),
      );
    })();
    return this.loading;
  }

  /** WebView2 can hand us a suspended context; call after any user input. */
  resume() {
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void this.ctx?.resume();
  }

  /**
   * Called when the island goes quiet. A running AudioContext keeps an audio
   * thread and its render quantum alive even with nothing playing, which shows
   * up as a steady trickle of CPU on a machine that is supposed to be idle.
   *
   * The delay covers the tail of whatever just played — suspending mid-sound
   * would clip it — and `play()` resumes the context on its own.
   */
  idle() {
    if (!this.ctx || this.ctx.state !== "running" || this.idleTimer != null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.ctx?.suspend();
    }, 1500);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(0.2, v));
    if (this.master) this.master.gain.value = this.volume;
    // The same slider sets how loud the voice is, so effects and speech stay in proportion.
    setVoiceVolume(this.volume);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  play(name: SoundName | string) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const master = this.master;
    const buf = this.buffers.get(name);
    if (!ctx || !master || !buf) return;
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const level = ctx.createGain();
    level.gain.value = this.gains.get(name) ?? 1;
    src.connect(level);
    level.connect(master);
    src.start();
  }
}

export const Sound = new SoundEngine();
