import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const publicRoot = new URL('../public/', import.meta.url);

test('offline installation caches only shipped app assets and serves its saved shell without a network', async () => {
  const base = 'https://example.invalid/';
  const listeners = {};
  const entries = new Map();
  const fetched = [];
  const removed = [];
  let claimed = false;
  const cache = {
    async addAll(paths) {
      for (const path of paths) {
        const url = new URL(path, base);
        assert.equal(url.origin, new URL(base).origin);
        const file = fileURLToPath(new URL(path === './' ? './index.html' : path, publicRoot));
        assert(existsSync(file), 'Missing offline asset ' + path);
        entries.set(url.href, readFileSync(file));
      }
    },
    async match(url) { return entries.get(url); }
  };
  const sw = {
    registration: {scope: base},
    clients: {async claim() { claimed = true; }},
    addEventListener(event, fn) { listeners[event] = fn; }
  };
  vm.runInNewContext(readFileSync(new URL('sw.js', publicRoot),'utf8'), {
    URL, self: sw,
    caches: {open: async () => cache, keys: async () => ['chalachitra-studio-old','other-app'], delete: async k => removed.push(k)},
    fetch(req) { fetched.push(req.url); throw Error('Network disabled'); }
  });
  await new Promise((resolve,reject) => listeners.install({waitUntil: p => p.then(resolve,reject)}));
  await new Promise((resolve,reject) => listeners.activate({waitUntil: p => p.then(resolve,reject)}));
  assert(claimed);
  assert.deepEqual(removed,['chalachitra-studio-old']);
  const request = url => new Request(url);
  const cached = await new Promise(resolve => listeners.fetch({request:request(base),respondWith:resolve}));
  assert.match(cached.toString(),/<title>Review studio/);
  assert(entries.has(base+'assets/court.mp4') && entries.has(base+'assets/held-sa.wav'));
  for (const url of [base+'private.mp4','https://www.youtube.com/watch?v=abcdefghijk']) {
    listeners.fetch({request:request(url),respondWith(){assert.fail('Unexpected intercepted URL '+url);}});
  }
  assert.deepEqual(fetched,[]);
});
