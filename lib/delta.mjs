// Per-block deltas: what a block spent and created, one JSON line each, appended after every
// applied block and replayed on restart on top of the newest full checkpoint. A rollback
// truncates the log. Small (a few KB per block), so a restart never rewrites the base.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

export class DeltaLog {
  constructor(path) { this.path = path; this.lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []; }
  // entries above `base` in order, parsed
  entries(base) { const out = []; for (const l of this.lines) { const d = JSON.parse(l); if (d.height > base) out.push(d); } return out; }
  append(d) { const l = JSON.stringify(d); this.lines.push(l); appendFileSync(this.path, l + '\n'); }
  // keep only blocks at or below `height`
  truncate(height) { const keep = this.lines.filter((l) => JSON.parse(l).height <= height); if (keep.length !== this.lines.length) { this.lines = keep; writeFileSync(this.path, keep.map((l) => l + '\n').join('')); } }
  // drop everything at or below a new full checkpoint
  compact(base) { this.truncate(Infinity); const keep = this.lines.filter((l) => JSON.parse(l).height > base); this.lines = keep; writeFileSync(this.path, keep.map((l) => l + '\n').join('')); }
  get length() { return this.lines.length; }
}
// apply one delta to a utxo set (spent keys removed, created coins added); returns the block height
export function applyDelta(utxo, d) {
  for (const key of d.spent) utxo.delete(key);
  for (const [key, coin] of d.created) utxo.set(key, coin);
  return d.height;
}
