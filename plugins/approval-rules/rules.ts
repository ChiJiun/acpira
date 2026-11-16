// The approval rules: which permission requests must reach the user as a card (or be refused), whatever the session's
// access level. Pure: it reads a permission hook payload and a configuration and returns a verdict, with no
// dependency on Acpira, so the test suite drives it directly.

import { analyze, type Command, OutOfTime, programName, quoteArgv } from './shell';

export type Action = 'ask' | 'deny';

export const BUILTIN = {
  'delete-files': { description: '刪除檔案或目錄', high: false },
  'git-discard': { description: '丟棄未提交的工作（git rm / clean / reset --hard / checkout -- / restore / stash drop）', high: false },
  'git-push': { description: 'git push', high: false },
  'config-files': { description: '修改設定檔', high: false },
  'branch-delete': { description: '刪除分支', high: false },
  'gh-merge': { description: '合併 PR（gh pr merge）', high: false },
  'foreign-repo': { description: '寫入 upstream 或非約定的 repo', high: false },
  'force-push': { description: '強制推送（--force / --force-with-lease / +refspec / --mirror）', high: true },
  'merge-auto': { description: '開啟 auto-merge', high: true },
  'merge-squash': { description: 'squash 合併', high: true },
  'merge-rebase': { description: 'rebase 合併', high: true },
  'repo-delete': { description: '刪除 repo', high: true },
  unparsed: { description: '指令無法完整解析，且含有危險關鍵字', high: false },
  'self-config': { description: '修改 approval-rules 自己的設定', high: false },
  unreadable: { description: '無法判斷要執行什麼或寫到哪裡（指令過長或太複雜、判斷逾時、執行請求沒有指令，或切換到無法判斷的目錄後寫檔）', high: false },
} as const;

export type BuiltinId = keyof typeof BUILTIN;

// Rules a user setting cannot switch off: the plugin's own configuration stays behind a card, and so does what could
// not be judged at all (otherwise a long or slow command would pass)
const LOCKED: ReadonlySet<BuiltinId> = new Set(['self-config', 'unreadable']);

export const DEFAULT_CONFIG_FILES: readonly string[] = [
  // Secrets and environment
  '.env', '.env.*', '.envrc', '*.pem', '*.key', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc',
  // CI
  '.github/workflows/**', '.github/actions/**', '.github/dependabot.yml', '.github/CODEOWNERS', '.gitlab-ci.yml',
  '.circleci/**', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml', '.buildkite/**',
  // Git
  '.gitignore', '.gitattributes', '.gitmodules', '.git/config', '.git/hooks/**', '.husky/**', '.pre-commit-config.yaml',
  // Package managers and build tools
  'package.json', 'pnpm-workspace.yaml', '.nvmrc', '.node-version', 'Cargo.toml', '.cargo/config', '.cargo/config.toml',
  'rust-toolchain', 'rust-toolchain.toml', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'go.mod', 'Gemfile', 'composer.json',
  'tsconfig.json', 'tsconfig.*.json', 'jsconfig.json', '*.config.js', '*.config.cjs', '*.config.mjs', '*.config.ts',
  '*.config.mts', '*.config.cts', '.eslintrc', '.eslintrc.*', '.prettierrc', '.prettierrc.*', '.babelrc', '.babelrc.*',
  '.editorconfig', '.stylelintrc', '.stylelintrc.*', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml',
  // Agents' own rules and settings
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.agents/**', '.claude/**', '.codex/**', '.cursor/**',
  '.cursorrules', '.windsurfrules', '.mcp.json', '.vscode/**', '.idea/**', '.acpira/**',
];

// Paths of the plugin's own settings and code: the data folder, every project's file, the installed plugin and its
// kept versions, and Acpira's record of which plugins are enabled
const SELF_FILES: readonly string[] = [
  'plugins/.data/approval-rules/**',
  '.agents/approval-rules.json',
  'plugins/state.json',
  'plugins/.versions/approval-rules/**',
  'plugins/approval-rules/**',
];

export interface CustomRule {
  id: string;
  description: string;
  action: Action;
  // Program then words that must follow it in order (flags in between are ignored): ["terraform", "apply"]
  command?: string[];
  // File globs: an edit, a deletion or a shell write of a matching file
  paths?: Glob[];
  // A regular expression on each command line (user configuration only)
  pattern?: RegExp;
  source: 'user' | 'project';
}

export interface RuleSetting {
  enabled: boolean;
  action: Action;
}

export interface Config {
  rules: Record<BuiltinId, RuleSetting>;
  configFiles: string[];
  configMatchers: Glob[];
  selfMatchers: Glob[];
  // Remote names `git push` may name without the foreign-repo rule (lowercase)
  allowedRemotes: string[];
  // owner/repo pairs gh may write to and pushes by URL may target (lowercase)
  allowedRepos: string[];
  custom: CustomRule[];
  toast: boolean;
}

export interface Hit {
  rule: string;
  description: string;
  action: Action;
  high: boolean;
  detail: string;
}

export interface Verdict {
  decision: 'pass' | 'ask' | 'deny';
  hits: Hit[];
  // One line for the user: which rules matched what
  reason: string;
}

// Globs: `**` any depth, `*` and `?` within a segment, `{a,b}` alternatives; a pattern matches at any depth,
// case-insensitively, and `dir/**` also names the folder itself. Matched without regular expressions, segment by
// segment, so a pattern from a project file cannot make a match slow.
export interface Glob {
  source: string;
  test(path: string): boolean;
}

const MAX_GLOB_LENGTH = 300;
const MAX_GLOB_STARS = 16;
const MAX_GLOB_ALTERNATIVES = 32;
export const MAX_PATH_LENGTH = 4096;

// Every alternative of `{a,b}` groups (not nested), or null past the limit
function braces(g: string): string[] | null {
  let out = [g];
  for (let round = 0; round < MAX_GLOB_ALTERNATIVES; round++) {
    const next: string[] = [];
    let changed = false;
    for (const s of out) {
      const open = s.indexOf('{');
      const close = open < 0 ? -1 : s.indexOf('}', open);
      if (close < 0) {
        next.push(s);
        continue;
      }
      changed = true;
      for (const alt of s.slice(open + 1, close).split(',')) next.push(s.slice(0, open) + alt + s.slice(close + 1));
    }
    if (next.length > MAX_GLOB_ALTERNATIVES) return null;
    out = next;
    if (!changed) return out;
  }
  return null;
}

// One segment against one pattern segment (`*` and `?` only): the usual two-pointer match, O(len × len) at worst
function segmentMatch(pat: string, s: string): boolean {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === s[i])) {
      p++;
      i++;
    } else if (p < pat.length && pat[p] === '*') {
      star = p++;
      mark = i;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

// Pattern segments (`**` for any number of segments) against path segments; memoised, so O(segments × segments)
function segmentsMatch(pat: string[], path: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (pi: number, si: number): boolean => {
    const key = pi * (path.length + 1) + si;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let r: boolean;
    if (pi === pat.length) r = si === path.length;
    else if (pat[pi] === '**') r = go(pi + 1, si) || (si < path.length && go(pi, si + 1));
    else r = si < path.length && segmentMatch(pat[pi]!, path[si]!) && go(pi + 1, si + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

// null when the glob is too long or has too many wildcards or alternatives
export function compileGlob(glob: string): Glob | null {
  let g = glob.trim().replace(/\\/g, '/').toLowerCase();
  if (!g || g.length > MAX_GLOB_LENGTH) return null;
  if ((g.match(/\*/g) ?? []).length > MAX_GLOB_STARS) return null;
  if (g.endsWith('/')) g += '**';
  g = g.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  const alts = braces(g);
  if (!alts) return null;
  const patterns = alts.map(a => {
    const segs = a.split('/').filter(s => s !== '' && s !== '.');
    // `a**b` is `a*b`; `**` alone spans folders; a pattern matches at any depth
    const norm = segs.map(s => (s === '**' ? s : s.replace(/\*\*+/g, '*')));
    const out = ['**'];
    for (const s of norm) if (!(s === '**' && out[out.length - 1] === '**')) out.push(s);
    return out;
  });
  return {
    source: glob,
    test(path: string): boolean {
      const segs = pathSegments(path);
      return patterns.some(p => segmentsMatch(p, segs));
    },
  };
}

