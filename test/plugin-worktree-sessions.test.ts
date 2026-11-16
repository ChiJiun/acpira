import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  branchExists, branchSlug, createWorktree, inspectRemoval, listWorktrees, parseWorktreeList, removeWorktree, samePath,
  worktreeBase, worktreePath, WorktreeError,
} from '../plugins/worktree-sessions/git';
import { parseCommand, splitArgs } from '../plugins/worktree-sessions/core';
import type { HostMsg } from '@acpira/shared/protocol';
import { SIDECAR_PROTOCOL_VERSION, type SidecarMsg } from '@acpira/shared/sidecar';
import { FAKE, NODE, Shell } from './sidecarShell';

// Waits on the sidecar: a slow machine starts the engine, the plugin process and fake agents one after another
const SLOW = 240_000;
const step = (what: string) => console.log(`[worktree-sessions e2e] ${new Date().toISOString()} ${what}`);

// The worktree-sessions plugin (plugins/worktree-sessions/): its git module against real repositories in a temp folder
// whose path has spaces and non-ASCII characters, its argument parsing, and the whole plugin end to end through the
// Rust sidecar and the fake agent (`/worktree <branch>` opens a session whose folder is the new worktree)

const PLUGIN_SRC = fileURLToPath(new URL('../plugins/worktree-sessions/', import.meta.url));

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.email', 'test@example.com');
  run(dir, 'config', 'user.name', 'Test');
  run(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// Frozen plugin copies are read-only, folders included: open them up so the temp dir can go
function writable(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) writable(p);
    else if (e.isFile()) chmodSync(p, 0o644);
  }
}

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      writable(d);
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e) {
      // A process of the sidecar may still hold a file on Windows: the temp folder is left, the test result stands
      console.warn(`left ${d}: ${String(e)}`);
    }
  }
}, 60_000);

async function failure(p: Promise<unknown>): Promise<WorktreeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WorktreeError);
    return e as WorktreeError;
  }
  throw new Error('expected a WorktreeError');
}

describe('worktree-sessions: paths and arguments', () => {
  it('places worktrees beside the repository by default, or where `root` says', () => {
    const repo = join('C:', 'Work Space', '專案', 'app');
    expect(worktreeBase(repo)).toBe(join('C:', 'Work Space', '專案', 'app.worktrees'));
    expect(worktreePath(repo, 'feature/log in')).toBe(join('C:', 'Work Space', '專案', 'app.worktrees', 'feature-log-in'));
    expect(worktreeBase(repo, 'trees/{repo}')).toBe(join('C:', 'Work Space', '專案', 'trees', 'app'));
    const abs = join(tmpdir(), 'wt root', '{repo}-x');
    expect(worktreeBase(repo, abs)).toBe(join(tmpdir(), 'wt root', 'app-x'));
    expect(branchSlug('a//b:c*')).toBe('a-b-c');
    expect(branchSlug('...')).toBe('worktree');
  });

  it('parses /worktree arguments', () => {
    expect(splitArgs('remove "D:\\My Work\\x" ')).toEqual(['remove', 'D:\\My Work\\x']);
    expect(parseCommand('')).toEqual({ kind: 'help' });
    expect(parseCommand('feature/x origin/main')).toEqual({ kind: 'create', branch: 'feature/x', start: 'origin/main' });
    expect(parseCommand('new list')).toEqual({ kind: 'create', branch: 'list', start: null });
    expect(parseCommand('list')).toEqual({ kind: 'list' });
    expect(parseCommand('rm feature/x')).toEqual({ kind: 'remove', target: 'feature/x' });
    expect(parseCommand('remove')).toEqual({ kind: 'remove', target: null });
    expect(parseCommand('config root default')).toEqual({ kind: 'config', key: 'root', value: 'default' });
    expect(parseCommand('a b c').kind).toBe('error');
    expect(parseCommand('config colour red').kind).toBe('error');
  });

  it('reads git worktree list --porcelain -z', () => {
    const out = ['worktree /r/main', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /r/x y', 'HEAD def', 'detached', 'locked', ''].join('\0');
    const list = parseWorktreeList(out);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ branch: 'main', main: true, detached: false });
    expect(list[1]).toMatchObject({ branch: null, main: false, detached: true, locked: true });
  });
});

