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
        // PowerShell script blocks always split; in a POSIX shell a brace groups only as a word of its own
        const alone = this.cur === null && (c === '}' || next === undefined || /\s/.test(next));
        if (d === 'ps' || alone) {
          this.op(c);
          this.i++;
          continue;
        }
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
    const name = /^[A-Za-z_][A-Za-z0-9_]*(:[A-Za-z_][A-Za-z0-9_]*)?|^[@*#?$!0-9-]/.exec(s.slice(this.i + 1));
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
      const m = /^(\d+|-)/.exec(s.slice(this.i + 2));
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
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(s.slice(i));
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

export function analyze(src: string, dialect: Dialect = 'posix'): Analysis {
  const out: Analysis = { commands: [], opaque: [], problems: [] };
  read(src, dialect, 0, [], out);
  return out;
}

function read(src: string, dialect: Dialect, depth: number, via: string[], out: Analysis): void {
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
  for (const n of lx.nested) read(n.src, n.dialect, depth + 1, [...via, n.why], out);
  const before = out.commands.length;
  for (const seg of segments(lx.toks)) expand(seg.words, seg.redirects, dialect, depth, via, out);
  // A shell or interpreter run without an inline script reads it from a file or its input (`curl … | sh`,
  // `sh <<EOF`), which cannot be read here: the whole line and the heredoc bodies go to the keyword checks
  if (out.commands.slice(before).some(c => c.via.length === via.length && SCRIPT_READERS.has(c.program))) {
    out.opaque.push({ text: src, why: 'a shell reads its script from elsewhere' });
    for (const b of lx.seen) out.opaque.push({ text: b, why: 'heredoc read by a shell' });
  }
}

const SCRIPT_READERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'python', 'python3', 'py', 'node', 'perl', 'ruby', 'pwsh', 'powershell', 'cmd', 'source', '.']);

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
};

function expand(input: Word[], redirs: Segment['redirects'], dialect: Dialect, depth: number, via: string[], out: Analysis): void {
  let ws = input.slice();
  while (ws.length && !ws[0]!.quoted && RESERVED.has(ws[0]!.text)) ws.shift();
  // `for x in ...` / `case $x in` / `select`: the words are data
  if (ws.length && !ws[0]!.quoted && ['for', 'case', 'select', 'esac', 'in'].includes(ws[0]!.text)) ws = [];
  // `FOO=1 BAR="a b" cmd` (a quoted value marks the word quoted; a quoted name is too rare to tell apart)
  if (dialect !== 'cmd') while (ws.length && ASSIGNMENT.test(ws[0]!.text)) ws.shift();
  const redirects = redirs.flatMap(r => (r.target ? [{ op: r.op, target: r.target.text }] : []));
  const sub = (src: string, d: Dialect, why: string) => read(src, d, depth + 1, [...via, why], out);
  const emit = (words: Word[]) => {
    const argv = words.map(w => w.text);
    const first = words[0];
    const cmd: Command = { argv, program: first ? programName(first.text) : '', dynamic: !!first?.dynamic, redirects, text: argv.join(' '), via };
    out.commands.push(cmd);
    if (cmd.dynamic) out.opaque.push({ text: cmd.text, why: 'the program is an expansion' });
    // find -exec / -execdir / -ok: the words up to `;` or `+` are a command of their own
    if (cmd.program === 'find') {
      for (let i = 1; i < words.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[i]!.text)) continue;
        let j = i + 1;
        while (j < words.length && words[j]!.text !== ';' && words[j]!.text !== '+') j++;
        expand(words.slice(i + 1, j), [], dialect, depth + 1, [...via, 'find -exec'], out);
        i = j;
      }
    }
    // Inline code given to an interpreter is read for keywords only
    const inline = INLINE_FLAGS[cmd.program];
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

  for (let guard = 0; guard < 16 && ws.length; guard++) {
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
      case 'fish':
      case 'busybox': {
        if (prog === 'busybox' && rest[0] && ['sh', 'ash', 'bash'].includes(rest[0].text)) {
          ws = rest;
          continue;
        }
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