// A path as Windows and POSIX would both resolve it: `\` and `/` alike, `//`, `/./` and `x/..` folded, trailing dots
// and spaces of a name dropped (Windows ignores them), `::$DATA` (the main stream) dropped; lowercase
export function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  const absolute = parts[0] === '' && parts.length > 1;
  for (let i = 0; i < parts.length; i++) {
    let s = parts[i]!;
    if (i === parts.length - 1) s = s.replace(/::\$data$/i, '');
    if (s !== '.' && s !== '..') s = s.replace(/[. ]+$/, '');
    if (s === '' || s === '.') continue;
    if (s === '..') {
      const top = out[out.length - 1];
      const drive = top !== undefined && /^[A-Za-z]:$/.test(top);
      if (top !== undefined && top !== '..' && top !== '~' && !drive) {
        out.pop();
        continue;
      }
      // Nothing above a root or a drive
      if (drive || (absolute && top === undefined)) continue;
    }
    out.push(s);
  }
  return (absolute ? '/' : '') + out.join('/');
}

function pathSegments(path: string): string[] {
  return normalizePath(path).toLowerCase().split('/').filter(Boolean);
}

// A Windows 8.3 short name (`GITHUB~1`, `PACKAG~1.JSO`): which long name it stands for cannot be known here
export const shortName = (path: string) => pathSegments(path).some(s => /^[^~]{1,6}~\d+(\.[^.]{0,3})?$/.test(s));

function matchesAny(path: string, globs: Glob[]): boolean {
  return globs.some(g => g.test(path));
}

