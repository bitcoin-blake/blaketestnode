// The node's worker: owns the origin's files (OPFS), fetches the snapshot in ranges straight to
// disk, hashes it, parses and indexes it with the same code the Node daemon runs.
import { SNAPSHOT, CHAIN } from '../lib/params.mjs';
import { Sha256 } from '../lib/sha256.mjs';
import { buildIndex, indexBytes, parseIndexBytes } from '../lib/packed.mjs';
import { bytesToHex } from '../lib/bytes.mjs';

const post = (m) => self.postMessage(m);
const log = (text) => post({ type: 'log', text });
let root;
const dir = async () => (root ??= await navigator.storage.getDirectory());
async function open(name, create = false) { const fh = await (await dir()).getFileHandle(name, { create }); return fh.createSyncAccessHandle(); }
async function sizeOf(name) { try { const h = await open(name); const n = h.getSize(); h.close(); return n; } catch { return -1; } }

// { size, read(off, len) } over an OPFS sync access handle: the browser twin of FileBytes
class OpfsBytes {
  constructor(handle) { this.h = handle; this.size = handle.getSize(); }
  read(off, len) { const b = new Uint8Array(Math.min(len, Math.max(0, this.size - off))); const n = this.h.read(b, { at: off }); return n === b.length ? b : b.subarray(0, n); }
}

async function status() {
  const est = await navigator.storage.estimate().catch(() => ({}));
  const dat = await sizeOf(SNAPSHOT.file), idx = await sizeOf(`${SNAPSHOT.file}.idx`), sha = await readSmall(`${SNAPSHOT.file}.sha256`), partial = (await readSmall(`${SNAPSHOT.file}.ranges`)) != null;
  post({ type: 'status', quota: est.quota ?? null, usage: est.usage ?? null, dat: partial ? Math.min(dat, SNAPSHOT.bytes - 1) : dat, idx, sha, partial, expect: { bytes: SNAPSHOT.bytes, sha256: SNAPSHOT.sha256, txoutsetHash: SNAPSHOT.txoutsetHash, baseHeight: SNAPSHOT.baseHeight, baseHash: SNAPSHOT.baseHash, coins: SNAPSHOT.coins, alias: CHAIN.alias } });
}
async function readSmall(name) { try { const h = await open(name); const b = new Uint8Array(h.getSize()); h.read(b, { at: 0 }); h.close(); return new TextDecoder().decode(b); } catch { return null; } }
async function writeSmall(name, text) { const h = await open(name, true); h.truncate(0); h.write(new TextEncoder().encode(text), { at: 0 }); h.flush(); h.close(); }

