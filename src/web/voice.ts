// Voice input helpers without the DOM, so they can be tested: WAV encoding, silence, inserting the
// transcript at the caret, and the install job's progress.

import type { VoiceJobView, VoiceStatus } from '../shared/types';

/** The sample rate whisper.cpp works at. */
export const WHISPER_RATE = 16_000;

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = WHISPER_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/**
 * Nothing worth transcribing: too short, or never louder than background noise. Whisper makes up
 * text for silence ("Thanks for watching"), so silence is not sent at all.
 */
export function isSilent(samples: Float32Array, sampleRate = WHISPER_RATE): boolean {
  if (samples.length < sampleRate * 0.3) return true;
  // The loudest 50 ms window, so a short phrase in a long silence still counts.
  const win = Math.max(1, Math.round(sampleRate * 0.05));
  let loudest = 0;
  for (let start = 0; start < samples.length; start += win) {
    let sum = 0;
    const end = Math.min(samples.length, start + win);
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
    loudest = Math.max(loudest, Math.sqrt(sum / (end - start)));
  }
  return loudest < 0.01;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

const WORD = /[\p{Script=Latin}\p{N}]/u;

/**
 * `text` with the selection [start, end) replaced by `insert`, and where the caret goes after it. A
 * space is added where a Latin word would otherwise run into another; CJK text gets none.
 */
export function insertTranscript(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  let piece = insert.trim();
  if (!piece) return { text, caret: end };
  const prev = before.at(-1);
  const next = after[0];
  if (prev && WORD.test(prev) && WORD.test(piece[0]!)) piece = ` ${piece}`;
  else if (prev && /[.,!?;:]/.test(prev) && WORD.test(piece[0]!)) piece = ` ${piece}`;
  if (next && WORD.test(next) && WORD.test(piece.at(-1)!)) piece = `${piece} `;
  return { text: before + piece + after, caret: before.length + piece.length };
}

/** 0:07, 1:05 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Percent of the current download, when the job is downloading. */
export function jobPercent(job: VoiceJobView): number | undefined {
  if (job.received === undefined || !job.total) return undefined;
  return Math.min(100, Math.floor((job.received / job.total) * 100));
}

/** Seconds left of the current download at its recent speed. */
export function jobSecondsLeft(job: VoiceJobView): number | undefined {
  if (job.received === undefined || !job.total || !job.bytesPerSecond) return undefined;
  return Math.max(0, Math.round((job.total - job.received) / job.bytesPerSecond));
}

/** What the mic button does when pressed. */
export type VoiceMode = 'unsupported' | 'setup' | 'installing' | 'ready';

export function voiceMode(status: VoiceStatus | null, browserCanRecord: boolean): VoiceMode {
  if (!browserCanRecord) return 'unsupported';
  if (status?.job?.state === 'running') return 'installing';
  return status?.ready ? 'ready' : 'setup';
}

/** Bytes still to download for `model`: the model, and the engine where Harness Relay downloads it. */
export function setupBytes(status: VoiceStatus, model = status.model): number {
  const m = status.models.find((x) => x.id === model);
  const engine = status.engine.installed ? 0 : (status.engine.downloadSize ?? 0);
  return (m && !m.downloaded ? m.size : 0) + engine;
}

/** The state Settings shows for voice input. */
export type VoicePill = 'off' | 'installing' | 'ready' | 'needsModel' | 'broken';

export function voicePill(s: VoiceStatus): VoicePill {
  if (s.job?.state === 'running') return 'installing';
  if (s.ready) return 'ready';
  if (s.engine.problem) return 'broken';
  return s.engine.installed ? 'needsModel' : 'off';
}
