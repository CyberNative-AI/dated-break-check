// Dated break check: run the Breakage Calendar's published searches over this repository and report the dates
// that will hit it. The searches and the matcher are the ones the browser check at
// https://cybernative.ai/breakage-calendar/check/ runs; src/match.js is a byte copy of that page's matcher.
// No repository file, name or match is sent to cybernative.ai: with data: live the step makes two GET requests
// with no body for the public calendar files, and refuses redirects; with data: bundled it makes none. The results
// (dates, file names, line numbers) go where every step's output goes: the job log, annotations and job summary
// that GitHub keeps with the workflow run.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { resolveRoot, LIMITS } from './walk.mjs';

const SITE = 'https://cybernative.ai';
export const UA = 'dated-break-check/1.0 (+https://github.com/CyberNative-AI/dated-break-check)';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PAST_DAYS = 30; // a date that took effect in the last 30 days is still reported, as "in effect"
export const DEADLINE_MS = 5 * 60 * 1000; // the whole walk and search; the step fails if it is reached
export const HEAP_MB = 256; // the scan thread's heap; the step fails if it is reached
const MAX_RESPONSE = 4 * 1024 * 1024; // each calendar file

export function input(env, name, fallback) {
  const v = env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

// ---- Calendar data. Live files are admitted only if every field the step uses has the expected type, size and,
// for searches, valid regex syntax; otherwise the step says so and uses the bundled copy.
const ID = /^[a-z0-9][a-z0-9.-]{0,199}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HREF = /^\/[a-z0-9][a-z0-9\/._-]{0,299}$/;
const KINDS = new Set(['match', 'possible', 'postgres']);
const FILE_SETS = new Set(['any', 'source', 'workflow']);
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isRegex = (p) => {
  if (!isStr(p, 2000)) return false;
  try { new RegExp(p); return true; } catch { return false; }
};
const isDate = (d) => {
  if (!DATE.test(d)) return false;
  const [y, m, n] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, n));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === n;
};

// Returns null when the data can be used, else what is wrong with it.
export function checkData(sigs, cal) {
  if (!sigs || typeof sigs !== 'object' || !Array.isArray(sigs.signatures)) return 'signatures: no signature list';
  if (sigs.signatures.length < 1 || sigs.signatures.length > 500) return 'signatures: count out of range';
  if (!isRegex(sigs.workflow)) return 'signatures: bad workflow search';
  const rows = new Set();
  let chars = 0;
  for (const s of sigs.signatures) {
    if (!s || typeof s !== 'object' || typeof s.row !== 'string' || !ID.test(s.row) || rows.has(s.row)) return 'signatures: bad or repeated row';
    rows.add(s.row);
    if (!KINDS.has(s.kind)) return `signatures: ${s.row}: bad kind`;
    if (!FILE_SETS.has(s.files) && !isRegex(s.files)) return `signatures: ${s.row}: bad file search`;
    if (!Array.isArray(s.patterns) || s.patterns.length > 50 || !s.patterns.every(isRegex)) return `signatures: ${s.row}: bad search`;
    if (s.needs !== undefined && !isRegex(s.needs)) return `signatures: ${s.row}: bad needs search`;
    chars += s.patterns.reduce((n, p) => n + p.length, 0);
  }
  if (chars > 100000) return 'signatures: searches too long';
  if (!cal || typeof cal !== 'object' || !Array.isArray(cal.entries)) return 'entries: no entry list';
  if (cal.entries.length < 1 || cal.entries.length > 5000) return 'entries: count out of range';
  const ids = new Set();
  for (const e of cal.entries) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id) || ids.has(e.id)) return 'entries: bad or repeated id';
    ids.add(e.id);
    if (typeof e.date !== 'string' || !isDate(e.date)) return `entries: ${e.id}: bad date`;
    if (!isStr(e.title, 500)) return `entries: ${e.id}: bad title`;
    if (e.short !== undefined && e.short !== null && !isStr(e.short, 200)) return `entries: ${e.id}: bad short title`;
    if (e.see !== undefined && e.see !== null && (typeof e.see !== 'object' || (e.see.href !== undefined && typeof e.see.href !== 'string'))) return `entries: ${e.id}: bad link`;
  }
  return null;
}

