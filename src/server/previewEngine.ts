/**
 * The Docker Engine API, for the one thing the `docker` CLI cannot do here: a container's terminal.
 * `docker attach` and `docker exec -t` refuse when their own input is not a terminal, and the
 * server's never is. Relay talks to the same local socket or named pipe `localDocker` pinned,
 * never to a TCP address.
 */
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { t } from './i18n';

export interface PreviewEngine {
  /** The container's terminal, both ways. `logs` replays what it wrote before. */
  attach(id: string, logs: boolean, signal?: AbortSignal): Promise<Duplex>;
  resize(id: string, rows: number, cols: number): Promise<void>;
}

const ID = /^[a-f0-9]{64}$/;

/** The socket of an endpoint `localDocker` accepted: a Unix socket, or a local named pipe on Windows. */
export function engineSocket(endpoint: string): string {
  const unix = /^unix:\/\/(\/[^\r\n]+)$/.exec(endpoint);
  if (unix) return unix[1]!;
  const pipe = /^npipe:\/\/\/\/\.\/pipe\/([a-zA-Z0-9._-]+)$/.exec(endpoint);
  if (pipe) return '\\\\.\\pipe\\' + pipe[1];
  throw new Error(t().previewDocker.local);
}

export function previewEngine(endpoint: string, request = http.request): PreviewEngine {
  const socketPath = engineSocket(endpoint);
  const checkedId = (id: string) => {
    if (!ID.test(id)) throw new Error(t().previewDocker.invalidDocker);
    return id;
  };
  return {
    attach(id, logs, signal) {
      return new Promise<Duplex>((resolve, reject) => {
        const path = `/containers/${checkedId(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1${logs ? '&logs=1' : ''}`;
        // A connection of its own each time: never one a refused attach left behind in a pool.
        const req = request({
          socketPath,
          agent: false,
          method: 'POST',
          path,
          headers: { Connection: 'Upgrade', Upgrade: 'tcp', 'Content-Length': '0' },
          signal,
          timeout: 15000,
        });
        req.on('upgrade', (_res, socket, head) => {
          socket.setTimeout(0);
          if (head.length) socket.unshift(head);
          resolve(socket);
        });
        req.on('response', (res) => {
          let detail = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (detail.length < 1024) detail += chunk;
          });
          res.on('end', () => reject(new Error(t().previewDocker.failed(t().previewDocker.attach) + ' ' + detail.trim())));
        });
        req.on('timeout', () => req.destroy(new Error(t().previewDocker.timeout(t().previewDocker.attach))));
        req.on('error', reject);
        req.end();
      });
    },
    resize(id, rows, cols) {
      return new Promise<void>((resolve) => {
        const path = `/containers/${checkedId(id)}/resize?h=${Math.round(rows)}&w=${Math.round(cols)}`;
        const req = request({ socketPath, agent: false, method: 'POST', path, headers: { 'Content-Length': '0' }, timeout: 5000 });
        // A container that just exited cannot be resized; the panel's size applies to the next run.
        req.on('response', (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve());
        req.end();
      });
    },
  };
}
