// The node's code asked for at once (one file after another took about 20 s over a CDN), with every file still checked by
// hash; and the loader says it is loading the code as soon as the tab holds the lock, before any file arrives.
//   node test/round17-test.mjs
import { readFileSync } from 'node:fs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
globalThis.URL.createObjectURL = () => `blob:${Math.random()}`;
globalThis.Blob ??= class { constructor(parts) { this.parts = parts; } };
const ROOT = new URL('../', import.meta.url);
const { workerSource, CODE_SHA256 } = await import('../browser/tabnode.js');
const N = Object.keys(CODE_SHA256).length;
const real = (path) => readFileSync(new URL(path, ROOT), 'utf8');
// a stand-in fetch that answers only after a turn of the event loop, counting the requests in flight at once
const counting = (alter = (p, x) => x) => { const s = { now: 0, max: 0, asked: [] }; s.fetchText = (path) => { s.asked.push(path); s.now++; s.max = Math.max(s.max, s.now); return new Promise((res) => setTimeout(() => { s.now--; res(alter(path, real(path))); }, 5)); }; return s; };
{
  const s = counting(); const prog = [];
  const src = await workerSource('https://cdn.example/x', { fetchText: s.fetchText, onProgress: (k, n) => prog.push(`${k}/${n}`) });
  t('every file of the table is asked for at once', s.max === N && s.asked.length === N, `max in flight ${s.max} of ${N}; asked ${s.asked.length}`);
  t('...each file once', new Set(s.asked).size === N);
  t('...and the worker comes back with its imports pointing at checked copies', !/from '\.\.?\//.test(src) && /from 'blob:/.test(src));
  t('progress is told file by file, ending at all of them', prog.length === N && prog.at(-1) === `${N}/${N}`, prog.join(' '));
}
{
  const s = counting((p, x) => (p === 'lib/mempool.mjs' ? x + '\n// changed' : x)); let err = '';
  try { await workerSource('https://cdn.example/x', { fetchText: s.fetchText }); } catch (e) { err = e.message; }
  t('a file that differs is still refused, by name, though it arrived with the others', /lib\/mempool\.mjs .* not the pinned file/.test(err), err);
}
{
  let err = ''; const fetchText = (p) => (p === 'lib/varint.mjs' ? Promise.reject(new Error('the node\'s code could not be loaded from cdn.example (no answer in 30 s): check the connection and reload')) : Promise.resolve(real(p)));
  try { await workerSource('https://cdn.example/x', { fetchText }); } catch (e) { err = e.message; }
  t('a file that cannot be fetched stops the start, in words', /could not be loaded/.test(err), err);
}
{ // the loader: "loading its code" said once the lock is held, before the first file arrives
  const workers = []; const realFetch = globalThis.fetch; let fetches = 0, saidFirst = null; const texts = [];
  globalThis.Worker = class { constructor() { workers.push(this); } postMessage() {} terminate() {} }; globalThis.addEventListener ??= () => {};
  globalThis.fetch = async (u) => { if (fetches++ === 0) saidFirst = texts.slice(); return new Response(readFileSync(new URL(String(u).replace('https://x.test/n/', ''), ROOT))); };
  const { createTabNode } = await import('../browser/tabnode.js');
  const tn = createTabNode({ base: 'https://x.test/n', snapshotUrl: 'https://x.test/s', blocksUrl: 'https://x.test/b-blocks' });
  tn.on('sync', (m) => texts.push(m.msg));
  await tn.start({ force: true });
  t('"Starting the node: loading its code…" is said before the first file is asked for', saidFirst?.includes('Starting the node: loading its code…'), JSON.stringify(saidFirst));
  t('...then "(k of N)" as files arrive, then "Starting the node…" once the worker runs', texts.includes(`Starting the node: loading its code (${N} of ${N})…`) && texts.at(-1) === 'Starting the node…', texts.join(' | '));
  globalThis.fetch = realFetch;
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
