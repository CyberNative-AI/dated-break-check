// Dated break check: run the Breakage Calendar's published searches over this repository and report the dates
// that will hit it. The searches and the matcher are the ones the browser check at
// https://cybernative.ai/breakage-calendar/check/ runs; src/match.js is a byte copy of that page's matcher.
// Nothing from the repository leaves the runner. The only network request is a GET of the two public
// calendar files; with data: bundled there is none.
import { readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, skipPath, looksBinary, MAX_BYTES, MAX_FILES, SKIP_DIRS } from './match.js';

const SITE = 'https://cybernative.ai';
const UA = 'dated-break-check/0.1 (+https://github.com/CyberNative-AI/dated-break-check)';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PAST_DAYS = 30; // a date that took effect in the last 30 days is still reported, as "in effect"

export function input(env, name, fallback) {
  const v = env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function walk(root) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop();
    let names;
    try { names = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(p); continue; }
      if (!d.isFile() || skipPath(p)) continue;
      let buf;
      try { if (statSync(join(root, p)).size > MAX_BYTES) continue; buf = readFileSync(join(root, p)); } catch { continue; }
      if (looksBinary(buf)) continue;
      files.push({ path: p, text: buf.toString('utf8') });
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

function valid(sigs, cal) {
  return sigs && Array.isArray(sigs.signatures) && typeof sigs.workflow === 'string'
    && sigs.signatures.every((s) => typeof s.row === 'string' && Array.isArray(s.patterns))
    && cal && Array.isArray(cal.entries) && cal.entries.every((e) => typeof e.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date));
}

export async function loadData(mode, fetchImpl = globalThis.fetch) {
  const bundled = () => ({
    sigs: JSON.parse(readFileSync(join(HERE, '../data/signatures.json'), 'utf8')),
    cal: JSON.parse(readFileSync(join(HERE, '../data/entries.json'), 'utf8')),
  });
  if (mode === 'bundled') return { ...bundled(), source: 'bundled' };
  try {
    const get = async (path) => {
      const r = await fetchImpl(SITE + path, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    };
    const [sigs, cal] = await Promise.all([get('/breakage-calendar/check/signatures.json'), get('/breakage-calendar/entries.json')]);
    if (!valid(sigs, cal)) throw new Error('unexpected file shape');
    return { sigs, cal, source: 'live' };
  } catch (err) {
    return { ...bundled(), source: 'bundled', fallbackReason: String(err.message || err) };
  }
}

const dayNum = (d) => { const [y, m, n] = d.split('-').map(Number); return Date.UTC(y, m - 1, n) / 864e5; };

// One finding per calendar date that the repository's files show and that falls in the window.
export function findings(files, sigs, entries, today, days) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const t = dayNum(today);
  return scan(files, sigs)
    .map((h) => ({ ...h, entry: byId.get(h.row) }))
    .filter((h) => h.entry)
    .map((h) => ({ ...h, daysLeft: dayNum(h.entry.date) - t }))
    .filter((h) => h.daysLeft >= -PAST_DAYS && h.daysLeft <= days)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.row.localeCompare(b.row));
}

const LABEL = { match: 'Hits this repository', possible: 'May hit this repository', mention: 'Named only in documents' };
export const when = (n) => (n < 0 ? `in effect since ${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`);
export const link = (e) => `${SITE}/breakage-calendar/#${e.id}`;
export const guide = (e) => (e.see && typeof e.see.href === 'string' && e.see.href.startsWith('/') ? SITE + e.see.href : null);

// GitHub workflow commands need %, CR and LF escaped in the message, and also : and , in properties.
const escMsg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escMsg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const escCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function annotations(found, root) {
  return found.filter((f) => f.kind !== 'mention').map((f) => {
    const e = f.entry, h = f.hits[0];
    const level = f.kind === 'match' ? 'warning' : 'notice';
    const file = root === '.' ? h.path : `${root.replace(/\/$/, '')}/${h.path}`;
    const fix = guide(e) || link(e);
    return `::${level} file=${escProp(file)},line=${h.line},title=${escProp(`${e.date} (${when(f.daysLeft)}): ${e.short || e.id}`)}::${escMsg(`${e.title}. What to check and the tested fix: ${fix}`)}`;
  });
}