// Range-fetch the snapshot into OPFS: several ranges in flight at once (one stream is slow
// over a long path), resuming from what is there; then the whole file is hashed once.
async function fetchSnapshot(url, { parallel = 6, chunk = 32 << 20 } = {}) {
  const h = await open(SNAPSHOT.file, true);
  // ranges are fixed-size chunks from 0; the journal lists the ones that completed, so a
  // resume after an interruption (ranges land out of order) refetches exactly what is missing
  const nChunks = Math.ceil(SNAPSHOT.bytes / chunk);
  const journalName = `${SNAPSHOT.file}.ranges`;
  let done = new Set(); try { const j = JSON.parse(await readSmall(journalName) ?? 'null'); if (j && j.chunk === chunk) done = new Set(j.done); } catch {}
  if (h.getSize() > SNAPSHOT.bytes) { h.truncate(0); done = new Set(); }
  const have = done.size * chunk - (done.has(nChunks - 1) ? nChunks * chunk - SNAPSHOT.bytes : 0);
  if (done.size) log(`resuming: ${done.size} of ${nChunks} ranges already on disk`);
  const t0 = performance.now(); let got = 0, lastReport = 0;
  const ranges = []; for (let i = 0; i < nChunks; i++) if (!done.has(i)) ranges.push([i, i * chunk, Math.min(SNAPSHOT.bytes, (i + 1) * chunk) - 1]);
  const total = SNAPSHOT.bytes - have;
  let journalLock = Promise.resolve(); // one sync access handle at a time on the journal
  const journal = () => (journalLock = journalLock.then(() => writeSmall(journalName, JSON.stringify({ chunk, done: [...done] }))).catch(() => {}));
  const report = () => { if (performance.now() - lastReport > 250) { lastReport = performance.now(); post({ type: 'fetch', have: have + got, total: SNAPSHOT.bytes, rate: got / ((performance.now() - t0) / 1000) }); } };
  const pull = async () => {
    for (;;) {
      const r = ranges.shift(); if (!r) return;
      const [ci, start, end] = r; let at = start;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, { headers: { range: `bytes=${at}-${end}` }, cache: 'no-store' });
          if (res.status !== 206) throw new Error(`server answered ${res.status} to a range request (needs Range and CORS)`);
          const reader = res.body.getReader();
          for (;;) { const { value, done } = await reader.read(); if (done) break; h.write(value, { at }); at += value.length; got += value.length; report(); }
          if (at !== end + 1) throw new Error(`short range: got to ${at}, wanted ${end + 1}`);
          h.flush(); done.add(ci); await journal();
          break;
        } catch (e) { if (attempt >= 3) throw e; log(`range ${ci}: ${e.message}, retrying`); got -= at - start; at = start; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, ranges.length) }, pull));
  h.flush(); h.close();
  const ms = performance.now() - t0;
  post({ type: 'fetch', have: SNAPSHOT.bytes, total: SNAPSHOT.bytes, rate: total / (ms / 1000) });
  log(`fetched ${(total / 1048576).toFixed(0)} MiB in ${(ms / 1000).toFixed(1)} s (${(total / 1048576 / (ms / 1000)).toFixed(1)} MiB/s), hashing the file`);
  const hex = await hashFile();
  post({ type: 'fetched', bytes: SNAPSHOT.bytes, ms, sha256: hex, ok: hex === SNAPSHOT.sha256 });
  if (hex !== SNAPSHOT.sha256) { await wipe(); throw new Error(`sha256 mismatch: got ${hex}; the file was discarded`); }
  try { await (await dir()).removeEntry(journalName); } catch {}
}

async function hashFile() { // for a file that landed in an earlier session without a recorded hash
  const h = await open(SNAPSHOT.file); const sha = new Sha256(); const buf = new Uint8Array(8 << 20); const size = h.getSize();
  for (let off = 0; off < size; off += buf.length) { const n = h.read(buf, { at: off }); sha.update(buf.subarray(0, n)); if ((off / buf.length) % 16 === 0) post({ type: 'hashing', at: off, total: size }); }
  h.close(); const hex = bytesToHex(sha.digest()); await writeSmall(`${SNAPSHOT.file}.sha256`, hex); return hex;
}

// Parse, verify hash_serialized_3, build the index, keep it on disk.
async function verify() {
  const h = await open(SNAPSHOT.file);
  const source = new OpfsBytes(h);
  const t0 = performance.now();
  const r = buildIndex(source, { hash: true, log: (text) => post({ type: 'parsing', text }) });
  h.close();
  const ok = r.hashSerialized === SNAPSHOT.txoutsetHash && r.baseHash === SNAPSHOT.baseHash && r.coinsRead === SNAPSHOT.coins && r.networkMagic === CHAIN.networkMagic;
  if (ok) { const ih = await open(`${SNAPSHOT.file}.idx`, true); ih.truncate(0); ih.write(indexBytes({ entries: r.entries, count: r.count, baseHash: r.baseHash }, SNAPSHOT.sha256), { at: 0 }); ih.flush(); ih.close(); }
  post({ type: 'verified', ok, coins: r.coinsRead, txids: r.txids, baseHash: r.baseHash, hashSerialized: r.hashSerialized, networkMagic: r.networkMagic, ms: performance.now() - t0, indexBytes: r.entries.length });
}

async function wipe() { const d = await dir(); for (const n of [SNAPSHOT.file, `${SNAPSHOT.file}.idx`, `${SNAPSHOT.file}.sha256`, `${SNAPSHOT.file}.ranges`]) { try { await d.removeEntry(n); } catch {} } }

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'status') await status();
    else if (m.type === 'fetch') { await fetchSnapshot(m.url); await status(); }
    else if (m.type === 'hash') { const hex = await hashFile(); post({ type: 'fetched', bytes: await sizeOf(SNAPSHOT.file), ms: 0, sha256: hex, ok: hex === SNAPSHOT.sha256 }); await status(); }
    else if (m.type === 'verify') { await verify(); await status(); }
    else if (m.type === 'wipe') { await wipe(); await status(); }
  } catch (err) { post({ type: 'error', text: err.message }); }
};
