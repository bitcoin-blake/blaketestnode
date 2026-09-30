// The other branch of the fork. The BLAKE2b chain and the chain it forked from share every block up
// to the snapshot base, and an address is the same string on both (one bech32 prefix), so a coin
// made at or below the base belongs to the same key on both chains until it is spent on one of them.
// The pair is any Esplora-shaped API following the other branch (`--pair-api`); it is not validated
// here, only checked once to be on the other side of this fork: its block at the base height must be
// the snapshot base, and its block at the fork height must not be ours.
import { SNAPSHOT } from './params.mjs';

export function makePair({ api, alias, forkHeight, fetchFn = globalThis.fetch, timeoutMs = 10000 }) {
  api = api.replace(/\/+$/, '');
  const get = async (path, as = 'json') => {
    const r = await fetchFn(`${api}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${alias} ${path}: HTTP ${r.status}`);
    return as === 'json' ? r.json() : (await r.text()).trim();
  };
  let checked = null;
  return {
    api, alias,
    // resolves to { ok, error? }; cached once it succeeds, retried after a failure
    async check(node) {
      if (checked?.ok) return checked;
      const ours = node?.chain[forkHeight];
      if (!ours) return (checked = { ok: false, error: `this node has no block at the fork height ${forkHeight} yet` });
      try {
        const base = await get(`/block-height/${SNAPSHOT.baseHeight}`, 'text'), fork = await get(`/block-height/${forkHeight}`, 'text');
        if (base !== SNAPSHOT.baseHash) return (checked = { ok: false, error: `${alias} block ${SNAPSHOT.baseHeight} is ${base.slice(0, 16)}…, not the snapshot base: another chain` });
        if (fork === ours) return (checked = { ok: false, error: `${alias} block ${forkHeight} is ours: it follows this branch, not the other` });
        return (checked = { ok: true, base, fork });
      } catch (e) { return (checked = { ok: false, error: e.message }); }
    },
    utxo: (address) => get(`/address/${address}/utxo`),
  };
}

// Both sides of one address: what is only here, only there, and on both (unspent on each branch).
export function comparePair(address, here, there, { alias, pairAlias, forkHeight }) {
  const key = (u) => `${u.txid}:${u.vout}`, sum = (a) => a.reduce((s, u) => s + u.value, 0);
  const thereKeys = new Set(there.map(key)), hereKeys = new Set(here.map(key));
  const both = here.filter((u) => thereKeys.has(key(u)));
  const onlyHere = here.filter((u) => !thereKeys.has(key(u))), onlyThere = there.filter((u) => !hereKeys.has(key(u)));
  return {
    address, fork: { height: forkHeight, base: { height: SNAPSHOT.baseHeight, hash: SNAPSHOT.baseHash } },
    [alias]: { coins: here.length, value: sum(here), only: { coins: onlyHere.length, value: sum(onlyHere) } },
    [pairAlias]: { coins: there.length, value: sum(there), only: { coins: onlyThere.length, value: sum(onlyThere) } },
    // spendable on either chain: a spend signed without SIGHASH_UNIFIED is valid on both, one signed with it only here
    both: both.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.status?.block_height ?? null })),
    utxo: { [alias]: onlyHere, [pairAlias]: onlyThere },
  };
}