// `host/owner/repo` (github.com when no host is given) from a slug, `host/owner/repo`, an https or ssh URL;
// lowercase, without `.git`
export function normalizeRepo(s: string): string {
  let r = s.trim().toLowerCase();
  const url = /^[a-z+]+:\/\//.test(r);
  r = r.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  // scp-like `host:owner/repo`, or `host:port/owner/repo` in a URL
  if (url) r = r.replace(/^([^/:]+):\d+\//, '$1/');
  else r = r.replace(/^([^/:]+):/, '$1/');
  const parts = r.split('/').filter(Boolean);
  if (parts.length < 2) return parts.join('/');
  const [owner, repo] = parts.slice(-2);
  const host = parts.length >= 3 ? parts[0] : 'github.com';
  return `${host}/${owner}/${repo}`;
}

const isUrl = (s: string) => /^[a-z+]+:\/\//i.test(s) || /^[^@\s]+@[^:\s]+:/.test(s) || s.includes('/');

// Configuration

function defaults(): Record<BuiltinId, RuleSetting> {
  const out = {} as Record<BuiltinId, RuleSetting>;
  for (const id of Object.keys(BUILTIN) as BuiltinId[]) out[id] = { enabled: true, action: 'ask' };
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
const MAX_PATTERNS = 200;
// Globs a project file may add in all (configFiles.add and every custom rule's paths)
const MAX_PROJECT_GLOBS = 500;

// Globs that compile; the others are reported
function globs(list: string[], where: string, warnings: string[]): Glob[] {
  const out: Glob[] = [];
  for (const p of list) {
    const g = compileGlob(p);
    if (g) out.push(g);
    else warnings.push(`${where}：${p.length > 60 ? `${p.slice(0, 59)}…` : p} 太長，或 * 超過 ${MAX_GLOB_STARS} 個、{a,b} 組合超過 ${MAX_GLOB_ALTERNATIVES} 種，已略過`);
  }
  return out;
}

function compileCustom(raw: unknown, source: 'user' | 'project', index: number, warnings: string[], budget: { globs: number }): CustomRule | null {
  const where = `${source === 'user' ? '使用者' : '專案'}設定 custom[${index}]`;
  if (!isObject(raw)) {
    warnings.push(`${where} 不是物件，已略過`);
    return null;
  }
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `rule-${index}`;
  const action: Action = raw.action === 'deny' ? 'deny' : 'ask';
  const rule: CustomRule = { id: source === 'project' ? `project:${id}` : `custom:${id}`, description: typeof raw.description === 'string' && raw.description ? raw.description : id, action, source };
  const command = strings(raw.command);
  if (command.length) rule.command = [programName(command[0]!), ...command.slice(1).map(w => w.toLowerCase())];
  let paths = strings(raw.paths).slice(0, MAX_PATTERNS);
  if (paths.length > budget.globs) {
    warnings.push(`${where}：專案設定的 glob 總數超過 ${MAX_PROJECT_GLOBS}，多的已略過`);
    paths = paths.slice(0, Math.max(0, budget.globs));
  }
  budget.globs -= paths.length;
  const compiled = globs(paths, where, warnings);
  if (compiled.length) rule.paths = compiled;
  if (typeof raw.pattern === 'string' && raw.pattern) {
    if (source === 'project') warnings.push(`${where}：專案設定不接受 pattern（正規表示式），已略過這個欄位`);
    else {
      try {
        rule.pattern = new RegExp(raw.pattern, 'i');
      } catch (e) {
        warnings.push(`${where}：pattern 不是有效的正規表示式（${(e as Error).message}）`);
      }
    }
  }
  if (!rule.command && !rule.paths && !rule.pattern) {
    warnings.push(`${where} 沒有 command、paths 或 pattern，已略過`);
    return null;
  }
  return rule;
}

const USER_KEYS = new Set(['highRisk', 'rules', 'configFiles', 'allowedRemotes', 'allowedRepos', 'custom', 'toast', '$schema', 'comment']);
const PROJECT_KEYS = new Set(['configFiles', 'custom', '$schema', 'comment']);

// The user's configuration may add, switch off and change rules; the project's only adds (an agent can edit project
// files, so nothing there may loosen what the user set)
export function resolveConfig(user: unknown, project: unknown): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  const rules = defaults();
  let configFiles = [...DEFAULT_CONFIG_FILES];
  let allowedRemotes = ['origin'];
  let allowedRepos: string[] = [];
  const custom: CustomRule[] = [];
  let toast = true;
  const projectBudget = { globs: MAX_PROJECT_GLOBS };
  let projectConfigFiles: string[] = [];

  if (user !== undefined && user !== null) {
    if (!isObject(user)) warnings.push('使用者設定不是 JSON 物件，改用預設規則');
    else {
      for (const k of Object.keys(user)) if (!USER_KEYS.has(k)) warnings.push(`使用者設定有不認得的欄位 ${k}`);
      const high = user.highRisk === 'deny' ? 'deny' : 'ask';
      if (user.highRisk !== undefined && user.highRisk !== 'ask' && user.highRisk !== 'deny') warnings.push('highRisk 只能是 "ask" 或 "deny"');
      for (const id of Object.keys(BUILTIN) as BuiltinId[]) if (BUILTIN[id].high) rules[id].action = high;
      if (isObject(user.rules)) {
        for (const [id, v] of Object.entries(user.rules)) {
          if (!Object.hasOwn(BUILTIN, id)) {
            warnings.push(`rules.${id} 不是內建規則`);
            continue;
          }
          const setting = rules[id as BuiltinId];
          if (!isObject(v)) {
            warnings.push(`rules.${id} 應該是物件，例如 { "enabled": false }`);
            continue;
          }
          if (v.enabled === false) {
            if (LOCKED.has(id as BuiltinId)) warnings.push(`rules.${id} 不能停用`);
            else setting.enabled = false;
          }
          if (v.action === 'ask' || v.action === 'deny') setting.action = v.action;
          else if (v.action !== undefined) warnings.push(`rules.${id}.action 只能是 "ask" 或 "deny"`);
        }
      }
      if (isObject(user.configFiles)) {
        if (Array.isArray(user.configFiles.replace)) configFiles = strings(user.configFiles.replace);
        const remove = new Set(strings(user.configFiles.remove));
        configFiles = configFiles.filter(p => !remove.has(p));
        configFiles.push(...strings(user.configFiles.add));
      }
      if (Array.isArray(user.allowedRemotes)) allowedRemotes = strings(user.allowedRemotes).map(r => r.toLowerCase());
      if (Array.isArray(user.allowedRepos)) allowedRepos = strings(user.allowedRepos).map(normalizeRepo);
      if (Array.isArray(user.custom)) user.custom.forEach((r, i) => { const c = compileCustom(r, 'user', i, warnings, { globs: Infinity }); if (c) custom.push(c); });
      if (user.toast === false) toast = false;
    }
  }

  if (project !== undefined && project !== null) {
    if (!isObject(project)) warnings.push('專案設定不是 JSON 物件，已略過');
    else {
      for (const k of Object.keys(project)) {
        if (!PROJECT_KEYS.has(k)) warnings.push(`專案設定的 ${k} 不會生效：專案層級只能新增規則（configFiles.add、custom）`);
      }
      if (isObject(project.configFiles)) {
        for (const k of Object.keys(project.configFiles)) if (k !== 'add') warnings.push(`專案設定的 configFiles.${k} 不會生效：只能用 add`);
        projectConfigFiles = strings(project.configFiles.add).slice(0, Math.min(MAX_PATTERNS, projectBudget.globs));
        projectBudget.globs -= projectConfigFiles.length;
      }
      if (Array.isArray(project.custom)) {
        project.custom.slice(0, MAX_PATTERNS).forEach((r, i) => { const c = compileCustom(r, 'project', i, warnings, projectBudget); if (c) custom.push(c); });
      }
    }
  }

  const configMatchers = [...globs(configFiles, '使用者設定 configFiles', warnings), ...globs(projectConfigFiles, '專案設定 configFiles.add', warnings)];
  configFiles = [...configFiles, ...projectConfigFiles];
  return {
    config: {
      rules,
      configFiles,
      configMatchers,
      selfMatchers: SELF_FILES.map(p => compileGlob(p)!),
      allowedRemotes,
      allowedRepos,
      custom,
      toast,
    },
    warnings,
  };
}

// What a permission request is about

export interface Request {
  kind?: string;
  // The request runs a command (its kind, or the tool row's kind, is execute)
  execute: boolean;
  // Command lines to read (rawInput, the tool row's target, backquoted parts of the title)
  commands: string[];
  // Files an edit-like tool would change
  paths: string[];
  // The session's folder, which relative paths are resolved against
  cwd?: string;
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'notebook_path', 'target_file', 'source', 'destination', 'old_path', 'new_path', 'oldPath', 'newPath'];
// A command line, or an argv array
const COMMAND_KEYS = ['command', 'cmd', 'CommandLine', 'commandLine', 'script'];
// Kinds whose paths are read, never written
const READING = new Set(['read', 'search', 'fetch', 'think', 'execute', 'switch_mode']);

const allStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string');

// A command line (string) or an argv (array of strings) as one line to read
function commandLine(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (v.trim()) out.add(v);
  } else if (allStrings(v)) out.add(quoteArgv(v));
}

