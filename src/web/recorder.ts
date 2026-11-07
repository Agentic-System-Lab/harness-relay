// Records the microphone in the browser and hands back 16 kHz mono samples for whisper.cpp.

import { WHISPER_RATE } from './voice';

export function canRecord(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

/** One recording: `start()`, then `stop()` for the samples or `cancel()`. */
export class Recorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private stopped?: Promise<void>;

  /** Asks for the microphone (the browser prompts the first time) and starts recording. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const recorder = new MediaRecorder(this.stream);
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.stopped = new Promise((resolve) => (recorder.onstop = () => resolve()));
    recorder.start(250);
  }

  /** Stops recording and decodes it to 16 kHz mono. */
  async stop(): Promise<Float32Array> {
    const recorder = this.recorder;
    if (!recorder) return new Float32Array(0);
    if (recorder.state !== 'inactive') recorder.stop();
    await this.stopped;
    this.release();
    const blob = new Blob(this.chunks, { type: recorder.mimeType });
    this.chunks = [];
    if (!blob.size) return new Float32Array(0);
    return decode(await blob.arrayBuffer());
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.chunks = [];
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}

/** Any format the browser recorded (WebM/Opus, MP4/AAC…) as 16 kHz mono samples. */
async function decode(data: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * WHISPER_RATE));
  const offline = new OfflineAudioContext(1, frames, WHISPER_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  // A one-channel context mixes stereo down while it resamples.
  return (await offline.startRendering()).getChannelData(0);
}
