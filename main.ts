// mend: one patch tool for every AI edit format.
//
// Applies an AI-written edit in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON edits) to a tree of text
// files, to SPEC.md v1. Node 22, standard library only, no network,
// no processes spawned. Every check runs `node main.ts [arguments]`
// once in a fresh directory; the exit code, everything on stdout and
// every file afterwards are exactly what SPEC.md says.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------- small helpers ----------

function isBlank(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

function stripTrailingWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function parseFail(line: number): never {
  throw new ParseError(line);
}

// A patch's lines: its text split at \n, each with one trailing \r
// removed, and without the empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A file's lines, line break and final-break flag, per SPEC.md section 3:
// the break is CRLF when the first line feed follows a carriage return,
// else LF; the lines are the text split at that break; the file ends
// with a break when its text ends with that break (the last empty piece
// is not a line); an empty file has no lines and no final break.
interface FileParts {
  lines: string[];
  br: '\r\n' | '\n';
  ends: boolean;
}

function parseFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const firstLF = text.indexOf('\n');
  const br: '\r\n' | '\n' = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let ends = false;
  if (text.endsWith(br)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, br, ends };
}

function renderFile(lines: string[], br: '\r\n' | '\n', ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------- line matching (SPEC.md section 5) ----------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(o: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0 || k > lines.length) return out;
  const no = o.map((l) => normLine(l, tier));
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(lines[i + j], tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

// O is found at the first of the three tiers at which it occurs at
// least once; --strict tries tier 0 only.
function findTier(o: string[], lines: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(o, lines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// Same, but only occurrences at or after `from`.
function findTierFrom(o: string[], lines: string[], from: number, strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(o, lines, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// The first line at or after `from` equal to a single line, at the
// first tier where one is (SPEC.md section 8, V4A anchor search).
function findSingle(line: string, lines: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(line, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i], t) === want) return i;
    }
  }
  return null;
}

// Build the lines that replace a matched occurrence. A context line is
// written as the file's own matched line, never the patch's. At tier 2
// every other line of N is re-indented: F is the leading spaces/tabs
// of the file's first matched line, P those of O's first line; a line
// of N that is not empty and not only whitespace, and starts with P,
// has that P replaced by F.
function buildReplacement(
  nLines: string[],
  nIsCtx: boolean[],
  nToO: (number | null)[],
  oLines: string[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWS(fileLines[pos]);
    p = leadingWS(oLines[0]);
  }
  for (let j = 0; j < nLines.length; j++) {
    if (nIsCtx[j]) {
      out.push(fileLines[pos + (nToO[j] as number)]);
    } else {
      let line = nLines[j];
      if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) {
        line = f + line.slice(p.length);
      }
      out.push(line);
    }
  }
  return out;
}

// Re-indent every line of N at tier 2 (formats without context lines).
function reindentAll(nLines: string[], fileFirst: string, oFirst: string, tier: number): string[] {
  if (tier !== 2) return nLines.slice();
  const f = leadingWS(fileFirst);
  const p = leadingWS(oFirst);
  return nLines.map((line) => {
    if (line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

// ---------- edits ----------

interface Hunk {
  a: number;
  oLines: string[];
  nLines: string[];
  oIsCtx: boolean[];
  nIsCtx: boolean[];
  oToN: (number | null)[];
  nToO: (number | null)[];
  plusLines: string[];
  noNL: boolean; // a \ line follows the hunk's last context or + line
  lastPlusNoNL: boolean; // a \ line follows the hunk's last + line
}

type UnifiedMode = 'create' | 'delete' | 'move' | 'change';

interface UnifiedEdit {
  format: 'unified';
  oldPath: string | null;
  newPath: string | null;
  mode: UnifiedMode;
  hunks: Hunk[];
}

interface SREdit {
  format: 'sr';
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  oLines: string[];
  nLines: string[];
  oIsCtx: boolean[];
  nIsCtx: boolean[];
  oToN: (number | null)[];
  nToO: (number | null)[];
}

interface V4AEdit {
  format: 'v4a';
  kind: 'add' | 'delete' | 'update';
  path: string;
  newPath: string | null;
  lines: string[];
  chunks: Chunk[];
}

interface JSONEdit {
  format: 'json';
  command: 'create' | 'str_replace' | 'insert';
  path: string;
  fileText: string;
  oldStr: string;
  newStr: string;
  insertLine: number;
}

type Edit = UnifiedEdit | SREdit | V4AEdit | JSONEdit;

// Convert raw body lines into O (context + - lines) and N (context +
// + lines), with the context maps: a context line of O and the same
// body line of N point at each other. Also the + lines alone, and the
// two \-line flags (a \ line refers to the body line before it).
function bodyToON(body: string[]): {
  oLines: string[];
  nLines: string[];
  oIsCtx: boolean[];
  nIsCtx: boolean[];
  oToN: (number | null)[];
  nToO: (number | null)[];
  plusLines: string[];
  noNL: boolean;
  lastPlusNoNL: boolean;
} {
  const oLines: string[] = [];
  const nLines: string[] = [];
  const oIsCtx: boolean[] = [];
  const nIsCtx: boolean[] = [];
  const oToN: (number | null)[] = [];
  const nToO: (number | null)[] = [];
  const plusLines: string[] = [];
  const kinds: ('ctx' | 'old' | 'new' | 'back')[] = [];
  for (const line of body) {
    const c = line === '' ? '' : line[0];
    if (c === ' ') {
      const t = line.slice(1);
      oLines.push(t);
      nLines.push(t);
      oIsCtx.push(true);
      nIsCtx.push(true);
      oToN.push(nLines.length - 1);
      nToO.push(oLines.length - 1);
      kinds.push('ctx');
    } else if (c === '-') {
      oLines.push(line.slice(1));
      oIsCtx.push(false);
      oToN.push(null);
      kinds.push('old');
    } else if (c === '+') {
      const t = line.slice(1);
      nLines.push(t);
      nIsCtx.push(false);
      nToO.push(null);
      plusLines.push(t);
      kinds.push('new');
    } else if (c === '\\') {
      kinds.push('back');
    } else {
      // An empty line is a context line whose text is empty.
      oLines.push('');
      nLines.push('');
      oIsCtx.push(true);
      nIsCtx.push(true);
      oToN.push(nLines.length - 1);
      nToO.push(oLines.length - 1);
      kinds.push('ctx');
    }
  }
  let noNL = false;
  let lastPlusNoNL = false;
  let lastCtxNew = -1;
  let lastNew = -1;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === 'ctx' || kinds[i] === 'new') lastCtxNew = i;
    if (kinds[i] === 'new') lastNew = i;
  }
  if (lastCtxNew >= 0 && kinds[lastCtxNew + 1] === 'back') noNL = true;
  if (lastNew >= 0 && kinds[lastNew + 1] === 'back') lastPlusNoNL = true;
  return { oLines, nLines, oIsCtx, nIsCtx, oToN, nToO, plusLines, noNL, lastPlusNoNL };
}

// ---------- unified diffs (SPEC.md section 6) ----------

// The path of a --- / +++ header line: the text after the four
// characters, up to the first tab, with surrounding spaces removed;
// /dev/null means no file; a leading a/ or b/ is removed.
function extractUnifiedPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0].trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return { a: Number(m[1]) };
}

function isBodyLine(line: string): boolean {
  if (line === '') return true;
  const c = line[0];
  return c === ' ' || c === '-' || c === '+' || c === '\\';
}

interface SectionDraft {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  diffOld: string | undefined;
  diffNew: string | undefined;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): UnifiedEdit[] {
  const sections: UnifiedEdit[] = [];
  let cur: SectionDraft | null = null;
  let curHunk: { a: number; body: string[] } | null = null;
  let state: 'out' | 'header' | 'section' | 'body' = 'out';

  const endBody = (): void => {
    if (curHunk === null || cur === null) return;
    const body = curHunk.body;
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const conv = bodyToON(body);
    cur.hunks.push({ a: curHunk.a, ...conv });
    curHunk = null;
  };

  const endSection = (): void => {
    endBody();
    if (cur !== null) {
      const oldP =
        cur.oldP !== undefined
          ? cur.oldP
          : cur.renameFrom !== null
            ? cur.renameFrom
            : cur.diffOld !== undefined
              ? cur.diffOld
              : null;
      const newP =
        cur.newP !== undefined
          ? cur.newP
          : cur.renameTo !== null
            ? cur.renameTo
            : cur.diffNew !== undefined
              ? cur.diffNew
              : null;
      let mode: UnifiedMode;
      if (oldP === null || cur.newFile) mode = 'create';
      else if (newP === null || cur.delFile) mode = 'delete';
      else if (oldP !== newP) mode = 'move';
      else mode = 'change';
      sections.push({ format: 'unified', oldPath: oldP, newPath: newP, mode, hunks: cur.hunks });
    }
    cur = null;
  };

  const newDraft = (): SectionDraft => ({
    oldP: undefined,
    newP: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    diffOld: undefined,
    diffNew: undefined,
    hunks: [],
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : null;

    if (state === 'body') {
      if (
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && next !== null && next.startsWith('+++ '))
      ) {
        endBody();
        state = 'section';
        // Fall through: this line starts something new.
      } else if (isBodyLine(line)) {
        (curHunk as { a: number; body: string[] }).body.push(line);
        continue;
      } else {
        endBody();
        state = 'section';
        // Fall through: this line is outside the body.
      }
    }

    if (state === 'section' || state === 'out') {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(stripTrailingWS(line));
        if (m === null) parseFail(i + 1);
        endSection();
        cur = newDraft();
        cur.diffOld = (m as RegExpExecArray)[1];
        cur.diffNew = (m as RegExpExecArray)[2];
        state = 'header';
        continue;
      }
      if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        endSection();
        cur = newDraft();
        cur.oldP = extractUnifiedPath(line);
        state = 'header';
        continue;
      }
      if (line.startsWith('@@')) {
        if (state === 'out') parseFail(i + 1);
        const h = parseHunkHeader(line);
        if (h === null) parseFail(i + 1);
        curHunk = { a: h.a, body: [] };
        state = 'body';
        continue;
      }
      continue; // prose, code fences, anything else outside a body
    }

    // state === 'header': inside a section, before its first hunk.
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(stripTrailingWS(line));
      if (m === null) parseFail(i + 1);
      endSection();
      cur = newDraft();
      cur.diffOld = (m as RegExpExecArray)[1];
      cur.diffNew = (m as RegExpExecArray)[2];
      state = 'header';
      continue;
    }
    if (line.startsWith('--- ')) {
      if (next === null || !next.startsWith('+++ ')) parseFail(i + 2);
      (cur as SectionDraft).oldP = extractUnifiedPath(line);
      continue;
    }
    if (line.startsWith('+++ ')) {
      (cur as SectionDraft).newP = extractUnifiedPath(line);
      continue;
    }
    if (line.startsWith('rename from ')) {
      if ((cur as SectionDraft).renameFrom === null) (cur as SectionDraft).renameFrom = line.slice(12).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      if ((cur as SectionDraft).renameTo === null) (cur as SectionDraft).renameTo = line.slice(10).trim();
      continue;
    }
    if (line.startsWith('new file mode')) {
      (cur as SectionDraft).newFile = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      (cur as SectionDraft).delFile = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line);
      if (h === null) parseFail(i + 1);
      curHunk = { a: h.a, body: [] };
      state = 'body';
      continue;
    }
    // index, old/new mode, similarity, dissimilarity, Index:, and any
    // other header line: ignored.
  }

  endSection();
  return sections;
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function parseSR(lines: string[]): SREdit[] {
  const edits: SREdit[] = [];
  let i = 0;
  let prevRep = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (stripTrailingWS(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    // The path is the nearest line before the SEARCH line, after the
    // previous block's REPLACE line (or the patch start), that is not
    // blank and, whitespace-trimmed, does not start with three
    // backticks; the path is that line whitespace-trimmed.
    let path: string | null = null;
    for (let j = s - 1; j > prevRep; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) parseFail(s + 1);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (stripTrailingWS(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) parseFail(s + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (stripTrailingWS(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) parseFail(s + 1);
    edits.push({
      format: 'sr',
      path: path as string,
      oldLines: lines.slice(s + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevRep = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC.md section 8) ----------

function isSectionStart(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function parseV4A(lines: string[]): V4AEdit[] {
  const n = lines.length;
  let f = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) {
      f = i;
      break;
    }
  }
  if (f === -1) parseFail(1);
  if (lines[f].trim() !== '*** Begin Patch') parseFail(f + 1);
  let l = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      l = i;
      break;
    }
  }
  if (lines[l].trim() !== '*** End Patch') parseFail(n + 1);

  const edits: V4AEdit[] = [];
  let i = f + 1;
  while (i < l) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const line = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      parseFail(i + 1);
    }
    const start = i;
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < l && !isSectionStart(lines[i])) {
      raw.push({ text: lines[i], idx: i });
      i++;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else parseFail(r.idx + 1);
      }
      edits.push({ format: 'v4a', kind: 'add', path, newPath: null, lines: fileLines, chunks: [] });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!isBlank(r.text)) parseFail(r.idx + 1);
      }
      edits.push({ format: 'v4a', kind: 'delete', path, newPath: null, lines: [], chunks: [] });
    } else {
      let newPath: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
        newPath = raw[0].text.slice(13).trim();
        j = 1;
      }
      const chunks: Chunk[] = [];
      let curChunk: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      const flush = (): void => {
        if (curChunk === null) return;
        const conv = bodyToON(curChunk.body);
        chunks.push({ anchor: curChunk.anchor, eof: curChunk.eof, ...conv });
        curChunk = null;
      };
      for (let k = j; k < raw.length; k++) {
        const { text, idx } = raw[k];
        if (text.startsWith('@@')) {
          flush();
          const anchorText = text.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
        } else if (text === '*** End of File') {
          if (curChunk === null) curChunk = { anchor: null, eof: false, body: [] };
          curChunk.eof = true;
          flush();
        } else if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
          if (curChunk === null) curChunk = { anchor: null, eof: false, body: [] };
          curChunk.body.push(text);
        } else {
          parseFail(idx + 1);
        }
      }
      flush();
      if (chunks.length === 0 && newPath === null) parseFail(start + 1);
      edits.push({ format: 'v4a', kind: 'update', path, newPath, lines: [], chunks });
    }
  }
  return edits;
}

