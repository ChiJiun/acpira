// Git operations of the worktree-sessions plugin, kept free of the plugin SDK so the tests run them against real
// repositories. Every git call goes through execFile (no shell), so paths with spaces or non-ASCII characters pass
// through as single arguments. Errors a user can act on are WorktreeError with a stable `code`.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type ErrorCode =
  | 'git-missing'
  | 'no-folder'
  | 'not-a-repo'
  | 'no-commits'
  | 'bad-branch'
  | 'branch-exists'
  | 'bad-start'
  | 'path-exists'
  | 'path-registered'
  | 'not-found'
  | 'main-worktree'
  | 'locked'
  | 'missing-folder'
  | 'dirty'
  | 'git-failed';

export class WorktreeError extends Error {
  constructor(message: string, readonly code: ErrorCode) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 60_000;

// One git invocation; never throws for a non-zero exit (the caller decides), only when git cannot be started
export function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 << 20,
        // No credential prompt can hang a call; status in the listing must not take the index lock from a running agent
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new WorktreeError('找不到 git 指令：請確認 git 已安裝且在 PATH 上。', 'git-missing'));
          return;
        }
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function trimmed(r: GitResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split(/\r?\n/).slice(0, 6).join(' / ');
}

// A path in the form this platform compares by: resolved, and case-folded on Windows
export function samePathKey(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return samePathKey(a) === samePathKey(b);
}

export interface RepoInfo {
  // The working tree `cwd` is in (may itself be a linked worktree)
  top: string;
  // The main working tree, beside which worktrees are placed by default
  mainRoot: string;
  // Folder name of the main working tree
  name: string;
}

export async function repoOf(cwd: string): Promise<RepoInfo> {
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new WorktreeError(`資料夾不存在：${cwd || '(空白)'}`, 'no-folder');
  }
  const r = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], cwd);
  if (r.code !== 0) {
    throw new WorktreeError(`這個資料夾不是 git repo 的工作目錄：${cwd}（git：${trimmed(r)}）`, 'not-a-repo');
  }
  const [topRaw, commonRaw] = r.stdout.split(/\r?\n/).filter(Boolean);
  if (!topRaw || !commonRaw) throw new WorktreeError(`無法判斷 ${cwd} 所在的 git repo。`, 'not-a-repo');
  const top = path.resolve(topRaw);
  const common = path.resolve(commonRaw);
  // `<main>/.git` for an ordinary repo; any other layout (a separate git dir) keeps the current tree as the anchor
  const mainRoot = path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : top;
  return { top, mainRoot, name: path.basename(mainRoot) || 'repo' };
}

// A branch name as one folder name: separators and characters Windows refuses become `-`
export function branchSlug(branch: string): string {
  const slug = branch
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return slug || 'worktree';
}

// Where worktrees of `mainRoot` go. Default: a sibling folder `<repo>.worktrees` next to the repository, so nothing
// lands inside the repo's own tree. `setting` (the plugin's `root`) may name another folder, absolute or relative to
// the repository's parent, with `{repo}` standing for the repository's folder name
export function worktreeBase(mainRoot: string, setting?: string | null): string {
  const name = path.basename(mainRoot) || 'repo';
  const parent = path.dirname(mainRoot);
  const s = setting?.trim();
  if (!s) return path.join(parent, `${name}.worktrees`);
  return path.resolve(parent, s.split('{repo}').join(name));
}

export function worktreePath(mainRoot: string, branch: string, setting?: string | null): string {
  return path.join(worktreeBase(mainRoot, setting), branchSlug(branch));
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  // Short name (`feature/x`), null when detached or bare
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  // The repository's main working tree (listed first by git)
  main: boolean;
}

export interface WorktreeStatus extends WorktreeEntry {
  exists: boolean;
  // Changed or untracked paths, null when the folder is gone or bare
  dirty: number | null;
  upstream: string | null;
  // Commits on the branch the upstream lacks; without an upstream, commits found on no remote at all
  unpushed: number | null;
  behind: number | null;
}

// `git worktree list --porcelain -z`: NUL-terminated lines, an empty one between records
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.split('\0')) {
    if (line === '') {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) entries.push(cur);
      cur = { path: path.resolve(value), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, main: entries.length === 0 };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) entries.push(cur);
  entries.forEach((e, i) => { e.main = i === 0; });
  return entries;
}

