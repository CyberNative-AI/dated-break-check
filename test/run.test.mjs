import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, lit, checkData, UA } from '../src/run.mjs';
import { walkFiles, scanTree, LIMITS } from '../src/walk.mjs';
import { scan } from '../src/match.js';

const fx = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const data = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`../data/${n}`, import.meta.url)), 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'dbc-'));

async function run(dir, extra = {}, fetchImpl, opts) {
  const out = [];
  const summaryFile = join(tmp(), 'summary.md');
  const code = await main({ GITHUB_WORKSPACE: dir, GITHUB_STEP_SUMMARY: summaryFile, INPUT_TODAY: '2026-11-08', INPUT_DATA: 'bundled', ...extra }, (l) => out.push(l), fetchImpl, opts);
  let summary = '';
  try { summary = readFileSync(summaryFile, 'utf8'); } catch {}
  return { code, out, summary };
}

// A fake cybernative.ai that serves the given files as real Responses, and records each request.
function site(sigs, cal, seen = []) {
  return async (url, opts) => {
    seen.push({ url, opts });
    const body = url.endsWith('/signatures.json') ? sigs : cal;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
}

// What the GitHub runner does with the step's output (actions/runner ActionCommandManager.TryProcessCommand):
// each line is tried as a ::cmd:: command at its start, then as a legacy ##[cmd] anywhere in it; while
// ::stop-commands::TOKEN is in force only ::TOKEN:: is processed.
function runnerCommands(out) {
  const done = [];
  let stop = null;
  for (const line of out.join('\n').split(/\r\n|\r|\n/)) {
    let cmd = null;
    const t = line.trimStart();
    if (t.startsWith('::') && t.indexOf('::', 2) > 0) cmd = t.slice(2, t.indexOf('::', 2)).split(' ')[0];
    else { const i = line.indexOf('##['); if (i >= 0 && line.indexOf(']', i) > 0) cmd = line.slice(i + 3, line.indexOf(']', i)).split(' ')[0].split(';')[0]; }
    if (!cmd) continue;
    if (stop) { if (cmd === stop) stop = null; continue; }
    if (cmd === 'stop-commands') { stop = t.slice(t.indexOf('::', 2) + 2); continue; }
    done.push(cmd);
  }
  return done;
}

test('walk skips installed packages', () => {
  const paths = [...walkFiles(fx('stack'))].map((f) => f.path);
  assert.ok(paths.includes('compose.yaml'));
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')));
});

test('stack fixture: postgres and image model warn, macos-14 in effect, README not reported', async () => {
  const { code, out, summary } = await run(fx('stack'));
  assert.equal(code, 0);
  const warn = out.filter((l) => l.startsWith('::warning '));
  assert.ok(warn.some((l) => l.includes('file=compose.yaml,line=3') && l.includes('2026-11-19') && l.includes('/guides/postgres-latest-19-docker-error-in-18-upgrade/')), warn.join('\n'));
  assert.ok(warn.some((l) => l.includes('file=app/images.py,line=4') && l.includes('2026-12-01')), warn.join('\n'));
  assert.ok(warn.some((l) => l.includes('file=.github/workflows/ci.yml') && l.includes('in effect since')), warn.join('\n'));
  assert.ok(!out.some((l) => l.startsWith('::') && l.includes('README.md')));
  // The model rows read code only, so a README that names gpt-4o is not reported at all.
  assert.ok(!summary.includes('README'));
});

test('fail-within fails only for matches inside the window', async () => {
  assert.equal((await run(fx('stack'), { 'INPUT_FAIL-WITHIN': '14' })).code, 1);
  assert.equal((await run(fx('clean'), { 'INPUT_FAIL-WITHIN': '14' })).code, 0);
});

test('days window excludes far dates', async () => {
  const { out } = await run(fx('stack'), { INPUT_DAYS: '15' });
  assert.ok(out.some((l) => l.includes('2026-11-19')));
  assert.ok(!out.some((l) => l.includes('2026-12-01')));
});

test('clean pinned stack reports nothing', async () => {
  const { code, out, summary } = await run(fx('clean'));
  assert.equal(code, 0);
  assert.ok(!out.some((l) => l.startsWith('::warning')));
  assert.match(summary, /No date between/);
});

test('bad input is a usage error', async () => {
  assert.equal((await run(fx('clean'), { INPUT_DAYS: 'soon' })).code, 2);
  assert.equal((await run(fx('clean'), { INPUT_TODAY: '2026-02-30' })).code, 2);
});

test('bundled data passes the same admission check as live data', () => {
  assert.equal(checkData(data('signatures.json'), data('entries.json')), null);
});

// ---- Network contract (C3147)
test('live mode: two GETs, no body, our user agent, redirects refused', async () => {
  const seen = [];
  const { code, summary } = await run(fx('stack'), { INPUT_DATA: 'live' }, site(data('signatures.json'), data('entries.json'), seen));
  assert.equal(code, 0);
  assert.deepEqual(seen.map((s) => s.url).sort(), ['https://cybernative.ai/breakage-calendar/check/signatures.json', 'https://cybernative.ai/breakage-calendar/entries.json']);
  for (const { opts } of seen) {
    assert.ok(!opts.body && !opts.method);
    assert.equal(opts.redirect, 'error');
    assert.deepEqual(opts.headers, { 'user-agent': UA });
  }
  assert.equal(UA, 'dated-break-check/0.1 (+https://github.com/CyberNative-AI/dated-break-check)');
  assert.match(summary, /current, from cybernative\.ai/);
});

test('live mode falls back to the bundled copy on a bad answer, and says so', async () => {
  const { code, out, summary } = await run(fx('stack'), { INPUT_DATA: 'live' }, site({ nope: 1 }, { nope: 1 }));
  assert.equal(code, 0);
  assert.ok(out.some((l) => l.startsWith('::notice::Could not use the current calendar')));
  assert.match(summary, /copy bundled with this version/);
  assert.ok(out.some((l) => l.includes('file=compose.yaml,line=3')));
});

test('bundled mode makes no request', async () => {
  let n = 0;
  await run(fx('stack'), { INPUT_DATA: 'bundled' }, async () => { n++; throw new Error('no'); });
  assert.equal(n, 0);
});

// ---- Live data admission (C3144)
test('live data with a missing field, bad regex, bad id or oversize answer is not used', async () => {
  const sigs = data('signatures.json'), cal = data('entries.json');
  const bad = [
    ['bad regex', { ...sigs, signatures: [{ ...sigs.signatures[0], patterns: ['(unclosed'] }, ...sigs.signatures.slice(1)] }, cal],
    ['bad needs', { ...sigs, signatures: [{ ...sigs.signatures[0], needs: '[z-a]' }, ...sigs.signatures.slice(1)] }, cal],
    ['no title', sigs, { ...cal, entries: [{ ...cal.entries[0], title: undefined }, ...cal.entries.slice(1)] }],
    ['id with markup', sigs, { ...cal, entries: [{ ...cal.entries[0], id: 'x)](https://evil.example' }, ...cal.entries.slice(1)] }],
    ['huge pattern', { ...sigs, signatures: [{ ...sigs.signatures[0], patterns: ['a'.repeat(5000)] }, ...sigs.signatures.slice(1)] }, cal],
    ['oversize answer', sigs, `{"entries":[${' '.repeat(5 * 1024 * 1024)}]}`],
  ];
  for (const [why, s, c] of bad) {
    const { code, out } = await run(fx('stack'), { INPUT_DATA: 'live' }, site(s, c));
    assert.equal(code, 0, why);
    assert.ok(out.some((l) => l.startsWith('::notice::Could not use the current calendar')), why);
  }
});

test('a catastrophic live search is stopped at the deadline and fails the step, not a clean pass', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'compose.yaml'), `${'a'.repeat(40)}!\n`);
  const sigs = data('signatures.json');
  const evil = { ...sigs, signatures: [{ row: sigs.signatures[0].row, kind: 'match', files: 'any', patterns: ['^(a+)+$'] }] };
  const t0 = Date.now();
  const { code, out, summary } = await run(dir, { INPUT_DATA: 'live' }, site(evil, data('entries.json')), { deadlineMs: 1500 });
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(code, 2);
  assert.ok(out.some((l) => l.startsWith('::error::The check did not finish')), out.join('\n'));
  assert.ok(!out.some((l) => l.includes('No date between')));
  assert.match(summary, /Not checked/);
});

