// The node in a tab, for any page: loads the browser worker pinned at `base` (imports rewritten, blob module), drives its
// phases (fetch from the mirror or the swarm, hash, verify, sync), seeds the snapshot when asked, and tells the page what
// is happening through events. No DOM in here; a page renders. Reef and Bight are two faces over this one loader.
//   const tn = createTabNode({ base, snapshotUrl, blocksUrl, torrent, seed });
//   tn.on('sync', ({ msg, pct, eta }) => …); tn.on('hist', ({ name, ms }) => …); tn.on('log', ({ text, level }) => …);
//   tn.on('message', (m) => …) for every worker message after the loader has taken its part; tn.on('synced', (m) => …) per type
//   await tn.start(); tn.post({ type: 'coins', script }); tn.followMempool({ relays, also, seedUrl }); tn.seedStart(); tn.wipe();
export const mib = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MiB`;
export const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
export const n = (x) => Number(x).toLocaleString('en-US');
export function eta(done, total, t0) { const el = (performance.now() - t0) / 1000; if (!done || el < 1) return ''; const left = (total - done) / (done / el); return left > 3600 ? `about ${(left / 3600).toFixed(1)} h left` : left > 90 ? `about ${Math.round(left / 60)} min left` : `about ${Math.round(left)} s left`; }
const WT_URL = 'https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js';

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
  async function seedStart() { if (seeding || !opts.seed || !fileReady() || swarm) return; const st = node.st; const sw = storeWorker(); seeding = { sw, client: null, t: null, base: node.sent, at: Date.now() }; const me = seeding;
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
  let hiddenAt = null; const wake = () => { if (!worker) return; if (node.phase === 'fetch' && node.error && !swarm) { node.lastError = { text: node.error, at: Date.now() }; node.error = null; log('the connection is back: resuming the snapshot'); plainFetch(); } else if (node.synced) post({ type: 'wake' }); };
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); else { if (hiddenAt && Date.now() - hiddenAt > 60_000) wake(); hiddenAt = null; } });
  addEventListener('online', wake);

  // ---- the worker's messages: the loader takes the phases, the page gets every message after
  function onMessage(e) { const m = e.data;
    if (m.type === 'status') { const first = !node.st; node.st = m; if (!first) seedStart(); if (first) { if (m.dat < m.expect.bytes) { if (opts.torrent) swarmFetch(m); else plainFetch(); } else if (!m.sha) hashPhase(); else if (m.idx <= 0) { seedStart(); verifyPhase(); } else { seedStart(); startSync(); } } }
    else if (m.type === 'fetch') { node.recv = m.have; sync(`Synchronizing with network… fetching the UTXO snapshot (${mib(m.have)} of ${mib(m.total)}, ${(m.rate / 1048576).toFixed(1)} MiB/s)`, m.have / m.total * 100, eta(m.have, m.total, node.fetchT0)); }
    else if (m.type === 'hashing') { sync(`Checking the snapshot's sha256… ${mib(m.at)} of ${mib(m.total)}`, m.at / m.total * 100, ''); }
    else if (m.type === 'fetched') { if (m.ms) hist('fetch the snapshot', m.ms); hist('check the sha256', Math.max(0, performance.now() - node.fetchT0 - (m.ms || 0))); if (!m.ok) { node.error = 'the snapshot\'s sha256 does not match the pinned value'; sync('Snapshot hash MISMATCH: the file is not the one the node expects', null); } else { node.sha = m.sha256; if (node.st) node.st.sha = m.sha256; seedStart(); verifyPhase(); } }
    else if (m.type === 'parsing') { sync(`Verifying the snapshot… ${m.text.trim()}`, null); }
    else if (m.type === 'verified') { hist('parse, hash and index the snapshot', m.ms); node.coins = m.coins; node.txids = m.txids; node.hs = m.hashSerialized; node.hsOk = m.ok; if (!m.ok) { node.error = 'hash_serialized_3 mismatch'; sync('Snapshot verification FAILED: hash_serialized_3 does not match', null); } else startSync(); }
    else if (m.type === 'blockfile') { node.recv += m.fetched || 0; }
    else if (m.type === 'progress') { const done = m.applied, total = Math.max(1, m.to - (m.height - m.applied)); sync(`Synchronizing with network… block ${n(m.height)} of ${n(m.to)} (${n(m.to - m.height)} remaining)`, done / total * 100, eta(done, total, node.syncT0)); node.height = m.height; node.coins = m.coins ?? node.coins; }
    else if (m.type === 'synced') { if (node.error && !/mismatch|FAILED/i.test(node.error)) { node.lastError = { text: node.error, at: Date.now() }; node.error = null; } if (!node.synced) hist(`validate ${n(m.applied)} blocks to the tip`, m.ms); node.synced = true; node.phase = 'synced'; node.height = m.height; node.hash = m.hash; node.time = m.time; node.lastSync = Date.now(); sync(m.applied ? `Up to date · ${n(m.height)} · ${m.applied} block${m.applied === 1 ? '' : 's'} validated` : `Up to date · ${n(m.height)}`, null); }
    else if (m.type === 'nostr') { node.nostr = m; }
    else if (m.type === 'mempool') { node.mempool = m; }
    else if (m.type === 'error') { const lookup = node.synced && /Block not found|sync first|not in the set|not in mempool/.test(m.text); if (!lookup) { node.error = m.text; sync('Error: ' + m.text.slice(0, 140), null); } log((lookup ? '' : 'node error: ') + m.text.replace(/ @ .*$/, '') + (lookup ? ' (code -5)' : ''), 'err'); }
    else if (m.type === 'log') { log(m.text); }
    if (m.type !== 'log') emit(m.type, m); emit('message', m); } // 'log' is the loader's own event above, so a worker log line is not delivered twice

  // one node per browser for every app of this origin (Reef, Bight, Winch, Hitch share its files): a second tab stays idle
  // and says so; start() resolves false then. The lock is held for the life of the page.
  // start({ force: true }) runs without the lock, for a browser whose lock API fails; the page asks the person first
  async function start({ force = false } = {}) { if (navigator.locks && opts.lock !== false && !force) { const got = await new Promise((res) => navigator.locks.request('bitcoin-blake:node', { signal: AbortSignal.timeout(3000) }, () => { res(true); return new Promise(() => {}); }).catch((e) => { if (e?.name !== 'AbortError' && e?.name !== 'TimeoutError') node.lockError = e?.message || String(e); res(false); })); /* a reload of the same tab can find the lock still held by the page it replaces: wait up to three seconds */ if (!got && node.lockError) { node.phase = 'busy'; sync('the browser refused the lock that keeps one node per browser: ' + node.lockError, null); emit('busy', { error: node.lockError }); return false; } if (!got) { node.busy = true; node.phase = 'busy'; sync('idle: the node runs in another tab of this browser (Reef, Bight, Winch or Hitch)', null); emit('busy', {}); return false; } }
    return startWorker(); }
  async function startWorker() { const src = await (await fetch(`${base}/browser/worker.js`)).text(); const w = src.replace(/from '\.\.\/lib\//g, `from '${base}/lib/`).replace(/from '\.\/blocks\.js'/g, `from '${base}/browser/blocks.js'`);
    worker = new Worker(URL.createObjectURL(new Blob([w], { type: 'text/javascript' })), { type: 'module' }); worker.onmessage = onMessage; worker.onerror = (e) => { node.error = e.message || 'worker failed'; sync('Error: ' + node.error, null); log('worker error: ' + node.error, 'err'); };
    sync('Starting the node…', null); log('loading the node from ' + base.replace('https://cdn.jsdelivr.net/gh/', '')); post({ type: 'status' }); return true; }

  return { node, opts, on, emit, start, post, startSync, fileReady, seedStart, seedStop,
    get swarm() { return swarm; }, get seeding() { return seeding; },
    setTorrent(v) { opts.torrent = !!v; }, setSeed(v) { opts.seed = !!v; if (opts.seed) seedStart(); else seedStop(); },
    followMempool({ relays, also = [23503], seedUrl = blocksUrl.replace(/-blocks$/, '-mempool.json') }) { post({ type: 'mempool', relays, also, seedUrl }); },
    wipe() { return seedStop().then(() => post({ type: 'wipe' })); } };
}