export function summary(found, { today, days, source, fallbackReason, fileCount }) {
  const out = [`## Dated breaks for this repository`, ''];
  const sure = found.filter((f) => f.kind === 'match');
  const maybe = found.filter((f) => f.kind === 'possible');
  const docs = found.filter((f) => f.kind === 'mention');
  out.push(sure.length || maybe.length
    ? `${sure.length} date${sure.length === 1 ? '' : 's'} hit this repository and ${maybe.length} may, between ${PAST_DAYS} days ago and ${days} days from ${today}.`
    : `No date between ${PAST_DAYS} days ago and ${days} days from ${today} matched this repository's files.`, '');
  for (const [title, list] of [[LABEL.match, sure], [LABEL.possible, maybe], [LABEL.mention, docs]]) {
    if (!list.length) continue;
    out.push(`### ${title}`, '', '| Date | When | What changes | Where | Fix |', '|---|---|---|---|---|');
    for (const f of list) {
      const where = f.hits.slice(0, 3).map((h) => `\`${escCell(h.path)}:${h.line}\``).join('<br>') + (f.hits.length + f.more > 3 ? `<br>and ${f.hits.length + f.more - 3} more` : '');
      const fix = guide(f.entry) ? `[guide](${guide(f.entry)}) · [calendar](${link(f.entry)})` : `[calendar](${link(f.entry)})`;
      out.push(`| ${f.entry.date} | ${when(f.daysLeft)} | ${escCell(f.entry.title)} | ${where} | ${fix} |`);
    }
    out.push('');
  }
  out.push(`Read ${fileCount} text files. Calendar data: ${source === 'live' ? 'current, from cybernative.ai' : `copy bundled with this version${fallbackReason ? ` (the current files could not be read: ${escCell(fallbackReason)})` : ''}`}. Dates a repository's files cannot show are listed on the [calendar](${SITE}/breakage-calendar/).`);
  return out.join('\n') + '\n';
}

export async function main(env = process.env, log = console.log, fetchImpl = globalThis.fetch) {
  const root = input(env, 'path', '.');
  const days = Number(input(env, 'days', '120'));
  const failRaw = input(env, 'fail-within', '');
  const failWithin = failRaw === '' ? null : Number(failRaw);
  const mode = input(env, 'data', 'live');
  if (!Number.isInteger(days) || days < 0 || (failWithin !== null && (!Number.isInteger(failWithin) || failWithin < 0)) || !['live', 'bundled'].includes(mode)) {
    log('::error::days and fail-within take a whole number of days (0 or more); data takes live or bundled.');
    return 2;
  }
  const today = input(env, 'today', new Date().toISOString().slice(0, 10)); // 'today' is for tests; not in action.yml
  const base = join(env.GITHUB_WORKSPACE || process.cwd(), root);
  const { sigs, cal, source, fallbackReason } = await loadData(mode, fetchImpl);
  if (fallbackReason) log(`::notice::Could not read the current calendar (${escMsg(fallbackReason)}); used the copy bundled with this version.`);
  const files = walk(base);
  const found = findings(files, sigs, cal.entries, today, days);
  for (const a of annotations(found, root)) log(a);
  for (const f of found) log(`${f.entry.date}  ${when(f.daysLeft).padEnd(24)}  ${LABEL[f.kind].padEnd(24)}  ${f.entry.short || f.entry.id}  ${f.hits[0].path}:${f.hits[0].line}`);
  if (!found.length) log(`No date between ${PAST_DAYS} days ago and ${days} days from ${today} matched ${files.length} files.`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(found, { today, days, source, fallbackReason, fileCount: files.length }));
  const due = found.filter((f) => f.kind === 'match' && failWithin !== null && f.daysLeft <= failWithin);
  if (due.length) {
    log(`::error::${due.length} dated break${due.length === 1 ? '' : 's'} that hit this repository take effect within ${failWithin} days: ${escMsg(due.map((f) => `${f.entry.date} ${f.entry.short || f.entry.id}`).join('; '))}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.log(`::error::${escMsg(err.stack || err)}`); process.exitCode = 2; });
}
