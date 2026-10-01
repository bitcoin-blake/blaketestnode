// The chain tip as the NIP-333 header events say it is: the newest kind 33333 event with
// the chain's `d` tag from the pinned publisher, signature verified, headers decoded.

// `nostr` is the engine's nostr module (verifyNostrEvent); Node callers may omit it.
export const nostrModule = async (nostr) => nostr ?? await import(`${(await import('./engine.mjs')).SCHEMA}/codec/nostr.js`); // Node only, lazily: the worker passes its own
// the headers an event carries, oldest first (v2 headers, version bit 31, are 164 bytes, v1 80)
export function decodeHeaders(k, content) {
  const headers = [];
  for (let pos = 0; pos < content.length;) { const size = (parseInt(content.slice(pos + 6, pos + 8), 16) & 0x80) ? 328 : 160; headers.push(k.codec.decode('BlockHeader', content.slice(pos, pos + size))); pos += size; }
  return headers;
}
// a signed tip dated more than ten minutes past this tab's clock is refused: the newest word stands, so one event from a
// publisher whose clock jumped ahead would otherwise outrank every honest tip after it until real time caught up
export const MAX_AHEAD_S = 600;
export const tooNew = (created_at, nowMs = Date.now()) => !(Number(created_at) <= Math.floor(nowMs / 1000) + MAX_AHEAD_S);
// every relay is heard (up to `timeoutMs`), not the first that answers: one fast relay holding an older genuine event must
// not become the tip. Settles early only when `agreeing` relays hand the same highest tip (height and hash). The highest
// verified tip wins; `relays` on the answer counts how many handed it. `held`: the tip this node already holds; relays that
// agree on an event older than it do not settle the fetch early (two stale relays must not cut off the one holding the newer
// word). `nowMs()`: the real time as this tab best knows it (its clock less the measured skew), for the too-new bound.
export async function fetchTip(k, { d, pubkey, relays }, { timeoutMs = 5_000, agreeing = 2, nostr = null, held = null, nowMs = () => Date.now() } = {}) {
  const { verifyNostrEvent } = await nostrModule(nostr);
  const best = { height: -1 }; const votes = new Map(); // `${height}:${hash}` → relays that handed it
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
        if (ev.pubkey !== pubkey || tooNew(ev.created_at, nowMs()) || !verifyNostrEvent(ev)) return;
        const tip = Number(ev.tags.find((t) => t[0] === 'tip')?.[1]); if (!(tip >= 0)) return;
        const headers = decodeHeaders(k, ev.content); if (!headers.length) return;
        const hash = k.codec.blockHash(headers.at(-1)); const key = `${tip}:${hash}`;
        const v = votes.get(key) ?? new Set(); v.add(url); votes.set(key, v);
        if (newer({ height: tip, created_at: ev.created_at }, best)) Object.assign(best, { height: tip, hash, headers, first: tip - headers.length + 1, relay: url, created_at: ev.created_at });
        if (best.height === tip && best.hash === hash && v.size >= agreeing && !(held && newer(held, best))) settle();
      } catch {}
    };
  })));
  await Promise.race([race, settled]);
  if (best.height < 0) return null;
  return { ...best, relays: votes.get(`${best.height}:${best.hash}`)?.size ?? 1 };
}
// which of two signed tips is the publisher's later word: the newer event (created_at), then the higher one. Only the pinned
// publisher's events get this far, so its newest statement stands, even at a lower height (a reorg to a shorter, heavier
// branch is signed later and lower); an older event a relay replays is older, whatever its height.
export const newer = (a, b) => (a.created_at ?? 0) > (b.created_at ?? 0) || ((a.created_at ?? 0) === (b.created_at ?? 0) && a.height > (b.height ?? -1));
// the floor a node keeps between sessions: the publisher's latest signed tip it has seen. An older event (a relay replaying
// one), or none at all, does not move it; a newer one does, up or down. tip: { height, hash, first, hashes, created_at }
export function higherTip(persisted, fresh, nowMs = Date.now()) {
  if (fresh && tooNew(fresh.created_at, nowMs)) fresh = null;
  if (!persisted?.hashes?.length) return fresh ?? null;
  if (!fresh?.hashes?.length) return persisted;
  return newer(fresh, persisted) || (fresh.height === persisted.height && fresh.hash === persisted.hash) ? fresh : persisted;
}

