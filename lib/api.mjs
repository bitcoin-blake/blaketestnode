// The node's face: a status page, JSON routes, and a WebSocket tip stream.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { SCHEMA } from './engine.mjs';
import { CHAIN } from './params.mjs';
import { comparePair } from './pair.mjs';

export async function startApi({ port, host = '127.0.0.1', status, node: nodeRef, source, k, mempool = null, log = () => {} }) {
  const N = () => (typeof nodeRef === 'function' ? nodeRef() : nodeRef); // the node may not exist yet while the snapshot loads
  const { attachWsServer } = await import(`${SCHEMA}/codec/ws.js`);
  const { addressToScript } = await import(`${SCHEMA}/codec/script.js`);
  const page = readFileSync(new URL('./status.html', import.meta.url), 'utf8');
  const cors = { 'access-control-allow-origin': '*' };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body, null, 1)); };
  // the coins paying `script`: confirmed ones from the set, unconfirmed ones from the mempool's outputs, and the confirmed ones a mempool transaction spends
  const addressCoins = (node, script) => {
    const mp = api.mempool, spent = mp?.spent ?? new Set(), confirmed = [], spentByMempool = [], unconfirmed = [];
    for (const { key, coin } of api.scripts.coins(script)) {
      const [txid, vout] = key.split(':'), h = coin.height;
      const u = { txid, vout: Number(vout), value: coin.output.value, status: { confirmed: true, block_height: h, block_hash: node.chain[h] ?? null, block_time: node.headers[h]?.time ?? null } };
      (spent.has(key) ? spentByMempool : confirmed).push(u);
    }
    if (mp) for (const [txid, e] of mp.txs) e.tx.outputs.forEach((o, vout) => { if (o.scriptPubKey === script && !spent.has(`${txid}:${vout}`)) unconfirmed.push({ txid, vout, value: o.value, status: { confirmed: false } }); });
    return { confirmed, unconfirmed, spentByMempool };
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path === '/' || path === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page); }
      if (path === '/status.json') return json(res, 200, status());
      let m;
      if ((m = /^\/coin\/([0-9a-f]{64}):(\d+)$/.exec(path))) {
        const node = N(); if (!node) return json(res, 503, { error: 'loading' });
        const coin = node.utxo.get(`${m[1]}:${m[2]}`);
        if (!coin) return json(res, 404, { error: 'not in the utxo set' });
        return json(res, 200, { ...coin, type: k.script.classify(coin.output.scriptPubKey).type, address: k.script.classify(coin.output.scriptPubKey).address });
      }
      if ((m = /^\/address\/([A-Za-z0-9]{14,90})(\/utxo|\/pair)?$/.exec(path))) { // Esplora's address routes, from the UTXO set (--address-index)
        const node = N(); if (!node || !api.scripts) return json(res, api.scripts === null ? 404 : 503, { error: api.scripts === null ? 'no address index: run with --address-index' : 'loading' });
        const script = addressToScript(m[1], k.params); if (!script) return json(res, 400, { error: `not an address on ${CHAIN.network}` });
        const { confirmed, unconfirmed, spentByMempool } = addressCoins(node, script);
        if (m[2] === '/utxo') return json(res, 200, [...confirmed, ...unconfirmed]);
        if (m[2] === '/pair') {
          if (!api.pair) return json(res, 404, { error: 'no pair chain: run with --pair-api <Esplora URL on the other branch>' });
          const c = await api.pair.check(node); if (!c.ok) return json(res, 502, { error: c.error });
          const there = (await api.pair.utxo(m[1])).filter((u) => u.status?.confirmed);
          return json(res, 200, comparePair(m[1], confirmed, there, { alias: CHAIN.alias, pairAlias: api.pair.alias, forkHeight: CHAIN.forkHeight }));
        }
        // a UTXO node keeps no history: the stats count what is unspent now, so funded - spent is the balance
        const stats = (f, s) => ({ funded_txo_count: f.length, funded_txo_sum: f.reduce((a, u) => a + u.value, 0), spent_txo_count: s.length, spent_txo_sum: s.reduce((a, u) => a + u.value, 0), tx_count: null });
        return json(res, 200, { address: m[1], scriptPubKey: script, chain_stats: stats([...confirmed, ...spentByMempool], []), mempool_stats: stats(unconfirmed, spentByMempool) });
      }
      if (path === '/template') { // datstr SPEC 6.3: the block this node would build, for a pay script (or several, comma separated)
        if (!api.template) return json(res, 503, { error: 'loading' }); const q = new URL(req.url, 'http://x').searchParams; const pay = String(q.get('pay') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (!pay.length || pay.some((x) => !/^[0-9a-f]{4,80}$/.test(x))) return json(res, 400, { error: 'pay=<script hex>[,<script hex>] is needed' });
        try { return json(res, 200, api.template(pay, q.get('worker') ?? undefined)); } catch (e) { return json(res, 500, { error: e.message }); } }
      if (path === '/mempool') { const mp = api.mempool; if (!mp) return json(res, 404, { error: 'no mempool' }); return json(res, 200, { count: mp.size, stats: mp.stats, txs: mp.list().map((e) => ({ txid: e.txid, fee: e.fee, vsize: e.vsize, feeRate: +e.feeRate.toFixed(2), at: e.at })) }); }
      if ((m = /^\/mempool\/([0-9a-f]{64})$/.exec(path))) { const e = api.mempool?.txs.get(m[1]); return e ? json(res, 200, { txid: m[1], hex: e.hex, fee: e.fee, vsize: e.vsize }) : json(res, 404, { error: 'not in the mempool' }); }
      if ((m = /^\/block\/(\d+)$/.exec(path))) {
        const h = Number(m[1]); const node = N(); if (!node) return json(res, 503, { error: 'loading' });
        if (h > node.height || !node.chain[h]) return json(res, 404, { error: 'not in the chain' });
        const hex = await source.blockHex(h).catch(() => null);
        return json(res, 200, { height: h, hash: node.chain[h], header: node.headers[h] ?? null, hex });
      }
      if ((m = /^\/header\/(\d+)$/.exec(path))) { const h = Number(m[1]); const node = N(); if (!node) return json(res, 503, { error: 'loading' }); return node.headers[h] ? json(res, 200, { height: h, hash: node.chain[h], header: node.headers[h] }) : json(res, 404, { error: 'unknown height' }); }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: e.message }); }
  });
  const clients = new Set();
  attachWsServer(server, (client, req) => {
    if (new URL(req.url, 'http://x').pathname !== '/tip') return client.close();
    clients.add(client); client.onClose(() => clients.delete(client));
    const node = N(); client.send(new TextEncoder().encode(JSON.stringify({ type: 'tip', height: node?.height ?? -1, hash: node?.tipHash() ?? null })));
  });
  await new Promise((r) => server.listen(port, host, r));
  log(`api on http://${host}:${port}/`);
  const api = { mempool, template: null, scripts: undefined, pair: null, server, broadcast(msg) { const b = new TextEncoder().encode(JSON.stringify(msg)); for (const c of clients) { try { c.send(b); } catch {} } }, clients };
  return api;
}
