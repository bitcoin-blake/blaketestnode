// Fetches the snapshot over WebTorrent (magnet + HTTP webseed) into dir, then checks its sha256.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { SNAPSHOT } from './params.mjs';

export async function sha256File(path) {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c);
  return h.digest('hex');
}

export async function fetchSnapshot(dir, { log = console.error, timeoutMs = 3_600_000 } = {}) {
  const path = `${dir}/${SNAPSHOT.file}`;
  if (existsSync(path) && statSync(path).size === SNAPSHOT.bytes) { log('snapshot already present'); return { path, skipped: true }; }
  const { default: WebTorrent } = await import('webtorrent');
  const client = new WebTorrent({ dht: true });
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.destroy(); reject(new Error('fetch timed out')); }, timeoutMs);
    client.on('error', (e) => log('client error', e.message));
    client.add(SNAPSHOT.magnet, { path: dir }, (t) => {
      log(`metadata: ${t.name} ${t.length} bytes, ${t.pieces.length} pieces`);
      const tick = setInterval(() => log(`  ${(t.progress * 100).toFixed(1)}% ${(t.downloadSpeed / 1048576).toFixed(1)} MiB/s peers ${t.numPeers} (${t.wires.filter((w) => w.type === 'webSeed').length} webseed)`), 5000);
      t.on('done', () => { clearInterval(tick); clearTimeout(timer); const ms = performance.now() - t0; client.destroy(); resolve({ path, ms, bytes: t.length, peers: t.numPeers }); });
    });
  });
}