async function getJson(fetchImpl, path) {
  const r = await fetchImpl(SITE + path, { headers: { 'user-agent': UA }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  if (Number(r.headers.get('content-length')) > MAX_RESPONSE) throw new Error(`${path}: larger than ${MAX_RESPONSE} bytes`);
  if (!r.body) throw new Error(`${path}: empty answer`);
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_RESPONSE) { await reader.cancel(); throw new Error(`${path}: larger than ${MAX_RESPONSE} bytes`); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error(`${path}: not valid JSON`); }
}

export async function loadData(mode, fetchImpl = globalThis.fetch) {
  const bundled = () => {
    const sigs = JSON.parse(readFileSync(join(HERE, '../data/signatures.json'), 'utf8'));
    const cal = JSON.parse(readFileSync(join(HERE, '../data/entries.json'), 'utf8'));
    const bad = checkData(sigs, cal);
    if (bad) throw new Error(`bundled calendar data: ${bad}`);
    return { sigs, cal };
  };
  if (mode === 'bundled') return { ...bundled(), source: 'bundled' };
  try {
    const [sigs, cal] = await Promise.all([getJson(fetchImpl, '/breakage-calendar/check/signatures.json'), getJson(fetchImpl, '/breakage-calendar/entries.json')]);
    const bad = checkData(sigs, cal);
    if (bad) throw new Error(bad);
    return { sigs, cal, source: 'live' };
  } catch (err) {
    const why = err.cause && err.cause.message ? `${err.message}: ${err.cause.message}` : String(err.message || err);
    return { ...bundled(), source: 'bundled', fallbackReason: why.slice(0, 300) };
  }
}

// ---- Scan, in a worker thread that is stopped at the deadline or when its heap limit is reached.
export function runScan(base, sigs, { deadlineMs = DEADLINE_MS, limits = LIMITS, heapMb = HEAP_MB } = {}) {
  return new Promise((done) => {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { base, sigs, limits },
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); w.terminate(); done(r); };
    const timer = setTimeout(() => finish({ error: 'timeout' }), deadlineMs);
    w.once('message', (m) => finish(m));
    w.once('error', (e) => finish({ error: e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'failed', message: String((e && e.message) || e) }));
    w.once('exit', (c) => finish({ error: 'failed', message: `the scan thread stopped (exit ${c})` }));
  });
}

const dayNum = (d) => { const [y, m, n] = d.split('-').map(Number); return Date.UTC(y, m - 1, n) / 864e5; };

// One finding per calendar date that the repository's files show and that falls in the window.
// rows: match.js scan() results ({ row, kind, hits, more }).
export function findings(rows, entries, today, days) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const t = dayNum(today);
  return rows
    .map((h) => ({ ...h, entry: byId.get(h.row) }))
    .filter((h) => h.entry)
    .map((h) => ({ ...h, daysLeft: dayNum(h.entry.date) - t }))
    .filter((h) => h.daysLeft >= -PAST_DAYS && h.daysLeft <= days)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.row.localeCompare(b.row));
}

const LABEL = { match: 'Hits this repository', possible: 'May hit this repository', mention: 'Named only in documents' };
export const when = (n) => (n < 0 ? `in effect since ${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`);
export const link = (e) => `${SITE}/breakage-calendar/#${encodeURIComponent(e.id)}`;
export const guide = (e) => (e.see && typeof e.see.href === 'string' && HREF.test(e.see.href) ? SITE + e.see.href : null);

