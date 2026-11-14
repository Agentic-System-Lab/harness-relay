/*
 * `npm run login`: a link that signs a browser in to Harness Relay, for when the one it printed at
 * start is gone (used, or more than an hour old). It works once, within ten minutes, whether the
 * server is running or not (it reads the same database: RELAY_DATA_DIR, else ./data).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuthStore, CODE_TTL_MS } from '../src/server/auth';
import { openDatabase } from '../src/server/db';
import { DB_FILE } from '../src/server/settings';
import { DEFAULT_HOST, DEFAULT_PORT } from '../src/server/ports';
import { signInLink } from '../src/server/signin';

const db = openDatabase(DB_FILE);
try {
  const { code } = new AuthStore(db).createCode(CODE_TTL_MS.device);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const built = existsSync(resolve(process.cwd(), 'dist/web/index.html'));
  console.log(`Sign a browser in (once, within ten minutes): ${signInLink(code, { host, port, dev: !built })}`);
  if (built) console.log(`With npm run dev: ${signInLink(code, { host, port, dev: true })}`);
  console.log(`Or type the code on the sign-in page: ${code}`);
} finally {
  db.close();
}