test('the scan thread has a memory bound', async () => {
  const dir = tmp();
  for (let i = 0; i < 24; i++) writeFileSync(join(dir, `f${i}.txt`), 'x'.repeat(1000000));
  const { code, out } = await run(dir, {}, undefined, { heapMb: 8, limits: { ...LIMITS, batchBytes: 1e9 } });
  assert.equal(code, 2);
  assert.ok(out.some((l) => l.startsWith('::error::The check used more than') || l.startsWith('::error::The check failed')), out.join('\n'));
});

test('a reached file limit is reported, and fails a gating run', async () => {
  const opts = { limits: { ...LIMITS, files: 2 } };
  const warnOnly = await run(fx('stack'), {}, undefined, opts);
  assert.equal(warnOnly.code, 0);
  assert.ok(warnOnly.out.some((l) => l.startsWith('::warning::The check stopped after 20,000 text files') || l.startsWith('::warning::The check stopped after')));
  assert.match(warnOnly.summary, /\*\*Incomplete\.\*\*/);
  const clean = tmp();
  for (let i = 0; i < 5; i++) writeFileSync(join(clean, `n${i}.txt`), 'nothing dated here\n');
  const gated = await run(clean, { 'INPUT_FAIL-WITHIN': '14' }, undefined, opts);
  assert.equal(gated.code, 2);
  assert.ok(!/No date between .* this repository's files/.test(gated.summary));
});

test('batched scan gives the same rows as one scan over every file', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'docs'));
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, `c${i}.yaml`), 'image: postgres:latest\nimage: postgres:bookworm\nruns-on: macos-14\n');
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'docs', `d${i}.md`), 'image: postgres:latest\n');
  writeFileSync(join(dir, 'p.yaml'), 'image: postgres:custom\n');
  const sigs = data('signatures.json');
  for (const d of [dir, fx('stack')]) {
    const whole = scan([...walkFiles(d)], sigs);
    assert.deepEqual(scanTree(d, sigs, { ...LIMITS, batchBytes: 1 }).rows, whole);
    assert.deepEqual(scanTree(d, sigs).rows, whole);
  }
});

