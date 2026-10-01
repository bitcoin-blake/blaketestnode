// The served block file mirrored into OPFS: the index JSON, then only the missing tail by
// Range, every record hash-checked and linked to its parent. Same rules as lib/source.mjs.
const HEADER = 8;
// a signal that aborts after `ms`, and also when `also` aborts (AbortSignal.timeout and .any where the browser has them)
export function deadline(ms, also = null) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms);
  const stop = () => clearTimeout(t); c.signal.addEventListener('abort', stop);
  if (also) { if (also.aborted) c.abort(also.reason); else also.addEventListener('abort', () => c.abort(also.reason), { once: true }); }
  return c.signal;
}
// a fetch whose body must keep moving: aborted when nothing arrives for `idleMs` (a blackholed connection never errors by
// itself), or when `signal` aborts; resolves to { res, bytes } with the whole body read
export async function fetchIdle(url, init = {}, { idleMs = 30_000, signal = null, onChunk = null } = {}) {
  const c = new AbortController(); let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => c.abort(new Error(`no data for ${Math.round(idleMs / 1000)} s from ${String(url).replace(/^https?:\/\//, '').split('/')[0]}`)), idleMs); };
  if (signal) { if (signal.aborted) c.abort(signal.reason); else signal.addEventListener('abort', () => c.abort(signal.reason), { once: true }); }
  arm();
  try {
    const res = await fetch(url, { ...init, signal: c.signal });
    if (!res.ok && res.status !== 206) return { res, bytes: null };
    const reader = res.body.getReader(); const parts = []; let n = 0;
    for (;;) { arm(); const { value, done } = await reader.read(); if (done) break; parts.push(value); n += value.length; onChunk?.(value); }
    const bytes = new Uint8Array(n); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
    return { res, bytes };
  } catch (e) { throw c.signal.aborted && c.signal.reason instanceof Error ? c.signal.reason : e; }
  finally { clearTimeout(timer); }
}
export class OpfsBlockSource {
  constructor(k, base, files, { log = () => {}, signal = () => null } = {}) { Object.assign(this, { k, base, files, log, signal }); }
  // the headers before the snapshot, kept under a name for the snapshot's base: a release with another base never reads an
  // old copy; a copy that covers the wrong range (torn, or from elsewhere) is fetched again rather than trusted
  async contextHeaders(url, { from, to } = {}) {
    const name = to != null ? `context-headers-${to}.json` : 'context-headers.json';
    const fits = (j) => j && (from == null || j.from === from) && (to == null || j.to === to);
    let j = null; try { j = JSON.parse((await this.files.readText(name)) ?? 'null'); } catch {}
    if (fits(j)) return j;
    const { res, bytes } = await fetchIdle(url, { cache: 'no-store' }, { signal: this.signal() });
    if (!res.ok) throw new Error(`context headers ${res.status}`);
    const t = new TextDecoder().decode(bytes); j = JSON.parse(t);
    if (!fits(j)) throw new Error(`the context headers served cover ${j?.from}..${j?.to}, not ${from}..${to}`);
    await this.files.writeText(name, t);
    return j;
  }
  async update() {
    // revalidated with the ETag: an unchanged index costs a 304, not the whole file
    const ir = await fetchIdle(`${this.base}.json`, { cache: 'no-cache' }, { signal: this.signal() });
    if (!ir.res.ok) throw new Error(`block index ${ir.res.status} (needs Range and CORS)`);
    const index = JSON.parse(new TextDecoder().decode(ir.bytes));
    let localIndex = { blocks: [] }; try { localIndex = JSON.parse((await this.files.readText('blocks.json')) ?? '{"blocks":[]}'); } catch {}
    let common = 0;
    while (common < localIndex.blocks.length && common < index.blocks.length && localIndex.blocks[common].hash === index.blocks[common].hash) common++;
    const have = common ? localIndex.blocks[common - 1].offset + HEADER + localIndex.blocks[common - 1].size : 0;
    const want = index.blocks.length ? index.blocks.at(-1).offset + HEADER + index.blocks.at(-1).size : 0;
    let fetched = 0;
    // the exclusive handle is closed whatever happens below: a failed fetch or a bad record must not leave blocks.dat open,
    // or every later sync would find it "open in another tab"
    const h = await this.files.handle('blocks.dat', true);
    try {
      if (h.getSize() > have) h.truncate(have);
      if (want > have) {
        const t0 = performance.now();
        const { res, bytes } = await fetchIdle(`${this.base}.dat`, { headers: { range: `bytes=${have}-${want - 1}` }, cache: 'no-store' }, { signal: this.signal() });
        if (res.status !== 206 && !(res.status === 200 && have === 0)) throw new Error(`block file ${res.status}`);
        if (bytes.length !== want - have) throw new Error(`short read ${bytes.length} of ${want - have}`);
        h.write(bytes, { at: have }); h.flush(); fetched = bytes.length;
        this.log(`block file: +${fetched} bytes in ${(performance.now() - t0).toFixed(0)} ms (${index.blocks.length - common} blocks)`);
      }
      // check every new record against the index and its parent
      let prev = common ? index.blocks[common - 1] : null;
      const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (const e of index.blocks.slice(common)) {
        if (prev && (e.height !== prev.height + 1 || e.offset !== prev.offset + HEADER + prev.size)) throw new Error(`index not contiguous at ${e.height}`);
        const rec = new Uint8Array(HEADER + e.size); h.read(rec, { at: e.offset });
        if (dv(rec).getUint32(0, true) !== e.height || dv(rec).getUint32(4, true) !== e.size) throw new Error(`record header mismatch at ${e.height}`);
        const block = this.k.codec.decode('Block', hex(rec.subarray(HEADER)));
        if (this.k.codec.blockHash(block.header) !== e.hash) throw new Error(`block ${e.height} hash mismatch`);
        if (prev && block.header.prevBlockHash !== prev.hash) throw new Error(`block ${e.height} does not link to ${prev.height}`);
        prev = e;
      }
    } finally { try { h.close(); } catch {} }
    await this.files.writeText('blocks.json', JSON.stringify(index));
    this.index = index; this.byHeight = new Map(index.blocks.map((b) => [b.height, b]));
    return { from: index.from, to: index.to, fetched, verified: index.blocks.length - common, blocks: index.blocks.length };
  }
  async tip() { return this.index.to; }
  async hash(h) { return this.byHeight.get(h)?.hash; }
  async blockHex(height) {
    const e = this.byHeight.get(height); if (!e) throw new Error(`no block ${height} in file`);
    const h = await this.files.handle('blocks.dat'); const b = new Uint8Array(e.size);
    try { h.read(b, { at: e.offset + HEADER }); } finally { try { h.close(); } catch {} }
    return hex(b);
  }
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
