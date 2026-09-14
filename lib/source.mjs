// Where blocks come from. HttpBlockSource mirrors the served block file into the data
// directory with Range requests and checks every block's hash against the index and,
// at the tail, against the NIP-333 headers; RpcBlockSource is the local node.
import { existsSync, statSync, appendFileSync, writeFileSync, readFileSync, truncateSync } from 'node:fs';
import { HEADER, readBlock } from './blockfile.mjs';

export class RpcBlockSource {
  constructor(rpc) { this.rpc = rpc; }
  async tip() { return this.rpc('getblockcount'); }
  async hash(h) { return this.rpc('getblockhash', h); }
  async blockHex(h) { return this.rpc('getblock', await this.hash(h), 0); }
  async headerHex(h) { return this.rpc('getblockheader', await this.hash(h), false); }
}

export class HttpBlockSource {
  constructor(k, base, dir, { log = () => {} } = {}) { this.k = k; this.base = base; this.dir = dir; this.log = log; this.dat = `${dir}/blocks.dat`; this.idx = `${dir}/blocks.json`; }
  async contextHeaders(url) {
    const p = `${this.dir}/context-headers.json`;
    if (!existsSync(p)) writeFileSync(p, await (await fetch(url)).text());
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  // fetch the index, then only the bytes of the file we do not have yet
  async update() {
    const r = await fetch(`${this.base}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`index ${r.status}`);
    const index = await r.json();
    const local = existsSync(this.idx) ? JSON.parse(readFileSync(this.idx, 'utf8')) : { blocks: [] };
    // keep the longest common prefix of the local index; anything after it is re-fetched
    let common = 0;
    while (common < local.blocks.length && common < index.blocks.length && local.blocks[common].hash === index.blocks[common].hash) common++;
    const have = common ? local.blocks[common - 1].offset + HEADER + local.blocks[common - 1].size : 0;
    if (existsSync(this.dat) && statSync(this.dat).size > have) truncateSync(this.dat, have);
    const want = index.blocks.length ? index.blocks.at(-1).offset + HEADER + index.blocks.at(-1).size : 0;
    let fetched = 0;
    if (want > have) {
      const t0 = performance.now();
      const res = await fetch(`${this.base}.dat`, { headers: { range: `bytes=${have}-${want - 1}` }, cache: 'no-store' });
      if (res.status !== 206 && !(res.status === 200 && have === 0)) throw new Error(`block file ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length !== want - have) throw new Error(`short read ${bytes.length} of ${want - have}`);
      appendFileSync(this.dat, bytes); fetched = bytes.length;
      this.log(`block file: +${fetched} bytes in ${(performance.now() - t0).toFixed(0)} ms (${index.blocks.length - common} blocks)`);
    }
    // verify every newly fetched block against the index hash (one read of the file)
    if (index.blocks.length > common) {
      const file = readFileSync(this.dat);
      let prev = common ? index.blocks[common - 1] : null;
      for (const e of index.blocks.slice(common)) {
        if (prev && (e.height !== prev.height + 1 || e.offset !== prev.offset + HEADER + prev.size)) throw new Error(`index not contiguous at ${e.height}`);
        if (file.readUInt32LE(e.offset) !== e.height || file.readUInt32LE(e.offset + 4) !== e.size) throw new Error(`record header mismatch at ${e.height}`);
        const block = this.k.codec.decode('Block', file.subarray(e.offset + HEADER, e.offset + HEADER + e.size).toString('hex'));
        if (this.k.codec.blockHash(block.header) !== e.hash) throw new Error(`block ${e.height} hash mismatch`);
        if (prev && block.header.prevBlockHash !== prev.hash) throw new Error(`block ${e.height} does not link to ${prev.height}`);
        prev = e;
      }
    }
    writeFileSync(this.idx, JSON.stringify(index));
    this.index = index; this.byHeight = new Map(index.blocks.map((b) => [b.height, b]));
    return { from: index.from, to: index.to, fetched, verified: index.blocks.length - common };
  }
  async tip() { return this.index.to; }
  async hash(h) { return this.byHeight.get(h)?.hash; }
  async blockHex(h) { const e = this.byHeight.get(h); if (!e) throw new Error(`no block ${h} in file`); return readBlock(this.dat, e).toString('hex'); }
}
