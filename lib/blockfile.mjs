// The block file: post-fork blocks appended as [u32le height][u32le size][block bytes],
// with a JSON index {network, from, to, blocks:[{height, hash, offset, size}]} beside it,
// so a client can Range-fetch exactly the tail it lacks and verify every block's hash.
import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, statSync, truncateSync, appendFileSync } from 'node:fs';

export const HEADER = 8;
export function readIndex(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
export function writeIndex(path, index) { writeFileSync(path, JSON.stringify(index)); }

export function appendBlock(datPath, index, height, hash, bytes) {
  const offset = existsSync(datPath) ? statSync(datPath).size : 0;
  const head = Buffer.alloc(HEADER); head.writeUInt32LE(height, 0); head.writeUInt32LE(bytes.length, 4);
  appendFileSync(datPath, Buffer.concat([head, bytes]));
  index.blocks.push({ height, hash, offset, size: bytes.length });
  index.to = height;
}
// drop every block from `height` on (a reorg): truncate the file and the index
export function truncateFrom(datPath, index, height) {
  const i = index.blocks.findIndex((b) => b.height === height);
  if (i < 0) return;
  truncateSync(datPath, index.blocks[i].offset);
  index.blocks.length = i;
  index.to = i ? index.blocks[i - 1].height : index.from - 1;
}
export function readBlock(datPath, entry) {
  const fd = openSync(datPath, 'r');
  try { const buf = Buffer.alloc(entry.size); readSync(fd, buf, 0, entry.size, entry.offset + HEADER); return buf; } finally { closeSync(fd); }
}
