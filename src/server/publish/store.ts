import type { Database } from '../db';
import { RENDER_REGIONS, type PublishAccount, type PublishKind, type RenderRegion } from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { maskSecret, type SecretStore } from '../secrets';

/** The credential store's names of the two keys. */
export const RENDER_SECRET = 'publish.render';
export const NEON_SECRET = 'publish.neon';

/** An app published from a preview, as Relay records it (`app_settings` key `publish`). */
export interface AppRecord {
  id: string;
  name: string;
  conversationId: string;
  folder: string;
  kind: PublishKind;
  serviceType: 'static_site' | 'web_service';
  /** `owner/name`, once GitHub made it. */
  repo?: string;
  /** The Render workspace it was made in. */
  ownerId: string;
  serviceId?: string;
  dashboardUrl?: string;
  /** Its address: Render's, and a static page's path when it is not the folder's index. */
  url?: string;
  path?: string;
  /** Its Neon projects, and each one's init scripts that committed (`scriptKey`: name and contents). */
  databases: { service: string; projectId: string; name: string; database: string; role: string; scriptsDone: string[] }[];
  /** Render was asked to make its service, whether or not its answer came: it may have one there not recorded. */
  serviceTried?: boolean;
  createdAt: number;
  publishedAt?: number;
  state: 'publishing' | 'live' | 'failed';
  error?: string;
  /** Its last publish stopped with the server: said in the language of whoever reads it. */
  interrupted?: boolean;
}

interface Saved {
  render: { ownerId?: string; owners: PublishAccount[]; region: RenderRegion };
  neon: { orgId?: string; orgs: PublishAccount[] };
  apps: AppRecord[];
}

const EMPTY = (): Saved => ({ render: { owners: [], region: 'oregon' }, neon: { orgs: [] }, apps: [] });

/**
 * Settings → Publish to the cloud: the Render and Neon keys in the credential store (never the
 * database as they are, never the UI), the rest (the workspace, region and organization, and the
 * published apps) in `app_settings` as JSON.
 */
export class PublishStore {
  private saved: Saved;

  constructor(
    private db: Database,
    private secrets?: SecretStore,
  ) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'publish'").get() as { value: string } | undefined;
    let parsed: Partial<Saved> = {};
    try {
      parsed = row ? (JSON.parse(row.value) as Partial<Saved>) : {};
    } catch {
      parsed = {};
    }
    const base = EMPTY();
    this.saved = {
      render: { ...base.render, ...parsed.render },
      neon: { ...base.neon, ...parsed.neon },
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
    };
    if (!RENDER_REGIONS.includes(this.saved.render.region)) this.saved.render.region = 'oregon';
    // A publish the server stopped during never finishes: say so.
    for (const app of this.saved.apps)
      if (app.state === 'publishing') {
        app.state = 'failed';
        app.interrupted = true;
      }
  }

  private save() {
    this.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('publish', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(this.saved));
  }

  get storage(): boolean {
    return Boolean(this.secrets);
  }

  private key(name: string): string {
    try {
      return this.secrets?.get(name) ?? '';
    } catch {
      throw new HttpError(503, t().publish.storage);
    }
  }
  renderKey = () => this.key(RENDER_SECRET);
  neonKey = () => this.key(NEON_SECRET);
  renderKeyMasked = () => maskSecret(this.renderKey());
  neonKeyMasked = () => maskSecret(this.neonKey());

  private setKey(name: string, value: string) {
    if (!this.secrets) throw new HttpError(503, t().publish.storage);
    this.secrets.set(name, value);
  }

  get render() {
    return this.saved.render;
  }
  get neon() {
    return this.saved.neon;
  }

  /** A checked Render key, with the workspaces it reaches: the only one is chosen. */
  setRender(key: string, owners: PublishAccount[]) {
    this.setKey(RENDER_SECRET, key);
    const keep = owners.find((o) => o.id === this.saved.render.ownerId);
    this.saved.render = { ...this.saved.render, owners, ownerId: keep?.id ?? (owners.length === 1 ? owners[0]!.id : undefined) };
    this.save();
  }

  updateRender(o: { ownerId?: string; region?: RenderRegion }) {
    if (o.ownerId !== undefined) {
      if (!this.saved.render.owners.some((x) => x.id === o.ownerId)) throw new HttpError(400, t().invalidField('ownerId'));
      this.saved.render.ownerId = o.ownerId;
    }
    if (o.region !== undefined) this.saved.render.region = o.region;
    this.save();
  }

  removeRender() {
    this.secrets?.delete(RENDER_SECRET);
    this.saved.render = { owners: [], region: this.saved.render.region };
    this.save();
  }

  setNeon(key: string, orgs: PublishAccount[]) {
    this.setKey(NEON_SECRET, key);
    const keep = orgs.find((o) => o.id === this.saved.neon.orgId);
    this.saved.neon = { orgs, orgId: keep?.id ?? (orgs.length === 1 ? orgs[0]!.id : undefined) };
    this.save();
  }

  updateNeon(o: { orgId?: string }) {
    if (o.orgId !== undefined) {
      if (!this.saved.neon.orgs.some((x) => x.id === o.orgId)) throw new HttpError(400, t().invalidField('orgId'));
      this.saved.neon.orgId = o.orgId;
    }
    this.save();
  }

  removeNeon() {
    this.secrets?.delete(NEON_SECRET);
    this.saved.neon = { orgs: [] };
    this.save();
  }

  apps(): AppRecord[] {
    return this.saved.apps;
  }

  app(id: string): AppRecord | undefined {
    return this.saved.apps.find((a) => a.id === id);
  }

  /** Records an app or what changed of it (the record is the one `apps()` holds). */
  put(app: AppRecord) {
    const i = this.saved.apps.findIndex((a) => a.id === app.id);
    if (i < 0) this.saved.apps.unshift(app);
    else this.saved.apps[i] = app;
    this.save();
  }

  remove(id: string) {
    this.saved.apps = this.saved.apps.filter((a) => a.id !== id);
    this.save();
  }
}