// Live subscription: onTip({height, hash, headers, first}) for every verified new event, with reconnects; every header the
// event carries is passed on, so the caller can hold the whole run against its chain (not the tip alone). → { close(), reopen() }.
// A socket that has said nothing for `quietMs` is opened again (after a sleep a socket can stay "open" but dead), and
// reopen() does it at once, for a page that wakes or comes back online.
// `since` looks back ten minutes, or more for a tab whose clock is off (skewS(): this clock minus the real one, in seconds), so
// a clock a minute or two fast does not drop every live event without a word
export const sinceFor = (nowMs = Date.now(), skewS = 0) => Math.floor(nowMs / 1000) - Math.max(MAX_AHEAD_S, Math.abs(Number(skewS) || 0) + MAX_AHEAD_S);
export async function subscribeTip(k, { d, pubkey, relays }, onTip, { log = () => {}, nostr = null, quietMs = 600_000, skewS = () => 0 } = {}) {
  const { verifyNostrEvent } = await nostrModule(nostr);
  const sockets = new Map(); let closed = false;
  const open = (url) => {
    if (closed) return; let ws;
    try { ws = new WebSocket(url); } catch { return setTimeout(() => open(url), 30_000); }
    ws.at = Date.now(); sockets.set(url, ws);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'live', { kinds: [33333], authors: [pubkey], '#d': [d], since: sinceFor(Date.now(), skewS()) }]));
    ws.onmessage = (m) => {
      ws.at = Date.now();
      try {
        const msg = JSON.parse(m.data); if (msg[0] !== 'EVENT') return;
        const ev = msg[2]; if (ev.pubkey !== pubkey || tooNew(ev.created_at, Date.now() - (Number(skewS()) || 0) * 1000) || !verifyNostrEvent(ev)) return;
        const tip = Number(ev.tags.find((t) => t[0] === 'tip')?.[1]);
        const headers = decodeHeaders(k, ev.content); if (!headers.length || !(tip >= 0)) return;
        onTip({ height: tip, hash: k.codec.blockHash(headers.at(-1)), headers, first: tip - headers.length + 1, relay: url, created_at: ev.created_at });
      } catch (e) { log('nip333 event ignored:', e.message); }
    };
    ws.onclose = () => { if (sockets.get(url) === ws) sockets.delete(url); if (!closed) setTimeout(() => open(url), 30_000); };
    ws.onerror = () => {};
  };
  const reopen = (only = null) => { for (const [url, ws] of [...sockets]) if (!only || only(ws)) { ws.onclose = null; sockets.delete(url); try { ws.close(); } catch {} open(url); } };
  const watchdog = setInterval(() => reopen((ws) => Date.now() - ws.at > quietMs), 60_000); watchdog.unref?.(); /* never keeps a Node process alive */
  relays.forEach(open);
  return { close() { closed = true; clearInterval(watchdog); for (const ws of sockets.values()) { try { ws.close(); } catch {} } }, reopen: () => reopen() };
}

// the signed tip's headers held against the chain a node applied and the block file it is served: agree counts the heights
// both have and that match; diverged when either has another hash at a height the tip covers (a mirror serving a fork is
// caught as soon as it serves or the node applies its block, not only when the tip arrives). tip: { first, hashes }.
// applied(h), served(h) → a hash or undefined
export function judgeTip(tip, { applied, served = () => undefined }) {
  let agree = 0, diverged = false, highest = null, firstDiverged = null;
  for (let i = 0; i < (tip?.hashes?.length ?? 0); i++) {
    const h = tip.first + i, a = applied(h), s = served(h);
    if ((a && a !== tip.hashes[i]) || (s && s !== tip.hashes[i])) { diverged = true; firstDiverged ??= h; }
    else if (a) { agree++; highest = h; }
  }
  return { agree, diverged, highest, firstDiverged };
}
// the height up to which this node's applied chain has been vouched for by a signed tip: the highest applied height ever
// matched to a signed header, never lowered by a tip that merely does not cover the blocks, and capped below the first
// height where the applied or served chain differs from what is signed. prev: the last value (kept in tip.json)
export function nextVouched(prev, { highest = null, firstDiverged = null } = {}) {
  let v = prev ?? null;
  if (highest != null) v = v == null ? highest : Math.max(v, highest);
  if (firstDiverged != null && v != null) v = Math.min(v, firstDiverged - 1);
  return v;
}
// the vouched height once a signed tip is accepted as the publisher's word: never above that tip (a newer, lower tip, say the
// publisher invalidated a block, takes back what it no longer signs); null stays null
export const vouchedUnder = (v, tip) => (v != null && tip?.height != null && v > tip.height ? tip.height : v ?? null);
// the first height at which the served chain differs from the signed headers (null when it does not): checked before any
// rollback or apply, so a block file on another branch is refused rather than followed. served(h) may be async.
export async function servedDisagreement(tip, served) {
  for (let i = 0; i < (tip?.hashes?.length ?? 0); i++) { const h = tip.first + i; const s = await served(h); if (s && s !== tip.hashes[i]) return h; }
  return null;
}
// may the node roll back to `common`? not when that would replace blocks below the first height the signed headers cover
export const rollbackAllowed = (common, tip) => !(tip?.hashes?.length && common + 1 < tip.first);

