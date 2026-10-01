// Writes browser/tabnode.js's table of sha256 hashes: the worker and every file of this repository it imports (relative
// imports, followed), as they are in the working tree. Run before committing a change to any of them; test/integrity-test.mjs
// fails when the table and the files disagree. Usage: node tools/integrity.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const resolve = (from, rel) => { const parts = from.split('/').slice(0, -1); for (const p of rel.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); } return parts.join('/'); };
export function table(entry = 'browser/worker.js') {
  const out = {}; const walk = (path) => { if (out[path]) return; const text = readFileSync(ROOT + path, 'utf8'); out[path] = createHash('sha256').update(text).digest('hex');
    for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) walk(resolve(path, m[1])); };
  walk(entry); return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
export const render = (t) => `export const CODE_SHA256 = {\n${Object.entries(t).map(([k, v]) => `  '${k}': '${v}',`).join('\n')}\n};`;
const tabnode = ROOT + 'browser/tabnode.js';
export function current() { const s = readFileSync(tabnode, 'utf8'); return s.slice(s.indexOf('// INTEGRITY:BEGIN\n') + 19, s.indexOf('\n// INTEGRITY:END')); }
if (import.meta.url === `file://${process.argv[1]}`) {
  const want = render(table());
  if (process.argv.includes('--check')) { const ok = current() === want; console.log(ok ? 'integrity table matches the files' : 'integrity table is stale: run node tools/integrity.mjs'); process.exit(ok ? 0 : 1); }
  const s = readFileSync(tabnode, 'utf8'); const a = s.indexOf('// INTEGRITY:BEGIN\n') + 19, b = s.indexOf('\n// INTEGRITY:END');
  writeFileSync(tabnode, s.slice(0, a) + want + s.slice(b)); console.log(want);
}
