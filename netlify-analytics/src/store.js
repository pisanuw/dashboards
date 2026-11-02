// Where the two documents the dashboard reads live.
//
//   history  daily pageviews/visitors/bandwidth per site, kept forever
//   latest   rankings (top pages, sources, ...) from the most recent sync
//
// Local runs keep them as JSON files under DATA_DIR, exactly as before. On
// Netlify there is no writable disk that survives a deploy, so the same two
// documents go into a Netlify Blobs store instead. Blobs is chosen
// automatically when running on Netlify; STORE=file|blobs overrides.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, STORE_BACKEND, BLOBS_STORE } from './config.js';

const NAMES = ['history', 'latest'];

function assertName(name) {
  if (!NAMES.includes(name)) throw new Error(`Unknown document "${name}"`);
}

// JSON files under DATA_DIR. Writes go to a temp file first so a crash
// mid-write cannot leave a truncated history behind.
function createFileStore() {
  const fileFor = (name) => path.join(DATA_DIR, `${name}.json`);

  return {
    kind: 'file',
    describe: () => DATA_DIR,

    async read(name, fallback) {
      assertName(name);
      try {
        return JSON.parse(await fs.readFile(fileFor(name), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
      }
    },

    async write(name, value) {
      assertName(name);
      const file = fileFor(name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, file);
    },
  };
}

// Netlify Blobs. Imported lazily so a local file-backed run never needs the
// package at all. Site-wide stores (getStore, not getDeployStore) persist
// across deploys, which is the whole point of using it here.
async function createBlobStore() {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: BLOBS_STORE, consistency: 'strong' });

  return {
    kind: 'blobs',
    describe: () => `Netlify Blobs store "${BLOBS_STORE}"`,

    async read(name, fallback) {
      assertName(name);
      const value = await store.get(name, { type: 'json' });
      return value ?? fallback;
    },

    async write(name, value) {
      assertName(name);
      await store.setJSON(name, value);
    },
  };
}

export function createStore() {
  return STORE_BACKEND === 'blobs' ? createBlobStore() : createFileStore();
}
