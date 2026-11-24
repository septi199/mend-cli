// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits (section 9), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), line matching at three tiers (section 5),
// and the all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split at its own line break (SPEC.md section 3). */
interface FileParts {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) lines.pop();
  return { br, lines, finalBr };
}

function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when anything (file or directory) is at the path in the tree as the edits left it. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

function leadWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function trailTrim(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function trimWs(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a += 1;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
  return s.slice(a, b);
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trailTrim(s);
  return trimWs(s);
}

/** One line of O or N. `ctx` marks a context line, present in both O and N. */
interface LineItem {
  text: string;
  ctx: boolean;
}

/** Positions >= `from` where O occurs in the file's lines at one tier. */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const m = o.length;
  if (m === 0 || m > fileLines.length - from) return out;
  const on = o.map((l) => normLine(l, tier));
  const fn = fileLines.map((l) => normLine(l, tier));
  outer: for (let i = from; i + m <= fileLines.length; i++) {
    for (let k = 0; k < m; k++) {
      if (fn[i + k] !== on[k]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function findTier(fileLines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line target, tier-first. */
function findSingle(lines: string[], target: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const nt = normLine(target, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === nt) return i;
    }
  }
  return null;
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  // SPEC section 5, read literally: a line starting with P has that P replaced by F.
  // When P is empty every such line starts with it, so F is prepended (practice v-indent).
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Replace O's lines at `pos` with N's lines, honouring context lines and tier-2 re-indent. */
function applyReplace(fileLines: string[], pos: number, oItems: LineItem[], nItems: LineItem[], tier: number): string[] {
  const oCtxPos: number[] = [];
  oItems.forEach((it, i) => {
    if (it.ctx) oCtxPos.push(i);
  });
  let f = '';
  let p = '';
  if (tier === 2 && oItems.length > 0) {
    f = leadWs(fileLines[pos] ?? '');
    p = leadWs(oItems[0]!.text);
  }
  const out: string[] = [];
  let nc = 0;
  for (const ni of nItems) {
    if (ni.ctx) {
      out.push(fileLines[pos + oCtxPos[nc]!]!);
      nc += 1;
    } else if (tier === 2) {
      out.push(reindent(ni.text, p, f));
    } else {
      out.push(ni.text);
    }
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + oItems.length)];
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: LineItem[];
  n: LineItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  plusNoNl: boolean;
  hasPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, `a/`/`b/` stripped, `/dev/null` is null. */
function parseDiffPath(rest: string): string | null {
  let s = rest.split('\t')[0]!.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  if (s === '/dev/null') return null;
  return s;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function parseHunkHeader(line: string): number | null {
  const m = HUNK_RE.exec(line);
  return m ? Number(m[1]) : null;
}

/** Whether a `\` line follows the body's last line of the wanted kind. */
function backslashAfterLast(body: string[], isTarget: (bl: string) => boolean): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    const bl = body[j]!;
    if (bl.startsWith('\\')) continue;
    if (isTarget(bl)) return j + 1 < body.length && body[j + 1]!.startsWith('\\');
  }
  return false;
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: LineItem[] = [];
  const n: LineItem[] = [];
  let hasPlus = false;
  for (const bl of body) {
    if (bl.startsWith('\\')) continue;
    if (bl === '' || bl.startsWith(' ')) {
      const item: LineItem = { text: bl === '' ? '' : bl.slice(1), ctx: true };
      o.push(item);
      n.push(item);
    } else if (bl.startsWith('-')) {
      o.push({ text: bl.slice(1), ctx: false });
    } else {
      n.push({ text: bl.slice(1), ctx: false });
      hasPlus = true;
    }
  }
  const isCtxOrPlus = (bl: string): boolean => bl === '' || bl.startsWith(' ') || bl.startsWith('+');
  const isPlus = (bl: string): boolean => bl.startsWith('+');
  return { a, o, n, noNl: backslashAfterLast(body, isCtxOrPlus), plusNoNl: backslashAfterLast(body, isPlus), hasPlus };
}

interface SectionWork {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  pairSet: boolean;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSectionWork(diffOld: string | null, diffNew: string | null): SectionWork {
  return { diffOld, diffNew, pairOld: null, pairNew: null, pairSet: false, renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [] };
}

function resolveSection(w: SectionWork): Section {
  let oldPath: string | null;
  let newPath: string | null;
  if (w.pairSet) {
    oldPath = w.pairOld;
    newPath = w.pairNew;
  } else {
    oldPath = w.renameOld ?? w.diffOld;
    newPath = w.renameNew ?? w.diffNew;
  }
  return { oldPath, newPath, newFile: w.newFile, deletedFile: w.deletedFile, hunks: w.hunks };
}

function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = s.oldPath;
    const newPath = s.newPath;
    const isCreate = oldPath === null || s.newFile;
    const isDelete = !isCreate && (newPath === null || s.deletedFile);
    const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
    // Every path the edit names is checked for safety before anything else about it.
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && newPath !== oldPath && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) return; // a creation naming no file: nothing to write.
      if (tree.exists(newPath)) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        for (const it of h.n) if (!it.ctx) plus.push(it.text);
        if (h.hasPlus) noNl = h.plusNoNl;
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const before = tree.get(oldPath!);
      if (before === null) throw new Fail('missing', oldPath!);
      tree.now.set(oldPath!, null);
      return;
    }
    const path = oldPath!;
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (isMove && tree.exists(newPath!)) throw new Fail('exists', newPath!);
    const parts = splitFile(before);
    let lines = parts.lines;
    let finalBr = parts.finalBr;
    let d = 0;
    for (const h of s.hunks) {
      if (h.o.length === 0) {
        const ins = Math.max(0, Math.min(h.a + d, lines.length));
        const atEnd = ins === lines.length;
        lines = [...lines.slice(0, ins), ...h.n.map((it) => it.text), ...lines.slice(ins)];
        if (atEnd) finalBr = !h.noNl;
        d += h.n.length;
        continue;
      }
      const found = findTier(lines, h.o.map((it) => it.text), strict, 0);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const matchedToEnd = best + h.o.length === lines.length;
      lines = applyReplace(lines, best, h.o, h.n, found.tier);
      if (matchedToEnd) finalBr = !h.noNl;
      d += h.n.length - h.o.length;
    }
    const outText = joinFile(lines, parts.br, finalBr);
    if (isMove) {
      tree.now.set(newPath!, outText);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: newPath! });
    } else {
      tree.now.set(path, outText);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const works: SectionWork[] = [];
  let cur: SectionWork | null = null;
  let inHeader = false;
  const pushCur = (): void => {
    if (cur) works.push(cur);
    cur = null;
    inHeader = false;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      pushCur();
      cur = newSectionWork(m[1]!, m[2]!);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur && inHeader && !cur.pairSet) {
        cur.pairOld = parseDiffPath(line.slice(4));
        cur.pairNew = parseDiffPath(lines[i + 1]!.slice(4));
        cur.pairSet = true;
        i += 2;
        continue;
      }
      pushCur();
      cur = newSectionWork(null, null);
      cur.pairOld = parseDiffPath(line.slice(4));
      cur.pairNew = parseDiffPath(lines[i + 1]!.slice(4));
      cur.pairSet = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j += 1;
        } else break;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      cur.hunks.push(buildHunk(a, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (!cur.pairSet) cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.pairSet) cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  pushCur();
  return works.map((w) => sectionEdit(resolveSection(w), strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const oItems = oldLines.map((t): LineItem => ({ text: t, ctx: false }));
    const nItems = newLines.map((t): LineItem => ({ text: t, ctx: false }));
    const out = applyReplace(parts.lines, found.pos[0]!, oItems, nItems, found.tier);
    tree.now.set(path, joinFile(out, parts.br, parts.finalBr));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: LineItem[];
  n: LineItem[];
}

interface RawLine {
  line: string;
  num: number;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.exists(path)) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: RawLine[], headerNum: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.line.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.line.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  const finishChunk = (): void => {
    if (curChunk) {
      chunks.push(curChunk);
      curChunk = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const { line, num } = raw[idx]!;
    if (line.startsWith('@@')) {
      finishChunk();
      const anchor = line.slice(2).trim();
      curChunk = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
      continue;
    }
    if (line === '*** End of File') {
      if (!curChunk) throw new Exit2(`error: parse ${num}`);
      curChunk.eof = true;
      finishChunk();
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (!curChunk) curChunk = { anchor: null, eof: false, o: [], n: [] };
      if (line === '' || line.startsWith(' ')) {
        const t = line === '' ? '' : line.slice(1);
        curChunk.o.push({ text: t, ctx: true });
        curChunk.n.push({ text: t, ctx: true });
      } else if (line.startsWith('-')) {
        curChunk.o.push({ text: line.slice(1), ctx: false });
      } else {
        curChunk.n.push({ text: line.slice(1), ctx: false });
      }
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  finishChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let lines = parts.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, ins), ...ch.n.map((it) => it.text), ...lines.slice(ins)];
        cursor = ch.eof ? lines.length : ins + ch.n.length;
        continue;
      }
      const found = findTier(lines, ch.o.map((it) => it.text), strict, cursor);
      if (!found) throw new Fail('no-match', path);
      let pos: number | null = null;
      for (const p of found.pos) {
        if (ch.eof && p + ch.o.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) throw new Fail('no-match', path);
      lines = applyReplace(lines, pos, ch.o, ch.n, found.tier);
      cursor = pos + ch.n.length;
    }
    const outText = joinFile(lines, parts.br, parts.finalBr);
    if (moveTo !== null) {
      tree.now.set(moveTo, outText);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, outText);
    }
  };
}

const SECTION_RE = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = SECTION_RE.exec(line);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const headerNum = i + 1;
    const raw: RawLine[] = [];
    i += 1;
    while (i < last) {
      const l = lines[i]!;
      if (SECTION_RE.test(l)) break;
      raw.push({ line: l, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    if (kind === 'Add File') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.line.startsWith('+')) fileLines.push(r.line.slice(1));
        else if (r.line === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'Delete File') {
      for (const r of raw) {
        if (!blank(r.line)) throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, headerNum, strict));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    if (consumed.has(m.old) || consumed.has(m.new)) continue;
    const oldWas = tree.original(m.old);
    const newWas = tree.original(m.new);
    const oldNow = tree.get(m.old);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      consumed.add(m.old);
      consumed.add(m.new);
    }
  }
  const sortedNow = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedNow) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of sortedNow) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