// The tip the served chain is held to before anything is rolled back or applied: the publisher's later word of the one this
// node holds and the one the relays hand now (fetched when `due`), and only that winner is held against the served chain, so
// two stale relays cannot raise a disagreement the held newer tip does not have. A held tip the chain has moved past (a reorg
// while the tab was closed) is not final: the relays are asked (when `mayForce`) before a disagreement stands, so a kept
// tip.json alone cannot wedge a node for good. fetch() → a tip or null; served(h) → a hash (may be async).
// → { tip, at: the first height that disagrees or null, fetched }
export async function settleTip({ held = null, due = false, mayForce = true, fetch, served, nowMs = Date.now() }) {
  let fetched = false, fresh = null;
  if (due) { fresh = await fetch(); fetched = true; }
  let tip = higherTip(held, fresh, nowMs), at = await servedDisagreement(tip, served);
  if (at != null && !fetched && mayForce) { fresh = await fetch(); fetched = true; tip = higherTip(held, fresh, nowMs); at = await servedDisagreement(tip, served); }
  return { tip, at, fetched };
}
// the real time as a tab best knows it: its clock less the skew its page measured (seconds, + when this clock is fast)
export const realNowOf = (clockMs, skewS = 0) => clockMs - (Number(skewS) || 0) * 1000;
// does a signed tip replace the one held? The publisher's later word, or the same word heard again (its live copy replaces a
// kept one), never an older one or one dated past the real time
export const takesTip = (held, t, nowMs = Date.now()) => !!t && higherTip(held, t, nowMs) === t;
// the same signed word (a relay saying the held tip again): taken, but it is not news, so it does not count as the last word
export const sameWord = (a, b) => !!a && !!b && a.height === b.height && a.hash === b.hash && (a.created_at ?? 0) === (b.created_at ?? 0);
// a live tip heard: the time of the last word is moved only by a tip taken (a relay replaying an old event does not keep the
// ten-minute fetch from coming due), and a sync follows only a taken tip above what is applied (or before anything is)
export const liveTipStep = ({ taken, nodeHeight = null, height, now = Date.now() }) => ({ tipAt: taken ? now : null, sync: !!taken && (nodeHeight == null || height > nodeHeight) });
export const TIP_FETCH_MS = 600_000, FORCE_MS = 60_000;
// one sync's word on the tip, before any rollback or apply: a fetch when ten minutes have passed without one (or none yet),
// a forced one at most once a minute when the tip held disagrees with the served chain; the later word is held against it.
// → { due, setTip (a tip to take, or null), tipAt, forcedAt, refuseAt (the first differing height, or null), refuseTip, retryMs }
// A refusal comes with a retry (a minute, doubling to ten): with the relays silent on a cold link the node asks again on its
// own rather than waiting for a new publish, a wake or a reload
export async function settleOrRefuse({ held = null, tipAt = null, forcedAt = null, now = Date.now(), nowMs = now, refusedN = 0, fetch, served }) {
  const due = !tipAt || now - tipAt > TIP_FETCH_MS, mayForce = !forcedAt || now - forcedAt > FORCE_MS;
  const st = await settleTip({ held, due, mayForce, fetch, served, nowMs });
  const out = { due, setTip: st.tip && st.tip !== held ? st.tip : null, tipAt: tipAt ?? null, forcedAt: forcedAt ?? null, refuseAt: st.at ?? null, refuseTip: st.at != null ? st.tip : null, retryMs: null };
  if (st.fetched) { out.tipAt = now; if (!due) out.forcedAt = now; }
  if (st.at != null) out.retryMs = Math.min(TIP_FETCH_MS, FORCE_MS * 2 ** Math.min(Math.max(0, refusedN), 4));
  return out;
}
// tip.json as kept from an earlier session → { tip, vouchedTo } or null: a well-formed run of headers not dated past the clock;
// its vouched height only when counted against this block source (or a file from before sources were noted), and never above
// the tip it was counted under
export function keptTip(j, blocksUrl, nowMs = Date.now()) {
  if (!j?.hashes?.length || j.first + j.hashes.length - 1 !== j.height || tooNew(j.created_at, nowMs)) return null;
  const tip = { ...j, live: false, relay: 'this tab (kept)' };
  return { tip, vouchedTo: Number.isInteger(j.vouchedTo) && (j.source == null || j.source === blocksUrl) ? vouchedUnder(j.vouchedTo, j) : null };
}
// the vouched height when a sync is asked of a block source: another source than the last one starts from nothing vouched
export const sourceVouched = (prevUrl, url, vouchedTo) => (prevUrl && prevUrl !== url ? null : vouchedTo ?? null);