// ---------- JSON edits (SPEC.md section 9) ----------

function validateEditObject(obj: unknown, lineNo: number): JSONEdit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) parseFail(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') parseFail(lineNo);
  if (typeof o.command !== 'string') parseFail(lineNo);
  const path = o.path as string;
  const command = o.command as string;
  if (command === 'create') {
    if (typeof o.file_text !== 'string') parseFail(lineNo);
    return {
      format: 'json',
      command: 'create',
      path,
      fileText: o.file_text as string,
      oldStr: '',
      newStr: '',
      insertLine: 0,
    };
  }
  if (command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') parseFail(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') parseFail(lineNo);
    return {
      format: 'json',
      command: 'str_replace',
      path,
      fileText: '',
      oldStr: o.old_str as string,
      newStr: (o.new_str as string | undefined) ?? '',
      insertLine: 0,
    };
  }
  if (command === 'insert') {
    if (!Number.isInteger(o.insert_line)) parseFail(lineNo);
    if (typeof o.new_str !== 'string') parseFail(lineNo);
    return {
      format: 'json',
      command: 'insert',
      path,
      fileText: '',
      oldStr: '',
      newStr: o.new_str as string,
      insertLine: o.insert_line as number,
    };
  }
  parseFail(lineNo);
}

function parseJSON(lines: string[], patchText: string): JSONEdit[] {
  let f = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      f = i;
      break;
    }
  }
  if (f === -1) parseFail(1);
  const firstChar = lines[f].trimStart()[0];
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      parseFail(f + 1);
    }
    if (!Array.isArray(arr)) parseFail(f + 1);
    if (arr.length === 0) parseFail(1);
    return (arr as unknown[]).map((o) => validateEditObject(o, f + 1));
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: JSONEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      parseFail(i + 1);
    }
    edits.push(validateEditObject(obj, i + 1));
  }
  if (edits.length === 0) parseFail(1);
  return edits;
}

