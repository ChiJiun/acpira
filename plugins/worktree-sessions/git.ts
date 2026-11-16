// Git operations of the worktree-sessions plugin, kept free of the plugin SDK so the tests run them against real
// repositories. Every git call goes through execFile (no shell), so paths with spaces or non-ASCII characters pass
// through as single arguments. Errors a user can act on are WorktreeError with a stable `code`.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
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
  | 'unreferenced'
  | 'remove-incomplete'
  | 'git-failed';

export class WorktreeError extends Error {
  // For `remove-incomplete`: whether git still registers the worktree after the failed removal
  registered?: boolean;
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
  // Ignored files and folders (`.env`, `build/`): not changes, but a removal deletes them
  ignored: number | null;
  upstream: string | null;
  // Commits on the branch the upstream lacks; without an upstream, commits found on no remote at all (null when the
  // repository has no remote)
  unpushed: number | null;
  behind: number | null;
  // The repository has no remote at all, so nothing is "pushed" or not
  noRemote: boolean;
  // Detached HEAD only: commits reachable from no branch, tag or remote, lost to everything but the reflog once the
  // worktree goes
  unreferenced: number | null;
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

// Entries of `git status --porcelain -z --ignored`: `!!` marks an ignored path, everything else a change; a rename or
// copy carries its source as one more field
export function countStatus(out: string): { changed: number; ignored: number } {
  const fields = out.split('\0');
  let changed = 0;
  let ignored = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    if (f.startsWith('!!')) ignored++;
    else changed++;
    if (f[0] === 'R' || f[0] === 'C') i++;
  }
  return { changed, ignored };
}

async function statusOf(e: WorktreeEntry, hasRemote: boolean): Promise<WorktreeStatus> {
  const exists = existsSync(e.path) && statSync(e.path).isDirectory();
  const base: WorktreeStatus = { ...e, exists, dirty: null, ignored: null, upstream: null, unpushed: null, behind: null, noRemote: !hasRemote, unreferenced: null };
  if (!exists || e.bare) return base;
  const st = await git(['status', '--porcelain', '-z', '--untracked-files=normal', '--ignored=traditional'], e.path);
  if (st.code === 0) {
    const c = countStatus(st.stdout);
    base.dirty = c.changed;
    base.ignored = c.ignored;
  }
  if (!e.head || /^0+$/.test(e.head)) return base;
  if (e.detached) {
    const lost = await git(['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes'], e.path);
    if (lost.code === 0) base.unreferenced = Number(lost.stdout.trim());
  }
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], e.path);
  if (up.code === 0 && up.stdout.trim()) {
    base.upstream = up.stdout.trim();
    const lr = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], e.path);
    const [behind, ahead] = lr.stdout.trim().split(/\s+/).map(Number);
    if (lr.code === 0 && Number.isFinite(ahead) && Number.isFinite(behind)) {
      base.unpushed = ahead ?? null;
      base.behind = behind ?? null;
    }
  } else if (hasRemote) {
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
  const remotes = await git(['remote'], repo.top);
  const hasRemote = remotes.code !== 0 || remotes.stdout.trim().length > 0;
  return { repo, worktrees: await Promise.all(entries.map(e => statusOf(e, hasRemote))) };
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

// Create branch `branch` at `start` and a worktree for it. The branch is made first, on its own (`git branch` refuses a
// name that exists, atomically): it is this call's proof of ownership, so a failure afterwards undoes only what this
// call made, even with another process creating the same branch or path at the same moment
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
  const made = await git(['branch', '--no-track', branch, commit], repo.top);
  if (made.code !== 0) {
    // Nothing of this call exists yet: nothing to undo
    if (await branchExists(branch, repo.top)) {
      throw new WorktreeError(`分支「${branch}」剛被其他操作建立。請換一個分支名稱。`, 'branch-exists');
    }
    throw new WorktreeError(`git branch 失敗：${trimmed(made)}`, 'git-failed');
  }
  const r = await git(['worktree', 'add', target, branch], repo.top);
  if (r.code !== 0) {
    const undone = await rollback(repo, target, branch, commit);
    const code: ErrorCode = existsSync(target) && !undone.ownWorktree ? 'path-exists' : 'git-failed';
    throw new WorktreeError(`git worktree add 失敗${undone.note}：${trimmed(r)}`, code);
  }
  return { repo, path: target, branch, start, commit };
}

