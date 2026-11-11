import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { availableParallelism } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  VOICE_MAX_SECONDS,
  VOICE_MODELS,
  type Lang,
  type LoginState,
  type VoiceEngineInfo,
  type VoiceJobStep,
  type VoiceJobView,
  type VoiceLanguage,
  type VoiceModelId,
  type VoiceSettingsUpdate,
  type VoiceStatus,
} from '../shared/types';
import { CONFIG } from './config';
import { HttpError } from './errors';
import { voiceFolder } from './protect';
import { currentLang, t } from './i18n';
import { runProcess, tail, type SpawnOptions, type SpawnResult } from './process';
import { DATA_DIR, type SettingsStore } from './settings';
import { expandPath } from './validate';

/*
 * Voice input: speech is turned into text on this computer by whisper.cpp (`whisper-server`).
 *
 * Nothing is installed until the user asks for it. An install is a background job: the engine
 * (Homebrew on macOS, the official prebuilt build on Linux and Windows), then the model, then a
 * check that the engine starts with it. Every download is pinned and checked by SHA-256.
 *
 * The engine runs as a child process started on first use and stopped after a while without use.
 * It listens on 127.0.0.1 on a random port under a random path prefix, so other pages in the
 * browser cannot reach it (whisper-server itself allows any origin).
 */

/** Multilingual whisper.cpp models on Hugging Face, pinned to one commit of the repository. */
const MODEL_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
export const MODEL_FILES: Record<VoiceModelId, { file: string; size: number; sha256: string }> = {
  base: { file: 'ggml-base.bin', size: 147_951_465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  small: { file: 'ggml-small.bin', size: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  'large-v3-turbo-q5_0': {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    size: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
  'large-v3-turbo': {
    file: 'ggml-large-v3-turbo.bin',
    size: 1_624_555_275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  },
  'large-v3-q5_0': {
    file: 'ggml-large-v3-q5_0.bin',
    size: 1_081_140_203,
    sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
  },
};

/** Where the models come from unless `RELAY_VOICE_MODEL_BASE_URL` names another folder holding them. */
export const MODEL_BASE_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_COMMIT}`;

/** A model's address: in `base`, a folder holding the model files (each checked by its size and SHA-256 all the same). */
export function modelUrl(id: VoiceModelId, base = MODEL_BASE_URL): string {
  return `${base}/${MODEL_FILES[id].file}`;
}

/** The official prebuilt engines of one whisper.cpp release (v1.9.5), per `<platform>-<arch>`. */
export const ENGINE_TAG = 'b5454';
export interface EngineBuild {
  asset: string;
  size: number;
  sha256: string;
  /** `whisper-server` inside the archive. */
  server: string;
}
export const ENGINE_BUILDS: Record<string, EngineBuild> = {
  'linux-x64': {
    asset: 'whisper-bin-ubuntu-x64.tar.gz',
    size: 10_364_195,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
    server: 'whisper-bin-ubuntu-x64/whisper-server',
  },
  'linux-arm64': {
    asset: 'whisper-bin-ubuntu-arm64.tar.gz',
    size: 4_608_377,
    sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149',
    server: 'whisper-bin-ubuntu-arm64/whisper-server',
  },
  'win32-x64': {
    asset: 'whisper-bin-x64.zip',
    size: 8_928_640,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    server: 'Release/whisper-server.exe',
  },
  'win32-arm64': {
    asset: 'whisper-bin-win-cpu-arm64.zip',
    size: 4_371_193,
    sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d',
    server: 'Release/whisper-server.exe',
  },
};

/** Where the engines come from unless `RELAY_VOICE_ENGINE_BASE_URL` names another folder holding them. */
export const ENGINE_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${ENGINE_TAG}`;

/** An engine's address: in `base`, a folder holding the release's archives (each checked by its size and SHA-256 all the same). */
export function engineUrl(b: EngineBuild, base = ENGINE_BASE_URL): string {
  return `${base}/${b.asset}`;
}

/** Where the engine Harness Relay downloads ends up (`dir` is the voice data folder). */
export function relayEnginePath(dir: string, platform: string, arch: string): string | undefined {
  const build = ENGINE_BUILDS[`${platform}-${arch}`];
  return build && join(dir, 'engine', ENGINE_TAG, build.server);
}

/** Where Homebrew puts its commands; a server started outside a terminal may not have them on PATH. */
export const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];

/** The engine stops after this long without use, which frees the memory the model takes. */
const IDLE_MS = 10 * 60 * 1000;
/** Loading a large model the first time (and compiling Metal shaders) can take a while. */
const START_TIMEOUT_MS = 3 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 1000;
/** Room kept free on the disk besides the download itself. */
const SPARE_BYTES = 200 * 1024 * 1024;

/** Steers Whisper to write Chinese in Traditional characters. It is decoder context, so it stays in Chinese. */
const ZH_HANT_PROMPT = '以下是繁體中文的句子。';

/** The model suggested for a computer: Apple silicon runs the large model on its GPU; elsewhere it runs on the CPU. */
export function recommendedModel(platform: string, arch: string): VoiceModelId {
  return platform === 'darwin' && arch === 'arm64' ? 'large-v3-turbo-q5_0' : 'small';
}

/** What to ask whisper.cpp for: the spoken language, and a prompt that picks the script. */
export function whisperLanguage(setting: VoiceLanguage, ui: Lang): { language: string; prompt?: string } {
  if (setting === 'en' || (setting === 'follow' && ui === 'en')) return { language: 'en' };
  if (setting === 'auto') return ui === 'zh-TW' ? { language: 'auto', prompt: ZH_HANT_PROMPT } : { language: 'auto' };
  return { language: 'zh', prompt: ZH_HANT_PROMPT };
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？、；：「」『』（）]/u;

/** The text Whisper heard, as one line: no markers such as [BLANK_AUDIO], no spaces between CJK segments. */
export function cleanTranscript(text: string): string {
  const lines = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[(（][^)）]*(音樂|音乐|掌聲|掌声|music|applause|silence)[^)）]*[)）]/giu, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let out = '';
  for (const line of lines) {
    if (!out) out = line;
    else out += CJK.test(out.at(-1)!) && CJK.test(line[0]!) ? line : ` ${line}`;
  }
  // Whisper puts spaces between segments; keep them only where a Latin word meets another.
  return out.replace(new RegExp(`(?<=${CJK.source}) +(?=${CJK.source})`, 'gu'), '');
}

