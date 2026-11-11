import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VOICE_MAX_SECONDS } from '../src/shared/types';
import { createApp } from '../src/server/app';
import { openDatabase } from '../src/server/db';
import { HttpError } from '../src/server/errors';
import { Hub } from '../src/server/hub';
import { withLang } from '../src/server/i18n';
import { Orchestrator } from '../src/server/orchestrator';
import type { SpawnOptions, SpawnResult } from '../src/server/process';
import { ProviderService } from '../src/server/providers';
import { SettingsStore } from '../src/server/settings';
import { Store } from '../src/server/store';
import {
  ENGINE_BASE_URL,
  ENGINE_BUILDS,
  ENGINE_TAG,
  MODEL_BASE_URL,
  MODEL_FILES,
  VoiceService,
  cleanTranscript,
  engineUrl,
  findOnPath,
  modelUrl,
  recommendedModel,
  wavSeconds,
  whisperLanguage,
  type VoiceHost,
} from '../src/server/voice';
import { encodeWav } from '../src/web/voice';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-voice-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const MODEL_BYTES = Buffer.from('fake ggml model '.repeat(64));
const ENGINE_BYTES = Buffer.from('fake engine archive');
const REAL_SMALL = { ...MODEL_FILES.small };
const REAL_BUILD = { ...ENGINE_BUILDS['linux-x64']! };

/** `seconds` of silence as 16 kHz mono WAV. */
const wav = (seconds: number) => Buffer.from(encodeWav(new Float32Array(Math.round(16_000 * seconds))));

function result(code: number | null, stdout = '', stderr = ''): SpawnResult {
  const bytes = Buffer.from(stdout);
  return { code, signal: null, stdout, stdoutBytes: bytes, stdoutTruncated: false, stdoutSize: bytes.length, stderr, aborted: false, timedOut: false };
}

interface FakeOptions {
  /** Body served for the small model (default: the bytes the pinned checksum expects). */
  modelBody?: () => BodyInit;
  /** whisper-server exits right away instead of serving. */
  serverExits?: boolean;
  text?: string;
  /** What `brew install` does (default: nothing). */
  onBrew?: () => void;
}

/** A computer without network or real processes: downloads, tar, brew and whisper-server are faked. */
function fakeHost(dir: string, over: Partial<VoiceHost> = {}, opts: FakeOptions = {}) {
  const calls: SpawnOptions[] = [];
  const urls: string[] = [];
  const forms: FormData[] = [];
  let serving = false;
  const run = async (o: SpawnOptions): Promise<SpawnResult> => {
    calls.push(o);
    if (o.bin === 'tar') {
      const server = join(o.args[o.args.indexOf('-C') + 1]!, REAL_BUILD.server);
      mkdirSync(dirname(server), { recursive: true });
      writeFileSync(server, '');
      return result(0);
    }
    if (o.args[0] === 'install') {
      opts.onBrew?.();
      return result(0, '==> Pouring whisper.cpp');
    }
    if (o.args[0] === '--help') return result(0, '', 'usage: whisper-server [options]');
    if (o.args.includes('--model')) {
      if (opts.serverExits) return result(1, '', 'error: failed to load model');
      serving = true;
      await new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }));
      serving = false;
      return { ...result(null), aborted: true };
    }
    return result(0);
  };
  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url === engineUrl(ENGINE_BUILDS['linux-x64']!)) return new Response(ENGINE_BYTES);
    if (url === modelUrl('small')) return new Response(opts.modelBody ? opts.modelBody() : MODEL_BYTES);
    if (url.endsWith('/health')) {
      if (!serving) throw new TypeError('fetch failed');
      return Response.json({ status: 'ok' });
    }
    if (url.endsWith('/inference')) {
      forms.push(init!.body as FormData);
      return Response.json({ text: opts.text ?? ' 你好 世界\n[BLANK_AUDIO]' });
    }
    return new Response('not found', { status: 404 });
  };
  const host: Partial<VoiceHost> = {
    platform: 'linux',
    arch: 'x64',
    env: { PATH: join(dir, 'bin') },
    dir,
    fetch: fetchFake as typeof fetch,
    run,
    freePort: async () => 54321,
    freeBytes: () => 1e12,
    brewDirs: [],
    ...over,
  };
  return { host, calls, urls, forms };
}