// ---------- format detection (SPEC.md section 4) ----------

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName | null {
  let f = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      f = i;
      break;
    }
  }
  if (f === -1) return null;
  if (lines[f].trim() === '*** Begin Patch') return 'v4a';
  const firstChar = lines[f].trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const line of lines) {
    if (stripTrailingWS(line) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (
      lines[i].startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      return 'unified';
    }
  }
  return null;
}

// ---------- applying edits (SPEC.md section 10) ----------

// The tree is a map from path to the file's text. Edits apply to a
// clone of it; a failed edit is discarded, so it changes nothing, and
// the edits after it still run.
type Tree = Map<string, string>;

interface ApplyOk {
  ok: true;
  move: { old: string; new: string } | null;
}

interface ApplyFail {
  ok: false;
  code: string;
  path: string;
}

type ApplyResult = ApplyOk | ApplyFail;

function applyFail(code: string, path: string): ApplyFail {
  return { ok: false, code, path };
}

// Apply a section's hunks to a file's lines, in order. Returns the new
// lines and final-break flag, or a failure code.
function applyHunks(
  lines: string[],
  ends: boolean,
  hunks: Hunk[],
  strict: boolean,
): { lines: string[]; ends: boolean } | { fail: string } {
  let cur = lines.slice();
  let curEnds = ends;
  let d = 0;
  for (const h of hunks) {
    if (h.oLines.length > 0) {
      const found = findTier(h.oLines, cur, strict);
      if (found === null) return { fail: 'no-match' };
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(h.nLines, h.nIsCtx, h.nToO, h.oLines, cur, best, found.tier);
      const touchesEnd = best + h.oLines.length === cur.length;
      cur = [...cur.slice(0, best), ...repl, ...cur.slice(best + h.oLines.length)];
      if (touchesEnd) curEnds = !h.noNL;
      d += h.nLines.length - h.oLines.length;
    } else {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > cur.length) idx = cur.length;
      const repl = h.nLines.slice();
      const atEnd = idx === cur.length;
      cur = [...cur.slice(0, idx), ...repl, ...cur.slice(idx)];
      if (atEnd && repl.length > 0) curEnds = !h.noNL;
      d += h.nLines.length;
    }
  }
  return { lines: cur, ends: curEnds };
}

