// One line of progress on a terminal, rewritten in place; nothing at all when stderr is not a
// terminal (logs and pm2 keep the plain log lines). Texts for the two long stages live here too.
export class Progress {
  constructor(stream = process.stderr, { minMs = 100 } = {}) { this.stream = stream; this.tty = !!stream.isTTY; this.minMs = minMs; this.last = 0; this.shown = false; }
  line(text, { force = false } = {}) {
    if (!this.tty) return false;
    const now = Date.now(); if (!force && now - this.last < this.minMs) return false; this.last = now;
    const width = (this.stream.columns || 120) - 1;
    this.stream.write(`\r\x1b[2K${text.length > width ? text.slice(0, width) : text}`); this.shown = true; return true;
  }
  end() { if (this.shown) { this.stream.write('\r\x1b[2K'); this.shown = false; } }
}

export const fmtDuration = (s) => s == null || !isFinite(s) ? '?' : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.floor(s / 60)} m ${Math.round(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
export const fmtAgo = (sec) => sec == null ? '?' : sec < 90 ? `${sec} s ago` : sec < 5400 ? `${Math.round(sec / 60)} min ago` : sec < 172800 ? `${(sec / 3600).toFixed(1)} h ago` : `${Math.round(sec / 86400)} d ago`;
const bar = (frac, w = 20) => { const n = Math.max(0, Math.min(w, Math.round(frac * w))); return `[${'#'.repeat(n)}${'.'.repeat(w - n)}]`; };

// the snapshot parse: bytes read of the file, coins so far, coins per second, time left
export function parseLine({ count, pos, total, ms }) {
  const frac = total ? pos / total : 0, s = ms / 1000, rate = s > 0 ? count / s : 0, eta = frac > 0 ? s / frac - s : null;
  return `parse ${bar(frac)} ${(frac * 100).toFixed(0)}% ${count.toLocaleString('en-US')} coins · ${Math.round(rate).toLocaleString('en-US')} coins/s · ${fmtDuration(s)} · eta ${fmtDuration(eta)}`;
}

// block validation: blocks done of total, the height, blocks per second, µs per transaction, time left
export function blocksLine({ done, total, height, ms, validateMs = null, txs = 0 }) {
  const frac = total ? done / total : 0, s = ms / 1000, bps = s > 0 ? done / s : 0, eta = bps > 0 ? (total - done) / bps : null;
  const us = validateMs != null && txs ? ` · ${Math.round(validateMs * 1000 / txs).toLocaleString('en-US')} µs/tx` : '';
  return `blocks ${bar(frac)} ${done.toLocaleString('en-US')}/${total.toLocaleString('en-US')} at ${height} · ${bps.toFixed(1)} blocks/s${us} · ${fmtDuration(s)} · eta ${fmtDuration(eta)}`;
}
