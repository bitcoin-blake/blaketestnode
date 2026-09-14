// Random access to a file without holding it in memory (Node). The browser's twin is an OPFS
// sync access handle in a worker, with the same { size, read(off, len) } shape.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
export class FileBytes {
  constructor(path) { this.fd = openSync(path, 'r'); this.size = fstatSync(this.fd).size; }
  read(off, len) { const b = new Uint8Array(Math.min(len, Math.max(0, this.size - off))); const n = readSync(this.fd, b, 0, b.length, off); return n === b.length ? b : b.subarray(0, n); }
  close() { closeSync(this.fd); }
}
