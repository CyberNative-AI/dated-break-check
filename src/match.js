// Breakage Calendar, "check a repository": run each date's own published search over a folder's text files.
// Pure functions only, so tests/breakage-calendar-check.test.mjs runs the same code the page runs.
// signatures.json says which rows a folder can show and which files each search reads.

// Folders a search never needs. Installed packages are skipped too: the AI-model rows' own commands search
// them, and the page says so beside a no-match result.
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.tox', '.mypy_cache',
  '.pytest_cache', 'vendor', 'dist', 'build', 'target', '.next', '.nuxt', 'coverage', '.gradle', 'Pods', 'site-packages']);
export const MAX_BYTES = 1024 * 1024;
export const MAX_FILES = 20000;
const MAX_HITS = 25;

// "Any" is every text file (the rows whose command is grep -rn … .). "Source" leaves out prose, so a README
// that names a model in an example does not read as code that sends it.
const SOURCE = /\.(py|pyi|ipynb|js|mjs|cjs|jsx|ts|tsx|go|rb|php|java|kt|kts|scala|cs|rs|swift|ex|exs|sh|bash|zsh|ps1|ya?ml|toml|json|ini|cfg|conf|env|properties|tf|r)$|(^|\/)(Dockerfile[^/]*|Makefile|\.env[^/]*)$/i;
const ANY = /./;
// Documents and published data: a line here mentions the thing; it does not call it.
const PROSE = /\.(md|mdx|rst|txt|adoc|html?|xml|ics|csv|svg|po|pot)$|(^|\/)(README|CHANGELOG|CHANGES|NEWS|HISTORY|LICENSE)[^/]*$/i;
export const isProse = (p) => PROSE.test(p);

export function skipPath(path) {
  return path.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d));
}

// "repo/.github/workflows/ci.yml" (a chosen folder) -> ".github/workflows/ci.yml".
export function repoRelative(p) {
  const i = p.indexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function fileTest(spec, sigs) {
  if (spec === 'source') return (p) => SOURCE.test(p);
  if (spec === 'any') return (p) => ANY.test(p);
  if (spec === 'workflow') return (p) => new RegExp(sigs.workflow).test(p);
  return (p) => new RegExp(spec).test(p);
}

// postgres, postgres:latest, :alpine, :trixie, :bookworm, :alpine3.24 and :alpine3.23 move to 19 unless a digest follows
// (the row's check text and the guide's tested tag list).
// A tag with a major version does not move. Any other tag, or one set from a variable, is for the reader to look up.
const PG = /(?:image:|FROM)\s*["']?(?:docker\.io\/)?(?:library\/)?postgres(?::([^\s"'@]+))?(@sha256:[0-9a-f]{64})?(?=[\s"']|$)/;
const PG_MOVES = new Set([undefined, 'latest', 'alpine', 'trixie', 'bookworm', 'alpine3.24', 'alpine3.23']);
export function postgresVerdict(line) {
  const m = line.match(PG);
  if (!m) return null;
  const [, tag, digest] = m;
  if (digest) return null;
  if (tag && /^\d/.test(tag)) return null;
  if (PG_MOVES.has(tag)) return 'match';
  return 'possible';
}

// files: [{ path, text }]. Returns one result per signature that found something, in signature order:
// { row, kind: 'match' | 'possible' | 'mention', hits: [{ path, line, text }], more }.
// 'mention' is a 'match' whose every line sits in a document or data file; code lines are listed first.
export function scan(files, sigs, { maxHits = MAX_HITS } = {}) {
  const out = [];
  for (const s of sigs.signatures) {
    const want = fileTest(s.files, sigs);
    const res = s.patterns.map((p) => new RegExp(p));
    const needs = s.needs ? new RegExp(s.needs) : null;
    const code = [], prose = [];
    let more = 0, kind = s.kind === 'postgres' ? null : s.kind;
    for (const f of files) {
      if (!want(f.path)) continue;
      if (s.files === 'source' && isProse(f.path)) continue;
      if (needs && !needs.test(f.text)) continue;
      const bucket = isProse(f.path) ? prose : code;
      const lines = f.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let hit = false;
        if (s.kind === 'postgres') {
          const v = postgresVerdict(line);
          if (v) { hit = true; kind = kind === 'match' || v === 'match' ? 'match' : 'possible'; }
        } else hit = res.some((r) => r.test(line));
        if (!hit) continue;
        if (bucket.length < maxHits) bucket.push({ path: f.path, line: i + 1, text: line.trim().slice(0, 200) });
        else more++;
      }
    }
    if (!code.length && !prose.length) continue;
    if (kind === 'match' && !code.length) kind = 'mention';
    const hits = [...code, ...prose];
    out.push({ row: s.row, kind, hits, more });
  }
  return out;
}