function applyUnified(model: Tree, edit: UnifiedEdit, strict: boolean): ApplyResult {
  const { oldPath, newPath, mode, hunks } = edit;
  if (mode === 'create') {
    if (newPath === null) return { ok: true, move: null };
    if (!isSafePath(newPath)) return applyFail('unsafe', newPath);
    if (model.has(newPath)) return applyFail('exists', newPath);
    const fileLines: string[] = [];
    let lastPlusNoNL = false;
    for (const h of hunks) {
      for (const l of h.plusLines) fileLines.push(l);
      if (h.plusLines.length > 0) lastPlusNoNL = h.lastPlusNoNL;
    }
    const text = fileLines.length === 0 ? '' : fileLines.join('\n') + (lastPlusNoNL ? '' : '\n');
    model.set(newPath, text);
    return { ok: true, move: null };
  }
  if (mode === 'delete') {
    if (oldPath === null) return { ok: true, move: null };
    if (!isSafePath(oldPath)) return applyFail('unsafe', oldPath);
    if (!model.has(oldPath)) return applyFail('missing', oldPath);
    model.delete(oldPath);
    return { ok: true, move: null };
  }
  // move or change: both paths named.
  const oldP = oldPath as string;
  const newP = newPath as string;
  if (!isSafePath(oldP)) return applyFail('unsafe', oldP);
  if (!isSafePath(newP)) return applyFail('unsafe', newP);
  if (!model.has(oldP)) return applyFail('missing', oldP);
  if (mode === 'move' && model.has(newP)) return applyFail('exists', newP);
  const { lines, br, ends } = parseFile(model.get(oldP) as string);
  const r = applyHunks(lines, ends, hunks, strict);
  if ('fail' in r) return applyFail(r.fail, oldP);
  const text = renderFile(r.lines, br, r.ends);
  if (mode === 'move') {
    model.delete(oldP);
    model.set(newP, text);
    return { ok: true, move: { old: oldP, new: newP } };
  }
  model.set(oldP, text);
  return { ok: true, move: null };
}

