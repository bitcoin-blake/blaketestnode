// Round three of the node's robustness: a parse that gives way (so a wipe or a ping is answered), an index that refuses to
// be torn, the rule files pinned by hash, and a mempool that knows how each transaction arrived.
//   SCHEMA=<bitcoin-desktop/schema> node test/robust3-test.mjs
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeSnapshot } from '../lib/snapshot-write.mjs';
import { buildIndex, buildIndexAsync, indexBytes, parseIndexBytes } from '../lib/packed.mjs';
import { FileBytes } from '../lib/filebytes.mjs';
import { Mempool } from '../lib/mempool.mjs';
import { CHAIN, SNAPSHOT } from '../lib/params.mjs';
import { hexToBytes, bytesToHex, reverse, equalBytes } from '../lib/bytes.mjs';
let ok = 0, bad = 0;
const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const dir = mkdtempSync(`${tmpdir()}/blaketestnode-r3-`);
try {
  // a small snapshot in the node's own format
  const coins = []; for (let i = 0; i < 2000; i++) coins.push({ txid: bytesToHex(randomBytes(32)), vout: i % 2, script: '0014' + bytesToHex(randomBytes(20)), value: 1000 + i, height: 1 + i });
  const groups = new Map(); for (const c of coins) (groups.get(c.txid) ?? groups.set(c.txid, []).get(c.txid)).push([c.vout, { height: c.height, coinbase: false, value: c.value, script: hexToBytes(c.script) }, null]);
  const raw = (x) => bytesToHex(reverse(hexToBytes(x)));
  const ordered = [...groups].sort((a, b) => (raw(a[0]) < raw(b[0]) ? -1 : 1)).map(([x, g]) => [x, g.sort((p, q) => p[0] - q[0])]);
  const path = `${dir}/utxo.dat`;
  await writeSnapshot(path, { groups: () => ordered }, { baseHeight: SNAPSHOT.baseHeight, baseHash: SNAPSHOT.baseHash, networkMagic: CHAIN.networkMagic, coins: coins.length });
  const file = new FileBytes(path);
  const a = buildIndex(file, { hash: true });
  let pauses = 0;
  const b = await buildIndexAsync(file, { hash: true, every: 100, pause: async () => { pauses++; } });
  t('the pausing parse builds the same index and the same hash_serialized_3 as the straight one', a.count === b.count && equalBytes(a.entries, b.entries) && a.hashSerialized === b.hashSerialized);
  t('...and gives way along the way', pauses >= 10, String(pauses));
  let stopped = null;
  try { await buildIndexAsync(file, { hash: true, every: 100, pause: async () => { throw Object.assign(new Error('wiping'), { quiet: true }); } }); } catch (e) { stopped = e; }
  t('a pause that throws (a wipe) stops the parse with that error', stopped?.message === 'wiping' && stopped.quiet);
  const ib = indexBytes({ entries: a.entries, count: a.count, baseHash: SNAPSHOT.baseHash }, SNAPSHOT.sha256);
  t('an intact index is read', parseIndexBytes(ib, SNAPSHOT.sha256).count === a.count);
  let torn = null; try { parseIndexBytes(ib.subarray(0, ib.length - 16), SNAPSHOT.sha256); } catch (e) { torn = e.message; }
  t('an index cut short is refused as torn, not half-trusted', /torn/.test(torn ?? ''), torn);
  let tiny = null; try { parseIndexBytes(ib.subarray(0, 20), SNAPSHOT.sha256); } catch (e) { tiny = e.message; }
  t('a few bytes are not an index', /not an index/.test(tiny ?? ''), tiny);
} finally { rmSync(dir, { recursive: true, force: true }); }

{
  // the worker's pinned rule hashes are those of the files at the engine commit it pins
  const src = readFileSync(new URL('../browser/worker.js', import.meta.url), 'utf8');
  const pin = src.match(/bitcoin-desktop\/schema@([0-9a-f]{40})/)?.[1];
  const want = Object.fromEntries([...src.matchAll(/'(schema\/[a-z0-9/-]+\.jsonld)': '([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]));
  const engine = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`;
  const badOnes = Object.entries(want).filter(([f, h]) => { try { return createHash('sha256').update(execSync(`git -C ${engine} show ${pin}:${f}`, { stdio: ['ignore', 'pipe', 'ignore'] })).digest('hex') !== h; } catch { return true; } });
  const fetched = [...src.matchAll(/j\('(schema\/[^']+)'\)/g)].map((m) => m[1]);
  t('the worker pins every rule file it fetches by hash, and the hashes are those at its engine commit', Object.keys(want).length === 6 && !badOnes.length && fetched.length >= 6 && fetched.every((f) => want[f]), JSON.stringify({ badOnes: badOnes.map(([f]) => f), fetched }));
}
{
  // how each mempool transaction arrived: only a node's own feed (23404) or the mirror's seed says a node has it
  class M extends Mempool { check(hex) { return this.txs.has(hex) ? { ok: true, txid: hex, dup: true } : { ok: true, txid: hex, tx: { inputs: [{ prevout: { txid: hex, vout: 0 } }], outputs: [] }, fee: 1, vsize: 1, feeRate: 1, replaces: [] }; } }
  const mp = new M({ k: null, node: null, network: 'x' });
  mp.add('aa', 'r', 'relay'); mp.add('bb', 'm', 'seed');
  t('a relay echo is not "fed"; a seed from the mirror is', mp.txs.get('aa').fed === false && mp.txs.get('aa').via === 'relay' && mp.txs.get('bb').fed === true && mp.lastFeedAt == null);
  mp.add('aa', 'f', 'feed');
  t('the same transaction later in a node\'s feed becomes "fed", and the feed time is kept', mp.txs.get('aa').fed === true && typeof mp.lastFeedAt === 'number');
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
