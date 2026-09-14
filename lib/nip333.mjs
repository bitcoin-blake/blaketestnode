// The chain tip as the NIP-333 header events say it is: the newest kind 33333 event with
// the chain's `d` tag from the pinned publisher, signature verified, headers decoded.

// `nostr` is the engine's nostr module (verifyNostrEvent); Node callers may omit it.
const nostrModule = async (nostr) => nostr ?? await import(`${(await import('./engine.mjs')).SCHEMA}/codec/nostr.js`); // Node only, lazily: the worker passes its own
export async function fetchTip(k, { d, pubkey, relays }, { timeoutMs = 5_000, graceMs = 400, nostr = null } = {}) {
  const { verifyNostrEvent } = await nostrModule(nostr);
  const best = { height: -1 };
  // resolve soon after the first verified event: a slow relay should not hold the answer
  let settle = null; const settled = new Promise((r) => { settle = r; });
  const race = Promise.all(relays.map((url) => new Promise((resolve) => {
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
        setTimeout(settle, graceMs);
      } catch {}
    };
  })));
  await Promise.race([race, settled]);
  return best.height >= 0 ? best : null;
}

// Live subscription: onTip({height, hash}) for every verified new event, with reconnects.
export async function subscribeTip(k, { d, pubkey, relays }, onTip, { log = () => {}, nostr = null } = {}) {
  const { verifyNostrEvent } = await nostrModule(nostr);
  const open = (url) => {
    let ws;
    try { ws = new WebSocket(url); } catch { return setTimeout(() => open(url), 30_000); }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'live', { kinds: [33333], authors: [pubkey], '#d': [d], since: Math.floor(Date.now() / 1000) - 60 }]));
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data); if (msg[0] !== 'EVENT') return;
        const ev = msg[2]; if (ev.pubkey !== pubkey || !verifyNostrEvent(ev)) return;
        const tip = Number(ev.tags.find((t) => t[0] === 'tip')?.[1]);
        const last = ev.content.slice(-((parseInt(ev.content.slice(-328 + 6, -328 + 8), 16) & 0x80) ? 328 : 160));
        onTip({ height: tip, hash: k.codec.blockHash(k.codec.decode('BlockHeader', last)), relay: url, created_at: ev.created_at });
      } catch (e) { log('nip333 event ignored:', e.message); }
    };
    ws.onclose = () => setTimeout(() => open(url), 30_000);
    ws.onerror = () => {};
  };
  relays.forEach(open);
}