function applySR(model: Tree, edit: SREdit, strict: boolean): ApplyResult {
  const { path, oldLines, newLines } = edit;
  if (!isSafePath(path)) return applyFail('unsafe', path);
  if (oldLines.length === 0) {
    if (model.has(path)) return applyFail('exists', path);
    model.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    return { ok: true, move: null };
  }
  if (!model.has(path)) return applyFail('missing', path);
  const { lines, br, ends } = parseFile(model.get(path) as string);
  const found = findTier(oldLines, lines, strict);
  if (found === null) return applyFail('no-match', path);
  if (found.occ.length > 1) return applyFail('ambiguous', path);
  const pos = found.occ[0];
  const repl = reindentAll(newLines, lines[pos], oldLines[0], found.tier);
  const out = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oldLines.length)];
  model.set(path, renderFile(out, br, ends));
  return { ok: true, move: null };
}

function applyV4A(model: Tree, edit: V4AEdit, strict: boolean): ApplyResult {
  const { kind, path, newPath } = edit;
  if (kind === 'add') {
    if (!isSafePath(path)) return applyFail('unsafe', path);
    if (model.has(path)) return applyFail('exists', path);
    model.set(path, edit.lines.length === 0 ? '' : edit.lines.join('\n') + '\n');
    return { ok: true, move: null };
  }
  if (kind === 'delete') {
    if (!isSafePath(path)) return applyFail('unsafe', path);
    if (!model.has(path)) return applyFail('missing', path);
    model.delete(path);
    return { ok: true, move: null };
  }
  // update
  if (!isSafePath(path)) return applyFail('unsafe', path);
  if (newPath !== null && !isSafePath(newPath)) return applyFail('unsafe', newPath);
  if (!model.has(path)) return applyFail('missing', path);
  if (newPath !== null && model.has(newPath)) return applyFail('exists', newPath);
  const { lines, br, ends } = parseFile(model.get(path) as string);
  let cur = lines.slice();
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.anchor !== null) {
      const at = findSingle(ch.anchor, cur, cursor, strict);
      if (at === null) return applyFail('no-match', path);
      cursor = at + 1;
    }
    if (ch.oLines.length > 0) {
      const found = findTierFrom(ch.oLines, cur, cursor, strict);
      if (found === null) return applyFail('no-match', path);
      let pos: number;
      if (ch.eof) {
        const endOcc = found.occ.find((p) => p + ch.oLines.length === cur.length);
        if (endOcc === undefined) return applyFail('no-match', path);
        pos = endOcc;
      } else {
        pos = found.occ[0];
      }
      const repl = buildReplacement(ch.nLines, ch.nIsCtx, ch.nToO, ch.oLines, cur, pos, found.tier);
      cur = [...cur.slice(0, pos), ...repl, ...cur.slice(pos + ch.oLines.length)];
      cursor = pos + repl.length;
    } else {
      const idx = ch.eof ? cur.length : cursor;
      const repl = ch.nLines.slice();
      cur = [...cur.slice(0, idx), ...repl, ...cur.slice(idx)];
      cursor = idx + repl.length;
    }
  }
  const text = renderFile(cur, br, ends);
  if (newPath !== null) {
    model.delete(path);
    model.set(newPath, text);
    return { ok: true, move: { old: path, new: newPath } };
  }
  model.set(path, text);
  return { ok: true, move: null };
}

