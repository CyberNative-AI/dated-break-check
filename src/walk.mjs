// Read the chosen folder's text files and run the calendar's searches over them, in bounded batches.
// Runs inside the scan worker (src/worker.mjs), so the main thread can stop it at the deadline.
import { openSync, readSync, fstatSync, closeSync, readdirSync, realpathSync, statSync, constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { scan, skipPath, looksBinary, isProse, MAX_BYTES, MAX_FILES, SKIP_DIRS } from './match.js';

export const LIMITS = {
  files: MAX_FILES, // text files read
  fileBytes: MAX_BYTES, // larger files are counted and left out
  totalBytes: 512 * 1024 * 1024, // bytes read in all
  entries: 200000, // directory entries looked at
  batchBytes: 8 * 1024 * 1024, // text handed to the matcher at once; the only file text held in memory
};
const MAX_HITS = 25; // as in match.js

const inside = (outer, p) => {
  const r = relative(outer, p);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
};

// The folder to read, as a real path inside the real workspace. Refuses a parent escape and a folder that is,
// or sits under, a symlink pointing out of the workspace. rel is the folder relative to the workspace, '/'-separated.
export function resolveRoot(workspace, path) {
  const ws = realpathSync(workspace);
  const lexical = resolve(ws, path);
  if (!inside(ws, lexical)) throw new RangeError(`path must be a folder inside the workspace; "${path}" is outside it`);
  let real;
  try { real = realpathSync(lexical); } catch { throw new RangeError(`path "${path}" does not exist in the workspace`); }
  if (!inside(ws, real)) throw new RangeError(`path "${path}" leads outside the workspace through a symlink`);
  if (!statSync(real).isDirectory()) throw new RangeError(`path "${path}" is not a folder`);
  return { base: real, rel: relative(ws, real).split(sep).join('/') || '.' };
}

const NOFOLLOW = constants.O_NOFOLLOW || 0; // not defined on Windows, where the Dirent check below still applies

// Reads one regular file without following a symlink, at most fileBytes. Returns null when it is not read.
function readText(path, limits, stats) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > limits.fileBytes) { stats.skippedLarge++; return null; }
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) { const k = readSync(fd, buf, n, st.size - n, n); if (k === 0) break; n += k; }
    stats.bytes += n;
    const bytes = buf.subarray(0, n);
    return looksBinary(bytes) ? null : bytes.toString('utf8');
  } catch { return null; } finally { closeSync(fd); }
}

// Yields { path, text } with path relative to base. Directory and file symlinks are not followed. Sets
// stats.stopped to 'files', 'bytes' or 'entries' when a limit ends the walk before every file was read.
export function* walkFiles(base, limits = LIMITS, stats = newStats()) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let names;
    try { names = readdirSync(rel ? join(base, rel) : base, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      if (++stats.entries > limits.entries) { stats.stopped = 'entries'; return; }
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(p); continue; }
      if (!d.isFile() || skipPath(p)) continue;
      if (stats.files >= limits.files) { stats.stopped = 'files'; return; }
      if (stats.bytes >= limits.totalBytes) { stats.stopped = 'bytes'; return; }
      const text = readText(join(base, p), limits, stats);
      if (text === null) continue;
      stats.files++;
      yield { path: p, text };
    }
  }
}

export const newStats = () => ({ files: 0, bytes: 0, entries: 0, skippedLarge: 0, stopped: null });

// Same result as match.js scan(allFiles, sigs), without holding every file: the matcher runs on batches and the
// results are merged in walk order. Per row: code hits first, then document hits, each capped at 25, the rest counted.
export function scanTree(base, sigs, limits = LIMITS) {
  const stats = newStats();
  const acc = new Map(sigs.signatures.map((s) => [s.row, { code: [], prose: [], more: 0, pgMatch: false, seen: false }]));
  const add = (bucket, h, a) => { if (bucket.length < MAX_HITS) bucket.push(h); else a.more++; };
  const run = (batch) => {
    for (const r of scan(batch, sigs)) {
      const a = acc.get(r.row);
      a.seen = true;
      a.more += r.more;
      if (r.kind === 'match' || r.kind === 'mention') a.pgMatch = true;
      for (const h of r.hits) add(isProse(h.path) ? a.prose : a.code, h, a);
    }
  };
  let batch = [], size = 0;
  for (const f of walkFiles(base, limits, stats)) {
    batch.push(f); size += f.text.length;
    if (size >= limits.batchBytes) { run(batch); batch = []; size = 0; }
  }
  if (batch.length) run(batch);
  const rows = [];
  for (const s of sigs.signatures) {
    const a = acc.get(s.row);
    if (!a.seen) continue;
    let kind = s.kind === 'postgres' ? (a.pgMatch ? 'match' : 'possible') : s.kind;
    if (kind === 'match' && !a.code.length) kind = 'mention';
    rows.push({ row: s.row, kind, hits: [...a.code, ...a.prose], more: a.more });
  }
  return { rows, stats };
}