// ---- Workspace boundary (C3145)
test('path stays inside the workspace; symlinks out of it are refused or not followed', async () => {
  const outside = tmp();
  writeFileSync(join(outside, 'compose.yaml'), 'image: postgres:latest\n');
  const ws = tmp();
  mkdirSync(join(ws, 'svc', 'db'), { recursive: true });
  writeFileSync(join(ws, 'svc', 'db', 'compose.yaml'), 'services:\n  db:\n    image: postgres:latest\n');
  symlinkSync(outside, join(ws, 'escape')); // selected root that leaves
  symlinkSync(join(ws, 'svc'), join(ws, 'inner')); // selected root that stays inside
  symlinkSync(outside, join(ws, 'svc', 'linked-dir')); // ordinary child links: never followed
  symlinkSync(join(outside, 'compose.yaml'), join(ws, 'svc', 'linked-compose.yaml'));

  const nested = await run(ws, { INPUT_PATH: 'svc' });
  assert.equal(nested.code, 0);
  const w = nested.out.filter((l) => l.startsWith('::warning '));
  assert.ok(w.some((l) => l.includes('file=svc/db/compose.yaml,line=3')), w.join('\n'));
  assert.ok(!nested.out.some((l) => l.includes('linked')));

  for (const p of ['..', '../x', 'escape', 'escape/sub', outside, 'missing']) {
    const r = await run(ws, { INPUT_PATH: p });
    assert.equal(r.code, 2, p);
    assert.ok(r.out[0].startsWith('::error::path'), `${p}: ${r.out[0]}`);
  }
  const viaLink = await run(ws, { INPUT_PATH: 'inner' });
  assert.ok(viaLink.out.some((l) => l.includes('file=svc/db/compose.yaml,line=3')), 'a link inside the workspace reports real paths');
  const abs = await run(ws, { INPUT_PATH: join(ws, 'svc') });
  assert.ok(abs.out.some((l) => l.includes('file=svc/db/compose.yaml,line=3')));
});