// Every git call spawns a process: slow on Windows with an antivirus filter
describe('worktree-sessions: git against real repositories', { timeout: 180_000 }, () => {
  it('creates a worktree on a new branch beside a repo whose path has spaces and non-ASCII characters', async () => {
    const root = temp('acpira-wt-');
    const repo = makeRepo(join(root, 'my repo 專案', 'app'));
    const made = await createWorktree({ cwd: repo, branch: 'feature/log in'.replace(' ', '-') });
    expect(made.path).toBe(join(root, 'my repo 專案', 'app.worktrees', 'feature-log-in'));
    expect(existsSync(join(made.path, 'README.md'))).toBe(true);
    expect(run(made.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/log-in');
    expect(made.commit).toBe(run(repo, 'rev-parse', 'HEAD'));

    // From inside the new worktree the repository is still the main one, and the listing sees both
    const { repo: info, worktrees } = await listWorktrees(made.path);
    expect(samePath(info.mainRoot, repo)).toBe(true);
    expect(worktrees.map(w => w.branch)).toEqual(['main', 'feature/log-in']);
    expect(worktrees[1]).toMatchObject({ main: false, exists: true, dirty: 0, upstream: null });
    expect(samePath(worktrees[1]!.path, made.path)).toBe(true);
  });

  it('starts from a given branch, tag or commit', async () => {
    const repo = makeRepo(join(temp('acpira-wt-'), 'app'));
    const first = run(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'second');
    run(repo, 'tag', 'v1', first);
    const made = await createWorktree({ cwd: repo, branch: 'from-tag', start: 'v1' });
    expect(made.commit).toBe(first);
    expect(existsSync(join(made.path, 'b.txt'))).toBe(false);
  });

  it('counts uncommitted changes and commits not pushed, with and without an upstream', async () => {
    const root = temp('acpira-wt-');
    const remote = join(root, 'remote.git');
    run(root, 'init', '-q', '--bare', remote);
    const repo = makeRepo(join(root, 'app'));
    run(repo, 'remote', 'add', 'origin', remote);
    run(repo, 'push', '-q', '-u', 'origin', 'main');

    const a = await createWorktree({ cwd: repo, branch: 'local-only' });
    writeFileSync(join(a.path, 'one.txt'), '1\n');
    run(a.path, 'add', '.');
    run(a.path, 'commit', '-q', '-m', 'one');
    writeFileSync(join(a.path, 'untracked.txt'), 'u\n');
    writeFileSync(join(a.path, 'README.md'), 'changed\n');

    const b = await createWorktree({ cwd: repo, branch: 'pushed' });
    run(b.path, 'push', '-q', '-u', 'origin', 'pushed');
    writeFileSync(join(b.path, 'two.txt'), '2\n');
    run(b.path, 'add', '.');
    run(b.path, 'commit', '-q', '-m', 'two');

    const { worktrees } = await listWorktrees(repo);
    const by = (branch: string) => worktrees.find(w => w.branch === branch)!;
    expect(by('main')).toMatchObject({ main: true, dirty: 0, upstream: 'origin/main', unpushed: 0 });
    expect(by('local-only')).toMatchObject({ dirty: 2, upstream: null, unpushed: 1 });
    expect(by('pushed')).toMatchObject({ dirty: 0, upstream: 'origin/pushed', unpushed: 1, behind: 0 });
  });

  it('refuses with a clear reason and leaves nothing behind', async () => {
    const root = temp('acpira-wt-');
    const plain = join(root, 'not a repo');
    mkdirSync(plain);
    expect((await failure(createWorktree({ cwd: plain, branch: 'x' }))).code).toBe('not-a-repo');
    expect((await failure(createWorktree({ cwd: join(root, 'gone'), branch: 'x' }))).code).toBe('no-folder');

    const repo = makeRepo(join(root, 'app'));
    run(repo, 'branch', 'taken');
    const taken = await failure(createWorktree({ cwd: repo, branch: 'taken' }));
    expect(taken.code).toBe('branch-exists');
    expect(taken.message).toContain('taken');
    expect((await failure(createWorktree({ cwd: repo, branch: 'bad..name' }))).code).toBe('bad-branch');
    expect((await failure(createWorktree({ cwd: repo, branch: '-x' }))).code).toBe('bad-branch');

    const missing = await failure(createWorktree({ cwd: repo, branch: 'from-nowhere', start: 'no-such-ref' }));
    expect(missing.code).toBe('bad-start');
    expect(await branchExists('from-nowhere', repo)).toBe(false);

    mkdirSync(join(root, 'app.worktrees', 'occupied'), { recursive: true });
    const occupied = await failure(createWorktree({ cwd: repo, branch: 'occupied' }));
    expect(occupied.code).toBe('path-exists');
    expect(await branchExists('occupied', repo)).toBe(false);

    // git itself fails (the worktree folder's parent is a file): the branch it made is rolled back
    const blocked = join(root, 'blocked-base');
    writeFileSync(blocked, 'a file, not a folder');
    const failed = await failure(createWorktree({ cwd: repo, branch: 'rolled-back', root: blocked }));
    expect(failed.code).toBe('git-failed');
    expect(await branchExists('rolled-back', repo)).toBe(false);
    expect((await listWorktrees(repo)).worktrees).toHaveLength(1);

    const empty = join(root, 'empty');
    mkdirSync(empty);
    run(empty, 'init', '-q');
    expect((await failure(createWorktree({ cwd: empty, branch: 'x' }))).code).toBe('no-commits');
  });

  it('removes only a clean worktree, keeps the branch, and never the main working tree', async () => {
    const repo = makeRepo(join(temp('acpira-wt-'), 'my app'));
    const made = await createWorktree({ cwd: repo, branch: 'to-remove' });
    writeFileSync(join(made.path, 'scratch.txt'), 'not committed\n');

    const dirty = await failure(removeWorktree(repo, 'to-remove'));
    expect(dirty.code).toBe('dirty');
    expect(dirty.message).toContain('未 commit');
    expect(existsSync(join(made.path, 'scratch.txt'))).toBe(true);

    expect((await failure(inspectRemoval(repo, repo))).code).toBe('main-worktree');
    expect((await failure(inspectRemoval(repo, 'nope'))).code).toBe('not-found');

    rmSync(join(made.path, 'scratch.txt'));
    const done = await removeWorktree(repo, made.path);
    expect(done.branch).toBe('to-remove');
    expect(existsSync(made.path)).toBe(false);
    expect(await branchExists('to-remove', repo)).toBe(true);
    expect((await listWorktrees(repo)).worktrees).toHaveLength(1);
  });
});

// The question blocks still open in a session view
function openQuestions(view: unknown): { id: string; message?: string; questions: { id: string; text: string; options: { id: string; label: string }[] }[] }[] {
  const found: any[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'question' && Array.isArray(o.questions) && !o.outcome) found.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(view);
  return found;
}

describe('worktree-sessions: end to end through the sidecar', { timeout: 600_000 }, () => {
  const shells: Shell[] = [];
  afterEach(async () => {
    for (const s of shells.splice(0)) await s.kill();
  }, 60_000);

  it('/worktree opens a session in the new worktree; list and remove go through question cards', async () => {
    const root = temp('acpira-wt-e2e-');
    const home = join(root, 'home');
    cpSync(PLUGIN_SRC, join(home, 'plugins', 'worktree-sessions'), { recursive: true, filter: src => !src.endsWith('README.md') });
    const repo = makeRepo(join(root, 'e2e repo 測試', 'app'));
    const expected = join(dirname(repo), 'app.worktrees', 'feat-e2e');

    const s = new Shell(home, repo);
    shells.push(s);
    const toasts: string[] = [];
    s.answers.toast = r => { if (r.method === 'toast') toasts.push(r.text); return null; };
    s.send({
      type: 'hello', protocolVersion: SIDECAR_PROTOCOL_VERSION, requestId: 'h1',
      client: { name: 'contract', version: '0', capabilities: ['toast'] },
      env: { hostLanguage: 'en', cwd: repo, blobBase: 'https://acpira.local/blobs' },
      settings: { defaultAgent: 'fake', agents: { fake: { name: 'Fake', command: NODE, args: [FAKE] } } },
    });
    await s.next((m): m is Extract<SidecarMsg, { type: 'helloOk' }> => m.type === 'helloOk', SLOW);
    s.send({ type: 'attachView', viewId: 'V', host: 'sidebar' });
    s.view('V', { type: 'ready' });
    step('hello ok');
    const init = await s.hostMsg('V', 'init', () => true, SLOW);
    step('view attached');
    const origin = init.state.active!.id;

    // Enabled the way the plugin page does
    // The engine gives a process 10 s to answer initialize; on a machine where node itself takes longer to start
    // (antivirus scanning a cold node.exe) the first check fails, and a retry finds node warm
    let enabled!: Extract<HostMsg, { type: 'plugins' }>;
    for (let attempt = 0; attempt < 4; attempt++) {
      s.view('V', { type: 'pluginAction', action: { op: 'enable', id: 'worktree-sessions' } });
      enabled = await s.upcoming((m): m is Extract<SidecarMsg, { type: 'hostMessage' }> => m.type === 'hostMessage' && m.viewId === 'V' && m.message.type === 'plugins'
        && (!!m.message.error || m.message.view.plugins.some(p => p.id === 'worktree-sessions' && p.enabled)), SLOW).then(m => m.message as Extract<HostMsg, { type: 'plugins' }>);
      if (!enabled.error?.includes('initialize within')) break;
      step(`enable retry: ${enabled.error}`);
    }
    expect(enabled.error).toBeUndefined();
    expect(enabled.view.plugins.find(p => p.id === 'worktree-sessions')).toMatchObject({ enabled: true });
    step('plugin enabled');
    // The process starts after the commit: until it answered initialize a call says it is not running. Its `list`
    // method answers for the repository the way another plugin would read it
    let listed0: { result?: any; error?: string } = {};
    for (let i = 0; i < 600; i++) {
      s.view('V', { type: 'pluginCall', id: `l${i}`, plugin: 'worktree-sessions', method: 'list', params: { cwd: repo } });
      listed0 = await s.hostMsg('V', 'pluginCalled', m => m.id === `l${i}`, SLOW);
      if (!listed0.error?.includes('no running process')) break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(listed0.error).toBeUndefined();
    expect(listed0.result).toMatchObject({ ok: true, worktrees: [{ branch: 'main', main: true, dirty: 0 }] });
    expect(samePath(listed0.result.repo, repo)).toBe(true);
    step('plugin process up');
    // The command list of the session follows the plugin's commands
    await s.hostMsg('V', 'session', m => m.session.id === origin && JSON.stringify(m.session).includes('"worktree"'), SLOW);

    step('command list has /worktree');
    s.view('V', { type: 'send', text: '/worktree feat/e2e' });
    const listed = await s.hostMsg('V', 'sessions', m => m.sessions.some(x => samePath(x.cwd, expected) && x.title === 'feat/e2e'), SLOW);
    const created = listed.sessions.find(x => samePath(x.cwd, expected))!;
    expect(created.id).not.toBe(origin);
    expect(existsSync(join(expected, 'README.md'))).toBe(true);
    expect(run(expected, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/e2e');
    // The window stays where it was, and the session it shows is kept
    expect(listed.sessions.some(x => x.id === origin) || init.state.active!.id === origin).toBe(true);

    step('first worktree session open');
    // A second one: the first worktree's session, still empty, must survive the plugin starting another
    s.view('V', { type: 'send', text: '/worktree feat/second' });
    const second = join(dirname(repo), 'app.worktrees', 'feat-second');
    const both = await s.hostMsg('V', 'sessions', m => m.sessions.some(x => samePath(x.cwd, second)), SLOW);
    expect(both.sessions.some(x => x.id === created.id)).toBe(true);

    step('second worktree session open');
    // A branch that exists already: an error toast, nothing created
    s.view('V', { type: 'send', text: '/worktree feat/e2e' });
    await expect.poll(() => toasts.some(t => t.includes('已存在')), { timeout: SLOW }).toBe(true);

    step('branch-exists toast');
    // list: a card in the origin session with one option per worktree
    s.view('V', { type: 'send', text: '/worktree list' });
    const withList = await s.hostMsg('V', 'session', m => m.session.id === origin && openQuestions(m.session).some(q => q.questions[0]?.id === 'list'), SLOW);
    const listCard = openQuestions(withList.session).find(q => q.questions[0]?.id === 'list')!;
    expect(listCard.questions[0]!.options.map(o => o.label)).toEqual(expect.arrayContaining(['main', 'feat/e2e', 'feat/second', '關閉']));
    s.view('V', { type: 'answer', sessionId: origin, blockId: listCard.id, answers: { list: 'close' } });

    step('list card answered');
    // remove with uncommitted changes: refused, the folder stays
    writeFileSync(join(expected, 'wip.txt'), 'work in progress\n');
    s.view('V', { type: 'send', text: '/worktree remove feat/e2e' });
    await expect.poll(() => toasts.some(t => t.includes('未 commit')), { timeout: SLOW }).toBe(true);
    expect(existsSync(join(expected, 'wip.txt'))).toBe(true);

    step('dirty refusal toast');
    // The `create` method other plugins call, without a session: only the worktree. That one is removed below, since
    // on Windows a folder an agent process runs in cannot be deleted
    s.view('V', { type: 'pluginCall', id: 'c1', plugin: 'worktree-sessions', method: 'create', params: { cwd: repo, branch: 'feat/bare', open: false } });
    const bare = (await s.hostMsg('V', 'pluginCalled', m => m.id === 'c1', SLOW)).result as { ok: boolean; path: string; sessionId: string | null };
    expect(bare).toMatchObject({ ok: true, branch: 'feat/bare', sessionId: null });
    const barePath = join(dirname(repo), 'app.worktrees', 'feat-bare');
    expect(samePath(bare.path, barePath)).toBe(true);
    // Opening a session needs the asking session
    s.view('V', { type: 'pluginCall', id: 'c2', plugin: 'worktree-sessions', method: 'create', params: { cwd: repo, branch: 'feat/no-origin' } });
    expect((await s.hostMsg('V', 'pluginCalled', m => m.id === 'c2', SLOW)).result).toMatchObject({ ok: false, code: 'bad-params' });
    expect(run(repo, 'branch', '--list', 'feat/no-origin')).toBe('');

    // remove a clean one: a confirmation card first, then the folder goes and the branch stays
    s.view('V', { type: 'send', text: '/worktree remove feat/bare' });
    const withConfirm = await s.hostMsg('V', 'session', m => m.session.id === origin && openQuestions(m.session).some(q => q.questions[0]?.id === 'confirm'), SLOW);
    const confirm = openQuestions(withConfirm.session).find(q => q.questions[0]?.id === 'confirm')!;
    expect(existsSync(barePath)).toBe(true);
    s.view('V', { type: 'answer', sessionId: origin, blockId: confirm.id, answers: { confirm: 'remove' } });
    await expect.poll(() => existsSync(barePath), { timeout: SLOW }).toBe(false);
    expect(run(repo, 'branch', '--list', 'feat/bare')).toContain('feat/bare');
  });
});
