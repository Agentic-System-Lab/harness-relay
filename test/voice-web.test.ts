import { describe, expect, it } from 'vitest';
import type { VoiceJobView, VoiceStatus } from '../src/shared/types';
import {
  encodeWav,
  formatClock,
  insertTranscript,
  isSilent,
  jobPercent,
  jobSecondsLeft,
  setupBytes,
  toBase64,
  voiceMode,
  voicePill,
} from '../src/web/voice';

function status(over: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    ready: false,
    engine: { installed: false, installer: 'download', accel: 'cpu' },
    models: [
      { id: 'base', size: 100, downloaded: true, recommended: false },
      { id: 'small', size: 500, downloaded: false, recommended: true },
    ],
    model: 'small',
    language: 'follow',
    bin: '',
    dir: '/data/voice/models',
    platform: 'linux-x64',
    server: 'stopped',
    ...over,
  };
}

const job = (over: Partial<VoiceJobView> = {}): VoiceJobView => ({
  id: 'j',
  model: 'small',
  state: 'running',
  steps: ['engine', 'model', 'check'],
  step: 'model',
  startedAt: 0,
  log: '',
  ...over,
});

describe('WAV encoding', () => {
  it('writes a 16 kHz mono 16-bit PCM file', () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const v = new DataView(bytes.buffer);
    const ascii = (at: number, len: number) => String.fromCharCode(...bytes.subarray(at, at + len));
    expect(bytes.length).toBe(44 + 12);
    expect(ascii(0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 12);
    expect(ascii(8, 8)).toBe('WAVEfmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(12);
    // Samples are clipped to [-1, 1].
    expect([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });

  it('encodes to base64', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('silence', () => {
  const rate = 16_000;
  const tone = (seconds: number, amp: number) => Float32Array.from({ length: rate * seconds }, (_, i) => amp * Math.sin(i / 8));

  it('skips recordings that are too short or too quiet', () => {
    expect(isSilent(tone(0.2, 0.5))).toBe(true);
    expect(isSilent(new Float32Array(rate * 2))).toBe(true);
    expect(isSilent(tone(2, 0.002))).toBe(true);
    expect(isSilent(tone(2, 0.2))).toBe(false);
  });

  it('notices a short phrase in a long silence', () => {
    const samples = new Float32Array(rate * 10);
    samples.set(tone(0.5, 0.3), rate * 4);
    expect(isSilent(samples)).toBe(false);
  });
});

describe('inserting a transcript', () => {
  it('goes at the caret, or replaces the selection', () => {
    expect(insertTranscript('', 0, 0, '你好')).toEqual({ text: '你好', caret: 2 });
    expect(insertTranscript('請幫我。', 3, 3, '看一下')).toEqual({ text: '請幫我看一下。', caret: 6 });
    expect(insertTranscript('fix the bug', 4, 7, 'that')).toEqual({ text: 'fix that bug', caret: 8 });
  });

  it('adds a space only where Latin words would run together', () => {
    expect(insertTranscript('@claude', 7, 7, 'please review')).toEqual({ text: '@claude please review', caret: 21 });
    expect(insertTranscript('Done.', 5, 5, 'Next')).toEqual({ text: 'Done. Next', caret: 10 });
    expect(insertTranscript('word', 0, 0, 'first')).toEqual({ text: 'first word', caret: 6 });
    expect(insertTranscript('用 React 寫', 9, 9, '一個元件')).toEqual({ text: '用 React 寫一個元件', caret: 13 });
    expect(insertTranscript('改成', 2, 2, 'TypeScript')).toEqual({ text: '改成TypeScript', caret: 12 });
    expect(insertTranscript('hello ', 6, 6, 'world')).toEqual({ text: 'hello world', caret: 11 });
  });

  it('leaves the text alone when nothing was heard', () => {
    expect(insertTranscript('abc', 1, 2, '  ')).toEqual({ text: 'abc', caret: 2 });
  });
});

describe('voice status in the UI', () => {
  it('decides what the microphone does', () => {
    expect(voiceMode(status(), false)).toBe('unsupported');
    expect(voiceMode(null, true)).toBe('setup');
    expect(voiceMode(status(), true)).toBe('setup');
    expect(voiceMode(status({ job: job() }), true)).toBe('installing');
    expect(voiceMode(status({ ready: true }), true)).toBe('ready');
    expect(voiceMode(status({ ready: true, job: job({ state: 'failed' }) }), true)).toBe('ready');
  });

  it('labels the Settings card', () => {
    expect(voicePill(status())).toBe('off');
    expect(voicePill(status({ job: job() }))).toBe('installing');
    expect(voicePill(status({ ready: true }))).toBe('ready');
    expect(voicePill(status({ engine: { installed: true, installer: 'download', accel: 'cpu' } }))).toBe('needsModel');
    expect(voicePill(status({ engine: { installed: false, installer: 'download', accel: 'cpu', problem: 'missing' } }))).toBe('broken');
  });

  it('shows what is left to download', () => {
    expect(setupBytes(status())).toBe(500);
    expect(setupBytes(status(), 'base')).toBe(0);
    const engine = { installed: false, installer: 'download' as const, accel: 'cpu' as const, downloadSize: 9 };
    expect(setupBytes(status({ engine }))).toBe(509);
    expect(setupBytes(status({ engine: { ...engine, installed: true } }))).toBe(500);
  });

  it('shows download progress', () => {
    expect(jobPercent(job())).toBeUndefined();
    expect(jobPercent(job({ received: 250, total: 1000 }))).toBe(25);
    expect(jobPercent(job({ received: 1000, total: 1000 }))).toBe(100);
    expect(jobSecondsLeft(job({ received: 250, total: 1000 }))).toBeUndefined();
    expect(jobSecondsLeft(job({ received: 250, total: 1000, bytesPerSecond: 50 }))).toBe(15);
    expect(formatClock(7.9)).toBe('0:07');
    expect(formatClock(65)).toBe('1:05');
  });
});
