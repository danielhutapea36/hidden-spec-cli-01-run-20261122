// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote — a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as
// JSON — to a tree of text files, to the specification SPEC.md ships in the
// kit (version 1). Every file is changed or none.
//
// Node 22, standard library alone. Run as `node main.ts [options] [PATCH]`.
//
// This entry builds on the kit's starter, which implements SPEC.md sections
// 1 to 4 (invocation, output, paths, format detection), 9 (JSON edits) and
// 10 (order and atomicity). Sections 5 (three-tier line matching), 6
// (unified diffs), 7 (SEARCH/REPLACE blocks) and 8 (V4A patches), and the
// move (`R`) output lines of section 2, are written here, in this session,
// from SPEC.md alone. The last lines hand a trial over to runner.ts when
// MAKEFUN_ENV_URL is set; runner.ts is kept as the kit has it.

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

/** A file's lines under its own line break (SPEC.md section 3). */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves performed by edits that succeeded: used for the `R` output lines. */
  moves: Array<{ from: string; to: string }> = [];
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
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where `o` occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  const n = o.length;
  if (n === 0) return res;
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which `o` occurs at or after `from`, with its positions. */
function findAtTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N (the replacement lines). A context line is written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** Render N against the file's matched lines at `pos` (SPEC.md section 5). */
function renderN(n: NLine[], fileLines: string[], pos: number, tier: number, oFirst: string | null): string[] {
  let f = '';
  let p: string | null = null;
  if (tier === 2 && oFirst !== null) {
    f = leadingWs(fileLines[pos] ?? '');
    p = leadingWs(oFirst);
  }
  return n.map((l) => {
    if (l.ctx) return fileLines[pos + l.oIndex]!;
    let t = l.text;
    if (p !== null && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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
      if (tree.get(p) !== null) throw new Fail('exists', p);
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
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** The hunk has `+` lines, and a `\` line follows its last one. */
  lastPlusNoEol: boolean;
  plusCount: number;
}

function parseHunkHeader(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return parseInt(m[1]!, 10);
}

/** A hunk body: the lines after the header until the first line that is not one. */
function parseHunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIndex: o.length - 1 });
      lastCtxPlus = idx;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIndex: -1 });
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  });
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const lastPlusNoEol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { a, o, n, noEol, lastPlusNoEol, plusCount: n.filter((l) => !l.ctx).length };
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, `a/` / `b/` removed. */
function pathFromHeader(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  pairSeen: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const ins = h.n.map((l) => l.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) final = !h.noEol;
      d += h.n.length;
    } else {
      const found = findAtTier(lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const touchesEnd = best + h.o.length === lines.length;
      const rep = renderN(h.n, lines, best, found.tier, h.o[0]!);
      lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + h.o.length)];
      if (touchesEnd) final = !h.noEol;
      d += h.n.length - h.o.length;
    }
  }
  return joinFile({ br: f.br, lines, final });
}

function sectionEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null = s.oldPath ?? s.renameFrom ?? s.diffOld;
    let newP: string | null = s.newPath ?? s.renameTo ?? s.diffNew;
    const oldDevNull = oldP === '/dev/null';
    const newDevNull = newP === '/dev/null';
    if (oldDevNull) oldP = null;
    if (newDevNull) newP = null;
    if (s.isNew || oldDevNull) {
      // Creation: the file is the `+` lines of all its hunks, in order.
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const l of h.n) if (!l.ctx) plus.push(l.text);
      let final = true;
      for (const h of s.hunks) if (h.plusCount > 0) final = !h.lastPlusNoEol;
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (s.isDeleted || newDevNull) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      // Move: hunks apply to the old file's lines, the result is written at the new path.
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(text, s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ from: oldP, to: newP });
      return;
    }
    const p = (oldP ?? newP) ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, s.hunks, strict, p));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSec = (diffOld: string | null, diffNew: string | null): USection => {
    const s: USection = { diffOld, diffNew, oldPath: null, newPath: null, renameFrom: null, renameTo: null, pairSeen: false, isNew: false, isDeleted: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const isPlusPlus = (l: string | undefined): boolean => l !== undefined && l.startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSec(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && isPlusPlus(lines[i + 1])) {
        cur = newSec(null, null);
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.hunks.length === 0) {
      // Section header: before its first hunk.
      if (line.startsWith('--- ')) {
        if (!isPlusPlus(lines[i + 1])) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.pairSeen) {
          cur = newSec(null, null);
          continue;
        }
        cur.oldPath = pathFromHeader(line);
        cur.newPath = pathFromHeader(lines[i + 1]!);
        cur.pairSeen = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = pathFromHeader(line);
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i + 1);
        const r = parseHunkBody(lines, i + 1);
        cur.hunks.push(buildHunk(a, r.body));
        i = r.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDeleted = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // After the hunks: a `--- ` / `+++ ` pair or a `diff --git` line starts a new section.
    if (line.startsWith('--- ') && isPlusPlus(lines[i + 1])) {
      cur = newSec(null, null);
      continue;
    }
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i + 1);
      const r = parseHunkBody(lines, i + 1);
      cur.hunks.push(buildHunk(a, r.body));
      i = r.next;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = findAtTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nlines: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const rep = renderN(nlines, f.lines, pos, found.tier, oldLines[0]!);
    f.lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
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
  o: string[];
  n: NLine[];
}

interface VSection {
  kind: string;
  path: string;
  startLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4aSection(kind: string, path: string, startLine: number, body: string[], bodyNos: number[]): VSection {
  if (kind === 'Add') {
    const out: string[] = [];
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!;
      if (l.startsWith('+')) out.push(l.slice(1));
      else if (l === '') out.push('');
      else throw new Exit2(`error: parse ${bodyNos[k]}`);
    }
    return { kind, path, startLine, addLines: out, moveTo: null, chunks: [] };
  }
  if (kind === 'Delete') {
    for (let k = 0; k < body.length; k++) throw new Exit2(`error: parse ${bodyNos[k]}`);
    return { kind, path, startLine, addLines: [], moveTo: null, chunks: [] };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice(13).trim();
    idx = 1;
  }
  interface RawChunk {
    anchor: string | null;
    eof: boolean;
    body: string[];
  }
  const raw: RawChunk[] = [];
  let cur: RawChunk | null = null;
  let seenChunk = false;
  for (; idx < body.length; idx++) {
    const line = body[idx]!;
    const no = bodyNos[idx]!;
    if (line === '@@' || line.startsWith('@@ ') || line.startsWith('@@\t')) {
      if (cur !== null) raw.push(cur);
      const a = line.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, body: [] };
      seenChunk = true;
      continue;
    }
    if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      raw.push(cur);
      cur = null;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        if (seenChunk) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, body: [] };
        seenChunk = true;
      }
      cur.body.push(line);
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (cur !== null) raw.push(cur);
  if (raw.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  const chunks: VChunk[] = raw.map((c) => {
    const o: string[] = [];
    const n: NLine[] = [];
    for (const l of c.body) {
      if (l === '' || l.startsWith(' ')) {
        const t = l === '' ? '' : l.slice(1);
        o.push(t);
        n.push({ text: t, ctx: true, oIndex: o.length - 1 });
      } else if (l.startsWith('-')) {
        o.push(l.slice(1));
      } else if (l.startsWith('+')) {
        n.push({ text: l.slice(1), ctx: false, oIndex: -1 });
      }
    }
    return { anchor: c.anchor, eof: c.eof, o, n };
  });
  return { kind, path, startLine, addLines: [], moveTo, chunks };
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'Add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'Delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(text);
    let lines = f.lines;
    let cursor = 0;
    for (const c of sec.chunks) {
      if (c.anchor !== null) {
        const found = findAtTier(lines, [c.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.occ[0]! + 1;
      }
      if (c.o.length === 0) {
        const at = c.eof ? lines.length : cursor;
        const ins = c.n.map((l) => l.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
      } else {
        let found: { tier: number; occ: number[] } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = occurrences(lines, c.o, t, cursor).filter((pos) => !c.eof || pos + c.o.length === lines.length);
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const pos = found.occ[0]!;
        const rep = renderN(c.n, lines, pos, found.tier, c.o[0]!);
        lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + c.o.length)];
        cursor = pos + rep.length;
      }
    }
    const out = joinFile({ br: f.br, lines, final: f.final });
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push({ from: p, to: sec.moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSec {
    kind: string;
    path: string;
    startLine: number;
    body: string[];
    bodyNos: number[];
  }
  const secs: RawSec[] = [];
  let cur: RawSec | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const m = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(line);
    if (m !== null) {
      cur = { kind: m[1]!, path: m[2]!.trim(), startLine: i + 1, body: [], bodyNos: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.body.push(line);
    cur.bodyNos.push(i + 1);
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    while (s.body.length > 0 && blank(s.body[s.body.length - 1]!)) {
      s.body.pop();
      s.bodyNos.pop();
    }
    edits.push(v4aEdit(parseV4aSection(s.kind, s.path, s.startLine, s.body, s.bodyNos), strict));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order of the paths;
  // a move that succeeded is one `R` line, sorted by its new path.
  interface Row {
    key: string;
    line: string;
  }
  const rMoves = tree.moves.filter(
    (m) => tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null,
  );
  const rFrom = new Set(rMoves.map((m) => m.from));
  const rTo = new Set(rMoves.map((m) => m.to));
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rFrom.has(p) || rTo.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of rMoves) rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
