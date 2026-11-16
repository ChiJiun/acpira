// The approval rules: which permission requests must reach the user as a card (or be refused), whatever the session's
// access level. Pure: it reads a permission hook payload and a configuration and returns a verdict, with no
// dependency on Acpira, so the test suite drives it directly.

import { analyze, type Command, programName, quoteArgv } from './shell';

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
} as const;

export type BuiltinId = keyof typeof BUILTIN;

// Rules a user setting cannot switch off: the plugin's own configuration stays behind a card
const LOCKED: ReadonlySet<BuiltinId> = new Set(['self-config']);

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

// Paths of the plugin's own settings (the data folder's config and every project's file)
const SELF_FILES: readonly string[] = ['plugins/.data/approval-rules/**', '.agents/approval-rules.json'];

export interface CustomRule {
  id: string;
  description: string;
  action: Action;
  // Program then words that must follow it in order (flags in between are ignored): ["terraform", "apply"]
  command?: string[];
  // File globs: an edit, a deletion or a shell write of a matching file
  paths?: RegExp[];
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
  configMatchers: RegExp[];
  selfMatchers: RegExp[];
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

// Globs: `**` any depth, `*` and `?` within a segment, `{a,b}` alternatives; a pattern matches at any depth, case-insensitively
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  if (g.endsWith('/')) g += '**';
  g = g.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/(\*\*\/)+/g, '**/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${g.slice(i + 1, end).split(',').map(escape).join('|')})`;
        i = end;
      }
    } else re += escape(c);
  }
  // `dir/**` also names the folder itself
  if (re.endsWith('/.*')) re = `${re.slice(0, -3)}(?:/.*)?`;
  return new RegExp(`(?:^|/)${re}$`, 'i');
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function matchesAny(path: string, res: RegExp[]): boolean {
  const p = normalizePath(path);
  return res.some(r => r.test(p));
}

