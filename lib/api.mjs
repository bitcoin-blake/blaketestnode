// The node's face: a status page, JSON routes, and a WebSocket tip stream.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { SCHEMA } from './engine.mjs';

export async function startApi({ port, host = '127.0.0.1', status, node: nodeRef, source, k, log = () => {} }) {
  const N = () => (typeof nodeRef === 'function' ? nodeRef() : nodeRef); // the node may not exist yet while the snapshot loads
  const { attachWsServer } = await import(`${SCHEMA}/codec/ws.js`);
  const page = readFileSync(new URL('./status.html', import.meta.url), 'utf8');
  const cors = { 'access-control-allow-origin': '*' };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body, null, 1)); };
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
  return { server, broadcast(msg) { const b = new TextEncoder().encode(JSON.stringify(msg)); for (const c of clients) { try { c.send(b); } catch {} } }, clients };
}
