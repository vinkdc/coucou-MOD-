// Hands-free voice conversation for the Ask chat. The microphone stays open and
// its raw samples are watched by a small voice-activity detector: each utterance
// (with a moment of lead-in, so no first syllable is lost) is sent as WAV to be
// transcribed and handed to the chat, and the reply is spoken as it streams in.
// Speaking over Mochi stops her at once (barge-in). Audio lives in memory only.

import { Bridge } from "./bridge";
import { stop as stopSpeaking, nowPlaying } from "./voice";
import { MIN_MS } from "./mic";

export type VoicePhase = "listening" | "hearing" | "thinking";

export interface VoiceChatHooks {
  onPhase(phase: VoicePhase): void;
  /** What was said. Resolves when the chat has taken it and the reply has arrived. */
  onUtterance(text: string): Promise<void>;
  onError(message: string): void;
}

export interface VoiceChat {
  stop(): void;
}

const RATE = 16_000;
const FRAME = 512; // 32 ms
const FRAME_MS = (FRAME / RATE) * 1000;
/** Audio kept from before the voice crossed the threshold: the soft start of a word. */
const PRE_ROLL_FRAMES = 14;
/** Silence after speech that closes an utterance: short enough to feel instant. */
const END_SILENCE_MS = 650;
/** Silence kept after the last word, so endings aren't clipped. */
const TAIL_FRAMES = 8;
/** Louder and longer than a cough or a click is needed to interrupt Mochi. */
const BARGE_IN_MS = 220;
const MAX_UTTERANCE_MS = 25_000;
const MIN_FLOOR = 0.006;

function friendly(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it for Kotoba in Windows Settings → Privacy → Microphone.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `Could not use the microphone: ${String(err)}`;
}

/** 16 kHz mono samples → a 16-bit WAV file. */
function wav(frames: Float32Array[]): ArrayBuffer {
  const count = frames.reduce((n, f) => n + f.length, 0);
  const out = new DataView(new ArrayBuffer(44 + count * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + count * 2, true);
  text(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, count * 2, true);
  let at = 44;
  for (const f of frames) {
    for (const v of f) {
      out.setInt16(at, Math.max(-1, Math.min(1, v)) * 0x7fff, true);
      at += 2;
    }
  }
  return out.buffer;
}

export async function startVoiceChat(hooks: VoiceChatHooks): Promise<VoiceChat> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Voice chat isn't available here.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw new Error(friendly(err));
  }

  // The context itself runs at 16 kHz, so the samples are ready for speech recognition as they come.
  const context = new AudioContext({ sampleRate: RATE });
  const source = context.createMediaStreamSource(stream);
  const tap = context.createScriptProcessor(FRAME, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(tap);
  tap.connect(mute);
  mute.connect(context.destination);

  let alive = true;
  let recording = false;
  /** Frames of the utterance so far; `voiced[i]` marks the loud ones. */
  let frames: Float32Array[] = [];
  let voiced: boolean[] = [];
  let ring: Float32Array[] = [];
  let silentMs = 0;
  let loudMs = 0;
  let elapsedMs = 0;
  /** Slow average of the room's noise, so the threshold follows the microphone and the room. */
  let floor = MIN_FLOOR;
  /** Utterances are sent in the order they were spoken, one at a time. */
  let chain: Promise<void> = Promise.resolve();

  function finish() {
    recording = false;
    const lastVoiced = voiced.lastIndexOf(true);
    const kept = frames.slice(0, lastVoiced + 1 + TAIL_FRAMES);
    const speechMs = voiced.filter(Boolean).length * FRAME_MS;
    frames = [];
    voiced = [];
    if (speechMs < MIN_MS * 0.6) {
      hooks.onPhase("listening");
      return;
    }
    hooks.onPhase("thinking");
    chain = chain.then(() => handle(wav(kept))).catch(() => {});
  }

  async function handle(audio: ArrayBuffer) {
    if (!alive) return;
    try {
      // After the learner stops talking, Gemini writes down the words (any language, no hint);
      // the tutor then thinks, and Fish Audio only speaks the answer.
      const text = (await Bridge.transcribe(audio, "audio/wav", "", "gemini")).trim();
      if (!alive) return;
      if (text) await hooks.onUtterance(text);
    } catch (err) {
      if (alive) hooks.onError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      if (alive && !recording) hooks.onPhase("listening");
    }
  }

  tap.onaudioprocess = (e) => {
    if (!alive) return;
    const frame = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0;
    for (const v of frame) sum += v * v;
    const level = Math.sqrt(sum / frame.length);
    const speaking = nowPlaying() !== null;
    elapsedMs += FRAME_MS;

    // Adapt to the room only while nobody (neither the learner nor Mochi) is making sound.
    if (!recording && !speaking) floor = Math.max(MIN_FLOOR, floor * 0.97 + level * 0.03);

    // Mochi's own voice leaks into the microphone a little: while she talks, ask for more.
    const threshold = Math.max(0.015, floor * 2.6) * (speaking ? 2.2 : 1);
    const loud = level > threshold;
    loudMs = loud ? loudMs + FRAME_MS : 0;

    if (!recording) {
      ring.push(frame);
      if (ring.length > PRE_ROLL_FRAMES) ring.shift();
      if (loud && (!speaking || loudMs >= BARGE_IN_MS)) {
        if (speaking) stopSpeaking();
        recording = true;
        frames = [...ring];
        voiced = frames.map(() => false);
        voiced[voiced.length - 1] = true;
        ring = [];
        silentMs = 0;
        elapsedMs = 0;
        hooks.onPhase("hearing");
      }
      return;
    }

    frames.push(frame);
    voiced.push(loud);
    silentMs = loud ? 0 : silentMs + FRAME_MS;
    if (silentMs >= END_SILENCE_MS || elapsedMs >= MAX_UTTERANCE_MS) finish();
  };

  hooks.onPhase("listening");

  return {
    stop() {
      if (!alive) return;
      alive = false;
      tap.onaudioprocess = null;
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
}