// `owner/repo` from a slug, `host/owner/repo`, an https or ssh URL; lowercase, without `.git`
export function normalizeRepo(s: string): string {
  let r = s.trim().toLowerCase();
  r = r.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  r = r.replace(':', '/');
  const parts = r.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
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
const MAX_PATTERN_LENGTH = 300;

function compileCustom(raw: unknown, source: 'user' | 'project', index: number, warnings: string[]): CustomRule | null {
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
  const paths = strings(raw.paths).slice(0, MAX_PATTERNS).filter(p => p.length <= MAX_PATTERN_LENGTH);
  if (paths.length) rule.paths = paths.map(globToRegExp);
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

  if (user !== undefined && user !== null) {
    if (!isObject(user)) warnings.push('使用者設定不是 JSON 物件，改用預設規則');
    else {
      for (const k of Object.keys(user)) if (!USER_KEYS.has(k)) warnings.push(`使用者設定有不認得的欄位 ${k}`);
      const high = user.highRisk === 'deny' ? 'deny' : 'ask';
      if (user.highRisk !== undefined && user.highRisk !== 'ask' && user.highRisk !== 'deny') warnings.push('highRisk 只能是 "ask" 或 "deny"');
      for (const id of Object.keys(BUILTIN) as BuiltinId[]) if (BUILTIN[id].high) rules[id].action = high;
      if (isObject(user.rules)) {
        for (const [id, v] of Object.entries(user.rules)) {
          if (!(id in BUILTIN)) {
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
      if (Array.isArray(user.custom)) user.custom.forEach((r, i) => { const c = compileCustom(r, 'user', i, warnings); if (c) custom.push(c); });
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
        configFiles.push(...strings(project.configFiles.add).slice(0, MAX_PATTERNS).filter(p => p.length <= MAX_PATTERN_LENGTH));
      }
      if (Array.isArray(project.custom)) {
        project.custom.slice(0, MAX_PATTERNS).forEach((r, i) => { const c = compileCustom(r, 'project', i, warnings); if (c) custom.push(c); });
      }
    }
  }

  return {
    config: {
      rules,
      configFiles,
      configMatchers: configFiles.map(globToRegExp),
      selfMatchers: SELF_FILES.map(globToRegExp),
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
  // Command lines to read (rawInput, the tool row's target, backquoted parts of the title)
  commands: string[];
  // Files an edit-like tool would change
  paths: string[];
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'notebook_path', 'target_file', 'source', 'destination', 'old_path', 'new_path', 'oldPath', 'newPath'];
const COMMAND_KEYS = ['command', 'cmd', 'CommandLine', 'commandLine'];
// Kinds whose paths are read, never written
const READING = new Set(['read', 'search', 'fetch', 'think', 'execute', 'switch_mode']);

export function extractRequest(payload: unknown): Request {
  const p = isObject(payload) ? payload : {};
  const tc = isObject(p.toolCall) ? p.toolCall : {};
  const row = isObject(p.row) ? p.row : {};
  const raw = isObject(tc.rawInput) ? tc.rawInput : {};
  const kind = typeof tc.kind === 'string' ? tc.kind : typeof row.kind === 'string' ? row.kind : undefined;
  const commands = new Set<string>();
  for (const k of COMMAND_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) commands.add(v);
    else if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) commands.add(quoteArgv(v as string[]));
  }
  if (kind === 'execute' && typeof row.target === 'string' && row.target.trim()) commands.add(row.target);
  if (kind === 'execute' || kind === undefined) {
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
  return { kind, commands: [...commands], paths: [...paths] };
}

// Keyword checks for what could not be read

const KEYWORDS: { re: RegExp; what: string }[] = [
  { re: /\b(rm|rmdir|unlink|shred|del|erase|rd|remove-item|rimraf|rmtree|rmsync|rmdirsync|unlinksync|os\.remove|deletefile|deletedirectory)\b/i, what: '刪除' },
  { re: /\bgit\b[\s\S]*\b(push|rm|clean|reset|checkout|restore|stash|branch|worktree|config|remote|update-ref)\b/i, what: 'git 寫入' },
  { re: /\bgh\b[\s\S]*\b(merge|delete|create|edit|close|api|repo)\b/i, what: 'gh 寫入' },
  { re: /--force\b|--force-with-lease|--mirror\b/i, what: '強制' },
];

function keywords(text: string): string[] {
  return KEYWORDS.filter(k => k.re.test(text)).map(k => k.what);
}

// Commands

interface Ctx {
  config: Config;
  hits: Hit[];
}

function add(ctx: Ctx, rule: BuiltinId, detail: string): void {
  const s = ctx.config.rules[rule];
  if (!s.enabled) return;
  if (ctx.hits.some(h => h.rule === rule && h.detail === detail)) return;
  ctx.hits.push({ rule, description: BUILTIN[rule].description, action: s.action, high: BUILTIN[rule].high, detail });
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
      if (has('--hard', '--merge')) add(ctx, 'git-discard', text);
      return;
    case 'checkout':
      if (has('--', '--force', '--ours', '--theirs', '--patch') || cluster('f') || cluster('p') || positionals(['', ...args]).includes('.')) add(ctx, 'git-discard', text);
      return;
    case 'restore': {
      const staged = has('--staged') || cluster('S');
      const worktree = has('--worktree') || cluster('W');
      if (!staged || worktree) add(ctx, 'git-discard', text);
      return;
    }
    case 'switch':
      if (has('--discard-changes', '--force') || cluster('f')) add(ctx, 'git-discard', text);
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

function gh(ctx: Ctx, cmd: Command): void {
  const argv = cmd.argv;
  const text = cmd.text;
  let repo: string | undefined;
  const pos: string[] = [];
  const flags: string[] = [];
  const fields: string[] = [];
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
    if (short === '-X' || name === '--method') method = value?.toUpperCase();
    if (['-f', '-F', '--field', '--raw-field'].includes(short) || ['--field', '--raw-field'].includes(name)) fields.push(value ?? '');
    if (name === '--input' || short === '--input') fields.push(value ?? '');
  }
  const group = pos[0];
  const verb = pos[1];
  if (!group) return;
  const foreign = (what: string) => {
    if (repo === undefined) add(ctx, 'foreign-repo', `${text}（沒有指定 --repo，gh 可能作用在 upstream）`);
    else if (!ctx.config.allowedRepos.includes(normalizeRepo(repo))) add(ctx, 'foreign-repo', `${text}（${what} ${repo} 不在 allowedRepos）`);
  };
  const flag = (...names: string[]) => flags.some(f => names.includes(f) || names.some(n => n.startsWith('--') && f.startsWith(`${n}=`)));
  const cluster = (letter: string) => flags.some(f => shortFlags(f).includes(letter));
  if (group === 'api') {
    const endpoint = (verb ?? '').replace(/^\/+/, '');
    const m = method ?? (fields.length ? 'POST' : 'GET');
    const all = fields.join(' ');
    if (m === 'GET' && !/mutation/i.test(all)) return;
    const target = /^repos\/([^/]+)\/([^/?]+)/i.exec(endpoint);
    if (target && !target[1]!.startsWith('{') && !target[2]!.startsWith('{')) {
      if (!ctx.config.allowedRepos.includes(`${target[1]}/${target[2]}`.toLowerCase())) add(ctx, 'foreign-repo', `${text}（API 寫入 ${target[1]}/${target[2]} 不在 allowedRepos）`);
    } else if (endpoint !== 'graphql') add(ctx, 'foreign-repo', `${text}（gh api 寫入，無法確認目標 repo）`);
    if (m === 'DELETE' && /^repos\/[^/]+\/[^/?]+\/?$/i.test(endpoint)) add(ctx, 'repo-delete', text);
    if (m === 'DELETE' && /\/git\/refs\//i.test(endpoint)) add(ctx, 'branch-delete', text);
    if (/\/pulls\/[^/]+\/merge\b/i.test(endpoint)) {
      add(ctx, 'gh-merge', text);
      if (/merge_method=squash/i.test(all)) add(ctx, 'merge-squash', text);
      if (/merge_method=rebase/i.test(all)) add(ctx, 'merge-rebase', text);
    }
    if (endpoint === 'graphql') {
      add(ctx, 'foreign-repo', `${text}（GraphQL mutation，無法確認目標 repo）`);
      if (/enablePullRequestAutoMerge/i.test(all)) add(ctx, 'merge-auto', text);
      if (/mergePullRequest/i.test(all)) add(ctx, 'gh-merge', text);
      if (/deleteRepository/i.test(all)) add(ctx, 'repo-delete', text);
      if (/deleteRef\b/i.test(all)) add(ctx, 'branch-delete', text);
    }
    return;
  }
  if (group === 'pr' && verb === 'merge') {
    add(ctx, 'gh-merge', text);
    if (flag('--auto')) add(ctx, 'merge-auto', text);
    if (flag('--squash') || cluster('s')) add(ctx, 'merge-squash', text);
    if (flag('--rebase') || cluster('r')) add(ctx, 'merge-rebase', text);
    if (flag('--delete-branch') || cluster('d')) add(ctx, 'branch-delete', text);
  }
  if (group === 'repo' && verb === 'delete') add(ctx, 'repo-delete', text);
  if (group === 'repo' && verb === 'edit' && flag('--enable-auto-merge')) add(ctx, 'merge-auto', text);
  const writes = GH_WRITES[group];
  if (writes && verb && (writes.includes(verb) || (group === 'ruleset' && verb !== 'list' && verb !== 'view' && verb !== 'check'))) {
    // `gh repo delete owner/repo`, `gh repo edit owner/repo`: the repository is the operand
    if (group === 'repo' && repo === undefined && pos[2] && pos[2].includes('/')) repo = pos[2];
    if (group === 'repo' && verb === 'create') return;
    foreign('repo');
  }
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
  for (const c of CONFIG_COMMANDS) {
    if (p !== c.program) continue;
    const pos = positionals(cmd.argv);
    if (pos[0] === c.sub && pos[1] && c.verbs.includes(pos[1])) add(ctx, 'config-files', text);
  }
  if (p === 'setx') add(ctx, 'config-files', text);
  const { writes, deletes } = fileTargets(cmd);
  if (deletes.length && (p === 'mv' || p === 'move' || p === 'move-item' || p === 'mi')) add(ctx, 'delete-files', text);
  for (const w of writes) if (matchesAny(w, ctx.config.configMatchers)) add(ctx, 'config-files', `${text}（寫入 ${w}）`);
  for (const w of [...writes, ...deletes]) if (matchesAny(w, ctx.config.selfMatchers)) add(ctx, 'self-config', `${text}（${w}）`);
  for (const r of ctx.config.custom) {
    let matched = false;
    if (r.command && p === r.command[0]) {
      const words = cmd.argv.slice(1).map(w => w.toLowerCase());
      let k = 1;
      for (const w of words) if (k < r.command.length && w === r.command[k]) k++;
      matched = k === r.command.length;
    }
    if (!matched && r.paths) matched = [...writes, ...deletes].some(w => matchesAny(w, r.paths!));
    if (!matched && r.pattern) matched = r.pattern.test(cmd.text);
    if (matched) addCustom(ctx, r, text);
  }
}

function addCustom(ctx: Ctx, r: CustomRule, detail: string): void {
  if (ctx.hits.some(h => h.rule === r.id && h.detail === detail)) return;
  ctx.hits.push({ rule: r.id, description: r.description, action: r.action, high: false, detail });
}

// The verdict for one permission hook payload
export function evaluate(payload: unknown, config: Config): Verdict {
  const req = extractRequest(payload);
  const ctx: Ctx = { config, hits: [] };

  if (req.kind === 'delete') add(ctx, 'delete-files', clip(req.paths.join(', ') || '刪除工具'));
  for (const path of req.paths) {
    if (matchesAny(path, config.selfMatchers)) add(ctx, 'self-config', path);
    if (req.kind !== 'delete' && matchesAny(path, config.configMatchers)) add(ctx, 'config-files', path);
    for (const r of config.custom) if (r.paths && matchesAny(path, r.paths)) addCustom(ctx, r, path);
  }

  for (const src of req.commands) {
    const a = analyze(src);
    for (const cmd of a.commands) commandHits(ctx, cmd, src);
    for (const o of a.opaque) {
      const k = keywords(o.text);
      if (k.length) add(ctx, 'unparsed', `${clip(o.text)}（${o.why}：${k.join('、')}）`);
    }
    if (a.problems.length) {
      const k = keywords(src);
      if (k.length) add(ctx, 'unparsed', `${clip(src)}（${[...new Set(a.problems)].join('、')}：${k.join('、')}）`);
    }
    for (const r of config.custom) if (r.pattern && r.pattern.test(src)) addCustom(ctx, r, clip(src));
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