// new_str's lines: split at \n, one trailing \r removed each, no empty
// piece after a final \n; an empty new_str has none.
function splitNewStrLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function applyJSON(model: Tree, edit: JSONEdit): ApplyResult {
  const { command, path } = edit;
  if (!isSafePath(path)) return applyFail('unsafe', path);
  if (command === 'create') {
    if (model.has(path)) return applyFail('exists', path);
    model.set(path, edit.fileText);
    return { ok: true, move: null };
  }
  if (!model.has(path)) return applyFail('missing', path);
  if (command === 'str_replace') {
    const text = model.get(path) as string;
    const { br } = parseFile(text);
    let hay = text;
    let oldS = edit.oldStr;
    let newS = edit.newStr;
    if (br === '\r\n') {
      hay = text.replace(/\r\n/g, '\n');
      oldS = edit.oldStr.replace(/\r\n/g, '\n');
      newS = edit.newStr.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let first = -1;
    let pos = 0;
    for (;;) {
      const at = hay.indexOf(oldS, pos);
      if (at === -1) break;
      count++;
      if (count === 1) first = at;
      if (count > 1) break;
      pos = at + 1;
    }
    if (count === 0) return applyFail('no-match', path);
    if (count > 1) return applyFail('ambiguous', path);
    let result = hay.slice(0, first) + newS + hay.slice(first + oldS.length);
    if (br === '\r\n') result = result.replace(/\n/g, '\r\n');
    model.set(path, result);
    return { ok: true, move: null };
  }
  // insert
  const { lines, br, ends } = parseFile(model.get(path) as string);
  const il = edit.insertLine;
  if (il < 0 || il > lines.length) return applyFail('no-match', path);
  const newLines = splitNewStrLines(edit.newStr);
  const out = [...lines.slice(0, il), ...newLines, ...lines.slice(il)];
  model.set(path, renderFile(out, br, ends));
  return { ok: true, move: null };
}

function applyEdit(model: Tree, edit: Edit, strict: boolean): ApplyResult {
  if (edit.format === 'unified') return applyUnified(model, edit, strict);
  if (edit.format === 'sr') return applySR(model, edit, strict);
  if (edit.format === 'v4a') return applyV4A(model, edit, strict);
  return applyJSON(model, edit);
}

// ---------- the tree, the diff, the write ----------

// Every regular file under the working directory, paths relative to it
// with / separators, mapped to its text.
function snapshotTree(dir: string): Tree {
  const out: Tree = new Map();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${prefix}${name}/`);
      else if (st.isFile()) out.set(prefix + name, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

// The change lines of exit 0: one line per path whose state changed, in
// byte order of the paths (UTF-8). A move that succeeded replaces its
// pair's D and A lines with one R line, sorted by <new>.
function computeChangeLines(
  initial: Tree,
  model: Tree,
  moves: { old: string; new: string }[],
): string[] {
  const lines: { key: string; text: string }[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const m of moves) {
    if (initial.has(m.old) && !model.has(m.old) && !initial.has(m.new) && model.has(m.new)) {
      rOld.add(m.old);
      rNew.add(m.new);
      lines.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const p of new Set([...initial.keys(), ...model.keys()])) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const inI = initial.has(p);
    const inM = model.has(p);
    if (!inI && inM) lines.push({ key: p, text: `A ${p}` });
    else if (inI && !inM) lines.push({ key: p, text: `D ${p}` });
    else if (inI && inM && initial.get(p) !== model.get(p)) lines.push({ key: p, text: `M ${p}` });
  }
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

// Write the model over the working directory: delete first (a file
// that was a directory's parent, or a path being moved), then write
// every path whose bytes are new or changed.
function writeTree(initial: Tree, model: Tree): void {
  for (const p of initial.keys()) {
    if (!model.has(p)) {
      try {
        rmSync(p, { force: true });
      } catch {
        // The file is gone already; nothing to do.
      }
    }
  }
  for (const [p, text] of model) {
    if (initial.has(p) && initial.get(p) === text) continue;
    const dir = dirname(p);
    if (dir !== '.') mkdirSync(dir, { recursive: true });
    writeFileSync(p, text);
  }
}

// ---------- the command line (SPEC.md section 1) ----------

interface Args {
  format: FormatName | 'auto';
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Args | null {
  let format: FormatName | 'auto' | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positionals: string[] = [];
  let noMoreOptions = false;
  for (const arg of argv) {
    if (!noMoreOptions && arg === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = arg.slice(9);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: positionals[0] ?? null };
}

// ---------- the CLI ----------

function fail2(line: string): void {
  process.stdout.write(`${line}\n`);
  process.exitCode = 2;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    fail2('error: usage');
    return;
  }

  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      fail2('error: no-patch');
      return;
    }
  }

  const patchLines = splitPatchLines(patchText);

  let format: FormatName;
  if (args.format === 'auto') {
    const detected = detectFormat(patchLines);
    if (detected === null) {
      fail2('error: format');
      return;
    }
    format = detected;
  } else {
    format = args.format;
  }

  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(patchLines);
    else if (format === 'search-replace') edits = parseSR(patchLines);
    else if (format === 'v4a') edits = parseV4A(patchLines);
    else edits = parseJSON(patchLines, patchText);
  } catch (err) {
    if (err instanceof ParseError) {
      fail2(`error: parse ${err.line}`);
      return;
    }
    throw err;
  }
  if (edits.length === 0) {
    fail2('error: parse 1');
    return;
  }

  const initial = snapshotTree('.');
  let model: Tree = new Map(initial);
  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const edit of edits) {
    const trial = new Map(model);
    const r = applyEdit(trial, edit, args.strict);
    if (r.ok) {
      model = trial;
      if (r.move !== null) moves.push(r.move);
    } else {
      failures.push({ code: r.code, path: r.path });
    }
  }

  if (failures.length > 0) {
    const out: string[] = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(`${out.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const changeLines = computeChangeLines(initial, model, moves);
  const out = [...changeLines];
  out.push(changeLines.length === 1 ? 'ok: 1 file' : `ok: ${changeLines.length} files`);
  if (!args.check) writeTree(initial, model);
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = 0;
}

// ---------- entry ----------

// When MAKEFUN_ENV_URL is set the trial is handed over to runner.ts,
// which reads the checks from the env, runs node main.ts on each one
// in a fresh directory, and posts what it did. Otherwise this is the
// CLI.
async function entry(): Promise<void> {
  if (process.env.MAKEFUN_ENV_URL) {
    await runTrial(process.env.MAKEFUN_ENV_URL);
    return;
  }
  runCli();
}

entry().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