export function extractRequest(payload: unknown): Request {
  const p = isObject(payload) ? payload : {};
  const tc = isObject(p.toolCall) ? p.toolCall : {};
  const row = isObject(p.row) ? p.row : {};
  const raw = isObject(tc.rawInput) ? tc.rawInput : {};
  const kind = typeof tc.kind === 'string' ? tc.kind : typeof row.kind === 'string' ? row.kind : undefined;
  // The tool call's kind and the row's may disagree (`other` in one, `execute` in the other): either one counts
  const execute = tc.kind === 'execute' || row.kind === 'execute';
  const commands = new Set<string>();
  for (const k of COMMAND_KEYS) commandLine(raw[k], commands);
  // `commands: ["git push", ["rm", "-rf", "x"]]`: each entry is a line or an argv
  if (Array.isArray(raw.commands)) for (const c of raw.commands) commandLine(c, commands);
  // `{ command: "git", args: ["push"] }`
  const program = typeof raw.command === 'string' ? raw.command : typeof raw.cmd === 'string' ? raw.cmd : undefined;
  for (const k of ['args', 'argv', 'arguments']) {
    const v = raw[k];
    if (allStrings(v)) {
      if (program) commands.add(`${program} ${quoteArgv(v)}`);
      else if (execute) commands.add(quoteArgv(v));
    } else if (typeof v === 'string' && v.trim() && (program || execute)) commands.add(program ? `${program} ${v}` : v);
  }
  if (execute && typeof raw.input === 'string' && raw.input.trim()) commands.add(raw.input);
  if (execute && typeof row.target === 'string' && row.target.trim()) commands.add(row.target);
  if (execute || kind === undefined) {
    for (const title of [tc.title]) {
      if (typeof title !== 'string') continue;
      // claude-agent-acp titles a shell call as the command in backquotes, with inner backquotes escaped
      const whole = /^`([\s\S]*)`$/.exec(title.trim());
      if (whole) commands.add(whole[1]!.replace(/\\`/g, '`'));
      else for (const m of title.matchAll(/`([^`]+)`/g)) commands.add(m[1]!);
    }
  }
  const paths = new Set<string>();
  if (!kind || !READING.has(kind)) {
    for (const k of PATH_KEYS) {
      const v = raw[k];
      if (typeof v === 'string' && v.trim()) paths.add(v);
    }
    for (const loc of [tc.locations, row.locations]) {
      if (!Array.isArray(loc)) continue;
      for (const l of loc) if (isObject(l) && typeof l.path === 'string' && l.path) paths.add(l.path);
    }
    // codex-acp's apply_patch keys its changes by path
    if (isObject(raw.changes)) for (const k of Object.keys(raw.changes)) paths.add(k);
  }
  // A diff in the request is an edit whatever the kind says
  if (Array.isArray(tc.content)) {
    for (const c of tc.content) if (isObject(c) && c.type === 'diff' && typeof c.path === 'string' && c.path) paths.add(c.path);
  }
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined;
  return { kind, execute, commands: [...commands], paths: [...paths], cwd };
}

// Keyword checks for what could not be read. One pass over the words, no regular expression on the whole text, so
// the time grows with the length and nothing else.

const DELETE_WORDS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'remove-item', 'rimraf', 'rmtree', 'rmsync', 'rmdirsync',
  'unlinksync', 'deletefile', 'deletedirectory', 'rm_rf', 'rm_r', 'rm_f', 'remove_dir', 'remove_entry', 'removesync',
  'removedirs', 'remove_file', 'remove_dir_all',
]);
// `remove` / `delete` mean a deletion only as a method of these: os.remove, File.delete, Deno.remove, [IO.File]::Delete
const DELETE_OWNERS = new Set(['os', 'fs', 'fsp', 'fse', 'promises', 'shutil', 'file', 'fileutils', 'dir', 'directory', 'fileinfo', 'directoryinfo', 'deno', 'path', 'pathlib', 'io', 'bun', 'filesystem']);
const OWNED_DELETES = new Set(['remove', 'delete', 'delete_all']);
const GIT_WORDS = new Set(['push', 'rm', 'clean', 'reset', 'checkout', 'restore', 'stash', 'branch', 'worktree', 'config', 'remote', 'update-ref', 'tag', 'merge', 'switch', 'filter-branch', 'filter-repo']);
const GH_WORDS = new Set(['merge', 'delete', 'create', 'edit', 'close', 'api', 'repo', 'alias']);

interface CodeWord {
  // The word as written, lowercase, without .exe / .cmd / .bat / .com / .ps1
  word: string;
  // Its dotted parts, joined to the word before when it is a method call (`[IO.File]::Delete`, `Path(p).unlink`)
  parts: string[];
}

function codeWords(text: string): CodeWord[] {
  const out: CodeWord[] = [];
  let prev = '';
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.:\-]+/)) {
    if (!raw) continue;
    const word = raw.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
    const call = word.startsWith('.') || word.startsWith(':') ? prev + word : word;
    prev = word;
    out.push({ word, parts: call.replace(/::/g, '.').split('.').filter(Boolean) });
  }
  return out;
}

export function keywords(text: string): string[] {
  let del = false;
  let gitWrite = false;
  let ghWrite = false;
  let force = false;
  let git = false;
  let gh = false;
  for (const { word, parts } of codeWords(text)) {
    const last = parts[parts.length - 1] ?? '';
    const owner = parts.length > 1 ? parts[parts.length - 2]! : '';
    if (DELETE_WORDS.has(word) || DELETE_WORDS.has(last) || (OWNED_DELETES.has(last) && DELETE_OWNERS.has(owner))) del = true;
    if (word.startsWith('--force') || word === '--mirror') force = true;
    if (git && GIT_WORDS.has(word)) gitWrite = true;
    if (gh && GH_WORDS.has(word)) ghWrite = true;
    if (last === 'git' || word === 'git') git = true;
    if (last === 'gh' || word === 'gh') gh = true;
  }
  const out: string[] = [];
  if (del) out.push('刪除');
  if (gitWrite) out.push('git 寫入');
  if (ghWrite) out.push('gh 寫入');
  if (force) out.push('強制');
  return out;
}

// Inline code that writes a file named in a string literal: `node -e "fs.writeFileSync('package.json', …)"`,
// `python -c "open('.env', 'w')"`

const WRITE_CALLS = new Set([
  'writefile', 'writefilesync', 'appendfile', 'appendfilesync', 'createwritestream', 'copyfile', 'copyfilesync',
  'cpsync', 'renamesync', 'symlinksync', 'linksync', 'writetextfile', 'writetextfilesync', 'write_text', 'write_bytes',
  'copy2', 'copytree', 'binwrite', 'writealltext', 'writeallbytes', 'writealllines', 'appendalltext', 'appendalllines',
  'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'new-item', 'outputfile', 'outputfilesync',
  'outputjson', 'writejson', 'writejsonsync',
]);
// Generic names that write only as a method of a file module: File.write, fs.cp, shutil.copy, os.replace, Bun.write
const OWNED_WRITES = new Set(['write', 'cp', 'mv', 'copy', 'move', 'rename', 'replace', 'symlink', 'link', 'touch']);
const WRITE_OWNERS = new Set([...DELETE_OWNERS, 'shutil', 'os']);
const OPEN_MODE = /^[rwax][bt+]*$/;

// The contents of the quoted strings in code (one pass; backslash escapes honoured)
function literals(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const q = text[i];
    if (q !== '"' && q !== "'" && q !== '`') continue;
    let j = i + 1;
    let s = '';
    while (j < text.length && text[j] !== q && text[j] !== '\n') {
      if (text[j] === '\\' && j + 1 < text.length) {
        s += text[j + 1];
        j += 2;
        continue;
      }
      s += text[j];
      j++;
    }
    if (j < text.length && text[j] === q && s.length <= 1024) out.push(s);
    i = j;
  }
  return out;
}

function inlineWrites(ctx: Ctx, text: string): void {
  const ws = codeWords(text);
  const lits = literals(text);
  const last = (w: CodeWord) => w.parts[w.parts.length - 1] ?? '';
  const owner = (w: CodeWord) => (w.parts.length > 1 ? w.parts[w.parts.length - 2]! : '');
  const writes =
    ws.some(w => WRITE_CALLS.has(last(w)) || WRITE_CALLS.has(w.word) || (OWNED_WRITES.has(last(w)) && WRITE_OWNERS.has(owner(w)))) ||
    // open('x', 'w'), File.open('x', 'w'), fopen('x', 'a')
    (ws.some(w => ['open', 'fopen'].includes(last(w))) && lits.some(l => OPEN_MODE.test(l) && /[wax+]/.test(l)));
  if (!writes) return;
  for (const l of new Set(lits)) {
    if (!l.trim() || l.length > MAX_PATH_LENGTH) continue;
    checkPath(ctx, l, l, 'write', `${clip(text)}（程式碼寫入 ${l}）`);
  }
}

// Commands

interface Ctx {
  config: Config;
  hits: Hit[];
  // Date.now() past which the judging gives up and asks
  deadline: number;
  // The session's folder
  cwd?: string;
}

function tick(ctx: Ctx): void {
  if (Date.now() > ctx.deadline) throw new OutOfTime();
}

function add(ctx: Ctx, rule: BuiltinId, detail: string): void {
  const s = ctx.config.rules[rule];
  if (!s.enabled) return;
  if (ctx.hits.some(h => h.rule === rule && h.detail === detail)) return;
  ctx.hits.push({ rule, description: BUILTIN[rule].description, action: s.action, high: BUILTIN[rule].high, detail });
}

// Where a target written on a command line points: absolute (or rooted in a variable, `$HOME/x`, `%APPDATA%\x`, whose
// tail is still matched) as it is, relative under the folder the command runs in; null when that folder is unknown
const ROOTED = /^(\/|~|[A-Za-z]:|\\\\|\$|%)/;
function resolve(target: string, dir: string | null, base: string | undefined): string | null {
  const t = target.replace(/\\/g, '/');
  if (ROOTED.test(t)) return t;
  if (dir === null) return null;
  const d = dir.replace(/\\/g, '/');
  const prefix = ROOTED.test(d) ? d : [base?.replace(/\\/g, '/'), d].filter(Boolean).join('/');
  return prefix ? `${prefix}/${t}` : t;
}

// The configuration, self and custom path rules for one file a tool or command writes or deletes. `local` is the
// path without the session folder in front, for the short-name check (the session folder itself may be a short name).
function checkPath(ctx: Ctx, path: string, local: string, op: 'write' | 'delete', detail: string): void {
  tick(ctx);
  if (path.length > MAX_PATH_LENGTH) {
    add(ctx, 'unreadable', `${detail}（路徑超過 ${MAX_PATH_LENGTH} 字元）`);
    return;
  }
  if (shortName(local)) add(ctx, 'unreadable', `${detail}（路徑用了 8.3 短檔名，無法判斷原本的名稱）`);
  if (matchesAny(path, ctx.config.selfMatchers)) add(ctx, 'self-config', detail);
  if (op === 'write' && matchesAny(path, ctx.config.configMatchers)) add(ctx, 'config-files', detail);
  for (const r of ctx.config.custom) if (r.paths && matchesAny(path, r.paths)) addCustom(ctx, r, detail);
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'rimraf', 'trash', 'trash-put', 'del', 'erase', 'rd', 'remove-item', 'ri', 'rmtree']);
const DANGER_WORDS = new Set(['push', 'rm', 'clean', 'reset', 'merge', 'delete', 'rmdir', 'remove-item', '-rf', '-fr', '--force', '--hard']);
const NULL_TARGETS =/^(\/dev\/null|nul|\$null|null|con|&\d|-)$/i;

// Positional words of a command (flags left out, `--` honoured)
function positionals(argv: string[], from = 1): string[] {
  const out: string[] = [];
  let ended = false;
  for (const a of argv.slice(from)) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') continue;
    // cmd.exe switches (`/s`, `/q`)
    if (!ended && /^\/[A-Za-z?]$/.test(a)) continue;
    out.push(a);
  }
  return out;
}

// Files a command writes or deletes, for the configuration and path rules
function fileTargets(cmd: Command): { writes: string[]; deletes: string[] } {
  const writes: string[] = [];
  const deletes: string[] = [];
  for (const r of cmd.redirects) if (r.op !== '<' && r.op !== '<<' && r.op !== '<<<' && !NULL_TARGETS.test(r.target)) writes.push(r.target);
  const p = cmd.program;
  const pos = positionals(cmd.argv);
  if (DELETERS.has(p)) deletes.push(...pos);
  else if (p === 'tee' || p === 'tee-object' || p === 'truncate') writes.push(...pos);
  else if ((p === 'sed' || p === 'perl') && cmd.argv.some(a => a === '--in-place' || /^-[A-Za-z]*i/.test(a))) writes.push(...pos);
  else if (['cp', 'install', 'ln', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy'].includes(p)) {
    if (p === 'robocopy') writes.push(pos[1] ?? '');
    else if (pos.length) writes.push(pos[pos.length - 1]!);
  } else if (['mv', 'move', 'ren', 'rename', 'move-item', 'mi', 'rename-item', 'rni'].includes(p)) {
    if (pos.length && NULL_TARGETS.test(pos[pos.length - 1]!)) deletes.push(...pos.slice(0, -1));
    else writes.push(...pos);
  } else if (['set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni'].includes(p)) writes.push(...pos);
  else if (p === 'dd') for (const a of cmd.argv) if (a.startsWith('of=')) writes.push(a.slice(3));
  return { writes: writes.filter(Boolean), deletes: deletes.filter(Boolean) };
}

// git: the subcommand and its arguments, after the global options
function gitParts(argv: string[]): { sub: string; args: string[]; alias: boolean } {
  let i = 1;
  let alias = false;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--super-prefix' || a === '--config-env') {
      if ((a === '-c' || a === '--config-env') && /^alias\./i.test(argv[i + 1] ?? '')) alias = true;
      i += 2;
      continue;
    }
    if (a.startsWith('-c') && /^-calias\./i.test(a)) alias = true;
    if (a.startsWith('--config-env=alias.')) alias = true;
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  return { sub: (argv[i] ?? '').toLowerCase(), args: argv.slice(i + 1), alias };
}

// Short flags in a cluster (`-fu` → f, u); long flags by name
function shortFlags(a: string): string {
  return /^-[A-Za-z0-9]+$/.test(a) ? a.slice(1) : '';
}

function gitPush(ctx: Ctx, args: string[], text: string): void {
  let force = false;
  let del = false;
  let dry = false;
  let mirror = false;
  let remote: string | undefined;
  const pos: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (ended) {
      pos.push(a);
      continue;
    }
    if (a === '--') {
      ended = true;
      continue;
    }
    if (a.startsWith('--')) {
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (name === '--force' || name === '--force-with-lease' || name === '--force-if-includes') force = true;
      else if (name === '--mirror') mirror = true;
      else if (name === '--delete' || name === '--prune') del = true;
      else if (name === '--dry-run') dry = true;
      else if (name === '--repo') remote = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      else if (name === '--push-option' || name === '--receive-pack' || name === '--exec') {
        if (!a.includes('=')) i++;
      }
      continue;
    }
    const s = shortFlags(a);
    if (s) {
      if (s.includes('f')) force = true;
      if (s.includes('d')) del = true;
      if (s.includes('n')) dry = true;
      if (s.endsWith('o')) i++;
      continue;
    }
    pos.push(a);
  }
  // A dry run writes nothing: no card (see README)
  if (dry) return;
  remote ??= pos[0];
  const refspecs = remote === pos[0] ? pos.slice(1) : pos;
  if (pos.some(p => p.startsWith('+'))) force = true;
  if (refspecs.some(r => r.startsWith(':') || r.startsWith('+:'))) del = true;
  add(ctx, 'git-push', text);
  if (force || mirror) add(ctx, 'force-push', text);
  if (del) add(ctx, 'branch-delete', text);
  if (remote !== undefined) {
    const allowed = isUrl(remote)
      ? ctx.config.allowedRepos.includes(normalizeRepo(remote))
      : ctx.config.allowedRemotes.includes(remote.toLowerCase());
    if (!allowed) add(ctx, 'foreign-repo', `${text}（遠端 ${remote} 不在 allowedRemotes / allowedRepos）`);
  }
}

