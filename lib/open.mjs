// Open a daemon's state read-only in another process: the newest checkpoint on the served chain,
// the deltas since it, the block file mirrored into a scratch directory so the daemon's own mirror
// is never touched. For tests and tools that want to be a web node without running the daemon.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { CHAIN, SNAPSHOT } from './params.mjs';
import { PackedUtxo, parseIndexBytes } from './packed.mjs';
import { FileBytes } from './filebytes.mjs';
import { HttpBlockSource } from './source.mjs';
import { ChainNode } from './node.mjs';
import { listStates } from './state.mjs';
import { DeltaLog, applyDelta } from './delta.mjs';

export async function openNode({ k, data, blocksUrl, scratch, log = () => {} }) {
  mkdirSync(scratch, { recursive: true });
  const source = new HttpBlockSource(k, blocksUrl, scratch, { log }); await source.update();
  const ctx = await source.contextHeaders(blocksUrl.replace(/-blocks$/, '-context-headers.json'));
  const load = (path, sha256) => { const idx = `${path}.idx`; if (!existsSync(idx)) throw new Error(`no index beside ${path}`); return new PackedUtxo(new FileBytes(path), parseIndexBytes(new Uint8Array(readFileSync(idx)), sha256)); };
  let utxo = null, base = null;
  for (const m of listStates(data)) { if (m.base_height > source.index.to || (await source.hash(m.base_height)) !== m.base_hash) continue; try { utxo = load(m.path, m.sha256); base = { height: m.base_height, hash: m.base_hash }; break; } catch (e) { log(`checkpoint ${m.base_height} unusable: ${e.message}`); } }
  if (!utxo) { utxo = load(`${data}/${SNAPSHOT.file}`, SNAPSHOT.sha256); base = { height: SNAPSHOT.baseHeight, hash: SNAPSHOT.baseHash }; }
  let replayed = 0; for (const d of new DeltaLog(`${data}/deltas.jsonl`).entries(base.height)) { if (d.height !== base.height + 1 || (await source.hash(d.height)) !== d.hash) break; applyDelta(utxo, d); base = { height: d.height, hash: d.hash }; replayed++; }
  const epochStart = Math.floor(SNAPSHOT.baseHeight / CHAIN.retargetInterval) * CHAIN.retargetInterval;
  const node = new ChainNode({ k, utxo, epochStart, log }); node.loadContext(ctx.headers.map((h) => k.codec.decode('BlockHeader', h))); node.setBase(base.height, base.hash);
  for (let h = SNAPSHOT.baseHeight + 1; h <= base.height; h++) { const b = k.codec.decode('Block', await source.blockHex(h)); node.headers[h] = b.header; node.chain[h] = await source.hash(h); }
  // and the rest of the served chain, validated here
  let applied = 0; for (let h = node.height + 1; h <= source.index.to; h++) { node.applyNext(h, await source.blockHex(h)); applied++; }
  log(`opened ${data}: checkpoint ${base.height - replayed}, ${replayed} delta(s), ${applied} block(s) validated, tip ${node.height}`);
  return { node, utxo, source, sync: async () => { await source.update(); let n = 0; for (let h = node.height + 1; h <= source.index.to; h++) { node.applyNext(h, await source.blockHex(h)); n++; } return n; } };
}
