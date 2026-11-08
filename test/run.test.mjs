import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, walk } from '../src/run.mjs';

const fx = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
async function run(dir, extra = {}, fetchImpl) {
  const out = [];
  const summaryFile = join(mkdtempSync(join(tmpdir(), 'dbc-')), 'summary.md');
  const code = await main({ GITHUB_WORKSPACE: dir, GITHUB_STEP_SUMMARY: summaryFile, INPUT_TODAY: '2026-11-08', INPUT_DATA: 'bundled', ...extra }, (l) => out.push(l), fetchImpl);
  let summary = '';
  try { summary = readFileSync(summaryFile, 'utf8'); } catch {}
  return { code, out, summary };
}

test('walk skips installed packages', () => {
  const paths = walk(fx('stack')).map((f) => f.path);
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
  assert.ok(!summary.includes('README.md'));
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
});

test('live mode GETs two public files and nothing else, falls back on a bad answer', async () => {
  const seen = [];
  const fake = async (url, opts) => { seen.push({ url, opts }); return { ok: true, json: async () => ({ nope: 1 }) }; };
  const { code, out, summary } = await run(fx('stack'), { INPUT_DATA: 'live' }, fake);
  assert.equal(code, 0);
  assert.deepEqual(seen.map((s) => s.url).sort(), ['https://cybernative.ai/breakage-calendar/check/signatures.json', 'https://cybernative.ai/breakage-calendar/entries.json']);
  assert.ok(seen.every((s) => !s.opts.body && (!s.opts.method || s.opts.method === 'GET')));
  assert.ok(out.some((l) => l.startsWith('::notice::Could not read the current calendar')));
  assert.match(summary, /copy bundled with this version/);
});

test('bundled mode makes no request', async () => {
  let n = 0;
  await run(fx('stack'), { INPUT_DATA: 'bundled' }, async () => { n++; throw new Error('no'); });
  assert.equal(n, 0);
});

test('workflow command lines carry no raw line breaks', async () => {
  const { out } = await run(fx('stack'));
  for (const l of out.filter((x) => x.startsWith('::'))) assert.ok(!/[\r\n]/.test(l));
});
