// A conservative reading of a shell command line: which programs it would run, with which literal arguments and
// redirections. Nothing is executed or expanded. POSIX shells, PowerShell and cmd.exe are read well enough to find
// the programs; whatever cannot be read (an expansion naming the program, an unterminated quote, an encoded or
// inline script) is reported so the caller can fall back to keyword checks. No dependency on Acpira.

export type Dialect = 'posix' | 'ps' | 'cmd';

export interface Redirect {
  op: string;
  target: string;
}

export interface Command {
  // Literal words with quotes removed; argv[0] is the program as written (empty for a bare redirection)
  argv: string[];
  // argv[0] reduced to a lowercase basename without .exe / .cmd / .bat / .com / .ps1
  program: string;
  // The program word depends on an expansion ($VAR, $(...)), so what runs is unknown
  dynamic: boolean;
  redirects: Redirect[];
  // The words joined, for messages and keyword checks
  text: string;
  // The wrappers it was found inside (`bash -c`, `cmd /c`, `powershell -Command`, ...)
  via: string[];
  // The folder it runs in after the `cd` / `pushd` / `Set-Location` before it on the line: '' for the folder the line
  // started in, a path (relative to that folder, or absolute), or null when a change of folder could not be followed
  cwd: string | null;
}

// Thrown when reading runs past the caller's deadline
export class OutOfTime extends Error {
  constructor() {
    super('out of time');
  }
}

interface State {
  dir: string | null;
  stack: (string | null)[];
}

interface Reading {
  out: Analysis;
  deadline: number;
}

export interface Opaque {
  text: string;
  why: string;
}

export interface Analysis {
  commands: Command[];
  // Text that could not be read as commands (inline scripts, dynamic programs, encoded commands)
  opaque: Opaque[];
  // Reasons the reading is incomplete (unterminated quote, nesting too deep, ...); the caller then checks the whole
  // source text for keywords
  problems: string[];
}

interface Word {
  text: string;
  dynamic: boolean;
  quoted: boolean;
}

type Tok = { kind: 'word'; word: Word } | { kind: 'op'; op: string } | { kind: 'redir'; op: string };

interface Nested {
  src: string;
  dialect: Dialect;
  why: string;
}

const MAX_DEPTH = 6;
const MAX_LENGTH = 64 * 1024;
// Sticky patterns read at an index instead of on a copy of the rest of the line
const DOLLAR_NAME = /[A-Za-z_][A-Za-z0-9_]*(:[A-Za-z_][A-Za-z0-9_]*)?|[@*#?$!0-9-]/y;
const DUP_TARGET = /\d+|-/y;
const HEREDOC_START = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/y;

const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'coproc', '{', '}', 'function']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