// ---- Output. File names come from the reader's repository and titles from the calendar files: neither is trusted.
// Workflow commands: %, CR and LF escaped in the message, and also : and , in properties (as GitHub's toolkit does).
const escMsg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escMsg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
// Plain log lines: no control or line-separator characters, so a value cannot start a line of its own.
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
export const oneLine = (s) => String(s).replace(CTRL, ' ');
// Job summary (GitHub Markdown): every ASCII punctuation character as a numeric character reference, so a value
// reads as literal text: no link, image, autolink, emphasis, HTML, code span or table cell can start inside it.
export const lit = (s) => oneLine(s).replace(/[!-\/:-@\[-`{-~]/g, (c) => `&#${c.charCodeAt(0)};`);

export function annotations(found, rel) {
  return found.filter((f) => f.kind !== 'mention').map((f) => {
    const e = f.entry, h = f.hits[0];
    const level = f.kind === 'match' ? 'warning' : 'notice';
    const file = rel === '.' ? h.path : `${rel}/${h.path}`;
    const fix = guide(e) || link(e);
    return `::${level} file=${escProp(file)},line=${h.line},title=${escProp(`${e.date} (${when(f.daysLeft)}): ${e.short || e.id}`)}::${escMsg(`${e.title}. What to check, and our tested fix where we have one: ${fix}`)}`;
  });
}

// The readable list in the log. main() prints it between ::stop-commands:: and a random resume token, so the
// runner reads none of these lines as a command, in either command syntax.
export function logLines(found) {
  return found.map((f) => oneLine(`${f.entry.date}  ${when(f.daysLeft).padEnd(24)}  ${LABEL[f.kind].padEnd(24)}  ${f.entry.short || f.entry.id}  ${f.hits[0].path}:${f.hits[0].line}`));
}

const STOPPED = {
  files: `${LIMITS.files.toLocaleString('en-US')} text files`,
  bytes: `reading ${LIMITS.totalBytes / 1024 / 1024} MB`,
  entries: `${LIMITS.entries.toLocaleString('en-US')} folder entries`,
};
export const incompleteText = (stopped) => `The check stopped after ${STOPPED[stopped] || stopped}, so the rest of the folder was not read. Set path to a smaller folder.`;

export function summary(found, { today, days, source, fallbackReason, stats }) {
  const out = [`## Dated breaks for this repository`, ''];
  if (stats.stopped) out.push(`**Incomplete.** ${incompleteText(stats.stopped)}`, '');
  const sure = found.filter((f) => f.kind === 'match');
  const maybe = found.filter((f) => f.kind === 'possible');
  const docs = found.filter((f) => f.kind === 'mention');
  out.push(sure.length || maybe.length
    ? `${sure.length} date${sure.length === 1 ? '' : 's'} hit this repository and ${maybe.length} may, between ${PAST_DAYS} days ago and ${days} days from ${today}.`
    : `No date between ${PAST_DAYS} days ago and ${days} days from ${today} matched ${stats.stopped ? 'the files that were read' : "this repository's files"}.`, '');
  for (const [title, list] of [[LABEL.match, sure], [LABEL.possible, maybe], [LABEL.mention, docs]]) {
    if (!list.length) continue;
    out.push(`### ${title}`, '', '| Date | When | What changes | Where | Fix |', '|---|---|---|---|---|');
    for (const f of list) {
      const n = f.hits.length + f.more;
      const where = f.hits.slice(0, 3).map((h) => `<code>${lit(h.path)}:${h.line}</code>`).join('<br>') + (n > 3 ? `<br>and ${n - 3} more` : '');
      const g = guide(f.entry);
      const fix = g ? `[guide](${g}) · [calendar](${link(f.entry)})` : `[calendar](${link(f.entry)})`;
      out.push(`| ${f.entry.date} | ${when(f.daysLeft)} | ${lit(f.entry.title)} | ${where} | ${fix} |`);
    }
    out.push('');
  }
  const large = stats.skippedLarge ? ` ${stats.skippedLarge} file${stats.skippedLarge === 1 ? '' : 's'} over 1 MB ${stats.skippedLarge === 1 ? 'was' : 'were'} not read.` : '';
  out.push(`Read ${stats.files} text file${stats.files === 1 ? '' : 's'}.${large} Calendar data: ${source === 'live' ? 'current, from cybernative.ai' : `copy bundled with this version${fallbackReason ? ` (the current files could not be used: ${lit(fallbackReason)})` : ''}`}. Dates a repository's files cannot show are listed on the [calendar](${SITE}/breakage-calendar/).`);
  return out.join('\n') + '\n';
}

const failedText = (error, { deadlineMs = DEADLINE_MS, heapMb = HEAP_MB } = {}) => ({
  timeout: `The check did not finish within ${deadlineMs / 60000} minutes, so it reports nothing for this run. A search may be very slow on one of your files: set path to a smaller folder, or data: bundled.`,
  memory: `The check used more than ${heapMb} MB and was stopped, so it reports nothing for this run. Set path to a smaller folder.`,
})[error];

export async function main(env = process.env, log = console.log, fetchImpl = globalThis.fetch, opts = {}) {
  const days = Number(input(env, 'days', '120'));
  const failRaw = input(env, 'fail-within', '');
  const failWithin = failRaw === '' ? null : Number(failRaw);
  const mode = input(env, 'data', 'live');
  const today = input(env, 'today', new Date().toISOString().slice(0, 10)); // 'today' is for tests; not in action.yml
  if (!Number.isInteger(days) || days < 0 || (failWithin !== null && (!Number.isInteger(failWithin) || failWithin < 0)) || !['live', 'bundled'].includes(mode) || !isDate(today)) {
    log('::error::days and fail-within take a whole number of days (0 or more); data takes live or bundled.');
    return 2;
  }
  let root;
  try { root = resolveRoot(env.GITHUB_WORKSPACE || process.cwd(), input(env, 'path', '.')); } catch (err) {
    log(`::error::${escMsg(err.message)}`);
    return 2;
  }
  const { sigs, cal, source, fallbackReason } = await loadData(mode, fetchImpl);
  if (fallbackReason) log(`::notice::Could not use the current calendar (${escMsg(fallbackReason)}); used the copy bundled with this version.`);
  const res = await runScan(root.base, sigs, opts);
  if (res.error) {
    const why = failedText(res.error, opts) || `The check failed (${res.message}), so it reports nothing for this run.`;
    log(`::error::${escMsg(why)}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Dated breaks for this repository\n\n**Not checked.** ${lit(why)}\n`);
    return 2;
  }
  const { rows, stats } = res;
  const found = findings(rows, cal.entries, today, days);
  for (const a of annotations(found, root.rel)) log(a);
  const token = randomBytes(16).toString('hex');
  log(`::stop-commands::${token}`);
  for (const l of logLines(found)) log(l);
  if (!found.length) log(`No date between ${PAST_DAYS} days ago and ${days} days from ${today} matched ${stats.files} files.`);
  log(`::${token}::`);
  if (stats.stopped) log(`::warning::${escMsg(incompleteText(stats.stopped))}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(found, { today, days, source, fallbackReason, stats }));
  const due = found.filter((f) => f.kind === 'match' && failWithin !== null && f.daysLeft <= failWithin);
  if (due.length) {
    log(`::error::${due.length} dated break${due.length === 1 ? '' : 's'} that hit this repository take effect within ${failWithin} days: ${escMsg(due.map((f) => `${f.entry.date} ${f.entry.short || f.entry.id}`).join('; '))}`);
    return 1;
  }
  if (stats.stopped && failWithin !== null) {
    log('::error::The check did not read the whole folder, so this run cannot pass as clean.');
    return 2;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.log(`::error::${escMsg(err.stack || err)}`); process.exitCode = 2; });
}
