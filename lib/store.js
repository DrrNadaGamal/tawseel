import { seedState } from './seed.js';

const KEY = 'tawseel/state-v1.json';
export const RESET_MS = 6 * 3600000;

// Memory store for tests / local dev.
export class MemoryStore {
  constructor() { this.s = null; this.tag = 0; }
  async read() { return this.s ? { state: structuredClone(this.s), tag: this.tag } : null; }
  async write(state, tag) {
    if (tag !== undefined && tag !== null && tag !== this.tag) { const e = new Error('conflict'); e.conflict = true; throw e; }
    this.s = structuredClone(state); this.tag = (this.tag || 0) + 1; return this.tag;
  }
}

// Vercel Blob store. Every state version is its own immutable blob (tawseel/s/000123.json).
// Writing version N+1 uses allowOverwrite:false, so two writers racing for the same version
// cannot both win: the loser gets "already exists" and retries on top of the winner's state.
// Immutable blobs also mean no stale CDN copy can ever be read for a version.
const PREFIX = 'tawseel/s/';
const vkey = (n) => PREFIX + String(n).padStart(9, '0') + '.json';
export class BlobStore {
  constructor(token = process.env.BLOB_READ_WRITE_TOKEN) { this.token = token; }
  async lib() { return import('@vercel/blob'); }
  async latest() {
    const { list } = await this.lib();
    let cursor, best = null;
    do {
      const r = await list({ prefix: PREFIX, limit: 1000, cursor, token: this.token });
      for (const b of r.blobs) if (!best || b.pathname > best.pathname) best = b;
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return best;
  }
  async read() {
    const best = await this.latest();
    if (!best) return null;
    const res = await fetch(best.url);
    if (!res.ok) throw new Error('blob read ' + res.status);
    return { state: await res.json(), tag: Number(best.pathname.slice(PREFIX.length, -5)) };
  }
  async write(state, tag) {
    const { put, list, del } = await this.lib();
    const next = (tag || 0) + 1;
    try {
      await put(vkey(next), JSON.stringify(state), { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json', token: this.token });
    } catch (e) {
      if (/already exists|exists/i.test(String(e?.message))) { const c = new Error('conflict'); c.conflict = true; throw c; }
      throw e;
    }
    // best-effort cleanup of old versions
    try {
      if (next % 5 === 0) {
        const r = await list({ prefix: PREFIX, limit: 1000, token: this.token });
        const old = r.blobs.filter((b) => b.pathname < vkey(next - 8)).map((b) => b.url);
        if (old.length) await del(old, { token: this.token });
      }
    } catch {}
    return next;
  }
}

export function makeStore() {
  return process.env.BLOB_READ_WRITE_TOKEN ? new BlobStore() : (globalThis.__tawseelMem ||= new MemoryStore());
}

export async function loadState(store, now) {
  const r = await store.read();
  if (!r || now - r.state.seededAt > RESET_MS) {
    const state = seedState(now);
    const tag = await store.write(state, r ? r.tag : undefined).catch((e) => { if (e.conflict) return null; throw e; });
    if (tag === null) return loadState(store, now);
    return { state, tag };
  }
  return r;
}

export async function mutate(store, now, fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const { state, tag } = await loadState(store, now);
    const result = await fn(state);
    if (!result || result.ok === false || result.noWrite) return result;
    try {
      state.version = (state.version || 0) + 1;
      await store.write(state, tag);
      return result;
    } catch (e) {
      if (!e.conflict) throw e;
    }
  }
  return { ok: false, error: 'busy', status: 503 };
}
