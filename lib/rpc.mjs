// JSON-RPC to a local node, configured from its bitcoin.conf (cookie or rpcuser/rpcpassword).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const SUBDIR = { 'btc:mainnet': '', 'btc:mainnet-blake2b': '', 'btc:testnet4': 'testnet4', 'btc:testnet4-blake2b': 'testnet4', 'btc:regtest': 'regtest', 'btc:regtest-blake2b': 'regtest' };
const PORT = { '': 8332, testnet4: 48332, regtest: 18443 };

export async function makeRpc(confPath, network) {
  const HOME = homedir();
  const conf = Object.fromEntries((await readFile(resolve(confPath.replace(/^~/, HOME)), 'utf8')).split('\n')
    .map((l) => l.replace(/#.*/, '').trim()).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const subdir = SUBDIR[network] ?? '';
  const datadir = resolve((conf.datadir ?? '~/.bitcoin').replace(/^~/, HOME));
  const auth = conf.rpcuser ? `${conf.rpcuser}:${conf.rpcpassword}` : (await readFile(`${datadir}/${subdir ? subdir + '/' : ''}.cookie`, 'utf8')).trim();
  const url = `http://${conf.rpcbind ?? '127.0.0.1'}:${conf.rpcport ?? PORT[subdir]}/`;
  const headers = { authorization: 'Basic ' + Buffer.from(auth).toString('base64'), 'content-type': 'application/json' };
  let id = 0;
  const rpc = async (method, ...params) => {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(`${method}: ${j.error.message}`); e.code = j.error.code; throw e; }
    return j.result;
  };
  rpc.url = url;
  return rpc;
}