// Undo a failed `worktree add` of `branch`, which this call created at `commit`. Only what is provably this call's
// goes: a worktree registered at `target` on `branch`, then the branch itself, deleted only while it still points at
// `commit` and no worktree has it checked out (`update-ref -d` compares and deletes atomically). Folders are left to
// git, which removes what its failed `worktree add` created; another process may be filling the same path
async function rollback(repo: RepoInfo, target: string, branch: string, commit: string): Promise<{ ownWorktree: boolean; note: string }> {
  let entries = await worktreeEntries(repo).catch(() => null);
  const own = entries?.find(e => samePath(e.path, target) && e.branch === branch);
  if (own) {
    await git(['worktree', 'remove', '--force', own.path], repo.top);
    entries = await worktreeEntries(repo).catch(() => null);
  }
  const checkedOut = entries === null || entries.some(e => e.branch === branch);
  const deleted = !checkedOut && (await git(['update-ref', '-d', `refs/heads/${branch}`, commit], repo.top)).code === 0;
  return { ownWorktree: !!own, note: deleted ? '，已還原' : `，分支「${branch}」留著（已有 worktree 使用或已有新 commit）` };
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
  if (e.detached && e.unreferenced === null) {
    return new WorktreeError(`無法確認 ${e.path} 的 detached HEAD 是否有不在任何分支上的 commit，為安全起見不移除。`, 'git-failed');
  }
  if (e.unreferenced) {
    return new WorktreeError(`worktree ${e.path} 是 detached HEAD，有 ${e.unreferenced} 個 commit 不在任何分支、tag 或遠端上，移除後只能從 reflog 找回，不移除。請先替它建立分支。`, 'unreferenced');
  }
  return null;
}

export interface Removed {
  path: string;
  branch: string | null;
  unpushed: number | null;
  ignored: number | null;
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
  const done: Removed = { path: e.path, branch: e.branch, unpushed: e.unpushed, ignored: e.ignored };
  if (r.code === 0) return done;
  // git may have deleted part of the folder, or unregistered it and then failed on the folder itself (Windows, a
  // process running in it): look again and say what is actually left
  const entries = await git(['worktree', 'list', '--porcelain', '-z'], e.mainPath);
  const registered = entries.code !== 0 || parseWorktreeList(entries.stdout).some(w => samePath(w.path, e.path));
  const folder = existsSync(e.path);
  if (!registered && !folder) return done;
  let left = 0;
  try {
    left = folder ? readdirSync(e.path).length : 0;
  } catch {
    // unreadable: counted as nothing
  }
  const branch = e.branch ? `分支「${e.branch}」保留，commit 都還在。` : '';
  const why = `（git：${trimmed(r)}）`;
  let message: string;
  if (!registered) {
    message = `git 已取消 worktree ${e.path} 的登記，但資料夾刪不掉（可能有程式正在使用它，例如還在執行的 agent），裡面還剩 ${left} 個項目。${branch}關掉使用它的程式後，請手動刪除這個資料夾。${why}`;
  } else if (folder) {
    message = `git worktree remove 沒有完成，worktree ${e.path} 仍登記著，部分檔案可能已被刪除（還剩 ${left} 個項目）。worktree 原本是乾淨的，關掉使用它的程式後，可以在該資料夾執行 git checkout -- . 還原，或再移除一次。${branch}${why}`;
  } else {
    message = `資料夾 ${e.path} 已刪除，但 git 仍登記著它；可在 repo 執行 git worktree prune 清掉登記。${branch}${why}`;
  }
  const err = new WorktreeError(message, 'remove-incomplete');
  err.registered = registered;
  throw err;
}