export async function worktreeEntries(repo: RepoInfo): Promise<WorktreeEntry[]> {
  const r = await git(['worktree', 'list', '--porcelain', '-z'], repo.top);
  if (r.code !== 0) throw new WorktreeError(`git worktree list 失敗：${trimmed(r)}`, 'git-failed');
  return parseWorktreeList(r.stdout);
}

// Entries of `git status --porcelain -z`; a rename or copy carries its source as one more field
export function countStatus(out: string): number {
  const fields = out.split('\0');
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    n++;
    if (f[0] === 'R' || f[0] === 'C') i++;
  }
  return n;
}

async function statusOf(e: WorktreeEntry): Promise<WorktreeStatus> {
  const exists = existsSync(e.path) && statSync(e.path).isDirectory();
  const base: WorktreeStatus = { ...e, exists, dirty: null, upstream: null, unpushed: null, behind: null };
  if (!exists || e.bare) return base;
  const st = await git(['status', '--porcelain', '-z', '--untracked-files=normal'], e.path);
  if (st.code === 0) base.dirty = countStatus(st.stdout);
  if (!e.head || /^0+$/.test(e.head)) return base;
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], e.path);
  if (up.code === 0 && up.stdout.trim()) {
    base.upstream = up.stdout.trim();
    const lr = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], e.path);
    const [behind, ahead] = lr.stdout.trim().split(/\s+/).map(Number);
    if (lr.code === 0 && Number.isFinite(ahead) && Number.isFinite(behind)) {
      base.unpushed = ahead ?? null;
      base.behind = behind ?? null;
    }
  } else {
    const rl = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], e.path);
    if (rl.code === 0) base.unpushed = Number(rl.stdout.trim());
  }
  return base;
}

export interface Listing {
  repo: RepoInfo;
  worktrees: WorktreeStatus[];
}

export async function listWorktrees(cwd: string): Promise<Listing> {
  const repo = await repoOf(cwd);
  const entries = await worktreeEntries(repo);
  return { repo, worktrees: await Promise.all(entries.map(statusOf)) };
}

export interface CreateOptions {
  cwd: string;
  branch: string;
  // A commit-ish; the HEAD of `cwd`'s working tree when absent
  start?: string | null;
  // The plugin's `root` setting (see worktreeBase)
  root?: string | null;
}

export interface Created {
  repo: RepoInfo;
  path: string;
  branch: string;
  start: string;
  commit: string;
}

export async function validateBranch(branch: string, cwd: string): Promise<void> {
  if (!branch || branch.startsWith('-')) throw new WorktreeError(`分支名稱不合法：「${branch}」`, 'bad-branch');
  const r = await git(['check-ref-format', '--branch', branch], cwd);
  if (r.code !== 0 || r.stdout.trim() !== branch) throw new WorktreeError(`分支名稱不合法：「${branch}」（git check-ref-format 不接受）`, 'bad-branch');
}

export async function branchExists(branch: string, cwd: string): Promise<boolean> {
  return (await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd)).code === 0;
}