async function settle(svc: VoiceService) {
  for (let i = 0; i < 500; i++) {
    const job = svc.status().job;
    if (job && job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the install did not finish');
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error('timed out');
}

let n = 0;
let dir: string;
let settings: SettingsStore;
const services: VoiceService[] = [];
function service(host: Partial<VoiceHost>): VoiceService {
  const svc = new VoiceService(settings, host);
  services.push(svc);
  return svc;
}

beforeEach(() => {
  dir = join(root, `voice-${++n}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  settings = new SettingsStore(openDatabase(':memory:'));
  // Fake downloads, with checksums that match them.
  MODEL_FILES.small = { ...REAL_SMALL, size: MODEL_BYTES.length, sha256: sha(MODEL_BYTES) };
  ENGINE_BUILDS['linux-x64'] = { ...REAL_BUILD, size: ENGINE_BYTES.length, sha256: sha(ENGINE_BYTES) };
});

afterEach(() => {
  for (const s of services.splice(0)) s.shutdown();
  MODEL_FILES.small = REAL_SMALL;
  ENGINE_BUILDS['linux-x64'] = REAL_BUILD;
});

describe('voice helpers', () => {
  it('pins every download to a version and a SHA-256', () => {
    for (const m of [REAL_SMALL, MODEL_FILES.base, MODEL_FILES['large-v3-turbo-q5_0'], MODEL_FILES['large-v3-turbo'], MODEL_FILES['large-v3-q5_0']]) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.size).toBeGreaterThan(1e8);
    }
    expect(modelUrl('base')).toMatch(/^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/ggml-base\.bin$/);
    expect(modelUrl('base', 'http://mirror.lan/whisper')).toBe('http://mirror.lan/whisper/ggml-base.bin');
    expect(engineUrl(REAL_BUILD, 'http://mirror.lan/whisper')).toBe(`http://mirror.lan/whisper/${REAL_BUILD.asset}`);
    for (const b of [REAL_BUILD, ENGINE_BUILDS['linux-arm64']!, ENGINE_BUILDS['win32-x64']!, ENGINE_BUILDS['win32-arm64']!]) {
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(engineUrl(b)).toBe(`https://github.com/ggml-org/whisper.cpp/releases/download/${ENGINE_TAG}/${b.asset}`);
    }
  });

  it('recommends the large model only where it runs on the GPU', () => {
    expect(recommendedModel('darwin', 'arm64')).toBe('large-v3-turbo-q5_0');
    expect(recommendedModel('darwin', 'x64')).toBe('small');
    expect(recommendedModel('linux', 'x64')).toBe('small');
    expect(recommendedModel('win32', 'x64')).toBe('small');
  });

  it('asks for Chinese in Traditional characters, or English, following the UI language', () => {
    expect(whisperLanguage('follow', 'zh-TW')).toEqual({ language: 'zh', prompt: expect.stringContaining('繁體') });
    expect(whisperLanguage('follow', 'en')).toEqual({ language: 'en' });
    expect(whisperLanguage('zh', 'en')).toEqual({ language: 'zh', prompt: expect.stringContaining('繁體') });
    expect(whisperLanguage('en', 'zh-TW')).toEqual({ language: 'en' });
    expect(whisperLanguage('auto', 'zh-TW')).toEqual({ language: 'auto', prompt: expect.stringContaining('繁體') });
    expect(whisperLanguage('auto', 'en')).toEqual({ language: 'auto' });
  });

  it('cleans up what Whisper heard', () => {
    expect(cleanTranscript(' 你好 世界\n[BLANK_AUDIO]')).toBe('你好世界');
    expect(cleanTranscript(' Hello world\n how are you ')).toBe('Hello world how are you');
    expect(cleanTranscript('把 React 元件拆開')).toBe('把 React 元件拆開');
    expect(cleanTranscript('(音樂)\n第一段。\n第二段')).toBe('第一段。第二段');
    expect(cleanTranscript('[Music]')).toBe('');
  });

  it('finds commands on PATH, with PATHEXT on Windows', () => {
    const files = new Set(['/a/whisper-server', 'C:\\w\\whisper-server.EXE', '/brew/brew']);
    const isFile = (p: string) => files.has(p);
    expect(findOnPath('whisper-server', { PATH: '/x:/a' }, 'linux', [], isFile)).toBe('/a/whisper-server');
    expect(findOnPath('whisper-server', { Path: 'C:\\w', PATHEXT: '.COM;.EXE' }, 'win32', [], isFile)).toBe('C:\\w\\whisper-server.EXE');
    expect(findOnPath('brew', { PATH: '/x' }, 'darwin', ['/brew'], isFile)).toBe('/brew/brew');
    expect(findOnPath('brew', { PATH: '/x' }, 'darwin', [], isFile)).toBeUndefined();
  });

  it('reads the length of a WAV recording', () => {
    expect(wavSeconds(wav(2))).toBeCloseTo(2, 5);
    expect(wavSeconds(Buffer.from('not a wav file at all, but long enough to have a header'))).toBeUndefined();
    expect(wavSeconds(Buffer.alloc(10))).toBeUndefined();
  });
});

describe('VoiceService', () => {
  it('starts with nothing installed and the model suggested for the computer', () => {
    const s = service(fakeHost(dir).host).status();
    expect(s.ready).toBe(false);
    expect(s.engine).toMatchObject({ installed: false, installer: 'download', downloadSize: ENGINE_BYTES.length });
    expect(s.dir).toBe(dir);
    expect(s.model).toBe('small');
    expect(s.models.every((m) => !m.downloaded)).toBe(true);
    expect(s.models.find((m) => m.recommended)?.id).toBe('small');
    expect(s.server).toBe('stopped');
    expect(existsSync(join(dir, 'models'))).toBe(false); // nothing is written until asked
  });

  it('installs the engine and the model in the background, then transcribes on 127.0.0.1 behind a secret path', async () => {
    const f = fakeHost(dir);
    const svc = service(f.host);
    const started = svc.install('small');
    expect(started.job).toMatchObject({ state: 'running', steps: ['engine', 'model', 'check'], model: 'small' });

    const job = await settle(svc);
    expect(job.state).toBe('success');
    expect(job.log).toContain('tar -xf');
    const s = svc.status();
    expect(s.ready).toBe(true);
    expect(s.engine).toMatchObject({ installed: true, source: 'relay', version: ENGINE_TAG, accel: 'cpu' });
    expect(s.models.find((m) => m.id === 'small')?.downloaded).toBe(true);
    expect(s.server).toBe('running'); // started by the check, so the first use is quick
    expect(settings.voice.model).toBe('small');
    expect(readdirSync(join(dir, 'engine'))).toEqual([ENGINE_TAG]); // the archive is gone

    const server = f.calls.find((c) => c.args.includes('--model'))!;
    expect(server.args).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--port', '54321']));
    const prefix = server.args[server.args.indexOf('--request-path') + 1]!;
    expect(prefix).toMatch(/^\/[0-9a-f]{32}$/);

    const text = await withLang('zh-TW', () => svc.transcribe(wav(1)));
    expect(text).toBe('你好世界');
    expect(f.urls.at(-1)).toBe(`http://127.0.0.1:54321${prefix}/inference`);
    const form = f.forms[0]!;
    expect(form.get('language')).toBe('zh');
    expect(String(form.get('prompt'))).toContain('繁體');
    expect(form.get('file')).toBeInstanceOf(Blob);
    // Only one engine process for several requests.
    await svc.transcribe(wav(1));
    expect(f.calls.filter((c) => c.args.includes('--model'))).toHaveLength(1);
  });

  it('throws away a download whose SHA-256 does not match, and says so in the viewer’s language', async () => {
    const svc = service(fakeHost(dir, {}, { modelBody: () => Buffer.alloc(MODEL_BYTES.length, 1) }).host);
    svc.install('small');
    expect((await settle(svc)).state).toBe('failed');
    expect(withLang('en', () => svc.status().job?.error)).toContain('SHA-256');
    expect(withLang('zh-TW', () => svc.status().job?.error)).toContain('已刪除');
    expect(readdirSync(join(dir, 'models'))).toEqual([]);
    expect(svc.status().ready).toBe(false);
  });

  it('cancels a download and leaves nothing half-written', async () => {
    const svc = service(fakeHost(dir, {}, { modelBody: () => new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(10)) }) }).host);
    svc.install('small');
    await until(() => svc.status().job?.step === 'model' && svc.status().job?.received === 10);
    expect(() => svc.install('small')).toThrow(HttpError); // one install at a time
    svc.cancel();
    expect((await settle(svc)).state).toBe('cancelled');
    expect(readdirSync(join(dir, 'models'))).toEqual([]);
    expect(() => svc.cancel()).toThrow(HttpError);
  });

  it('checks the disk has room first', () => {
    const svc = service(fakeHost(dir, { freeBytes: () => 1000 }).host);
    expect(() => withLang('en', () => svc.install('small'))).toThrow(/Not enough disk space/);
    expect(svc.status().job).toBeUndefined();
  });

  it('needs Homebrew on macOS', () => {
    const svc = service(fakeHost(dir, { platform: 'darwin', arch: 'arm64' }).host);
    const s = withLang('en', () => svc.status());
    expect(s.engine).toMatchObject({ installed: false, installer: 'none', accel: 'metal' });
    expect(s.engine.installerNote).toContain('Homebrew');
    expect(s.model).toBe('large-v3-turbo-q5_0');
    expect(() => svc.install('small')).toThrow(HttpError);
  });

  // A macOS PATH (`:` between folders) cannot hold this system's folders on Windows (`C:\…`).
  it.skipIf(process.platform === 'win32')('installs the engine with Homebrew on macOS', async () => {
    writeFileSync(join(dir, 'bin', 'brew'), '');
    // brew links bin/whisper-server to the Cellar.
    const cellar = join(dir, 'Cellar', 'whisper-cpp', '1.9.5', 'bin', 'whisper-server');
    const onBrew = () => {
      mkdirSync(dirname(cellar), { recursive: true });
      writeFileSync(cellar, '');
      symlinkSync(cellar, join(dir, 'bin', 'whisper-server'));
    };
    const f = fakeHost(dir, { platform: 'darwin', arch: 'arm64' }, { onBrew });
    const svc = service(f.host);
    expect(svc.status().engine.installer).toBe('homebrew');
    svc.install('small');
    expect((await settle(svc)).state).toBe('success');
    const brew = f.calls.find((c) => c.args[0] === 'install')!;
    expect(brew.bin).toBe(join(dir, 'bin', 'brew'));
    expect(brew.args).toEqual(['install', 'whisper-cpp']);
    expect(brew.env.HOMEBREW_NO_AUTO_UPDATE).toBe('1');
    expect(svc.status().engine).toMatchObject({ installed: true, source: 'homebrew', version: '1.9.5', accel: 'metal' });
  });

  it('uses a whisper-server set in Settings, and says when it is missing', () => {
    const svc = service(fakeHost(dir).host);
    svc.update({ bin: join(dir, 'nope', 'whisper-server') });
    expect(svc.status().engine.problem).toContain(join(dir, 'nope', 'whisper-server'));
    expect(() => svc.install('small')).toThrow(HttpError);
    const custom = join(dir, 'my-whisper-server');
    writeFileSync(custom, '');
    expect(svc.update({ bin: custom }).engine).toMatchObject({ installed: true, source: 'custom', path: custom });
  });

  it('reports an engine that does not start', async () => {
    const svc = service(fakeHost(dir, {}, { serverExits: true }).host);
    svc.install('small');
    const job = await settle(svc);
    expect(job.state).toBe('failed');
    expect(job.error).toContain('failed to load model');
    await expect(svc.transcribe(wav(1))).rejects.toMatchObject({ status: 503 });
  });

  it('rejects recordings it cannot use', async () => {
    const svc = service(fakeHost(dir).host);
    await expect(svc.transcribe(Buffer.from('hello'))).rejects.toMatchObject({ status: 400 });
    await expect(svc.transcribe(wav(VOICE_MAX_SECONDS + 10))).rejects.toMatchObject({ status: 400 });
    await expect(svc.transcribe(wav(1))).rejects.toMatchObject({ status: 409 }); // not installed
  });

  it('switches and deletes models, and removes everything it downloaded', async () => {
    const svc = service(fakeHost(dir).host);
    svc.install('small');
    await settle(svc);
    expect(svc.status().server).toBe('running');

    // Another model: the running engine has the old one loaded, so it stops.
    let s = svc.update({ model: 'base' });
    expect(s).toMatchObject({ model: 'base', ready: false, server: 'stopped' });
    s = svc.update({ model: 'small' });
    expect(s.ready).toBe(true);

    s = svc.deleteModel('small');
    expect(s.ready).toBe(false);
    expect(s.models.find((m) => m.id === 'small')?.downloaded).toBe(false);

    svc.uninstall();
    expect(existsSync(dir)).toBe(false);
    expect(svc.status()).toMatchObject({ ready: false, job: undefined });
  });

  it('downloads from the folders RELAY_VOICE_MODEL_BASE_URL and RELAY_VOICE_ENGINE_BASE_URL name, checked all the same', async () => {
    const f = fakeHost(dir);
    const mirror = { modelBaseUrl: 'http://mirror.lan/whisper/models', engineBaseUrl: 'http://mirror.lan/whisper/engine' };
    const asked: string[] = [];
    // The mirror serves what the usual places serve.
    const fetchMirror = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      return f.host.fetch!(url.replace(mirror.modelBaseUrl, MODEL_BASE_URL).replace(mirror.engineBaseUrl, ENGINE_BASE_URL), init);
    }) as typeof fetch;
    const svc = service({ ...f.host, ...mirror, fetch: fetchMirror });
    svc.install('small');
    const job = await settle(svc);
    expect(job.state).toBe('success');
    const engine = `http://mirror.lan/whisper/engine/${ENGINE_BUILDS['linux-x64']!.asset}`;
    const model = `http://mirror.lan/whisper/models/${MODEL_FILES.small.file}`;
    expect(asked).toEqual(expect.arrayContaining([engine, model]));
    expect(job.log).toContain(engine);
    expect(job.log).toContain(model);

    // A mirror that serves other bytes is caught by the pinned SHA-256.
    svc.uninstall();
    const other = fakeHost(dir, {}, { modelBody: () => Buffer.alloc(MODEL_BYTES.length, 1) });
    const bad = service({ ...other.host, ...mirror, fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      other.host.fetch!(String(input).replace(mirror.modelBaseUrl, MODEL_BASE_URL).replace(mirror.engineBaseUrl, ENGINE_BASE_URL), init)) as typeof fetch });
    bad.install('small');
    expect((await settle(bad)).state).toBe('failed');
    expect(bad.status().models.find((m) => m.id === 'small')?.downloaded).toBe(false);
  });

  it('removes only what it put in a folder RELAY_VOICE_DIR names', async () => {
    const svc = service(fakeHost(dir, { ownDir: false }).host);
    svc.install('small');
    expect((await settle(svc)).state).toBe('success');
    // The user's own files beside Harness Relay's.
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, 'models', 'my-model.bin'), 'mine');
    mkdirSync(join(dir, 'engine', 'b1234'));

    svc.uninstall();
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(readdirSync(join(dir, 'models'))).toEqual(['my-model.bin']);
    expect(readdirSync(join(dir, 'engine'))).toEqual(['b1234']);
    expect(existsSync(join(dir, 'public'))).toBe(false); // empty, so it went
    expect(svc.status()).toMatchObject({ ready: false, job: undefined });

    // With nothing else there, the folder goes too.
    rmSync(join(dir, 'notes.txt'));
    rmSync(join(dir, 'models', 'my-model.bin'));
    rmSync(join(dir, 'engine', 'b1234'), { recursive: true });
    rmSync(join(dir, 'bin'), { recursive: true }); // the fake PATH's folder
    svc.uninstall();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('voice settings', () => {
  it('are kept in the database', () => {
    const db = openDatabase(':memory:');
    new SettingsStore(db).setVoice({ model: 'base', language: 'en', bin: ' /opt/w/whisper-server ' });
    expect(new SettingsStore(db).voice).toEqual({ model: 'base', language: 'en', bin: '/opt/w/whisper-server' });
    db.prepare("UPDATE app_settings SET value = ? WHERE key = 'voice'").run('{"model":"huge","language":"xx"}');
    expect(new SettingsStore(db).voice).toEqual({ model: undefined, language: 'follow', bin: '' });
  });
});

