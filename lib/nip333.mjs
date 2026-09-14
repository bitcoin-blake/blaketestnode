// The chain tip as the NIP-333 header events say it is: the newest kind 33333 event with
// the chain's `d` tag from the pinned publisher, signature verified, headers decoded.
import { SCHEMA } from './engine.mjs';

export async function fetchTip(k, { d, pubkey, relays }, { timeoutMs = 5_000 } = {}) {
  const { verifyNostrEvent } = await import(`${SCHEMA}/codec/nostr.js`);
  const best = { height: -1 };
  await Promise.all(relays.map((url) => new Promise((resolve) => {
    let ws; const done = () => { try { ws?.close(); } catch {} resolve(); };
    const timer = setTimeout(done, timeoutMs);
    try { ws = new WebSocket(url); } catch { clearTimeout(timer); return resolve(); }
    ws.onerror = () => { clearTimeout(timer); done(); };
    ws.onclose = () => { clearTimeout(timer); resolve(); };
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'tip', { kinds: [33333], authors: [pubkey], '#d': [d], limit: 3 }]));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg[0] === 'EOSE') { clearTimeout(timer); return done(); }
      if (msg[0] !== 'EVENT') return;
      const ev = msg[2];
      try {
        if (ev.pubkey !== pubkey || !verifyNostrEvent(ev)) return;
        const tip = Number(ev.tags.find((t) => t[0] === 'tip')?.[1]);
        if (!(tip > best.height)) return;
        const headers = [];
        for (let pos = 0; pos < ev.content.length;) { // v2 headers (version bit 31) are 164 bytes, v1 80
          const size = (parseInt(ev.content.slice(pos + 6, pos + 8), 16) & 0x80) ? 328 : 160;
          headers.push(k.codec.decode('BlockHeader', ev.content.slice(pos, pos + size))); pos += size;
        }
        const first = tip - headers.length + 1;
        Object.assign(best, { height: tip, hash: k.codec.blockHash(headers.at(-1)), headers, first, relay: url, created_at: ev.created_at });
      } catch {}
    };
  })));
  return best.height >= 0 ? best : null;
}