// ---- Output injection (C3143, C3146)
const HOSTILE_NAME = 'x\n::error file=a.py::forged by name\n##[error]legacy by name\r##[add-mask]y compose.yaml';
const HOSTILE_SHORT = 'postgres\n::error::forged by label ##[error]legacy by label';
const HOSTILE_TITLE = 'T [link](https://evil.example/a) ![img](https://evil.example/i.png) <img src=x> | cell | www.evil.example https://evil.example a@evil.example `tick` *em* <b>b</b>\n## heading';

function hostileRepo() {
  const dir = tmp();
  writeFileSync(join(dir, HOSTILE_NAME), 'image: postgres:latest\n');
  writeFileSync(join(dir, 'a`b|c](https:evil.example) compose.yaml'), 'image: postgres:latest\n');
  return dir;
}
function hostileData() {
  const cal = data('entries.json');
  return { ...cal, entries: cal.entries.map((e) => (e.id === '2026-11-19-postgres-latest-becomes-19' ? { ...e, short: HOSTILE_SHORT, title: HOSTILE_TITLE } : e)) };
}

test('hostile file names and calendar labels cannot add runner commands', async () => {
  const { out } = await run(hostileRepo(), { INPUT_DATA: 'live' }, site(data('signatures.json'), hostileData()));
  const cmds = runnerCommands(out);
  assert.deepEqual(cmds.filter((c) => c !== 'warning' && c !== 'notice'), [], out.join('\n'));
  assert.equal(cmds.filter((c) => c === 'warning').length, 1); // one row, annotated on its first hit
  for (const l of out.filter((x) => x.startsWith('::'))) assert.ok(!/[\r\n]/.test(l));
  // The readable list still shows the row.
  assert.ok(out.some((l) => !l.startsWith('::') && l.includes('2026-11-19') && l.includes('compose.yaml')));
});

test('workflow command lines carry no raw line breaks', async () => {
  const { out } = await run(fx('stack'));
  for (const l of out.filter((x) => x.startsWith('::'))) assert.ok(!/[\r\n]/.test(l));
});

test('hostile titles and file names render as literal text in the summary', async () => {
  const { summary } = await run(hostileRepo(), { INPUT_DATA: 'live' }, site(data('signatures.json'), hostileData()));
  const row = summary.split('\n').find((l) => l.startsWith('| 2026-11-19'));
  assert.ok(row, summary);
  // Only our own markup in the row: 5 cells, our two links, <code>/<br>. No raw punctuation from the values.
  assert.equal(row.split('|').length, 7, row);
  assert.equal((row.match(/\]\(/g) || []).length, 2, row);
  assert.ok(!/evil\.example|`|\*em\*|<img|<b>/.test(row), row);
  assert.equal(lit('a](b) `c` <d> | e'), 'a&#93;&#40;b&#41; &#96;c&#96; &#60;d&#62; &#124; e');
});
