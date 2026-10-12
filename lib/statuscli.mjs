// A running daemon's /status.json as a few lines for a terminal (blaketestnode status [--watch]).
import { fmtAgo, fmtDuration } from './progress.mjs';
const n = (x) => x == null ? '?' : Number(x).toLocaleString('en-US');
const short = (h) => h ? `${h.slice(0, 16)}…` : '—';
export function renderStatus(s, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  out.push(`${s.alias ?? s.network}  ${s.state}  height ${n(s.height)}  ${short(s.hash)}  coins ${n(s.coins)}${s.saving ? '  (writing a checkpoint)' : ''}`);
  out.push(`tip time ${s.tipTime ? fmtAgo(now - s.tipTime) : '?'} · last tick ${s.lastTickAt ? fmtAgo(now - s.lastTickAt) : '?'} · uptime ${fmtDuration(s.uptimeS)} · rss ${n(s.rssMiB)} MiB`);
  const ck = s.checkpoint; out.push(`checkpoint ${ck ? `${n(ck.height)} ${short(ck.hash)}` : 'none (fork snapshot)'} · deltas ${n(s.deltas)}`);
  const t = s.nostr;
  if (t) { const behind = s.height - t.height; out.push(`nostr tip ${n(t.height)} ${t.agree === true ? 'agrees' : t.agree === false ? 'DISAGREES' : 'not yet compared'}${behind > 0 ? `, ${behind} behind` : behind < 0 ? `, ${-behind} ahead` : ''} · ${t.created_at ? fmtAgo(now - t.created_at) : '?'} via ${(t.relay ?? '').replace(/^wss?:\/\//, '')}`); }
  else out.push('nostr tip: none heard');
  const f = s.file; if (f) out.push(`block file ${n(f.from)}–${n(f.to)} (${n(f.blocks)} blocks)${f.at ? `, checked ${fmtAgo(now - f.at)}` : ''}`);
  const r = s.run; if (r) out.push(`this run: ${n(r.blocks)} blocks, ${n(r.txs)} txs, ${fmtDuration((r.validateMs ?? 0) / 1000)} validating, ${n(r.failed)} failed, ${n(r.rollbacks)} rollbacks${r.startedFrom != null ? `, from ${n(r.startedFrom)}` : ''}`);
  const extras = [];
  if (s.mempool) extras.push(`mempool ${n(s.mempool.count)}`);
  if (s.addressIndex && s.addressIndex !== 'loading') extras.push(`address index ${n(s.addressIndex.coins)} coins`); else if (s.addressIndex === 'loading') extras.push('address index loading');
  if (s.pair) extras.push(`pair ${s.pair.alias}`);
  if (extras.length) out.push(extras.join(' · '));
  return out.join('\n');
}
