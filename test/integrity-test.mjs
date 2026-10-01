// The loader's table of hashes describes the files at this commit, and the loader refuses a file that differs from it.
import { table, render, current } from '../tools/integrity.mjs';
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0; const t = (name, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !d ? '' : `\n        ${d}`}`); ok ? pass++ : fail++; };
const tb = table();
t('the table names the worker and every module of this repository it imports', ['browser/worker.js', 'browser/blocks.js', 'lib/nip333.mjs', 'lib/mempool.mjs', 'lib/params.mjs', 'lib/node.mjs', 'lib/packed.mjs', 'lib/bytes.mjs'].every((p) => tb[p]), Object.keys(tb).join(', '));
t('browser/tabnode.js carries the table of the files as they are (run node tools/integrity.mjs after changing one)', current() === render(tb));
// the loader itself, with a stand-in fetch: a file that differs is refused, the right files are bundled
globalThis.URL.createObjectURL = (b) => `blob:${Math.random()}`;
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
const { workerSource } = await import('../browser/tabnode.js');
const ROOT = new URL('..', import.meta.url).pathname;
const real = (path) => Promise.resolve(readFileSync(ROOT + path, 'utf8'));
const src = await workerSource('https://cdn.example/x', { fetchText: real });
t('the worker is loaded with its imports pointing at checked copies', !/from '\.\.?\//.test(src) && /from 'blob:/.test(src));
let err = ''; try { await workerSource('https://cdn.example/x', { fetchText: (p) => (p === 'lib/params.mjs' ? Promise.resolve('export const CHAIN = {};') : real(p)) }); } catch (e) { err = e.message; }
t('a file that differs from the table is refused, by name', /lib\/params\.mjs .* not the pinned file/.test(err), err);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
