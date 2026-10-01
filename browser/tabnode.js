// The node in a tab, for any page: loads the browser worker pinned at `base` (imports rewritten, blob module), drives its
// phases (fetch from the mirror or the swarm, hash, verify, sync), seeds the snapshot when asked, and tells the page what
// is happening through events. No DOM in here; a page renders. Reef and Bight are two faces over this one loader.
//   const tn = createTabNode({ base, snapshotUrl, blocksUrl, torrent, seed });
//   tn.on('sync', ({ msg, pct, eta }) => …); tn.on('hist', ({ name, ms }) => …); tn.on('log', ({ text, level }) => …);
//   tn.on('message', (m) => …) for every worker message after the loader has taken its part; tn.on('synced', (m) => …) per type
//   await tn.start(); tn.post({ type: 'coins', script }); tn.followMempool({ relays, also, seedUrl }); tn.seedStart(); await tn.wipe() → { removed, failed }.
export const mib = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MiB`;
export const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
export const n = (x) => Number(x).toLocaleString('en-US');
export function eta(done, total, t0) { const el = (performance.now() - t0) / 1000; if (!done || el < 1) return ''; const left = (total - done) / (done / el); return left > 3600 ? `about ${(left / 3600).toFixed(1)} h left` : left > 90 ? `about ${Math.round(left / 60)} min left` : `about ${Math.round(left)} s left`; }
const WT_URL = 'https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js';
// AbortSignal.timeout where the browser has it (Safari 15 has locks but not this)
const timeoutSignal = (ms) => { if (AbortSignal.timeout) return AbortSignal.timeout(ms); const c = new AbortController(); setTimeout(() => c.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms); return c.signal; };
// errors of the network, as opposed to a file or a rule: these are retried by themselves
const NETWORK = /Failed to fetch|NetworkError|network|no data for|no answer in|block index \d|block file \d|short read|short range|answered 5\d\d|Load failed|aborted|timed? ?out|ECONN|503|502|504/i;

// a small worker holding one OPFS file with a sync access handle: the page's WebTorrent store writes pieces through it,
// and a seeding page reads through it (read-only, so the node worker can read the same file)
const STORE_SRC = `let h = null, name = null; const root = () => navigator.storage.getDirectory();
onmessage = async (e) => { const m = e.data; try {
  if (m.t === 'open') { name = m.name; const fh = await (await root()).getFileHandle(name, { create: !m.ro }); h = m.ro ? await fh.createSyncAccessHandle({ mode: 'read-only' }) : await fh.createSyncAccessHandle(); if (!m.ro && h.getSize() !== m.size) h.truncate(m.size); postMessage({ id: m.id, ok: true, size: h.getSize() }); }
  else if (m.t === 'close') { if (h) { try { h.flush(); } catch {} h.close(); h = null; } postMessage({ id: m.id, ok: true }); }
  else if (m.t === 'put') { h.write(m.buf, { at: m.at }); postMessage({ id: m.id, ok: true }); }
  else if (m.t === 'get') { const b = new Uint8Array(m.len); const n = h.read(b, { at: m.at }); postMessage({ id: m.id, ok: true, buf: b.buffer, n }, [b.buffer]); }
  else if (m.t === 'finish') { h.flush(); h.close(); h = null; const dir = await root(); const fh = await dir.getFileHandle(name); try { await dir.removeEntry(m.to); } catch {}
    if (fh.move) await fh.move(m.to); else { const out = await (await dir.getFileHandle(m.to, { create: true })).createSyncAccessHandle(); const src = await fh.createSyncAccessHandle(); const buf = new Uint8Array(32 << 20); let at = 0, n; while ((n = src.read(buf, { at })) > 0) { out.write(buf.subarray(0, n), { at }); at += n; } out.flush(); out.close(); src.close(); await dir.removeEntry(name); }
    postMessage({ id: m.id, ok: true }); }
  else if (m.t === 'remove') { if (h) { h.close(); h = null; } try { await (await root()).removeEntry(name); } catch {} postMessage({ id: m.id, ok: true }); }
  else if (m.t === 'probe') { /* two read-only handles on one scratch file: only a browser with read-only access handles opens both (elsewhere the option is ignored and the first is exclusive) */ const dir = await root(); const fh = await dir.getFileHandle('.seed-probe', { create: true }); let a = null, b = null, ok = false;
    try { a = await fh.createSyncAccessHandle({ mode: 'read-only' }); b = await fh.createSyncAccessHandle({ mode: 'read-only' }); ok = true; } catch {} finally { try { a?.close(); } catch {} try { b?.close(); } catch {} try { await dir.removeEntry('.seed-probe'); } catch {} }
    postMessage({ id: m.id, ok: true, readOnly: ok }); }
} catch (err) { postMessage({ id: m.id, ok: false, error: err.message }); } };`;
function storeWorker() { const w = new Worker(URL.createObjectURL(new Blob([STORE_SRC], { type: 'text/javascript' }))); let id = 0; const waits = new Map();
  w.onmessage = (e) => { const m = e.data; const p = waits.get(m.id); if (!p) return; waits.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(m.error)); };
  return { rpc: (m, transfer = []) => new Promise((resolve, reject) => { m.id = ++id; waits.set(m.id, { resolve, reject }); w.postMessage(m, transfer); }), terminate: () => w.terminate() }; }
// a chunk store in the shape WebTorrent expects: put/get by piece index, backed by the store worker
function opfsStoreClass(rpc) { return class { constructor(chunkLength, opts) { this.chunkLength = chunkLength; this.length = opts.length; }
  put(i, buf, cb = () => {}) { if (!this.Buf) this.Buf = buf.constructor; const copy = new Uint8Array(buf.length); copy.set(buf); rpc({ t: 'put', at: i * this.chunkLength, buf: copy }, [copy.buffer]).then(() => cb(null), cb); }
  get(i, opts, cb) { if (typeof opts === 'function') { cb = opts; opts = null; } const off = opts?.offset ?? 0; const piece = Math.min(this.chunkLength, this.length - i * this.chunkLength); const len = opts?.length ?? piece - off;
    rpc({ t: 'get', at: i * this.chunkLength + off, len }).then((m) => { const a = new Uint8Array(m.buf, 0, m.n); cb(null, this.Buf?.from ? this.Buf.from(a.buffer, a.byteOffset, a.length) : a); }, cb); }
  close(cb = () => {}) { cb(null); } destroy(cb = () => {}) { cb(null); } }; }
const torrentFileUrl = (snapshotUrl) => snapshotUrl.replace(/\.dat$/, '') + '.torrent';

// ---- the node's own code by content as well as by commit: sha256 of every file of this repository the worker loads, at the
// commit that holds this table (tools/integrity.mjs writes it; test/integrity-test.mjs checks it against the files)
// INTEGRITY:BEGIN
export const CODE_SHA256 = {
  'browser/blocks.js': 'd64c9d892a979502111c9ea1cf06ad7a588cd3b6e6d1e1dbb2d9f670de481573',
  'browser/worker.js': 'd083d01275f03e937b1335ac703d012d86476d299866badb17fbbe810978dd4c',
  'lib/bytes.mjs': 'c03070261249baaab1475caa4bf34f40c81556bc5fff97817c69951a356439d3',
  'lib/mempool.mjs': 'cd6fb29f9ad4c30e2430516a1cf2c2b43883a611e15bc6084df57068565bad23',
  'lib/nip333.mjs': '3f5bff6c201261a41322f51319d34d1c02e7b64ce3c68d59ca24af0983047e7a',
  'lib/node.mjs': '94713169c52c1443bc1def4cc0ede7647113b62da976bc8623b8018e5984e727',
  'lib/packed.mjs': 'bf79465a5bf4bfcbbec600d8f42b3ded81f1daf8a065ea95c4c08977460ceb3c',
  'lib/params.mjs': 'ff9abe2d6eca1b10460f4b74577ad56cfcc74fa2fa411903ee8cac9f18734058',
  'lib/sha256.mjs': '5150a47ad64ba86f527858f432bda497742b0548f71a3fbc1b0e1b1d04bbb9ce',
  'lib/snapshot.mjs': '944194abbaba8786a786acebfc0ecae060a12899f5c96985a824cbe3c87a12e4',
  'lib/template.mjs': 'fbe4be2c74580be3ab73238ecfe40f4908f52e2fc7a6250ab6da7dd7b9c77c94',
  'lib/varint.mjs': '6faaf5287e86853ef5ebf334b547695e696b4b5a80eba267e3f5383e5f9a161b',
  'lib/webminer.mjs': 'b1a7f5d582b5e1349a807a6438965a387f6cf5a3e878238f96f7e5a04c3d2998',
};
// INTEGRITY:END
async function sha256hex(text) { const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
// fetch `path` (relative to the repository at `base`), check it, bring in its relative imports the same way (as blob URLs),
// and give back its text with those imports pointing at the checked copies. Imports of other repositories (the engine,
// sidestr) stay as they are: pinned by commit, and the engine's rule files are checked by hash in the worker.
export async function workerSource(base, { entry = 'browser/worker.js', fetchText = null } = {}) {
  const host = base.replace(/^https?:\/\//, '').split('/')[0]; const blobs = new Map();
  const get = fetchText ?? (async (path) => { let r; try { r = await fetch(`${base}/${path}`, { signal: timeoutSignal(30_000) }); } catch (e) { throw new Error(`the node's code could not be loaded from ${host} (${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'no answer in 30 s' : e.message}): check the connection and reload`); } if (!r.ok) throw new Error(`the node's code could not be loaded from ${host} (${path} answered ${r.status}): check the connection and reload`); return r.text(); });
  const resolve = (from, rel) => { const parts = from.split('/').slice(0, -1); for (const p of rel.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); } return parts.join('/'); };
  const load = async (path, top) => {
    if (blobs.has(path)) return blobs.get(path);
    const text = await get(path); const want = CODE_SHA256[path];
    if (!want) throw new Error(`the node's ${path} is not in this loader's table of checked files: nothing was started`);
    if ((await sha256hex(text)) !== want) throw new Error(`the node's ${path} from ${host} is not the pinned file (its sha256 differs): nothing was started`);
    let out = text; for (const m of [...text.matchAll(/from '(\.{1,2}\/[^']+)'/g)]) { const dep = resolve(path, m[1]); out = out.split(`from '${m[1]}'`).join(`from '${await load(dep, false)}'`); }
    if (top) return out;
    const url = URL.createObjectURL(new Blob([out], { type: 'text/javascript' })); blobs.set(path, url); return url;
  };
  return load(entry, true);
}
export function createTabNode({ base, snapshotUrl, blocksUrl, torrent = false, seed = false, wtUrl = WT_URL, coins = 14200000 }) {
  const node = { phase: 'starting', st: null, height: null, hash: null, time: null, coins: null, txids: null, hs: null, hsOk: null, sha: null, hist: [], nostr: null, recv: 0, sent: 0, synced: false, fetchT0: 0, verifyT0: 0, syncT0: 0, lastSync: null, error: null, peers: null, mempool: null };
  const opts = { torrent, seed };
  const handlers = new Map(); const on = (t, f) => { (handlers.get(t) ?? handlers.set(t, new Set()).get(t)).add(f); return () => handlers.get(t)?.delete(f); };
  const emit = (t, a) => { for (const f of handlers.get(t) ?? []) { try { f(a); } catch (e) { console.error(e); } } };
  const log = (text, level = 'log') => emit('log', { text, level });
  const sync = (msg, pct, eta) => emit('sync', { msg, pct, eta: eta ?? '' });
  const hist = (name, ms) => { node.hist.push([name, ms]); emit('hist', { name, ms }); };
  let worker = null; const post = (m) => { if (worker) worker.postMessage(m); };
  const startSync = () => { node.phase = 'sync'; node.syncT0 = performance.now(); sync('Synchronizing with network… fetching the blocks since the fork', 0); post({ type: 'sync', blocksUrl, noScripts: false }); };
  const plainFetch = () => { node.phase = 'fetch'; node.fetchT0 = performance.now(); sync('Synchronizing with network… fetching the UTXO snapshot', 0); post({ type: 'fetch', url: snapshotUrl }); };
  const hashPhase = () => { node.phase = 'hash'; node.fetchT0 = performance.now(); sync('Checking the snapshot\'s hash…', 0); post({ type: 'hash' }); };
  const verifyPhase = () => { node.phase = 'verify'; node.verifyT0 = performance.now(); sync(`Verifying the snapshot… recomputing hash_serialized_3 over ${(coins / 1e6).toFixed(1)} million coins`, null); post({ type: 'verify' }); };

  // ---- the swarm: WebTorrent on the page (a worker has no WebRTC), pieces through the store worker, the mirror as webseed; the plain fetch when the swarm gives little
  let swarm = null;
  const swarmTeardown = (removePart) => { const s = swarm; swarm = null; if (!s) return; try { s.client?.destroy(); } catch {} (removePart ? s.sw.rpc({ t: 'remove' }) : Promise.resolve()).catch(() => {}).then(() => s.sw.terminate()); };
  async function swarmFetch(st) { const t0 = performance.now(); node.phase = 'fetch'; node.fetchT0 = t0; sync('Synchronizing with network… joining the swarm for the UTXO snapshot', 0); log('swarm: loading WebTorrent and the torrent file');
    let tick = null; const sw = storeWorker(); swarm = { sw, client: null };
    const fail = (e) => { if (!swarm) return; clearInterval(tick); log(`swarm: ${e.message}; fetching from the mirror instead`, 'err'); swarmTeardown(true); plainFetch(); };
    try {
      const [{ default: WebTorrent }, tf] = await Promise.all([import(wtUrl), fetch(torrentFileUrl(snapshotUrl), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`torrent file ${r.status}`); return r.arrayBuffer(); })]);
      await sw.rpc({ t: 'open', name: `${st.expect.file}.part`, size: st.expect.bytes });
      const client = new WebTorrent(); swarm.client = client; client.on('error', fail);
      client.add(new Uint8Array(tf), { store: opfsStoreClass(sw.rpc), storeCacheSlots: 0 }, (t) => { if (!swarm) return; log(`swarm: ${t.infoHash.slice(0, 12)}… ${t.pieces.length} pieces of ${mib(t.pieceLength)}, ${t.announce.length} trackers, webseed ${t.urlList?.length ? 'yes' : 'no'}`);
        tick = setInterval(() => { if (!swarm) return clearInterval(tick); const wires = t.wires.filter((w) => !w.destroyed); const ws = wires.filter((w) => w.type === 'webSeed').length; const peers = wires.length - ws; node.recv = t.downloaded; node.peers = { peers, webseed: ws };
          sync(`Synchronizing with network… fetching the UTXO snapshot from the swarm (${mib(t.downloaded)} of ${mib(t.length)}, ${(t.downloadSpeed / 1048576).toFixed(1)} MiB/s, ${peers} peer${peers === 1 ? '' : 's'}${ws ? ' + the mirror' : ''})`, t.progress * 100, eta(t.downloaded, t.length, t0));
          const el = performance.now() - t0; if (t.downloaded === 0 && el > 60000) fail(new Error('nothing from the swarm in 60 s')); else if (el > 30000 && t.progress < 0.5 && t.downloadSpeed < 2 * 1048576) fail(new Error(`the swarm gives ${(t.downloadSpeed / 1048576).toFixed(1)} MiB/s after ${Math.round(el / 1000)} s`)); }, 1000);
        t.on('done', async () => { if (!swarm) return; clearInterval(tick); const ms = performance.now() - t0; const peers = node.peers ?? {}; try { await sw.rpc({ t: 'finish', to: st.expect.file }); } catch (e) { return fail(e); }
          hist(`fetch the snapshot from the swarm (${peers.peers ?? 0} peer${peers.peers === 1 ? '' : 's'}${peers.webseed ? ' + the mirror' : ''})`, ms); log(`swarm: ${mib(t.length)} in ${secs(ms)}, ${mib(t.downloaded)} downloaded, ${mib(t.uploaded)} uploaded`);
          swarmTeardown(false); node.st.dat = st.expect.bytes; node.st.partial = false; hashPhase(); }); });
    } catch (e) { fail(e); } }

  // ---- seeding: the complete, checked snapshot held read-only and served to the swarm while the tab is open
  let seeding = null;
  const fileReady = () => { const st = node.st; return !!st && st.dat >= st.expect.bytes && !!(st.sha || node.sha); };
  // seeding holds the snapshot open read-only beside the node; a browser without read-only access handles would hold it
  // exclusively and stop the node, so it is asked first (once) and seeding refused there
  let seedProbe = null;
  const seedSupported = () => (seedProbe ??= (async () => { const sw = storeWorker(); try { return !!(await sw.rpc({ t: 'probe' })).readOnly; } catch { return false; } finally { sw.terminate(); } })());
  async function seedStart() { if (seeding || !opts.seed || !fileReady() || swarm) return;
    if (!(await seedSupported())) { node.seedUnsupported = true; log('seeding is not possible in this browser: it cannot open the snapshot read-only beside the node (Chrome, Edge and Brave can)', 'err'); emit('seeding', { unsupported: true }); return; }
    if (seeding || !opts.seed || !fileReady() || swarm) return; const st = node.st; const sw = storeWorker(); seeding = { sw, client: null, t: null, base: node.sent, at: Date.now() }; const me = seeding;
    const stop = (why) => { if (seeding !== me) return; log(`seeding stopped: ${why}`, 'err'); seedStop(); };
    try {
      const [{ default: WebTorrent }, tf] = await Promise.all([import(wtUrl), fetch(torrentFileUrl(snapshotUrl), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`torrent file ${r.status}`); return r.arrayBuffer(); })]);
      if (seeding !== me) return; const o = await sw.rpc({ t: 'open', name: st.expect.file, ro: true }); if (o.size !== st.expect.bytes) throw new Error(`the file is ${o.size} bytes, not ${st.expect.bytes}`);
      if (seeding !== me) return; const client = new WebTorrent(); me.client = client; client.on('error', (e) => stop(e.message));
      client.add(new Uint8Array(tf), { store: opfsStoreClass(sw.rpc), storeCacheSlots: 0, skipVerify: true }, (t) => { if (seeding !== me) return; me.t = t; log(`seeding the snapshot to the swarm (${t.announce.length} trackers); stops when this tab closes`);
        me.tick = setInterval(() => { if (seeding !== me) return; node.sent = me.base + t.uploaded; emit('seeding', { peers: t.wires.filter((w) => !w.destroyed && w.type !== 'webSeed').length, uploaded: t.uploaded, wires: t.wires.filter((w) => !w.destroyed).map((w) => ({ type: w.type, peerId: w.peerId, uploaded: w.uploaded })) }); }, 2000); });
    } catch (e) { stop(e.message); } }
  function seedStop() { const s = seeding; seeding = null; if (!s) return Promise.resolve(); clearInterval(s.tick); try { s.client?.destroy(); } catch {} emit('seeding', null); return s.sw.rpc({ t: 'close' }).catch(() => {}).then(() => s.sw.terminate()); }
  addEventListener('beforeunload', () => { swarmTeardown(false); seedStop(); });
  // after a sleep (hidden more than a minute) or a lost connection, the worker opens its relay sockets again and looks for
  // blocks; a snapshot download that stopped for want of a connection resumes where it stopped (its journal lists the ranges)
  // the first catch-up (before 'synced', when the worker has no timer of its own) is retried too: at once on wake, and after
  // a network error by itself with a growing wait (5 s … 5 min)
  let retryTimer = null, retryN = 0;
  const retrySync = () => { clearTimeout(retryTimer); retryTimer = null; node.retryAt = null; node.lastError = { text: node.error, at: Date.now() }; node.error = null; log('looking for the blocks again'); startSync(); };
  let hiddenAt = null; const wake = () => { if (!worker || node.phase === 'wiped') return; /* a wiped node waits to be started again */ if (node.phase === 'fetch' && node.error && !swarm) { clearTimeout(retryTimer); retryTimer = null; node.lastError = { text: node.error, at: Date.now() }; node.error = null; log('the connection is back: resuming the snapshot'); plainFetch(); } else if (node.phase === 'sync' && node.error && !node.synced) retrySync(); else if (node.synced) post({ type: 'wake' }); };
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); else { if (hiddenAt && Date.now() - hiddenAt > 60_000) wake(); hiddenAt = null; } });
  addEventListener('online', wake);
  // a laptop that slept with the tab in front fires neither of those: timers stop while asleep, so a long gap between ticks says it
  let lastTick = Date.now(); const ticker = setInterval(() => { const now = Date.now(); if (now - lastTick > 120_000) { log(`the computer slept for about ${Math.round((now - lastTick) / 60_000)} min: reconnecting`); wake(); } lastTick = now; }, 15_000); ticker.unref?.();

  // a worker that died (memory pressure on a phone) or hangs says nothing: a ping every 30 s, answered outside its queue; two
  // minutes without an answer is said as an error the page shows, and cleared when it answers again
  // unresponsive is a state, not a stop: node.unresponsive is set with node.unresponsiveText (pages show it as a warning), and node.error is untouched;
  // a page that was itself paused (asleep, a frozen background tab) does not count the pause against the worker
  let lastPong = Date.now(), lastPing = Date.now(); const UNRESPONSIVE = 'the node has not answered for two minutes (its worker may have been stopped by the browser): reload the page if it does not come back';
  const pinger = setInterval(() => { if (!worker) return; const now = Date.now(); const paused = now - lastPing > 60_000; lastPing = now; if (paused) { lastPong = now; post({ type: 'ping', t: now }); return; } post({ type: 'ping', t: now });
    if (now - lastPong > 120_000 && !node.unresponsive) { node.unresponsive = true; node.unresponsiveText = UNRESPONSIVE; /* its own field: a real node.error (a mismatch, a disagreement) is never overwritten */ sync(UNRESPONSIVE, null); log(UNRESPONSIVE, 'err'); emit('unresponsive', {}); emit('message', { type: 'unresponsive' }); } }, 30_000); pinger.unref?.();
  // ---- the worker's messages: the loader takes the phases, the page gets every message after
  function onMessage(e) { const m = e.data;
    if (m.type === 'pong') { lastPong = Date.now(); if (node.unresponsive) { node.unresponsive = false; node.unresponsiveText = null; /* node.error is left as it was */ log('the node answers again'); sync(node.error ? 'Error: ' + node.error.slice(0, 140) : node.synced ? `Up to date · ${n(node.height)}` : 'the node answers again', null); emit('responsive', {}); emit('message', { type: 'responsive' }); } return; }
    if (m.type === 'status') { const first = !node.st; node.st = m; if (!first) seedStart(); if (first) { if (m.dat < m.expect.bytes) { if (opts.torrent) swarmFetch(m); else plainFetch(); } else if (!m.sha) hashPhase(); else if (m.idx <= 0) { seedStart(); verifyPhase(); } else { seedStart(); startSync(); } } }
    else if (m.type === 'fetch') { retryN = 0; node.retryAt = null; node.recv = m.have; sync(`Synchronizing with network… fetching the UTXO snapshot (${mib(m.have)} of ${mib(m.total)}, ${(m.rate / 1048576).toFixed(1)} MiB/s)`, m.have / m.total * 100, eta(m.have, m.total, node.fetchT0)); }
    else if (m.type === 'hashing') { sync(`Checking the snapshot's sha256… ${mib(m.at)} of ${mib(m.total)}`, m.at / m.total * 100, ''); }
    else if (m.type === 'fetched') { retryN = 0; node.retryAt = null; if (m.ms) hist('fetch the snapshot', m.ms); hist('check the sha256', Math.max(0, performance.now() - node.fetchT0 - (m.ms || 0))); if (!m.ok) { node.error = 'the snapshot\'s sha256 does not match the pinned value'; sync('Snapshot hash MISMATCH: the file is not the one the node expects', null); } else { node.sha = m.sha256; if (node.st) node.st.sha = m.sha256; seedStart(); verifyPhase(); } }
    else if (m.type === 'parsing') { sync(`Verifying the snapshot… ${m.text.trim()}`, null); }
    else if (m.type === 'verified' && (node.phase === 'sync' || node.phase === 'synced')) { node.coins = m.coins ?? node.coins; /* an index rebuilt during a sync: the sync goes on, it is not started again */ }
    else if (m.type === 'verified') { hist('parse, hash and index the snapshot', m.ms); node.coins = m.coins; node.txids = m.txids; node.hs = m.hashSerialized; node.hsOk = m.ok; if (!m.ok) { node.error = 'hash_serialized_3 mismatch'; sync('Snapshot verification FAILED: hash_serialized_3 does not match', null); } else startSync(); }
    else if (m.type === 'blockfile') { node.recv += m.fetched || 0; }
    else if (m.type === 'progress') { retryN = 0; node.retryAt = null; const done = m.applied, total = Math.max(1, m.to - (m.height - m.applied)); sync(`Synchronizing with network… block ${n(m.height)} of ${n(m.to)} (${n(m.to - m.height)} remaining)`, done / total * 100, eta(done, total, node.syncT0)); node.height = m.height; node.coins = m.coins ?? node.coins; }
    else if (m.type === 'synced') { retryN = 0; node.retryAt = null; clearTimeout(retryTimer); retryTimer = null; if (node.error && !/mismatch|FAILED/i.test(node.error)) { node.lastError = { text: node.error, at: Date.now() }; node.error = null; } if (!node.synced) hist(`validate ${n(m.applied)} blocks to the tip`, m.ms); node.synced = true; node.phase = 'synced'; node.height = m.height; node.hash = m.hash; node.time = m.time; node.lastSync = Date.now(); sync(m.applied ? `Up to date · ${n(m.height)} · ${m.applied} block${m.applied === 1 ? '' : 's'} validated` : `Up to date · ${n(m.height)}`, null); }
    else if (m.type === 'nostr') { node.nostr = m; }
    else if (m.type === 'mempool') { node.mempool = m; }
    else if (m.type === 'error') { const lookup = node.synced && (m.req != null || /Block not found|sync first|not in the set|not in mempool/.test(m.text)); /* a request's own answer, not the node's state */ if (!lookup) { node.error = m.text; sync('Error: ' + m.text.slice(0, 140), null); }
      if (!lookup && node.phase === 'fetch' && !swarm && NETWORK.test(m.text) && !retryTimer) { const wait = Math.min(300_000, 5000 * 2 ** retryN++); log(`the snapshot's source did not answer: the fetch resumes in ${Math.round(wait / 1000)} s`); node.retryAt = Date.now() + wait; retryTimer = setTimeout(() => { retryTimer = null; node.retryAt = null; node.lastError = { text: node.error, at: Date.now() }; node.error = null; plainFetch(); }, wait); }
      if (!lookup && node.phase === 'sync' && !node.synced && NETWORK.test(m.text) && !retryTimer) { const wait = Math.min(300_000, 5000 * 2 ** retryN++); log(`the block source did not answer: trying again in ${Math.round(wait / 1000)} s`); node.retryAt = Date.now() + wait; retryTimer = setTimeout(retrySync, wait); } log((lookup ? '' : 'node error: ') + m.text.replace(/ @ .*$/, '') + (lookup ? ' (code -5)' : ''), 'err'); }
    else if (m.type === 'log') { log(m.text); }
    if (m.type !== 'log') emit(m.type, m); emit('message', m); } // 'log' is the loader's own event above, so a worker log line is not delivered twice

  // one node per browser for every app of this origin (Reef, Bight, Winch, Hitch share its files): a second tab stays idle
  // and says so; start() resolves false then. The lock is held for the life of the page.
  // start({ force: true }) runs without the lock, for a browser whose lock API fails; the page asks the person first
  async function start({ force = false } = {}) { if (navigator.locks && opts.lock !== false && !force) { const got = await new Promise((res) => navigator.locks.request('bitcoin-blake:node', { signal: timeoutSignal(3000) }, () => { res(true); return new Promise(() => {}); }).catch((e) => { if (e?.name !== 'AbortError' && e?.name !== 'TimeoutError') node.lockError = e?.message || String(e); res(false); })); /* a reload of the same tab can find the lock still held by the page it replaces: wait up to three seconds */ if (!got && node.lockError) { node.phase = 'busy'; sync('the browser refused the lock that keeps one node per browser: ' + node.lockError, null); emit('busy', { error: node.lockError }); return false; } if (!got) { node.busy = true; node.phase = 'busy'; sync('idle: the node runs in another tab of this browser (Reef, Bight, Winch or Hitch)', null); emit('busy', {}); return false; } }
    return startWorker(); }
  let workerSrc = null;
  const spawn = () => { worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })), { type: 'module' }); worker.onmessage = onMessage; worker.onerror = (e) => { node.error = e.message || 'worker failed'; sync('Error: ' + node.error, null); log('worker error: ' + node.error, 'err'); }; lastPong = Date.now(); };
  async function startWorker() {
    // the node's code from the CDN, each file checked against the hashes this loader carries (a CDN serving other code would
    // run another node beside the wallet's key): a hang, an error page or a changed file stops here, said in words
    workerSrc = await workerSource(base);
    spawn();
    sync('Starting the node…', null); log('loading the node from ' + base.replace('https://cdn.jsdelivr.net/gh/', '')); post({ type: 'status' }); return true; }

  return { node, opts, on, emit, start, post, startSync, fileReady, seedStart, seedStop,
    get swarm() { return swarm; }, get seeding() { return seeding; },
    setTorrent(v) { opts.torrent = !!v; }, setSeed(v) { opts.seed = !!v; if (opts.seed) seedStart(); else seedStop(); },
    followMempool({ relays, also = [23503], seedUrl = blocksUrl.replace(/-blocks$/, '-mempool.json') }) { post({ type: 'mempool', relays, also, seedUrl }); },
    // resolves once the node's files are removed ({ removed, failed }). A worker that does not answer in `timeoutMs` (busy, or
    // stuck) is stopped and a fresh one wipes; that one has another `timeoutMs`, else this rejects and nothing is pending
    // this clock against the real one (seconds, + when fast): the live signed tip looks back that much further
    setSkew(s) { post({ type: 'skew', s }); },
    wipe({ timeoutMs = 20_000 } = {}) { swarmTeardown(true); clearTimeout(retryTimer); retryTimer = null; node.retryAt = null; node.phase = 'wiped'; /* no retry or wake restarts a node being wiped */
      const once = () => new Promise((resolve, reject) => { const off = on('wiped', (m) => { clearTimeout(t); off(); resolve({ removed: m.removed, failed: m.failed }); });
        const t = setTimeout(() => { off(); reject(new Error('timeout')); }, timeoutMs); post({ type: 'wipe' }); });
      return seedStop().then(async () => { if (!worker) throw new Error('the node is not running in this tab');
        try { return await once(); }
        catch { log('the node did not answer the wipe: stopping it and wiping from a fresh one', 'err'); try { worker.terminate(); } catch {} spawn();
          try { return await once(); } catch { try { worker.terminate(); } catch {} worker = null;
            /* no node runs now: said as an error (phase 'error', node.error, an 'error' message), so a page does not go on showing a frozen node as live */
            const text = 'the node did not wipe in time and is stopped: its files may be partly removed. Close the other tabs of this site and reload'; node.phase = 'error'; node.synced = false; node.error = text; sync('Error: ' + text, null);
            const m = { type: 'error', text, fatal: true }; emit('error', m); emit('message', m); throw new Error('the node did not wipe in time, and nothing is pending: close the other tabs of this site and try again'); } } }); },
    seedSupported, workerSource: () => workerSource(base) };
}