/** `name` on PATH (with PATHEXT on Windows), then in `extra` directories. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: string,
  extra: string[] = [],
  isFile: (p: string) => boolean = fileExists,
): string | undefined {
  // `platform`'s own separators, whichever system this runs on.
  const { delimiter, join: joinPath } = platform === 'win32' ? win32 : posix;
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter), ...extra].filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = joinPath(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return undefined;
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Bytes as the user reads them (server messages). */
function formatSize(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

/** Duration of a 16-bit PCM WAV file, in seconds; undefined when it is not one. */
export function wavSeconds(wav: Buffer): number | undefined {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  const byteRate = wav.readUInt32LE(28);
  return byteRate ? (wav.length - 44) / byteRate : undefined;
}

/** An error whose message is rendered when it is shown, in the language of whoever looks. */
class VoiceError extends Error {
  constructor(readonly render: () => string) {
    super(render());
  }
}

/** What the service needs from the computer; tests swap in fakes. */
export interface VoiceHost {
  platform: string;
  arch: string;
  env: NodeJS.ProcessEnv;
  /** Models and the downloaded engine live here. */
  dir: string;
  /**
   * The empty folder the engine serves static files from (`--public`), which only Harness Relay writes
   * in: `public` in its own `dir`; beside the data folder's `voice` for a folder `RELAY_VOICE_DIR` names,
   * where a `public` of the user's own may already be (and whisper-server lets any page read it).
   */
  publicDir: string;
  /**
   * Whether `dir` is Harness Relay's own (`voice` in its data folder), which removing voice input
   * deletes whole; a folder `RELAY_VOICE_DIR` names keeps everything Harness Relay did not put there.
   */
  ownDir: boolean;
  /** The folder the models are downloaded from (`RELAY_VOICE_MODEL_BASE_URL`, else Hugging Face). */
  modelBaseUrl: string;
  /** The folder the engines are downloaded from (`RELAY_VOICE_ENGINE_BASE_URL`, else GitHub). */
  engineBaseUrl: string;
  fetch: typeof fetch;
  run: (o: SpawnOptions) => Promise<SpawnResult>;
  freePort: () => Promise<number>;
  freeBytes: (dir: string) => number;
  /** Where Homebrew's commands are, besides PATH. */
  brewDirs: string[];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function freeBytes(dir: string): number {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

type Installer = { kind: 'homebrew'; brew: string } | { kind: 'download'; build: EngineBuild } | { kind: 'none'; note: () => string };

class InstallJob {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly abort = new AbortController();
  state: LoginState = 'running';
  step: VoiceJobStep;
  received?: number;
  total?: number;
  bytesPerSecond?: number;
  finishedAt?: number;
  private log = '';
  private error?: () => string;
  private mark = { at: 0, bytes: 0 };

  constructor(
    readonly model: VoiceModelId,
    readonly steps: VoiceJobStep[],
  ) {
    this.step = steps[0]!;
  }

  begin(step: VoiceJobStep): void {
    this.step = step;
    this.received = this.total = this.bytesPerSecond = undefined;
  }

  append(text: string): void {
    this.log += text;
    if (this.log.length > 32_000) this.log = this.log.slice(-32_000);
  }

  startDownload(total: number): void {
    this.received = 0;
    this.total = total;
    this.bytesPerSecond = undefined;
    this.mark = { at: Date.now(), bytes: 0 };
  }

  progress(received: number): void {
    this.received = received;
    const now = Date.now();
    if (now - this.mark.at >= 1000) {
      const speed = ((received - this.mark.bytes) * 1000) / (now - this.mark.at);
      this.bytesPerSecond = this.bytesPerSecond === undefined ? speed : this.bytesPerSecond * 0.6 + speed * 0.4;
      this.mark = { at: now, bytes: received };
    }
  }

  finish(state: Exclude<LoginState, 'running'>, error?: () => string): void {
    this.state = state;
    this.error = error;
    this.finishedAt = Date.now();
  }

  view(): VoiceJobView {
    return {
      id: this.id,
      model: this.model,
      state: this.state,
      steps: this.steps,
      step: this.step,
      received: this.received,
      total: this.total,
      bytesPerSecond: this.bytesPerSecond === undefined ? undefined : Math.round(this.bytesPerSecond),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      log: this.log,
      error: this.error?.(),
    };
  }
}

interface EngineProcess {
  model: VoiceModelId;
  bin: string;
  /** http://127.0.0.1:<port>/<secret> */
  base: string;
  state: 'starting' | 'running' | 'stopped';
  ready: Promise<void>;
  stop: AbortController;
}

export class VoiceService {
  private host: VoiceHost;
  private job?: InstallJob;
  private proc?: EngineProcess;
  private idle?: NodeJS.Timeout;

  constructor(
    private settings: SettingsStore,
    host: Partial<VoiceHost> = {},
  ) {
    this.host = {
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      dir: voiceFolder(),
      publicDir: CONFIG.voiceDir ? join(DATA_DIR, 'voice-public') : join(DATA_DIR, 'voice', 'public'),
      ownDir: !CONFIG.voiceDir,
      modelBaseUrl: CONFIG.voiceModelBaseUrl ?? MODEL_BASE_URL,
      engineBaseUrl: CONFIG.voiceEngineBaseUrl ?? ENGINE_BASE_URL,
      fetch: (...args) => fetch(...args),
      run: runProcess,
      freePort,
      freeBytes,
      brewDirs: BREW_DIRS,
      ...host,
    };
  }

  private get modelsDir(): string {
    return join(this.host.dir, 'models');
  }

  private modelPath(id: VoiceModelId): string {
    return join(this.modelsDir, MODEL_FILES[id].file);
  }

  private hasModel(id: VoiceModelId): boolean {
    try {
      return statSync(this.modelPath(id)).size === MODEL_FILES[id].size;
    } catch {
      return false;
    }
  }

  /** The selected model, or the one recommended for this computer. */
  private model(): VoiceModelId {
    return this.settings.voice.model ?? recommendedModel(this.host.platform, this.host.arch);
  }

  private installer(): Installer {
    const { platform, arch, env } = this.host;
    if (platform === 'darwin') {
      const brew = findOnPath('brew', env, platform, this.host.brewDirs);
      return brew ? { kind: 'homebrew', brew } : { kind: 'none', note: () => t().voiceNeedsHomebrew };
    }
    const build = ENGINE_BUILDS[`${platform}-${arch}`];
    return build ? { kind: 'download', build } : { kind: 'none', note: () => t().voiceNoBuild(`${platform}-${arch}`) };
  }

  /** The engine this computer would use: the path set in Settings, the one downloaded here, or one on PATH. */
  engine(): VoiceEngineInfo {
    const { platform, arch, env } = this.host;
    const installer = this.installer();
    // Homebrew's build uses Metal; it is the GPU only on Apple silicon.
    const accel: VoiceEngineInfo['accel'] = platform === 'darwin' && arch === 'arm64' ? 'metal' : 'unknown';
    const base: VoiceEngineInfo = {
      installed: false,
      installer: installer.kind,
      installerNote: installer.kind === 'none' ? installer.note() : undefined,
      downloadSize: installer.kind === 'download' ? installer.build.size : undefined,
      accel,
    };
    const custom = this.settings.voice.bin;
    if (custom) {
      const path = /[\\/]|^~/.test(custom) ? (fileExists(expandPath(custom)) ? expandPath(custom) : undefined) : findOnPath(custom, env, platform);
      return path ? { ...base, installed: true, path, source: 'custom' } : { ...base, problem: t().voiceBinNotFound(custom) };
    }
    const relay = relayEnginePath(this.host.dir, platform, arch);
    if (relay && fileExists(relay)) return { ...base, installed: true, path: relay, source: 'relay', version: ENGINE_TAG, accel: 'cpu' };
    const found = findOnPath('whisper-server', env, platform, platform === 'win32' ? [] : this.host.brewDirs);
    if (!found) return base;
    let real = found;
    try {
      real = realpathSync(found);
    } catch {
      /* keep the link */
    }
    const cellar = /\/Cellar\/[^/]+\/([^/]+)\//.exec(real);
    return { ...base, installed: true, path: found, source: cellar ? 'homebrew' : 'path', version: cellar?.[1] };
  }

  status(): VoiceStatus {
    const engine = this.engine();
    const model = this.model();
    const recommended = recommendedModel(this.host.platform, this.host.arch);
    const { language, bin } = this.settings.voice;
    return {
      ready: engine.installed && this.hasModel(model),
      engine,
      models: VOICE_MODELS.map((id) => ({ id, size: MODEL_FILES[id].size, downloaded: this.hasModel(id), recommended: id === recommended })),
      model,
      language,
      bin,
      dir: this.host.dir,
      platform: `${this.host.platform}-${this.host.arch}`,
      job: this.job?.view(),
      server: this.proc?.state ?? 'stopped',
    };
  }

  update(u: VoiceSettingsUpdate): VoiceStatus {
    const before = this.settings.voice;
    this.settings.setVoice(u);
    // The running engine has the old model or binary loaded: the next use starts the new one.
    if ((u.model && u.model !== this.proc?.model) || (u.bin !== undefined && u.bin.trim() !== before.bin)) this.stopServer();
    return this.status();
  }

  /** Starts a background install of whatever is missing for `model`, which then becomes the selected model. */
  install(model: VoiceModelId): VoiceStatus {
    if (this.job?.state === 'running') throw new HttpError(409, t().voiceBusy);
    const engine = this.engine();
    const steps: VoiceJobStep[] = [];
    let installer: Installer | undefined;
    let need = 0;
    if (!engine.installed) {
      if (engine.problem) throw new HttpError(400, engine.problem);
      installer = this.installer();
      if (installer.kind === 'none') throw new HttpError(400, installer.note());
      steps.push('engine');
      if (installer.kind === 'download') need += installer.build.size * 4; // the archive and what it unpacks to
    }
    if (!this.hasModel(model)) {
      steps.push('model');
      need += MODEL_FILES[model].size;
    }
    steps.push('check');
    if (need) {
      mkdirSync(this.host.dir, { recursive: true });
      const free = this.host.freeBytes(this.host.dir);
      if (free < need + SPARE_BYTES) throw new HttpError(400, t().voiceNoSpace(formatSize(need), formatSize(free)));
    }
    const job = new InstallJob(model, steps);
    this.job = job;
    void this.runJob(job, installer);
    return this.status();
  }

  cancel(): VoiceStatus {
    if (this.job?.state !== 'running') throw new HttpError(409, t().voiceNoJob);
    this.job.abort.abort();
    return this.status();
  }

  deleteModel(id: VoiceModelId): VoiceStatus {
    if (this.job?.state === 'running' && this.job.model === id) throw new HttpError(409, t().voiceModelBusy);
    if (this.proc?.model === id) this.stopServer();
    rmSync(this.modelPath(id), { force: true });
    rmSync(`${this.modelPath(id)}.part`, { force: true });
    return this.status();
  }

  /** Deletes the models and the engine Harness Relay downloaded (an engine from Homebrew stays). */
  uninstall(): VoiceStatus {
    if (this.job?.state === 'running') throw new HttpError(409, t().voiceBusy);
    this.stopServer();
    if (this.host.ownDir) rmSync(this.host.dir, { recursive: true, force: true });
    else this.removeOwnFiles();
    this.job = undefined;
    return this.status();
  }

  /**
   * What Harness Relay put in a folder `RELAY_VOICE_DIR` names: the models, this version's engine and
   * what its download left, then the folders it made once they are empty. Anything else stays.
   */
  private removeOwnFiles(): void {
    const engine = join(this.host.dir, 'engine');
    for (const m of Object.values(MODEL_FILES)) {
      for (const f of [m.file, `${m.file}.part`]) rmSync(join(this.modelsDir, f), { force: true });
    }
    for (const d of [ENGINE_TAG, `${ENGINE_TAG}.tmp`]) rmSync(join(engine, d), { recursive: true, force: true });
    for (const b of Object.values(ENGINE_BUILDS)) {
      for (const f of [b.asset, `${b.asset}.part`]) rmSync(join(engine, f), { force: true });
    }
    rmSync(this.host.publicDir, { recursive: true, force: true });
    for (const d of [this.modelsDir, engine, this.host.dir]) {
      try {
        rmdirSync(d);
      } catch {
        /* missing, or holds something else */
      }
    }
  }

  /** Starts the engine ahead of a transcription (while the user speaks). */
  prepare(): void {
    if (this.status().ready) void this.ensureServer().catch(() => {});
  }

  async transcribe(wav: Buffer): Promise<string> {
    const seconds = wavSeconds(wav);
    if (seconds === undefined) throw new HttpError(400, t().voiceBadAudio);
    if (seconds > VOICE_MAX_SECONDS + 5) throw new HttpError(400, t().voiceTooLong(VOICE_MAX_SECONDS));
    let base: string;
    try {
      base = await this.ensureServer();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, (err as Error).message);
    }
    const { language, prompt } = whisperLanguage(this.settings.voice.language, currentLang());
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
    form.set('response_format', 'json');
    form.set('temperature', '0');
    form.set('language', language);
    if (prompt) form.set('prompt', prompt);
    let res: Response;
    let body: string;
    try {
      res = await this.host.fetch(`${base}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
      body = await res.text();
    } catch (err) {
      throw new HttpError(503, t().voiceTranscribeFailed((err as Error).message));
    } finally {
      this.touch();
    }
    let data: { text?: unknown; error?: unknown } = {};
    try {
      data = JSON.parse(body) as typeof data;
    } catch {
      /* not JSON */
    }
    if (!res.ok || data.error) throw new HttpError(503, t().voiceTranscribeFailed(String(data.error ?? (body.slice(0, 300) || `HTTP ${res.status}`))));
    return cleanTranscript(String(data.text ?? ''));
  }

  shutdown(): void {
    if (this.job?.state === 'running') this.job.abort.abort();
    this.stopServer();
  }

  // --- Install ---------------------------------------------------------------------

  private async runJob(job: InstallJob, installer: Installer | undefined): Promise<void> {
    try {
      for (const step of job.steps) {
        if (job.abort.signal.aborted) throw new Error('aborted');
        job.begin(step);
        if (step === 'engine') await this.installEngine(job, installer!);
        else if (step === 'model') await this.downloadModel(job);
        else await this.check(job);
      }
      if (this.settings.voice.model !== job.model) this.update({ model: job.model });
      job.finish('success');
    } catch (err) {
      if (job.abort.signal.aborted) job.finish('cancelled', () => t().voiceCancelled);
      else job.finish('failed', err instanceof VoiceError ? err.render : () => (err as Error).message);
    }
  }

  private async installEngine(job: InstallJob, installer: Installer): Promise<void> {
    const signal = job.abort.signal;
    if (installer.kind === 'homebrew') {
      job.append('$ brew install whisper-cpp\n');
      const r = await this.host.run({
        bin: installer.brew,
        args: ['install', 'whisper-cpp'],
        // No `brew update` first (it can take minutes), no prompts, no hints.
        env: { ...this.host.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' },
        signal,
        timeoutMs: 30 * 60 * 1000,
        onLine: (l) => job.append(`${l}\n`),
        onSpawn: (child) => child.stderr?.on('data', (b: Buffer) => job.append(b.toString('utf8'))),
      });
      if (r.aborted) throw new Error('aborted');
      if (r.code !== 0) {
        const detail = tail(r.stderr || r.stdout, 400) || `exit ${r.code}`;
        throw new VoiceError(() => t().voiceBrewFailed(detail));
      }
      if (!this.engine().installed) throw new VoiceError(() => t().voiceEngineBroken('whisper-server not found after brew install'));
      return;
    }
    if (installer.kind !== 'download') throw new VoiceError(installer.note);
    const { build } = installer;
    const dir = join(this.host.dir, 'engine');
    mkdirSync(dir, { recursive: true });
    const archive = join(dir, build.asset);
    const url = engineUrl(build, this.host.engineBaseUrl);
    job.append(`${url}\n`);
    await this.download(job, url, archive, build.size, build.sha256, build.asset);
    const unpacked = join(dir, `${ENGINE_TAG}.tmp`);
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    // tar reads .tar.gz everywhere, and .zip on Windows 10+ (bsdtar).
    job.append(`$ tar -xf ${build.asset}\n`);
    const r = await this.host.run({ bin: 'tar', args: ['-xf', archive, '-C', unpacked], env: this.host.env, signal, timeoutMs: 5 * 60 * 1000 });
    rmSync(archive, { force: true });
    if (r.aborted) throw new Error('aborted');
    if (r.code !== 0 || !fileExists(join(unpacked, build.server))) {
      rmSync(unpacked, { recursive: true, force: true });
      const detail = tail(r.stderr || r.stdout, 400) || `${build.server} missing`;
      throw new VoiceError(() => t().voiceExtractFailed(detail));
    }
    const target = join(dir, ENGINE_TAG);
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
    if (this.host.platform !== 'win32') chmodSync(join(target, build.server), 0o755);
  }

  private async downloadModel(job: InstallJob): Promise<void> {
    const m = MODEL_FILES[job.model];
    mkdirSync(this.modelsDir, { recursive: true });
    const url = modelUrl(job.model, this.host.modelBaseUrl);
    job.append(`${url}\n`);
    await this.download(job, url, this.modelPath(job.model), m.size, m.sha256, m.file);
  }

  /** Streams `url` to `dest`, checking its size and SHA-256; nothing is left behind when that fails. */
  private async download(job: InstallJob, url: string, dest: string, bytes: number, sha256: string, name: string): Promise<void> {
    const signal = job.abort.signal;
    const part = `${dest}.part`;
    job.startDownload(bytes);
    let res: Response;
    try {
      res = await this.host.fetch(url, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      const detail = (err as Error).message;
      throw new VoiceError(() => t().voiceDownloadFailed(name, detail));
    }
    if (!res.ok || !res.body) throw new VoiceError(() => t().voiceDownloadFailed(name, `HTTP ${res.status}`));
    const hash = createHash('sha256');
    let received = 0;
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream),
        new Transform({
          transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
            hash.update(chunk);
            received += chunk.length;
            if (received > bytes) return done(new Error(`more than ${bytes} bytes`));
            job.progress(received);
            done(null, chunk);
          },
        }),
        createWriteStream(part, { mode: 0o644 }),
        { signal },
      );
    } catch (err) {
      rmSync(part, { force: true });
      if (signal.aborted) throw err;
      const detail = (err as Error).message;
      throw new VoiceError(() => t().voiceDownloadFailed(name, detail));
    }
    if (received !== bytes || hash.digest('hex') !== sha256) {
      rmSync(part, { force: true });
      throw new VoiceError(() => t().voiceChecksumMismatch(name));
    }
    renameSync(part, dest);
  }

  /** The engine runs (its libraries load) and starts with the model, so the first use is quick. */
  private async check(job: InstallJob): Promise<void> {
    const engine = this.engine();
    if (!engine.installed) throw new VoiceError(() => engine.problem ?? t().voiceNotReady);
    job.append(`$ ${engine.path} --help\n`);
    const r = await this.host.run({ bin: engine.path!, args: ['--help'], env: this.host.env, signal: job.abort.signal, timeoutMs: 30_000 });
    if (r.aborted) throw new Error('aborted');
    const out = `${r.stdout}${r.stderr}`;
    if (r.code !== 0 && !/usage/i.test(out)) {
      const detail = tail(out, 400) || `exit ${r.code}`;
      throw new VoiceError(() => t().voiceEngineBroken(detail));
    }
    job.append(`$ whisper-server --model ${MODEL_FILES[job.model].file}\n`);
    await this.ensureServer(job.model, job.abort.signal);
  }

  // --- The engine process ----------------------------------------------------------

  /** The running engine's base URL, starting it (with `model`, by default the selected one) if needed. */
  private async ensureServer(model = this.model(), signal?: AbortSignal): Promise<string> {
    const engine = this.engine();
    if (!engine.installed || !this.hasModel(model)) throw new HttpError(409, t().voiceNotReady);
    let proc = this.proc;
    if (!proc || proc.state === 'stopped' || proc.model !== model || proc.bin !== engine.path) {
      this.stopServer();
      proc = this.startServer(engine.path!, model);
      this.proc = proc;
    }
    const current = proc;
    const onAbort = () => this.proc === current && this.stopServer();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await current.ready;
    } catch (err) {
      if (this.proc === current) this.stopServer();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    this.touch();
    return current.base;
  }

  private startServer(bin: string, model: VoiceModelId): EngineProcess {
    const stop = new AbortController();
    const secret = randomBytes(16).toString('hex');
    const proc: EngineProcess = { model, bin, base: '', state: 'starting', ready: Promise.resolve(), stop };
    proc.ready = (async () => {
      const port = await this.host.freePort();
      proc.base = `http://127.0.0.1:${port}/${secret}`;
      // whisper-server also serves static files from --public: point it at an empty folder of our own.
      const { publicDir } = this.host;
      mkdirSync(publicDir, { recursive: true });
      const threads = String(Math.max(1, Math.min(8, availableParallelism())));
      const args = [
        '--model', this.modelPath(model),
        '--host', '127.0.0.1',
        '--port', String(port),
        '--request-path', `/${secret}`,
        '--public', publicDir,
        '--threads', threads,
        '--no-timestamps',
        '--suppress-nst',
      ];
      let exited: SpawnResult | Error | undefined;
      const done = this.host
        .run({ bin, args, env: this.host.env, cwd: this.host.dir, signal: stop.signal })
        .then(
          (r) => (exited = r),
          (err: Error) => (exited = err),
        )
        .finally(() => {
          proc.state = 'stopped';
          if (this.proc === proc) this.proc = undefined;
        });
      const deadline = Date.now() + START_TIMEOUT_MS;
      for (;;) {
        if (stop.signal.aborted) throw new Error('aborted');
        if (exited) {
          const e = exited;
          const detail = e instanceof Error ? e.message : tail(e.stderr || e.stdout, 400) || `exit ${e.code}`;
          throw new VoiceError(() => t().voiceServerFailed(detail));
        }
        try {
          const res = await this.host.fetch(`${proc.base}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) break;
        } catch {
          /* not listening yet: the model is still loading */
        }
        if (Date.now() > deadline) {
          stop.abort();
          throw new VoiceError(() => t().voiceServerFailed('timed out'));
        }
        await Promise.race([done, new Promise((r) => setTimeout(r, 250))]);
      }
      proc.state = 'running';
    })();
    proc.ready.catch(() => {}); // awaited by ensureServer; never an unhandled rejection
    return proc;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stopServer(), IDLE_MS);
    this.idle.unref();
  }

  private stopServer(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const proc = this.proc;
    this.proc = undefined;
    if (proc) {
      proc.state = 'stopped';
      proc.stop.abort();
    }
  }
}
