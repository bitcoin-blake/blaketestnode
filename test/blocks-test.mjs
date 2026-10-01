// The browser's block mirror (browser/blocks.js) under a fake OPFS and a fake fetch: the exclusive handle on blocks.dat is
// closed whatever fails (a 416, a short read, a bad record), a silent connection is cut, the context headers are keyed by
// the snapshot base and fetched again when the stored copy is wrong.
import { OpfsBlockSource, fetchIdle } from '../browser/blocks.js';
let pass = 0, fail = 0;
const t = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`); ok ? pass++ : fail++; };
const throwsAsync = async (f, re) => { try { await f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---- a fake OPFS: files as byte arrays; a handle counts as open until closed, and a second exclusive open fails like Chrome's
function fakeFiles() {
  const store = new Map(), open = new Set();
  const handle = async (name, create = false) => {
    if (!store.has(name)) { if (!create) throw new Error(`NotFoundError: ${name}`); store.set(name, new Uint8Array(0)); }
    if (open.has(name)) throw new Error(`${name} is open in another tab of this site; close it and retry`);
    open.add(name); let closed = false;
    return {
      getSize: () => store.get(name).length,
      truncate: (n) => store.set(name, store.get(name).slice(0, n)),
      write: (b, { at }) => { const cur = store.get(name); const out = new Uint8Array(Math.max(cur.length, at + b.length)); out.set(cur); out.set(b, at); store.set(name, out); return b.length; },
      read: (b, { at }) => { const cur = store.get(name); const part = cur.subarray(at, at + b.length); b.set(part); return part.length; },
      flush: () => {},
      close: () => { if (!closed) { closed = true; open.delete(name); } },
    };
  };
  return { store, open, handle, readText: async (n) => (store.has(n) ? new TextDecoder().decode(store.get(n)) : null), writeText: async (n, s) => store.set(n, new TextEncoder().encode(s)) };
}
// blocks of one byte each: block i links to block i-1; blockHash(header) is 'h<i>'
const k = { codec: { decode: (_, hex) => { const id = parseInt(hex, 16); return { header: { id, prevBlockHash: 'h' + (id - 1) } }; }, blockHash: (h) => 'h' + h.id } };
const rec = (height) => { const b = new Uint8Array(9); new DataView(b.buffer).setUint32(0, height, true); new DataView(b.buffer).setUint32(4, 1, true); b[8] = height & 0xff; return b; };
const indexFor = (heights, hashOf = (h) => 'h' + (h & 0xff)) => ({ from: heights[0], to: heights.at(-1), blocks: heights.map((h, i) => ({ height: h, hash: hashOf(h), offset: i * 9, size: 1 })) });
const dat = (heights) => { const out = new Uint8Array(heights.length * 9); heights.forEach((h, i) => out.set(rec(h), i * 9)); return out; };
let served = {};
globalThis.fetch = async (url, init = {}) => {
  const s = served[String(url).replace(/^.*\//, '')]; if (!s) return new Response('', { status: 404 });
  if (s.hang) return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.error(init.signal.reason)); } }), { status: 200 });
  if (typeof s === 'function') return s(init);
  return new Response(s.body, { status: s.status ?? 200 });
};
const H = [101, 102, 103];

{
  const files = fakeFiles();
  served = { 'b.json': { body: JSON.stringify(indexFor(H)) }, 'b.dat': { status: 416, body: '' } };
  const src = new OpfsBlockSource(k, 'https://m/b', files);
  t('a 416 for the block file fails the update and leaves blocks.dat closed', (await throwsAsync(() => src.update(), /block file 416/)) && !files.open.has('blocks.dat'));
  served['b.dat'] = { status: 206, body: dat(H).slice(0, 10) };
  t('a short read fails and leaves it closed', (await throwsAsync(() => src.update(), /short read/)) && !files.open.has('blocks.dat'));
  served['b.json'] = { body: JSON.stringify(indexFor(H, (h) => (h === 102 ? 'other' : 'h' + (h & 0xff)))) };
  served['b.dat'] = { status: 206, body: dat(H) };
  t('a record whose hash is not the index\'s fails and leaves it closed', (await throwsAsync(() => src.update(), /hash mismatch/)) && !files.open.has('blocks.dat'));
  served['b.json'] = { body: JSON.stringify(indexFor(H)) };
  const u = await src.update();
  t('...and the next update, the source mended, goes through', u.verified === 3 && !files.open.has('blocks.dat') && (await src.blockHex(102)) === '66');
}
{
  const files = fakeFiles();
  const src = new OpfsBlockSource(k, 'https://m/b', files);
  served = { 'b.json': { body: JSON.stringify(indexFor(H)) }, 'b.dat': { status: 206, body: dat(H) } };
  await src.update();
  const real = files.handle; files.handle = async (n, c) => { const h = await real(n, c); const r = h.read; h.read = () => { throw new Error('read failed'); }; void r; return h; };
  t('a failed read in blockHex leaves blocks.dat closed', (await throwsAsync(() => src.blockHex(101), /read failed/)) && !files.open.has('blocks.dat'));
}
{
  served = { 'slow': { hang: true } };
  const t0 = Date.now();
  t('a connection that sends nothing is cut after the idle time, with a sentence', (await throwsAsync(() => fetchIdle('https://m/slow', {}, { idleMs: 150 }), /no data for/)) && Date.now() - t0 < 2000);
  const ac = new AbortController(); setTimeout(() => ac.abort(Object.assign(new Error('woke'), { quiet: true })), 50);
  let reason = null; try { await fetchIdle('https://m/slow', {}, { idleMs: 5000, signal: ac.signal }); } catch (e) { reason = e; }
  t('an abort from outside comes back as its own reason (a quiet abort stays quiet)', reason?.quiet === true);
}
{
  const files = fakeFiles();
  const src = new OpfsBlockSource(k, 'https://m/b', files);
  served = { 'ctx.json': { body: JSON.stringify({ from: 100, to: 150, headers: [] }) } };
  await files.writeText('context-headers-150.json', JSON.stringify({ from: 0, to: 9, headers: [] }));
  const c = await src.contextHeaders('https://m/ctx.json', { from: 100, to: 150 });
  t('a stored copy of the context headers with the wrong range is fetched again, and kept under the base height', c.from === 100 && JSON.parse(await files.readText('context-headers-150.json')).from === 100);
  await files.writeText('context-headers-150.json', '{torn');
  t('a torn stored copy is fetched again', (await src.contextHeaders('https://m/ctx.json', { from: 100, to: 150 })).to === 150);
  served['ctx.json'] = { body: JSON.stringify({ from: 0, to: 1, headers: [] }) };
  await files.writeText('context-headers-150.json', '');
  t('a served copy with the wrong range is refused in words', await throwsAsync(() => src.contextHeaders('https://m/ctx.json', { from: 100, to: 150 }), /cover 0\.\.1, not 100\.\.150/));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