// An operand of `git checkout` that names files rather than a branch: `.`, `./x`, `a\b`, a glob, or a name with a file
// extension (`a.ts`, `package.json`; a version tag such as v1.2.3 ends in a digit and passes)
const pathLike = (a: string) => a === '.' || a.startsWith('./') || a.startsWith('../') || a.includes('\\') || a.includes('*') || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(a);

function git(ctx: Ctx, cmd: Command): void {
  const { sub, args, alias } = gitParts(cmd.argv);
  const text = cmd.text;
  const flags = args.filter(a => a.startsWith('-'));
  const has = (...names: string[]) => args.some(a => names.includes(a) || names.some(n => n.startsWith('--') && a.startsWith(`${n}=`)));
  const cluster = (letter: string) => flags.some(a => shortFlags(a).includes(letter));
  if (alias) {
    const k = keywords(text);
    if (k.length) add(ctx, 'unparsed', `${text}（git -c alias.*：${k.join('、')}）`);
  }
  switch (sub) {
    case 'push':
      return gitPush(ctx, args, text);
    case 'rm':
      if (!has('--dry-run') && !cluster('n')) add(ctx, 'git-discard', text);
      return;
    case 'clean':
      if (!has('--dry-run') && !cluster('n')) add(ctx, 'git-discard', text);
      return;
    case 'reset':
      if (has('--hard', '--merge', '--keep')) add(ctx, 'git-discard', text);
      return;
    case 'checkout': {
      // `git checkout src/a.ts` restores the file; `-B` resets an existing branch. A branch or tag name passes.
      const operands = positionals(['', ...args]);
      if (has('--', '--force', '--ours', '--theirs', '--patch') || cluster('f') || cluster('p') || cluster('B') || operands.some(pathLike)) add(ctx, 'git-discard', text);
      return;
    }
    case 'tag':
      if (has('--delete') || cluster('d')) add(ctx, 'branch-delete', text);
      return;
    case 'merge':
      if (has('--squash')) add(ctx, 'merge-squash', text);
      return;
    case 'restore': {
      const staged = has('--staged') || cluster('S');
      const worktree = has('--worktree') || cluster('W');
      if (!staged || worktree) add(ctx, 'git-discard', text);
      return;
    }
    case 'switch':
      if (has('--discard-changes', '--force', '--force-create') || cluster('f') || cluster('C')) add(ctx, 'git-discard', text);
      return;
    case 'stash': {
      const verb = positionals(['', ...args])[0];
      if (verb === 'drop' || verb === 'clear') add(ctx, 'git-discard', text);
      return;
    }
    case 'worktree': {
      const verb = positionals(['', ...args])[0];
      if (verb === 'remove' || verb === 'prune') add(ctx, 'git-discard', text);
      return;
    }
    case 'branch':
      if (has('--delete') || cluster('d') || cluster('D')) add(ctx, 'branch-delete', text);
      return;
    case 'update-ref':
      if (has('--stdin') || cluster('d')) add(ctx, 'branch-delete', text);
      return;
    case 'config': {
      const reading = has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '--show-origin', '--show-scope', '--get-color', '--get-colorbool') || cluster('l');
      const verb = positionals(['', ...args]);
      const writing = has('--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '--edit') || cluster('e');
      if (verb[0] === 'get' || verb[0] === 'list') return;
      if (writing || verb[0] === 'set' || verb[0] === 'unset' || verb[0] === 'edit' || verb[0] === 'rename-section' || verb[0] === 'remove-section' || (!reading && verb.length >= 2)) add(ctx, 'config-files', text);
      return;
    }
    case 'remote': {
      const verb = positionals(['', ...args])[0];
      if (verb && ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune'].includes(verb)) add(ctx, 'config-files', text);
      return;
    }
    case 'filter-branch':
    case 'filter-repo':
      add(ctx, 'git-discard', text);
      return;
    default:
  }
}

const GH_WRITES: Record<string, string[]> = {
  pr: ['create', 'merge', 'close', 'reopen', 'edit', 'comment', 'review', 'ready', 'lock', 'unlock', 'update-branch', 'revert'],
  issue: ['create', 'close', 'reopen', 'edit', 'comment', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop'],
  release: ['create', 'delete', 'edit', 'upload', 'delete-asset'],
  repo: ['create', 'delete', 'edit', 'rename', 'archive', 'unarchive', 'fork', 'sync', 'deploy-key', 'set-default'],
  label: ['create', 'edit', 'delete', 'clone'],
  secret: ['set', 'delete', 'remove'],
  variable: ['set', 'delete', 'remove'],
  workflow: ['run', 'enable', 'disable'],
  run: ['cancel', 'rerun', 'delete'],
  cache: ['delete'],
  ruleset: [],
  project: ['create', 'delete', 'edit', 'close', 'copy', 'item-add', 'item-delete', 'item-edit', 'field-create', 'field-delete', 'link', 'unlink'],
};
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input', '-t', '--title', '-b', '--body', '-B', '--base', '--head', '-m', '--milestone', '-a', '--assignee', '-l', '--label', '-r', '--reviewer', '--subject', '--body-file', '-q', '--jq', '--template', '-p', '--project', '--match-head-commit', '-A', '--author-email', '--hostname', '--cache']);

// gh's command groups; anything else is an alias (`gh alias set`) or an extension whose effect is unknown
const GH_GROUPS = new Set([
  'agent-task', 'alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'co', 'codespace', 'cs', 'completion', 'config',
  'copilot', 'extension', 'extensions', 'ext', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'preview',
  'project', 'release', 'repo', 'ruleset', 'rs', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow',
  'version', 'accessibility', 'a11y', 'licenses',
]);

// A write to the GitHub REST or GraphQL API (`gh api`, curl and the like): which repository, and merges, deletions
// and auto-merge it would do. `body` is the request's fields or data; `unknownBody` when they come from a file.
function githubApi(ctx: Ctx, method: string, path: string, body: string, unknownBody: boolean, host: string, text: string, tool: string): void {
  const endpoint = path.replace(/^\/+/, '').split(/[?#]/)[0]!;
  if (endpoint === 'graphql' || endpoint === 'api/graphql') {
    // A query reads; a mutation, or a body the command line does not show, may write
    if (!unknownBody && !/\bmutation\b/i.test(body)) return;
    add(ctx, 'foreign-repo', `${text}（GraphQL ${unknownBody ? '內容在檔案裡' : 'mutation'}，無法確認目標 repo）`);
    if (/enablePullRequestAutoMerge/i.test(body)) add(ctx, 'merge-auto', text);
    if (/mergePullRequest/i.test(body)) add(ctx, 'gh-merge', text);
    if (/deleteRepository/i.test(body)) add(ctx, 'repo-delete', text);
    if (/deleteRef\b/i.test(body)) add(ctx, 'branch-delete', text);
    return;
  }
  if (method === 'GET' || method === 'HEAD') return;
  const target = /^repos\/([^/]+)\/([^/?]+)/i.exec(endpoint);
  if (target && !target[1]!.startsWith('{') && !target[2]!.startsWith('{') && !target[1]!.startsWith(':')) {
    const repo = normalizeRepo(`${host}/${target[1]}/${target[2]}`);
    if (!ctx.config.allowedRepos.includes(repo)) add(ctx, 'foreign-repo', `${text}（API 寫入 ${repo} 不在 allowedRepos）`);
  } else add(ctx, 'foreign-repo', `${text}（${tool} 寫入，無法確認目標 repo）`);
  if (method === 'DELETE' && /^repos\/[^/]+\/[^/?]+\/?$/i.test(endpoint)) add(ctx, 'repo-delete', text);
  if (method === 'DELETE' && /\/git\/refs\//i.test(endpoint)) add(ctx, 'branch-delete', text);
  if (/\/pulls\/[^/]+\/merge\b/i.test(endpoint)) {
    add(ctx, 'gh-merge', text);
    if (/merge_method\W*squash/i.test(body)) add(ctx, 'merge-squash', text);
    if (/merge_method\W*rebase/i.test(body)) add(ctx, 'merge-rebase', text);
  }
}

function gh(ctx: Ctx, cmd: Command): void {
  const argv = cmd.argv;
  const text = cmd.text;
  let repo: string | undefined;
  let hostname = 'github.com';
  const pos: string[] = [];
  const flags: string[] = [];
  const fields: string[] = [];
  let fromFile = false;
  let method: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    flags.push(a);
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
    // `-Rowner/repo`, `-XDELETE`
    const attached = !a.startsWith('--') && a.length > 2 ? a.slice(2) : undefined;
    const short = !a.startsWith('--') ? a.slice(0, 2) : name;
    // In `gh pr merge`, -r / -m / -b / -t are booleans or values depending on the command; only -R, -X, -f, -F read on
    const takes = GH_VALUE_FLAGS.has(short) && !(pos[0] === 'pr' && pos[1] === 'merge' && ['-r', '-m', '-s', '-d'].includes(short));
    const value = inline ?? attached ?? (takes ? argv[++i] : undefined);
    if (short === '-R' || name === '--repo') repo = value;
    if (name === '--hostname' && value) hostname = value;
    if (short === '-X' || name === '--method') method = value?.toUpperCase();
    if (['-f', '-F', '--field', '--raw-field'].includes(short) || ['--field', '--raw-field'].includes(name)) {
      fields.push(value ?? '');
      // `-F query=@file.graphql`: the value is read from a file
      if ((short === '-F' || name === '--field') && /^[^=]*=@/.test(value ?? '')) fromFile = true;
    }
    if (name === '--input') {
      fields.push(value ?? '');
      fromFile = true;
    }
  }
  const group = pos[0];
  const verb = pos[1];
  if (!group) return;
  if (!GH_GROUPS.has(group)) {
    add(ctx, 'unparsed', `${text}（gh ${group} 是別名或擴充指令，無法判斷它做什麼）`);
    return;
  }
  const foreign = (what: string) => {
    if (repo === undefined) add(ctx, 'foreign-repo', `${text}（沒有指定 --repo，gh 可能作用在 upstream）`);
    else if (!ctx.config.allowedRepos.includes(normalizeRepo(repo))) add(ctx, 'foreign-repo', `${text}（${what} ${repo} 不在 allowedRepos）`);
  };
  const flag = (...names: string[]) => flags.some(f => names.includes(f) || names.some(n => n.startsWith('--') && f.startsWith(`${n}=`)));
  const cluster = (letter: string) => flags.some(f => shortFlags(f).includes(letter));
  if (group === 'api') {
    const m = method ?? (fields.length ? 'POST' : 'GET');
    githubApi(ctx, m, verb ?? '', fields.join(' '), fromFile, hostname, text, 'gh api');
    return;
  }
  // `gh alias set` / `import` / `delete` change what a gh command means
  if (group === 'alias' && verb && ['set', 'import', 'delete'].includes(verb)) add(ctx, 'config-files', text);
  if (group === 'pr' && verb === 'merge') {
    add(ctx, 'gh-merge', text);
    if (flag('--auto')) add(ctx, 'merge-auto', text);
    if (flag('--squash') || cluster('s')) add(ctx, 'merge-squash', text);
    if (flag('--rebase') || cluster('r')) add(ctx, 'merge-rebase', text);
    if (flag('--delete-branch') || cluster('d')) add(ctx, 'branch-delete', text);
  }
  if (group === 'repo' && verb === 'delete') add(ctx, 'repo-delete', text);
  if (group === 'repo' && verb === 'edit' && flag('--enable-auto-merge')) add(ctx, 'merge-auto', text);
  const writes = GH_WRITES[group === 'rs' ? 'ruleset' : group];
  if (writes && verb && (writes.includes(verb) || ((group === 'ruleset' || group === 'rs') && verb !== 'list' && verb !== 'view' && verb !== 'check'))) {
    // `gh repo delete owner/repo`, `gh repo edit owner/repo`: the repository is the operand
    if (group === 'repo' && repo === undefined && pos[2] && pos[2].includes('/')) repo = pos[2];
    if (group === 'repo' && verb === 'create') return;
    foreign('repo');
  }
}

// HTTP clients that can write to the GitHub API without gh
const HTTP_CLIENTS = new Set(['curl', 'wget', 'wget2', 'http', 'https', 'httpie', 'xh', 'xhs', 'invoke-restmethod', 'irm', 'invoke-webrequest', 'iwr']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function httpGithub(ctx: Ctx, cmd: Command): void {
  const argv = cmd.argv;
  let url: string | undefined;
  let method: string | undefined;
  const body: string[] = [];
  let fromFile = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const lower = a.toLowerCase();
    const eq = a.indexOf('=');
    const name = lower.startsWith('-') && eq > 0 ? lower.slice(0, eq) : lower;
    const inline = lower.startsWith('-') && eq > 0 ? a.slice(eq + 1) : undefined;
    const next = () => inline ?? argv[++i] ?? '';
    // Short flags are case-sensitive (curl's -x is a proxy, -X the method); long and PowerShell ones are not
    if (a === '-X' || name === '--request' || name === '--method' || name === '-method') method = next().toUpperCase();
    else if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2).toUpperCase();
    else if (['-d', '-F', '-T'].includes(a) || ['--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '--form', '--form-string', '--upload-file', '--post-data', '--body-data', '-body', '--raw'].includes(name)) {
      const v = next();
      body.push(v);
      if (v.startsWith('@') || a === '-T' || name === '--upload-file') fromFile = true;
    } else if (['--post-file', '--body-file', '-infile'].includes(name)) {
      next();
      fromFile = true;
    } else if (/api\.github\.com(\/|$)/i.test(a) && url === undefined) url = a;
    // httpie / xh: `http PUT url field=value`
    else if (!a.startsWith('-') && url === undefined && HTTP_METHODS.has(a.toUpperCase())) method = a.toUpperCase();
    else if (!a.startsWith('-') && url !== undefined && /^[^=:]+(:=|==|=|@)/.test(a)) {
      body.push(a);
      if (!/^[^=:]+==/.test(a)) method ??= 'POST';
    }
  }
  if (url === undefined) return;
  const m = method ?? (body.length || fromFile ? 'POST' : 'GET');
  const path = url.replace(/^[a-z]+:\/\//i, '').replace(/^[^/]*api\.github\.com/i, '');
  githubApi(ctx, m, path, body.join(' '), fromFile, 'github.com', clip(cmd.text), cmd.program);
}

const CONFIG_COMMANDS: { program: string; verbs: string[]; sub?: string }[] = [
  { program: 'npm', sub: 'config', verbs: ['set', 'delete', 'rm', 'edit', 'fix'] },
  { program: 'pnpm', sub: 'config', verbs: ['set', 'delete', 'rm', 'edit'] },
  { program: 'yarn', sub: 'config', verbs: ['set', 'delete', 'unset'] },
  { program: 'npm', sub: 'pkg', verbs: ['set', 'delete', 'fix'] },
  { program: 'gh', sub: 'config', verbs: ['set'] },
];

function commandHits(ctx: Ctx, cmd: Command, fallbackText: string): void {
  const p = cmd.program;
  const text = clip(cmd.text || fallbackText);
  // `$GIT push`, `"$tool" rm x`: the program is unknown, its words may still say what it does (the text itself is
  // checked for keywords as opaque)
  if (cmd.dynamic && cmd.argv.slice(1).some(a => DANGER_WORDS.has(a.toLowerCase()))) add(ctx, 'unparsed', `${text}（程式名稱是變數）`);
  if (DELETERS.has(p)) add(ctx, 'delete-files', text);
  if (p === 'find' && cmd.argv.includes('-delete')) add(ctx, 'delete-files', text);
  if (/(::|\.)(delete|deletefile|deletedirectory)$/.test(p) || /^\.delete$/.test(p)) add(ctx, 'delete-files', text);
  if (p === 'git') git(ctx, cmd);
  if (p === 'gh') gh(ctx, cmd);
  if (HTTP_CLIENTS.has(p)) httpGithub(ctx, cmd);
  for (const c of CONFIG_COMMANDS) {
    if (p !== c.program) continue;
    const pos = positionals(cmd.argv);
    if (pos[0] === c.sub && pos[1] && c.verbs.includes(pos[1])) add(ctx, 'config-files', text);
  }
  if (p === 'setx') add(ctx, 'config-files', text);
  const { writes, deletes } = fileTargets(cmd);
  if (deletes.length && (p === 'mv' || p === 'move' || p === 'move-item' || p === 'mi')) add(ctx, 'delete-files', text);
  const targets: { written: string; op: 'write' | 'delete' }[] = [...writes.map(w => ({ written: w, op: 'write' as const })), ...deletes.map(w => ({ written: w, op: 'delete' as const }))];
  for (const { written, op } of targets) {
    const path = resolve(written, cmd.cwd, ctx.cwd);
    if (path === null) {
      add(ctx, 'unreadable', `${text}（切換到無法判斷的目錄後${op === 'write' ? '寫入' : '刪除'} ${written}）`);
      continue;
    }
    checkPath(ctx, path, resolve(written, cmd.cwd, undefined) ?? written, op, `${text}（${op === 'write' ? '寫入' : '刪除'} ${written}）`);
  }
  for (const r of ctx.config.custom) {
    let matched = false;
    if (r.command && p === r.command[0]) {
      const words = cmd.argv.slice(1).map(w => w.toLowerCase());
      let k = 1;
      for (const w of words) if (k < r.command.length && w === r.command[k]) k++;
      matched = k === r.command.length;
    }
    if (!matched && r.pattern) matched = r.pattern.test(cmd.text);
    if (matched) addCustom(ctx, r, text);
  }
}

function addCustom(ctx: Ctx, r: CustomRule, detail: string): void {
  if (ctx.hits.some(h => h.rule === r.id && h.detail === detail)) return;
  ctx.hits.push({ rule: r.id, description: r.description, action: r.action, high: false, detail });
}

// A command line longer than this is not read at all (the card is asked for instead)
export const MAX_COMMAND_LENGTH = 16 * 1024;
// Time the judging may take before it gives up and asks; the hook's own limit (plugin.json `timeout`) is 10 s, and a
// hook that runs past it counts as having no opinion, which would let the request through
export const BUDGET_MS = 2000;

export interface EvaluateOptions {
  // Override BUDGET_MS (tests)
  budgetMs?: number;
}

function judge(ctx: Ctx, req: Request): void {
  const { config } = ctx;
  tick(ctx);
  if (req.execute && !req.commands.length) add(ctx, 'unreadable', '執行請求裡找不到要執行的指令');
  if (req.kind === 'delete') add(ctx, 'delete-files', clip(req.paths.join(', ') || '刪除工具'));
  for (const path of req.paths) {
    const full = resolve(path, '', ctx.cwd) ?? path;
    checkPath(ctx, full, path, req.kind === 'delete' ? 'delete' : 'write', path);
  }

  for (const src of req.commands) {
    tick(ctx);
    if (src.length > MAX_COMMAND_LENGTH) {
      add(ctx, 'unreadable', `${clip(src)}（指令長 ${src.length} 字元，超過 ${MAX_COMMAND_LENGTH}，不解析）`);
      continue;
    }
    const a = analyze(src, 'posix', ctx.deadline);
    for (const cmd of a.commands) {
      tick(ctx);
      commandHits(ctx, cmd, src);
    }
    for (const o of a.opaque) {
      tick(ctx);
      const k = keywords(o.text);
      if (k.length) add(ctx, 'unparsed', `${clip(o.text)}（${o.why}：${k.join('、')}）`);
      inlineWrites(ctx, o.text);
    }
    if (a.problems.length) {
      const k = keywords(src);
      if (k.length) add(ctx, 'unparsed', `${clip(src)}（${[...new Set(a.problems)].join('、')}：${k.join('、')}）`);
    }
    for (const r of config.custom) if (r.pattern && r.pattern.test(src)) addCustom(ctx, r, clip(src));
  }
}

// The verdict for one permission hook payload
export function evaluate(payload: unknown, config: Config, options: EvaluateOptions = {}): Verdict {
  const req = extractRequest(payload);
  const ctx: Ctx = { config, hits: [], deadline: Date.now() + (options.budgetMs ?? BUDGET_MS), cwd: req.cwd };
  try {
    judge(ctx, req);
  } catch (e) {
    if (!(e instanceof OutOfTime)) throw e;
    add(ctx, 'unreadable', `判斷超過 ${options.budgetMs ?? BUDGET_MS} 毫秒，停止解析`);
  }
  const decision = ctx.hits.length === 0 ? 'pass' : ctx.hits.some(h => h.action === 'deny') ? 'deny' : 'ask';
  return { decision, hits: ctx.hits, reason: describe(ctx.hits) };
}

export function describe(hits: Hit[]): string {
  if (!hits.length) return '';
  const rules = [...new Set(hits.map(h => h.description))].join('、');
  const details = [...new Set(hits.map(h => h.detail))].slice(0, 3).join('；');
  return `${rules}：${details}`;
}
