// Recording the learner's voice for speech recognition. The audio lives in
// memory only: it goes to Fish Audio for transcription and nowhere else, and is
// never written to disk.

import { Bridge } from "./bridge";

export interface Recording {
  /** Stops and returns what was recorded. */
  stop(): Promise<{ bytes: ArrayBuffer; mime: string; ms: number }>;
  /** Stops and throws the audio away. */
  cancel(): void;
}

/** A spoken sentence or two; longer recordings are cut here. */
const MAX_MS = 30_000;

function friendly(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it for Kotoba in Windows Settings → Privacy → Microphone.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `Could not use the microphone: ${String(err)}`;
}

function pickMime(): string {
  const wanted = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return wanted.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Recording isn't available here.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    throw new Error(friendly(err));
  }
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  const started = performance.now();
  let cancelled = false;
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  recorder.start();
  const timer = window.setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, MAX_MS);

  return {
    async stop() {
      window.clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
      await finished;
      release();
      const type = recorder.mimeType || mime || "audio/webm";
      const blob = new Blob(chunks, { type });
      return { bytes: await blob.arrayBuffer(), mime: type, ms: performance.now() - started };
    },
    cancel() {
      cancelled = true;
      window.clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
      release();
      void cancelled;
    },
  };
}

/** Recordings shorter than this are almost surely a mis-click. */
export const MIN_MS = 400;

/** Records, then turns the audio into text. Use `begin()` on press and `end()` on release. */
export function dictation() {
  let rec: Recording | null = null;
  return {
    get active() {
      return rec !== null;
    },
    async begin(): Promise<void> {
      if (rec) return;
      rec = await startRecording();
    },
    /** The transcript, or null when the recording was too short to be speech. */
    async end(): Promise<string | null> {
      const r = rec;
      rec = null;
      if (!r) return null;
      const { bytes, mime, ms } = await r.stop();
      if (ms < MIN_MS) return null;
      return (await Bridge.transcribe(bytes, mime)).trim();
    },
    cancel() {
      rec?.cancel();
      rec = null;
    },
  };
}