// Keep only the matched dates' events from the published .ics. A downloaded file does not refresh, so the
// subscription lines go and the name says what it holds.
export function filterIcs(ics, rowIds, name) {
  const lines = ics.replace(/\r\n/g, '\n').split('\n');
  const head = [], events = [];
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { cur = [l]; continue; }
    if (cur) { cur.push(l); if (l === 'END:VEVENT') { events.push(cur); cur = null; } continue; }
    if (l === 'END:VCALENDAR' || l === '') continue;
    head.push(l);
  }
  const keep = events.filter((ev) => {
    const uid = ev.find((l) => l.startsWith('UID:'));
    return uid && rowIds.some((id) => uid === `UID:${id}@cybernative.ai` || new RegExp(`^UID:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}@cybernative\\.ai$`).test(uid));
  });
  // Drop folded continuation lines of the dropped properties together with them.
  const top = [];
  let dropping = false;
  for (const l of head) {
    if (l.startsWith(' ')) { if (!dropping) top.push(l); continue; }
    dropping = /^(REFRESH-INTERVAL|X-PUBLISHED-TTL|SOURCE|X-WR-CALNAME|X-WR-CALDESC|NAME|URL)[;:]/.test(l);
    if (!dropping) top.push(l);
  }
  top.push(`X-WR-CALNAME:${name.replace(/[,;\\]/g, (c) => '\\' + c)}`);
  return [...top, ...keep.flat(), 'END:VCALENDAR', ''].join('\r\n');
}

// The course: today on the left, the last date on the right, so the dates still to come spread over the width.
// Dates already in effect (or under way today) share one stone left of Today; one 2008 date cannot squeeze the rest.
// Positions are percent of the track. Month ticks stop short of the right edge so no label runs off a phone.
export const COURSE_NOW = 10;
export function courseMarks(entries, today, kind = new Map()) {
  const day = (d) => { const [y, m, n] = d.split('-').map(Number); return Date.UTC(y, m - 1, n) / 864e5; };
  const t = day(today), hi = Math.max(t + 1, ...entries.map((e) => day(e.date)));
  const at = (d) => (day(d) <= t ? COURSE_NOW / 2 : COURSE_NOW + ((day(d) - t) / (hi - t)) * (100 - COURSE_NOW));
  // Hits last so they stand over the grey ticks; "match" over "possible" where they share the in-effect stone.
  const rank = (e) => ({ possible: 1, match: 2 }[kind.get(e.id)] || 0);
  const stones = entries.slice().sort((a, b) => rank(a) - rank(b)).map((e) => ({ id: e.id, kind: kind.get(e.id), at: at(e.date) }));
  const months = [];
  let [y, m] = today.split('-').map(Number);
  for (;;) {
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    const d = `${y}-${String(m).padStart(2, '0')}-01`;
    if (day(d) > hi || at(d) > 92) break;
    months.push({ m, at: at(d) });
  }
  // On a phone the "In effect" label takes about a quarter of the track: months that close to Today are hidden,
  // then every other month from the first one shown.
  let n = 0;
  for (const x of months) { x.near = x.at - COURSE_NOW < 24; x.alt = !x.near && n++ % 2 === 1; }
  return { now: COURSE_NOW, past: entries.some((e) => day(e.date) <= t), stones, months };
}