describe('voice HTTP API', () => {
  const HOST = { host: '127.0.0.1:8787' };
  const json = (method: string, body: unknown) => ({
    method,
    headers: { ...HOST, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  function app() {
    const db = openDatabase(':memory:');
    settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const voice = service(fakeHost(dir).host);
    return createApp({ auth: null, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers: new ProviderService(settings), voice });
  }

  it('reports the status and validates settings', async () => {
    const a = app();
    const res = await a.request('/api/voice', { headers: HOST });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: false, model: 'small', language: 'follow' });
    expect((await a.request('/api/voice/settings', json('PUT', { language: 'klingon' }))).status).toBe(400);
    expect((await a.request('/api/voice/settings', json('PUT', { model: 'huge' }))).status).toBe(400);
    const ok = await a.request('/api/voice/settings', json('PUT', { language: 'en' }));
    expect(await ok.json()).toMatchObject({ language: 'en' });
    expect((await a.request('/api/voice/install', json('POST', { model: 'huge' }))).status).toBe(400);
    expect((await a.request('/api/voice/install', json('DELETE', {}))).status).toBe(409);
  });

  it('installs, then transcribes JSON uploads only', async () => {
    const a = app();
    const audio = wav(1).toString('base64');
    expect((await a.request('/api/voice/transcribe', json('POST', { audio }))).status).toBe(409);
    const plain = await a.request('/api/voice/transcribe', { method: 'POST', headers: { ...HOST, 'content-type': 'text/plain' }, body: audio });
    expect(plain.status).toBe(415);
    expect((await a.request('/api/voice/transcribe', json('POST', { audio: 42 }))).status).toBe(400);

    const started = await a.request('/api/voice/install', json('POST', { model: 'small' }));
    expect(await started.json()).toMatchObject({ job: { state: 'running' } });
    await until(() => services.at(-1)!.status().job?.state === 'success');
    const res = await a.request('/api/voice/transcribe', json('POST', { audio }));
    expect(await res.json()).toEqual({ text: '你好世界' });
    expect((await a.request('/api/voice/models/small', json('DELETE', {}))).status).toBe(200);
    expect((await a.request('/api/voice', json('DELETE', {}))).status).toBe(200);
  });
});
