// The bitcoin-kernel engine (bitcoin-desktop/schema) with the knots-blake2b overlay.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
export const SCHEMA = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`;
export async function loadEngine(network) {
  const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
  const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
  const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));
  return createKernel({
    core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
    chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'), network,
    overlays: [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))],
  });
}