async function resolveCommit(start: string, cwd: string): Promise<string | null> {
  if (start.startsWith('-')) return null;
  const r = await git(['rev-parse', '--verify', '--quiet', `${start}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

// The nearest ancestor of `p` that exists, so a rollback removes only the folders this run created
function existingAncestor(p: string): string {
  let cur = path.dirname(p);
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

function removeIfEmpty(dir: string): boolean {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmdirSync(dir);
      return true;
    }
  } catch {
    // left for the user: the error message names the path
  }
  return false;
}

// Create branch `branch` at `start` and a worktree for it. On any failure the repository is left as it was: a
// half-registered worktree is removed, the branch this call made (still at `start`) is deleted, and folders it created
// are removed when empty
export async function createWorktree(o: CreateOptions): Promise<Created> {
  const repo = await repoOf(o.cwd);
  const branch = o.branch.trim();
  await validateBranch(branch, repo.top);
  if (await branchExists(branch, repo.top)) {
    throw new WorktreeError(`分支「${branch}」已存在。請換一個分支名稱；這個外掛只為新分支建立 worktree。`, 'branch-exists');
  }
  const start = o.start?.trim() || 'HEAD';
  const commit = await resolveCommit(start, o.cwd);
  if (!commit) {
    if (start === 'HEAD') throw new WorktreeError('這個 repo 還沒有任何 commit，無法建立 worktree。', 'no-commits');
    throw new WorktreeError(`找不到起點「${start}」（需要分支、tag 或 commit）。`, 'bad-start');
  }
  const target = worktreePath(repo.mainRoot, branch, o.root);
  if (existsSync(target)) {
    throw new WorktreeError(`worktree 路徑已存在：${target}。請換分支名稱、移走該資料夾，或用 /worktree config root 改放置位置。`, 'path-exists');
  }
  const registered = (await worktreeEntries(repo)).find(e => samePath(e.path, target));
  if (registered) {
    throw new WorktreeError(`git 仍登記著路徑 ${target}（資料夾已不在）。請先在 repo 執行 git worktree prune 再重試。`, 'path-registered');
  }
  const anchor = existingAncestor(target);
  const r = await git(['worktree', 'add', '-b', branch, target, commit], repo.top);
  if (r.code !== 0 || !existsSync(target)) {
    await rollback(repo, target, anchor, branch, commit);
    throw new WorktreeError(`git worktree add 失敗，已還原：${trimmed(r)}`, 'git-failed');
  }
  return { repo, path: target, branch, start, commit };
}

async function rollback(repo: RepoInfo, target: string, anchor: string, branch: string, commit: string): Promise<void> {
  const entries = await worktreeEntries(repo).catch(() => [] as WorktreeEntry[]);
  // Only the worktree this call just added: it holds nothing but the checkout of `commit`
  if (entries.some(e => samePath(e.path, target))) await git(['worktree', 'remove', '--force', target], repo.top);
  removeIfEmpty(target);
  for (let dir = path.dirname(target); samePathKey(dir).startsWith(samePathKey(anchor)) && !samePath(dir, anchor); dir = path.dirname(dir)) {
    if (!removeIfEmpty(dir)) break;
  }
  const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo.top);
  if (tip.code === 0 && tip.stdout.trim() === commit) await git(['branch', '-D', branch], repo.top);
}

// Find a worktree by path or branch name
export function findWorktree<T extends WorktreeEntry>(list: T[], target: string, cwd: string): T | undefined {
  const t = target.trim();
  return list.find(e => e.branch === t) ?? list.find(e => samePath(e.path, path.resolve(cwd, t)));
}

// Why `e` may not be removed, or null when it may
export function removalBlocker(e: WorktreeStatus): WorktreeError | null {
  if (e.main) return new WorktreeError(`${e.path} 是 repo 的主工作目錄，不能移除。`, 'main-worktree');
  if (e.bare) return new WorktreeError(`${e.path} 是 bare repo，不能移除。`, 'main-worktree');
  if (e.locked) return new WorktreeError(`worktree ${e.path} 已被鎖定（git worktree lock），請先解鎖。`, 'locked');
  if (!e.exists) return new WorktreeError(`worktree 資料夾已不存在：${e.path}。git 的登記可用 git worktree prune 清掉。`, 'missing-folder');
  if (e.dirty === null) return new WorktreeError(`無法讀取 ${e.path} 的 git status，為安全起見不移除。`, 'git-failed');
  if (e.dirty > 0) {
    return new WorktreeError(`worktree ${e.path} 有 ${e.dirty} 個未 commit 的變更（含未追蹤檔案），不移除。請先 commit、stash 或自行清掉後再試。`, 'dirty');
  }
  return null;
}

export interface Removed {
  path: string;
  branch: string | null;
  unpushed: number | null;
}

// Look up and check a worktree for removal without touching it; `main` is the main working tree git runs in
export async function inspectRemoval(cwd: string, target: string): Promise<WorktreeStatus & { mainPath: string }> {
  const { repo, worktrees } = await listWorktrees(cwd);
  const e = findWorktree(worktrees, target, cwd);
  if (!e) throw new WorktreeError(`找不到 worktree「${target}」（請給分支名稱或路徑；/worktree list 可列出全部）。`, 'not-found');
  const blocked = removalBlocker(e);
  if (blocked) throw blocked;
  return { ...e, mainPath: worktrees.find(w => w.main)?.path ?? repo.mainRoot };
}

// Remove a clean worktree's folder and registration; the branch stays. Re-checks right before removing, and never
// passes --force, so git itself also refuses a worktree with changes
export async function removeWorktree(cwd: string, target: string): Promise<Removed> {
  const e = await inspectRemoval(cwd, target);
  const r = await git(['worktree', 'remove', e.path], e.mainPath);
  if (r.code !== 0) throw new WorktreeError(`git worktree remove 失敗：${trimmed(r)}`, 'git-failed');
  return { path: e.path, branch: e.branch, unpushed: e.unpushed };
}
