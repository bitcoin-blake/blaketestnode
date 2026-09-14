// Checkpoints: the UTXO set written as a dumptxoutset-format snapshot at a height, with a
// manifest, so a restart loads the newest one instead of replaying from the fork.
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { writeSnapshot } from './snapshot.mjs';

export function listStates(dir) {
  const d = `${dir}/state`; if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^utxo-\d+\.json$/.test(f)).map((f) => ({ ...JSON.parse(readFileSync(`${d}/${f}`, 'utf8')), path: `${d}/${f.replace(/\.json$/, '.dat')}` }))
    .filter((m) => existsSync(m.path)).sort((a, b) => b.base_height - a.base_height);
}
export async function saveState(dir, utxo, { height, hash, networkMagic, network, keep = 2, log = () => {} }) {
  const d = `${dir}/state`; mkdirSync(d, { recursive: true });
  const dat = `${d}/utxo-${height}.dat`;
  const r = await writeSnapshot(`${dat}.tmp`, utxo, { baseHeight: height, baseHash: hash, networkMagic, coins: utxo.size, log });
  renameSync(`${dat}.tmp`, dat);
  const manifest = { network, base_height: height, base_hash: hash, txoutset_hash: r.hashSerialized, coins: r.coins, bytes: r.bytes, sha256: r.sha256, written_at: Math.floor(Date.now() / 1000), file: `utxo-${height}.dat` };
  writeFileSync(`${d}/utxo-${height}.json`, JSON.stringify(manifest, null, 1));
  for (const old of listStates(dir).slice(keep)) { try { unlinkSync(old.path); unlinkSync(old.path.replace(/\.dat$/, '.json')); } catch {} }
  return { ...manifest, ms: r.ms };
}
