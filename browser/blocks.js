// The served block file mirrored into OPFS: the index JSON, then only the missing tail by
// Range, every record hash-checked and linked to its parent. Same rules as lib/source.mjs.
const HEADER = 8;
export class OpfsBlockSource {
  constructor(k, base, files, { log = () => {} } = {}) { Object.assign(this, { k, base, files, log }); }
  async contextHeaders(url) {
    let t = await this.files.readText('context-headers.json');
    if (!t) { t = await (await fetch(url, { cache: 'no-store' })).text(); await this.files.writeText('context-headers.json', t); }
    return JSON.parse(t);
  }
  async update() {
    const r = await fetch(`${this.base}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`block index ${r.status} (needs Range and CORS)`);
    const index = await r.json();
    const local = JSON.parse((await this.files.readText('blocks.json')) ?? '{"blocks":[]}');
    let common = 0;
    while (common < local.blocks.length && common < index.blocks.length && local.blocks[common].hash === index.blocks[common].hash) common++;
    const have = common ? local.blocks[common - 1].offset + HEADER + local.blocks[common - 1].size : 0;
    const h = await this.files.handle('blocks.dat', true);
    if (h.getSize() > have) h.truncate(have);
    const want = index.blocks.length ? index.blocks.at(-1).offset + HEADER + index.blocks.at(-1).size : 0;
    let fetched = 0;
    if (want > have) {
      const t0 = performance.now();
      const res = await fetch(`${this.base}.dat`, { headers: { range: `bytes=${have}-${want - 1}` }, cache: 'no-store' });
      if (res.status !== 206 && !(res.status === 200 && have === 0)) throw new Error(`block file ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
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
    h.close();
    await this.files.writeText('blocks.json', JSON.stringify(index));
    this.index = index; this.byHeight = new Map(index.blocks.map((b) => [b.height, b]));
    return { from: index.from, to: index.to, fetched, verified: index.blocks.length - common, blocks: index.blocks.length };
  }
  async tip() { return this.index.to; }
  async hash(h) { return this.byHeight.get(h)?.hash; }
  async blockHex(height) {
    const e = this.byHeight.get(height); if (!e) throw new Error(`no block ${height} in file`);
    const h = await this.files.handle('blocks.dat'); const b = new Uint8Array(e.size); h.read(b, { at: e.offset + HEADER }); h.close();
    return hex(b);
  }
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