export function programName(word: string): string {
  const p = word.replace(/\\/g, '/');
  return p
    .slice(p.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

// Lexing: words, operators and redirections, with $(...) / `...` / <(...) collected for a separate reading
class Lexer {
  i = 0;
  toks: Tok[] = [];
  nested: Nested[] = [];
  problems: string[] = [];
  // Heredoc bodies whose substitutions would run (unquoted delimiter)
  live: string[] = [];
  // Every heredoc body, for a shell that reads its script from input
  seen: string[] = [];
  private cur: Word | null = null;
  // Brace groups opened by a `{` read as an operator, and `{` kept inside the current word (`{a,b}`, `{}`)
  private groups = 0;
  private wordBraces = 0;
  private heredocs: { delim: string; strip: boolean; quoted: boolean }[] = [];
  private wantDelim: { strip: boolean } | null = null;

  constructor(
    readonly s: string,
    readonly d: Dialect,
  ) {}

  private add(ch: string, dynamic = false): void {
    this.cur ??= { text: '', dynamic: false, quoted: false };
    this.cur.text += ch;
    if (dynamic) this.cur.dynamic = true;
  }

  private mark(quoted: boolean): void {
    this.cur ??= { text: '', dynamic: false, quoted: false };
    if (quoted) this.cur.quoted = true;
  }

  private flush(): void {
    if (!this.cur) return;
    const w = this.cur;
    this.cur = null;
    this.wordBraces = 0;
    if (this.wantDelim) {
      this.heredocs.push({ delim: w.text, strip: this.wantDelim.strip, quoted: w.quoted });
      this.wantDelim = null;
    }
    this.toks.push({ kind: 'word', word: w });
  }

  private op(op: string): void {
    this.flush();
    this.toks.push({ kind: 'op', op });
  }

  private redir(op: string): void {
    // `2>` / `1>>`: the digits are the descriptor, not a word
    if (this.cur && !this.cur.quoted && !this.cur.dynamic && /^\d+$/.test(this.cur.text)) this.cur = null;
    this.flush();
    this.toks.push({ kind: 'redir', op });
  }

  run(): void {
    const { s, d } = this;
    while (this.i < s.length) {
      const c = s[this.i]!;
      const next = s[this.i + 1];
      if (c === ' ' || c === '\t' || c === '\r') {
        this.flush();
        this.i++;
        continue;
      }
      if (c === '\n') {
        this.op(';');
        this.i++;
        this.bodies();
        continue;
      }
      if (c === '#' && this.cur === null && d !== 'cmd') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === "'" && d !== 'cmd') {
        this.single();
        continue;
      }
      if (c === '"') {
        this.double();
        continue;
      }
      if (c === '\\' && d === 'posix') {
        if (next === undefined) {
          this.add('\\');
          this.i++;
        } else if (next === '\n') {
          this.i += 2;
        } else if (/[\s'"\\$`;&|<>(){}*?#~!]/.test(next)) {
          this.add(next);
          this.i += 2;
        } else {
          // A backslash before a plain character is kept: Windows paths (C:\Users\x) reach a POSIX reading too
          this.add('\\');
          this.i++;
        }
        continue;
      }
      if (c === '`' && d === 'ps') {
        if (next === '\n' || (next === '\r' && s[this.i + 2] === '\n')) this.i += next === '\n' ? 2 : 3;
        else if (next !== undefined) {
          this.add(next);
          this.i += 2;
        } else this.i++;
        continue;
      }
      if (c === '^' && d === 'cmd') {
        if (next !== undefined && next !== '\n') this.add(next);
        this.i += 2;
        continue;
      }
      if (c === '$' && d !== 'cmd') {
        this.dollar();
        continue;
      }
      if (c === '`' && d === 'posix') {
        this.backtick();
        continue;
      }
      if (c === '%' && d === 'cmd') {
        const end = s.indexOf('%', this.i + 1);
        if (end > this.i + 1 && /^[A-Za-z0-9_~:=,.-]+$/.test(s.slice(this.i + 1, end))) {
          this.add(s.slice(this.i, end + 1), true);
          this.i = end + 1;
        } else {
          this.add('%');
          this.i++;
        }
        continue;
      }
      if (c === '&') {
        if (next === '&') {
          this.op('&&');
          this.i += 2;
        } else if (next === '>' && d !== 'cmd') {
          const append = s[this.i + 2] === '>';
          this.redir(append ? '&>>' : '&>');
          this.i += append ? 3 : 2;
        } else {
          this.op('&');
          this.i++;
        }
        continue;
      }
      if (c === '|') {
        if (next === '|') {
          this.op('||');
          this.i += 2;
        } else if (next === '&') {
          this.op('|&');
          this.i += 2;
        } else {
          this.op('|');
          this.i++;
        }
        continue;
      }
      if (c === ';') {
        this.op(next === ';' ? ';;' : ';');
        this.i += next === ';' ? 2 : 1;
        continue;
      }
      if (c === '(' || c === ')') {
        this.op(c);
        this.i++;
        continue;
      }
      if (c === '{' || c === '}') {
        // PowerShell script blocks always split. A POSIX reading splits them too, because a PowerShell line read as
        // POSIX must not hide `{Remove-Item x}`: a `{` starting a word is a group unless the word is a brace expansion
        // (`{a,b}`, `{1..3}`) or find's `{}`, and a `}` closes a group opened that way (or stands alone)
        let split = d === 'ps';
        if (!split && c === '{') split = this.cur === null && !this.braceWord();
        if (!split && c === '}') split = this.wordBraces === 0 && (this.cur === null || this.groups > 0);
        if (split) {
          if (c === '{') this.groups++;
          else if (this.groups > 0) this.groups--;
          this.op(c);
          this.i++;
          continue;
        }
        if (c === '{') this.wordBraces++;
        else if (this.wordBraces > 0) this.wordBraces--;
      }
      if (c === '<' || c === '>') {
        this.angle();
        continue;
      }
      this.add(c);
      this.i++;
    }
    this.flush();
    if (this.heredocs.length) this.problems.push('unterminated heredoc');
  }

  // Whether the `{` here starts a brace expansion or `{}` rather than a group (looks at most 64 characters ahead)
  private braceWord(): boolean {
    const { s } = this;
    const limit = Math.min(s.length, this.i + 64);
    let depth = 0;
    for (let j = this.i + 1; j < limit; j++) {
      const c = s[j]!;
      if (' \t\r\n;|&<>()\'"'.includes(c)) return false;
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth > 0) {
          depth--;
          continue;
        }
        const body = s.slice(this.i + 1, j);
        return body === '' || body.includes(',') || body.includes('..');
      }
    }
    return false;
  }

  private single(): void {
    const { s } = this;
    this.mark(true);
    this.i++;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === "'") {
        if (this.d === 'ps' && s[this.i + 1] === "'") {
          this.add("'");
          this.i += 2;
          continue;
        }
        this.i++;
        return;
      }
      this.add(c);
      this.i++;
    }
    this.problems.push('unterminated single quote');
  }

  private double(): void {
    const { s, d } = this;
    this.mark(true);
    this.i++;
    while (this.i < s.length) {
      const c = s[this.i]!;
      const next = s[this.i + 1];
      if (c === '"') {
        if (d === 'ps' && next === '"') {
          this.add('"');
          this.i += 2;
          continue;
        }
        this.i++;
        return;
      }
      if (d === 'posix' && c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') this.add(next);
        this.i += 2;
        continue;
      }
      if (d === 'ps' && c === '`' && next !== undefined) {
        this.add(next);
        this.i += 2;
        continue;
      }
      if (c === '$' && d !== 'cmd') {
        this.dollar();
        continue;
      }
      if (c === '`' && d === 'posix') {
        this.backtick();
        continue;
      }
      if (c === '%' && d === 'cmd') {
        const end = s.indexOf('%', this.i + 1);
        if (end > this.i + 1 && /^[A-Za-z0-9_~:=,.-]+$/.test(s.slice(this.i + 1, end))) {
          this.add(s.slice(this.i, end + 1), true);
          this.i = end + 1;
          continue;
        }
      }
      this.add(c);
      this.i++;
    }
    this.problems.push('unterminated double quote');
  }

  // `$(...)`, `$((...))`, `${...}`, `$name`
  private dollar(): void {
    const { s } = this;
    const next = s[this.i + 1];
    if (next === '(') {
      const arith = s[this.i + 2] === '(';
      const end = matchParen(s, this.i + 1);
      if (end < 0) {
        this.problems.push('unterminated $(');
        this.add(s.slice(this.i), true);
        this.i = s.length;
        return;
      }
      const body = s.slice(this.i + 2, end);
      if (!arith) this.nested.push({ src: body, dialect: this.d === 'ps' ? 'ps' : 'posix', why: '$(...)' });
      this.add(s.slice(this.i, end + 1), true);
      this.i = end + 1;
      return;
    }
    if (next === '{') {
      const end = s.indexOf('}', this.i + 2);
      if (end < 0) {
        this.problems.push('unterminated ${');
        this.add(s.slice(this.i), true);
        this.i = s.length;
        return;
      }
      this.add(s.slice(this.i, end + 1), true);
      this.i = end + 1;
      return;
    }
    DOLLAR_NAME.lastIndex = this.i + 1;
    const name = DOLLAR_NAME.exec(s);
    if (name) {
      this.add(s.slice(this.i, this.i + 1 + name[0].length), true);
      this.i += 1 + name[0].length;
      return;
    }
    this.add('$');
    this.i++;
  }

  private backtick(): void {
    const { s } = this;
    let j = this.i + 1;
    let body = '';
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\' && s[j + 1] === '`') {
        body += '`';
        j += 2;
        continue;
      }
      body += s[j];
      j++;
    }
    if (j >= s.length) {
      this.problems.push('unterminated backtick');
      this.add(s.slice(this.i), true);
      this.i = s.length;
      return;
    }
    this.nested.push({ src: body, dialect: 'posix', why: '`...`' });
    this.add(s.slice(this.i, j + 1), true);
    this.i = j + 1;
  }

  private angle(): void {
    const { s, d } = this;
    const c = s[this.i]!;
    const next = s[this.i + 1];
    // Process substitution <(...) / >(...)
    if (d === 'posix' && next === '(') {
      const end = matchParen(s, this.i + 1);
      if (end < 0) {
        this.problems.push('unterminated process substitution');
        this.i = s.length;
        return;
      }
      this.nested.push({ src: s.slice(this.i + 2, end), dialect: 'posix', why: `${c}(...)` });
      this.add(s.slice(this.i, end + 1), true);
      this.i = end + 1;
      return;
    }
    if (c === '<') {
      if (next === '<' && d === 'posix') {
        if (s[this.i + 2] === '<') {
          // A here-string: the word is data
          this.redir('<<<');
          this.i += 3;
          return;
        }
        const strip = s[this.i + 2] === '-';
        this.redir('<<');
        this.i += strip ? 3 : 2;
        this.wantDelim = { strip };
        return;
      }
      this.redir(next === '>' ? '<>' : '<');
      this.i += next === '>' ? 2 : 1;
      return;
    }
    // `>&2`, `2>&1`, `>&-`: a descriptor copy, no file
    if (next === '&') {
      DUP_TARGET.lastIndex = this.i + 2;
      const m = DUP_TARGET.exec(s);
      if (m) {
        if (this.cur && !this.cur.quoted && /^\d+$/.test(this.cur.text)) this.cur = null;
        this.flush();
        this.i += 2 + m[0].length;
        return;
      }
      this.redir('>&');
      this.i += 2;
      return;
    }
    if (next === '>') {
      this.redir('>>');
      this.i += 2;
      return;
    }
    if (next === '|') {
      this.redir('>|');
      this.i += 2;
      return;
    }
    this.redir('>');
    this.i++;
  }

  // After a newline: the bodies of the heredocs opened on the line just ended
  private bodies(): void {
    const { s } = this;
    while (this.heredocs.length) {
      const h = this.heredocs.shift()!;
      let body = '';
      let found = false;
      while (this.i < s.length) {
        let end = s.indexOf('\n', this.i);
        if (end < 0) end = s.length;
        const raw = s.slice(this.i, end).replace(/\r$/, '');
        this.i = Math.min(end + 1, s.length);
        const line = h.strip ? raw.replace(/^\t+/, '') : raw;
        if (line === h.delim) {
          found = true;
          break;
        }
        body += raw + '\n';
      }
      if (!found) {
        this.problems.push('unterminated heredoc');
        this.heredocs = [];
      }
      this.seen.push(body);
      if (!h.quoted && /\$\(|`/.test(body)) this.live.push(body);
    }
  }
}

// The index of the `)` closing the `(` at `open`, skipping quotes and nested parentheses; -1 when there is none
function matchParen(s: string, open: number): number {
  let depth = 0;
  // Heredocs opened on the current line: their bodies (a commit message in `$(cat <<'EOF' ... EOF)`) are data
  const pending: { delim: string; strip: boolean }[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\n' && pending.length) {
      let j = i + 1;
      while (pending.length) {
        const h = pending.shift()!;
        for (;;) {
          if (j >= s.length) return -1;
          let end = s.indexOf('\n', j);
          if (end < 0) end = s.length;
          const raw = s.slice(j, end).replace(/\r$/, '');
          j = end + 1;
          if ((h.strip ? raw.replace(/^\t+/, '') : raw) === h.delim) break;
        }
      }
      i = j - 1;
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      HEREDOC_START.lastIndex = i;
      const m = HEREDOC_START.exec(s);
      if (m) {
        pending.push({ delim: m[2] ?? m[3] ?? m[4] ?? '', strip: m[1] === '-' });
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return -1;
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Segment {
  words: Word[];
  redirects: { op: string; target: Word | null }[];
}

function segments(toks: Tok[]): Segment[] {
  const out: Segment[] = [];
  let seg: Segment = { words: [], redirects: [] };
  let pending: { op: string; target: Word | null } | null = null;
  const end = () => {
    if (seg.words.length || seg.redirects.length) out.push(seg);
    seg = { words: [], redirects: [] };
    pending = null;
  };
  for (const t of toks) {
    if (t.kind === 'op') end();
    else if (t.kind === 'redir') {
      pending = { op: t.op, target: null };
      seg.redirects.push(pending);
    } else if (pending) {
      pending.target = t.word;
      pending = null;
    } else seg.words.push(t.word);
  }
  end();
  return out;
}

const lit = (text: string): Word => ({ text, dynamic: false, quoted: false });

// `deadline` (a Date.now() value): past it the reading stops with OutOfTime
export function analyze(src: string, dialect: Dialect = 'posix', deadline = Infinity): Analysis {
  const out: Analysis = { commands: [], opaque: [], problems: [] };
  read(src, dialect, 0, [], { out, deadline }, { dir: '', stack: [] });
  return out;
}

function tick(r: Reading): void {
  if (r.deadline !== Infinity && Date.now() > r.deadline) throw new OutOfTime();
}

const copy = (st: State): State => ({ dir: st.dir, stack: [...st.stack] });

function read(src: string, dialect: Dialect, depth: number, via: string[], r: Reading, st: State): void {
  const { out } = r;
  tick(r);
  if (depth > MAX_DEPTH) {
    out.problems.push('nested too deeply');
    out.opaque.push({ text: src, why: 'nested too deeply' });
    return;
  }
  if (src.length > MAX_LENGTH) {
    out.problems.push('command too long');
    return;
  }
  const lx = new Lexer(src, dialect);
  lx.run();
  out.problems.push(...lx.problems);
  for (const body of lx.live) out.opaque.push({ text: body, why: 'heredoc with substitutions' });
  const segs = segments(lx.toks);
  // A substitution runs in a subshell and its `cd` does not carry over; it is read before the line's commands, so
  // when the line changes folder the substitution's folder is not known
  const moves = segs.some(seg => seg.words.some(w => CD.has(programName(w.text)) || POPD.has(programName(w.text))));
  for (const n of lx.nested) read(n.src, n.dialect, depth + 1, [...via, n.why], r, moves ? { dir: null, stack: [] } : copy(st));
  const before = out.commands.length;
  for (const seg of segs) {
    tick(r);
    expand(seg.words, seg.redirects, dialect, depth, via, r, st);
  }
  // A shell or interpreter run without an inline script reads it from a file or its input (`curl … | sh`,
  // `sh <<EOF`), which cannot be read here: the whole line and the heredoc bodies go to the keyword checks
  if (out.commands.slice(before).some(c => c.via.length === via.length && SCRIPT_READERS.has(interpreter(c.program)))) {
    out.opaque.push({ text: src, why: 'a shell reads its script from elsewhere' });
    for (const b of lx.seen) out.opaque.push({ text: b, why: 'heredoc read by a shell' });
  }
}

const SCRIPT_READERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'python', 'pypy', 'py', 'node', 'perl', 'ruby', 'php', 'lua', 'pwsh', 'powershell', 'cmd', 'source', '.']);

const joined = (ws: Word[]) => ws.map(w => w.text).join(' ');

// Flags of a wrapper that take a value as the next word
const VALUE_FLAGS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--chdir', '--prompt'],
  doas: ['-u', '-C'],
  env: ['-u', '--unset', '-C', '--chdir'],
  exec: ['-a'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '--class', '--classdata'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: ['-I', '-L', '-l', '-n', '-P', '-s', '-d', '-E', '-e', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--replace', '--eof', '--max-chars'],
  npx: ['-p', '--package'],
  watch: ['-n', '--interval', '-q', '--equexit'],
  ssh: ['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-E', '-b', '-c', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I'],
  wsl: ['-d', '--distribution', '-u', '--user', '--cd', '--shell-type'],
  su: ['-s', '--shell', '-g', '--group'],
};

const UV_VALUE_FLAGS = ['--with', '-w', '--python', '-p', '--project', '--directory', '--package', '--env-file', '--from', '--spec', '--index', '--extra', '--group', '-e', '--environment'];

const PS_VALUE_FLAGS = new Set([
  '-executionpolicy', '-ep', '-ex', '-exec', '-windowstyle', '-w', '-win', '-version', '-v', '-inputformat', '-if', '-inp',
  '-outputformat', '-of', '-o', '-out', '-configurationname', '-config', '-workingdirectory', '-wd', '-settingsfile',
  '-psconsolefile', '-custompipename', '-encodedarguments', '-ea',
]);

// Skip a wrapper's own flags; returns the index of its first operand
function skipFlags(ws: Word[], from: number, values: string[] = [], stopAtDashDash = true): number {
  let i = from;
  while (i < ws.length) {
    const t = ws[i]!.text;
    if (t === '--' && stopAtDashDash) return i + 1;
    if (!t.startsWith('-') || t === '-') return i;
    const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
    i += values.includes(name) && !t.includes('=') ? 2 : 1;
  }
  return i;
}

function prefixOf(flag: string, full: string, min: number): boolean {
  return flag.length >= min && full.startsWith(flag);
}

function decodeUtf16(b64: string): string | null {
  try {
    const bin = atob(b64.replace(/\s/g, ''));
    let s = '';
    for (let i = 0; i + 1 < bin.length; i += 2) s += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8));
    return s;
  } catch {
    return null;
  }
}

const INLINE_FLAGS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  python: ['-c'],
  python3: ['-c'],
  python2: ['-c'],
  py: ['-c'],
  pypy: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  osascript: ['-e'],
  lua: ['-e'],
  rscript: ['-e'],
};

// Versioned interpreter names under their family: python3.12, pythonw, nodejs, ruby3.2, perl5.36
export function interpreter(program: string): string {
  if (/^python(\d+(\.\d+)*)?w?$/.test(program)) return 'python';
  if (/^pypy\d*(\.\d+)*$/.test(program)) return 'pypy';
  if (/^node(js)?\d*$/.test(program)) return 'node';
  if (/^ruby\d*(\.\d+)*$/.test(program)) return 'ruby';
  if (/^perl\d*(\.\d+)*$/.test(program)) return 'perl';
  if (/^php\d*(\.\d+)*$/.test(program)) return 'php';
  if (/^lua\d*(\.\d+)*$/.test(program)) return 'lua';
  return program;
}

// The folder commands change to (`cd`, `chdir`, `pushd`, `Set-Location`, `Push-Location`) and back from
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const POPD = new Set(['popd', 'pop-location']);
const ABSOLUTE = /^(\/|~|[A-Za-z]:|\\\\)/;

function changeDir(cmd: Command, words: Word[], dialect: Dialect, st: State): void {
  const p = cmd.program;
  if (POPD.has(p)) {
    st.dir = st.stack.length ? st.stack.pop()! : null;
    return;
  }
  if (!CD.has(p)) return;
  let target: Word | undefined;
  let count = 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text.toLowerCase();
    if (!w.quoted && ['-path', '-literalpath', '-lp', '-pspath'].includes(t)) {
      target = words[++i];
      count++;
      continue;
    }
    // `cd -L` / `-P` / `-e`, `cd /d` (cmd.exe), Set-Location's switches
    if (!w.quoted && ['-l', '-p', '-e', '/d', '--', '-stackname', '-passthru'].includes(t)) {
      if (t === '-stackname') i++;
      continue;
    }
    target ??= w;
    count++;
  }
  const from = st.dir;
  if (p === 'pushd' || p === 'push-location') st.stack.push(from);
  if (count > 1 || (target && (target.dynamic || target.text === '-'))) {
    st.dir = null;
    return;
  }
  // `cd` alone: home in a POSIX shell and PowerShell 7, no change in cmd.exe
  const to = target ? target.text.replace(/\\/g, '/') : dialect === 'cmd' ? '' : '~';
  if (!target && dialect === 'cmd') return;
  if (ABSOLUTE.test(to)) st.dir = to;
  else if (from === null) st.dir = null;
  else st.dir = from ? `${from}/${to}` : to;
}

function expand(input: Word[], redirs: Segment['redirects'], dialect: Dialect, depth: number, via: string[], r: Reading, st: State): void {
  const { out } = r;
  // find -exec inside find -exec: as deep as read() allows
  if (depth > MAX_DEPTH) {
    out.problems.push('nested too deeply');
    out.opaque.push({ text: joined(input), why: 'nested too deeply' });
    return;
  }
  let ws = input.slice();
  while (ws.length && !ws[0]!.quoted && RESERVED.has(ws[0]!.text)) ws.shift();
  // `for x in ...` / `case $x in` / `select`: the words are data
  if (ws.length && !ws[0]!.quoted && ['for', 'case', 'select', 'esac', 'in'].includes(ws[0]!.text)) ws = [];
  // `FOO=1 BAR="a b" cmd` (a quoted value marks the word quoted; a quoted name is too rare to tell apart)
  if (dialect !== 'cmd') while (ws.length && ASSIGNMENT.test(ws[0]!.text)) ws.shift();
  const redirects = redirs.flatMap(r => (r.target ? [{ op: r.op, target: r.target.text }] : []));
  const sub = (src: string, d: Dialect, why: string) => read(src, d, depth + 1, [...via, why], r, copy(st));
  const emit = (words: Word[]) => {
    const argv = words.map(w => w.text);
    const first = words[0];
    const cmd: Command = { argv, program: first ? programName(first.text) : '', dynamic: !!first?.dynamic, redirects, text: argv.join(' '), via, cwd: st.dir };
    out.commands.push(cmd);
    changeDir(cmd, words, dialect, st);
    if (cmd.dynamic) out.opaque.push({ text: cmd.text, why: 'the program is an expansion' });
    // find -exec / -execdir / -ok: the words up to `;` or `+` are a command of their own
    if (cmd.program === 'find') {
      for (let i = 1; i < words.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[i]!.text)) continue;
        let j = i + 1;
        while (j < words.length && words[j]!.text !== ';' && words[j]!.text !== '+') j++;
        expand(words.slice(i + 1, j), [], dialect, depth + 1, [...via, 'find -exec'], r, copy(st));
        i = j;
      }
    }
    // Inline code given to an interpreter is read for keywords only
    const inline = INLINE_FLAGS[interpreter(cmd.program)];
    if (inline) {
      for (let i = 1; i < words.length; i++) {
        const t = words[i]!.text;
        let code: string | undefined;
        for (const f of inline) {
          if (t === f) code = words[i + 1]?.text;
          else if (f.startsWith('--') && t.startsWith(`${f}=`)) code = t.slice(f.length + 1);
          // A cluster ending in the flag (`perl -le 'code'`)
          else if (/^-[A-Za-z]$/.test(f) && /^-[A-Za-z]+$/.test(t) && t.endsWith(f.slice(1))) code = words[i + 1]?.text;
          if (code !== undefined) break;
        }
        if (code === undefined) continue;
        if (code) out.opaque.push({ text: code, why: `${cmd.program} inline code` });
        break;
      }
    }
  };

  for (let guard = 0; ws.length; guard++) {
    // `sudo sudo sudo … rm x`: past this many wrappers the rest is left to the keyword checks
    if (guard >= 16) {
      out.problems.push('wrapped too deeply');
      out.opaque.push({ text: joined(ws), why: 'wrapped too deeply' });
      break;
    }
    const head = ws[0]!;
    if (head.dynamic) break;
    const prog = programName(head.text);
    const rest = ws.slice(1);
    switch (prog) {
      case 'sudo':
      case 'doas':
      case 'nice':
      case 'ionice':
      case 'stdbuf':
      case 'nohup':
      case 'setsid':
      case 'unbuffer':
      case 'chronic':
      case 'time':
      case 'exec': {
        ws = ws.slice(skipFlags(ws, 1, VALUE_FLAGS[prog]));
        continue;
      }
      case 'timeout':
      case 'gtimeout': {
        const i = skipFlags(ws, 1, VALUE_FLAGS.timeout);
        ws = ws.slice(i + 1);
        continue;
      }
      case 'command':
      case 'builtin': {
        if (rest.some(w => w.text === '-v' || w.text === '-V')) return emit(ws);
        ws = ws.slice(skipFlags(ws, 1));
        continue;
      }
      case 'env': {
        let i = 1;
        for (; i < ws.length; i++) {
          const t = ws[i]!.text;
          if (t === '-S' || t === '--split-string' || t.startsWith('--split-string=') || (t.startsWith('-S') && t.length > 2)) {
            const script = t === '-S' || t === '--split-string' ? ws[i + 1]?.text : t.startsWith('-S') ? t.slice(2) : t.slice(t.indexOf('=') + 1);
            if (script) sub(script, 'posix', 'env -S');
            return;
          }
          if (t === '--') {
            i++;
            break;
          }
          if (t.startsWith('-')) {
            if ((VALUE_FLAGS.env ?? []).includes(t)) i++;
            continue;
          }
          if (ASSIGNMENT.test(t)) continue;
          break;
        }
        ws = ws.slice(i);
        continue;
      }
      case 'xargs': {
        ws = ws.slice(skipFlags(ws, 1, VALUE_FLAGS.xargs));
        continue;
      }
      case 'parallel': {
        const stop = ws.findIndex(w => w.text === ':::' || w.text === '::::');
        ws = ws.slice(skipFlags(ws, 1), stop < 0 ? undefined : stop);
        continue;
      }
      case 'npx':
      case 'bunx':
      case 'pnpx': {
        for (let i = 1; i < ws.length; i++) {
          const t = ws[i]!.text;
          if (t === '-c' || t === '--call') {
            const script = ws[i + 1]?.text;
            if (script) sub(script, 'posix', `${prog} -c`);
            return;
          }
        }
        ws = ws.slice(skipFlags(ws, 1, VALUE_FLAGS.npx));
        continue;
      }
      // `busybox rm x`, `toybox rm x`: the applet is the program
      case 'busybox':
      case 'toybox': {
        if (!rest.length || rest[0]!.text.startsWith('-')) return emit(ws);
        ws = rest;
        continue;
      }
      // `trap 'rm -rf dist' EXIT`: the action runs later in this shell
      case 'trap': {
        const action = rest.find(w => !w.text.startsWith('-'));
        if (action && action.text !== '' && action.text !== '-') sub(action.text, dialect === 'cmd' ? 'posix' : dialect, 'trap');
        return emit(ws);
      }
      // Python runners: `uv run python -c …`, `uvx tool`, `poetry run …`, `pipenv run …`, `pdm run …`, `hatch run …`
      case 'uv': {
        if (rest[0]?.text !== 'run' && rest[0]?.text !== 'tool') return emit(ws);
        const from = rest[0]?.text === 'tool' ? (rest[1]?.text === 'run' ? 3 : -1) : 2;
        if (from < 0) return emit(ws);
        ws = ws.slice(skipFlags(ws, from, UV_VALUE_FLAGS));
        continue;
      }
      case 'uvx':
      case 'pipx': {
        if (prog === 'pipx' && rest[0]?.text !== 'run') return emit(ws);
        ws = ws.slice(skipFlags(ws, prog === 'pipx' ? 2 : 1, UV_VALUE_FLAGS));
        continue;
      }
      case 'poetry':
      case 'pipenv':
      case 'pdm':
      case 'hatch':
      case 'rye': {
        if (rest[0]?.text !== 'run') return emit(ws);
        ws = ws.slice(skipFlags(ws, 2, UV_VALUE_FLAGS));
        continue;
      }
      case 'npm':
      case 'pnpm':
      case 'yarn':
      case 'bun': {
        const verb = rest[0]?.text;
        if (verb === 'exec' || verb === 'dlx' || verb === 'x') {
          ws = ws.slice(skipFlags(ws, 2, VALUE_FLAGS.npx));
          continue;
        }
        return emit(ws);
      }
      case 'sh':
      case 'bash':
      case 'zsh':
      case 'dash':
      case 'ksh':
      case 'mksh':
      case 'ash':
      case 'fish': {
        for (let i = 1; i < ws.length; i++) {
          const t = ws[i]!.text;
          if (t === '-o' || t === '+o' || t === '-O' || t === '+O' || t === '--rcfile' || t === '--init-file') {
            i++;
            continue;
          }
          if (/^\+[A-Za-z]+$/.test(t)) continue;
          if (t === '--command' || t === '-c' || (/^-[A-Za-z]+$/.test(t) && t.includes('c'))) {
            const script = ws[i + 1];
            if (!script) return emit(ws);
            if (script.dynamic) out.opaque.push({ text: script.text, why: `${prog} -c with an expansion` });
            sub(script.text, 'posix', `${prog} -c`);
            return;
          }
          if (t.startsWith('--command=')) {
            sub(t.slice('--command='.length), 'posix', `${prog} -c`);
            return;
          }
          if (!t.startsWith('-')) break;
        }
        return emit(ws);
      }
      case 'cmd': {
        for (let i = 1; i < ws.length; i++) {
          const t = ws[i]!.text;
          const m = /^\/[ck](.*)$/is.exec(t);
          if (m) {
            const script = [m[1] ?? '', joined(ws.slice(i + 1))].filter(Boolean).join(' ');
            sub(script, 'cmd', 'cmd /c');
            return;
          }
          if (!t.startsWith('/')) break;
        }
        return emit(ws);
      }
      case 'powershell':
      case 'pwsh':
      case 'powershell_ise': {
        for (let i = 1; i < ws.length; i++) {
          const t = ws[i]!.text.toLowerCase();
          const flag = t.startsWith('/') ? `-${t.slice(1)}` : t;
          if (prefixOf(flag, '-command', 2) || prefixOf(flag, '-commandwithargs', 9) || flag === '-cwa') {
            const script = ws.slice(i + 1);
            if (script.length === 1 && script[0]!.text === '-') return emit(ws);
            sub(joined(script), 'ps', `${prog} -Command`);
            return;
          }
          if (prefixOf(flag, '-encodedcommand', 2) || flag === '-ec') {
            const b64 = ws[i + 1]?.text ?? '';
            const script = decodeUtf16(b64);
            if (script === null) out.opaque.push({ text: b64, why: 'undecodable -EncodedCommand' });
            else sub(script, 'ps', `${prog} -EncodedCommand`);
            return;
          }
          if (prefixOf(flag, '-file', 2)) return emit(ws);
          if (flag.startsWith('-')) {
            if (PS_VALUE_FLAGS.has(flag)) i++;
            continue;
          }
          // Windows PowerShell reads the first operand and the rest as the command
          sub(joined(ws.slice(i)), 'ps', prog);
          return;
        }
        return emit(ws);
      }
      case 'eval': {
        if (rest.some(w => w.dynamic)) out.opaque.push({ text: joined(rest), why: 'eval with an expansion' });
        sub(joined(rest), 'posix', 'eval');
        return;
      }
      case 'iex':
      case 'invoke-expression': {
        const args = rest.filter(w => !/^-command$/i.test(w.text));
        if (args.some(w => w.dynamic)) out.opaque.push({ text: joined(args), why: 'Invoke-Expression with an expansion' });
        sub(joined(args), 'ps', 'Invoke-Expression');
        return;
      }
      case 'start':
      case 'start-process':
      case 'saps': {
        if (dialect === 'cmd' && prog === 'start') {
          let i = 1;
          if (ws[i]?.quoted) i++;
          while (i < ws.length && ws[i]!.text.startsWith('/')) i += /^\/d$/i.test(ws[i]!.text) ? 2 : 1;
          ws = ws.slice(i);
          continue;
        }
        let file: Word | undefined;
        const args: Word[] = [];
        for (let i = 1; i < ws.length; i++) {
          const w = ws[i]!;
          const t = w.text.toLowerCase();
          if (prefixOf(t, '-filepath', 2) || t === '-path') file = ws[++i];
          else if (prefixOf(t, '-argumentlist', 2) || t === '-args') {
            const v = ws[++i];
            if (v) args.push(...v.text.split(',').flatMap(a => splitWords(a)).map(lit));
          } else if (t.startsWith('-')) {
            if (['-workingdirectory', '-verb', '-windowstyle', '-redirectstandardoutput', '-redirectstandardinput', '-redirectstandarderror', '-credential'].includes(t)) i++;
          } else if (!file) file = w;
          else args.push(...w.text.split(',').flatMap(a => splitWords(a)).map(lit));
        }
        if (!file) return emit(ws);
        ws = [file, ...args];
        continue;
      }
      case 'call': {
        if (dialect === 'cmd') {
          ws = rest;
          continue;
        }
        return emit(ws);
      }
      case 'wsl': {
        let exec = -1;
        for (let i = 1; i < ws.length; i++) {
          const t = ws[i]!.text;
          if (t === '-e' || t === '--exec') {
            exec = i + 1;
            break;
          }
          if (t === '--') {
            sub(joined(ws.slice(i + 1)), 'posix', 'wsl');
            return;
          }
          if (!t.startsWith('-')) {
            sub(joined(ws.slice(i)), 'posix', 'wsl');
            return;
          }
          if ((VALUE_FLAGS.wsl ?? []).includes(t)) i++;
        }
        if (exec < 0) return emit(ws);
        ws = ws.slice(exec);
        continue;
      }
      case 'ssh': {
        const host = skipFlags(ws, 1, VALUE_FLAGS.ssh);
        const remote = ws.slice(host + 1);
        if (remote.length) sub(joined(remote), 'posix', 'ssh');
        return emit(ws.slice(0, host + 1));
      }
      case 'su': {
        for (let i = 1; i < ws.length; i++) {
          const t = ws[i]!.text;
          if (t === '-c' || t === '--command') {
            const script = ws[i + 1]?.text;
            if (script) sub(script, 'posix', 'su -c');
            return;
          }
        }
        return emit(ws);
      }
      case 'watch': {
        const i = skipFlags(ws, 1, VALUE_FLAGS.watch);
        sub(joined(ws.slice(i)), 'posix', 'watch');
        return;
      }
      case 'alias': {
        // `alias p='git push'`: the value is what later runs under that name
        for (const w of rest) {
          const eq = w.text.indexOf('=');
          if (eq > 0) sub(w.text.slice(eq + 1), dialect, 'alias');
        }
        return emit(ws);
      }
      default:
        return emit(ws);
    }
  }
  if (ws.length) emit(ws);
  else if (redirects.length) emit([]);
}

// Split a plain string on whitespace, honouring simple quotes (for Start-Process -ArgumentList and argv arrays)
export function splitWords(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

// An argv array as one POSIX command line, quoting where needed, so it reads back as the same words
export function quoteArgv(argv: string[]): string {
  return argv.map(a => (a !== '' && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}
