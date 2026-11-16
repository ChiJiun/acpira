// The worktree-sessions plugin's process: `/worktree` and the `create` / `list` methods other plugins call. The git
// work lives in git.ts, the parsing and wording in core.ts; this file talks to the engine.
//
// A hook call has at most 10 s and three failed calls in a row pause the plugin, so the `command` hook only parses
// the arguments, starts the work in the background and answers `{}` (nothing is sent to the agent). Results reach the
// user as toasts and question cards (`ui/ask`); expected failures are never thrown back to the engine.
import { definePlugin, type Context } from '@acpira/plugin';
import { createWorktree, inspectRemoval, listWorktrees, removeWorktree, repoOf, samePath, samePathKey, worktreeBase, WorktreeError, type Created, type WorktreeStatus } from './git';
import { describe, label, liveSessionBlocker, parseCommand, table, USAGE, type LiveSession, type SessionRef } from './core';

const SETTINGS = 'settings';
const LINKS = 'links';

interface Settings {
  root?: string | null;
}

// The session this plugin opened for each worktree, by samePathKey
interface Link {
  session: string;
  branch: string;
  repo: string;
  at: number;
}

interface CommandPayload {
  name?: string;
  arguments?: string;
  session?: string;
  agent?: string;
  cwd?: string;
}

// Mutating work runs one at a time: two creations racing would interleave the viewer's session switches and the
// read-modify-write of the links
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => {});
  return next;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function toast(ctx: Context, text: string, level: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
  // The engine accepts info / warning / error and cuts the text at 500 characters
  await ctx.request('ui/toast', { text: text.slice(0, 500), level }).catch(e => ctx.log(`toast failed: ${message(e)}`));
}

async function settings(ctx: Context): Promise<Settings> {
  return (await ctx.storage.get<Settings>(SETTINGS)) ?? {};
}

async function links(ctx: Context): Promise<Record<string, Link>> {
  return (await ctx.storage.get<Record<string, Link>>(LINKS)) ?? {};
}

async function sessionsIn(ctx: Context): Promise<{ id: string; title: string; cwd: string }[]> {
  try {
    return ((await ctx.session.list()) ?? []) as { id: string; title: string; cwd: string }[];
  } catch (e) {
    ctx.log(`session/list failed: ${message(e)}`);
    return [];
  }
}

export interface Opened {
  sessionId: string | null;
  // Why no session was opened, or what went wrong with the one that was (its agent failed to start)
  sessionError?: string;
  // `create` called with `wait: false`: the session is still being opened (see the `opened` method)
  sessionPending?: boolean;
}

// Session states that mean the agent did not come up
const START_FAILED: Record<string, string> = {
  error: 'agent 啟動失敗',
  auth_required: 'agent 需要先登入',
  closed: 'session 已關閉',
};

async function backTo(ctx: Context, origin: string): Promise<boolean> {
  const r = await ctx.session.act({ type: 'selectSession', id: origin }).catch(() => null);
  if (r?.active !== origin) return false;
  return !!(await ctx.session.get(origin, 0).catch(() => null));
}

// A new session in `dir` through the plugin's own viewer. The engine answers with the viewer's active session, which
// stays the previous one when the start failed, so the session's folder is checked before it counts.
//
// Starting a session drops the viewer's current one when it is still empty and no other window shows it
// (`drop_empty_current`). The viewer is therefore moved to `origin`, the session asking, before the start, and the
// start is skipped unless the engine confirms the viewer is on it. Afterwards the viewer goes back to `origin` again,
// so it never stays on the new session (a session a viewer shows is not marked unread)
async function openSession(ctx: Context, dir: string, title: string, agent: string | undefined, origin: string): Promise<Opened> {
  try {
    if (!(await backTo(ctx, origin))) {
      return { sessionId: null, sessionError: `找不到發出要求的 session（${origin}），為了不讓引擎丟掉其他還沒用過的 session，沒有開新 session` };
    }
    const r = await ctx.session.act({ type: 'newSession', cwd: dir, ...(agent ? { agent } : {}) });
    const id = typeof r?.active === 'string' ? r.active : null;
    const view = id && id !== origin ? await ctx.session.get(id, 0) : null;
    if (!id || !view || typeof view.cwd !== 'string' || !samePath(view.cwd, dir)) {
      await backTo(ctx, origin);
      return { sessionId: null, sessionError: `引擎沒有在 ${dir} 開出 session` };
    }
    await ctx.session.act({ type: 'renameSession', id, title }).catch(e => ctx.log(`rename failed: ${message(e)}`));
    await backTo(ctx, origin);
    const failed = typeof view.status === 'string' ? START_FAILED[view.status] : undefined;
    if (failed) return { sessionId: id, sessionError: `${failed}${typeof view.error === 'string' && view.error ? `：${view.error}` : ''}` };
    return { sessionId: id };
  } catch (e) {
    return { sessionId: null, sessionError: message(e) };
  }
}

export interface CreateParams {
  cwd: string;
  branch: string;
  start?: string | null;
  agent?: string;
  // The session asking; the plugin's viewer returns to it afterwards
  session?: string;
  // false: only the worktree, no session
  open?: boolean;
}

export type CreateAnswer =
  | ({ ok: true; path: string; branch: string; commit: string; repo: string } & Opened)
  | { ok: false; code: string; error: string };

// Sessions `create` is still opening or has opened, by samePathKey of the worktree (this process only)
const opening = new Map<string, { state: 'pending' | 'done' | 'failed' } & Opened>();

async function openAndLink(ctx: Context, made: Created, p: CreateParams, origin: string): Promise<Opened> {
  return serial(async () => {
    const opened = await openSession(ctx, made.path, made.branch, p.agent, origin);
    if (opened.sessionId) {
      const all = await links(ctx);
      all[samePathKey(made.path)] = { session: opened.sessionId, branch: made.branch, repo: made.repo.mainRoot, at: Date.now() };
      await ctx.storage.set(LINKS, all);
    }
    return opened;
  });
}

// `wait`: answer once the session is open (the command). Without it the answer comes as soon as the worktree exists
// and the session opens in the background: starting an agent can take longer than a method call may
async function create(ctx: Context, p: CreateParams, wait: boolean): Promise<CreateAnswer> {
  if (p.open !== false && !p.session) {
    return { ok: false, code: 'bad-params', error: '開 session 需要 `session`（呼叫端所在、使用者正在看或已有對話的 session），否則請傳 `open: false`' };
  }
  let made: Created;
  try {
    const root = (await settings(ctx)).root;
    made = await serial(() => createWorktree({ cwd: p.cwd, branch: p.branch, start: p.start, root }));
  } catch (e) {
    return { ok: false, code: e instanceof WorktreeError ? e.code : 'error', error: message(e) };
  }
  const base = { ok: true as const, path: made.path, branch: made.branch, commit: made.commit, repo: made.repo.mainRoot };
  if (p.open === false || !p.session) return { ...base, sessionId: null };
  const job = openAndLink(ctx, made, p, p.session);
  if (wait) return { ...base, ...(await job) };
  const key = samePathKey(made.path);
  opening.set(key, { state: 'pending', sessionId: null, sessionPending: true });
  job.then(
    o => opening.set(key, { state: o.sessionId ? 'done' : 'failed', ...o }),
    e => opening.set(key, { state: 'failed', sessionId: null, sessionError: message(e) }),
  );
  return { ...base, sessionId: null, sessionPending: true };
}

interface Row {
  w: WorktreeStatus;
  sessions: SessionRef[];
}

async function rows(ctx: Context, cwd: string): Promise<{ repo: string; rows: Row[] }> {
  const { repo, worktrees } = await listWorktrees(cwd);
  const [all, linked] = await Promise.all([sessionsIn(ctx), links(ctx)]);
  return {
    repo: repo.mainRoot,
    rows: worktrees.map(w => {
      const here = all.filter(s => typeof s.cwd === 'string' && samePath(s.cwd, w.path)).map(s => ({ id: s.id, title: s.title }));
      const link = linked[samePathKey(w.path)];
      // A linked session the engine no longer lists is not shown: it was deleted
      if (link && !here.some(s => s.id === link.session) && all.some(s => s.id === link.session)) here.push({ id: link.session, title: link.branch });
      return { w, sessions: here };
    }),
  };
}

async function showList(ctx: Context, p: CommandPayload): Promise<void> {
  const { repo, rows: list } = await rows(ctx, p.cwd ?? '');
  if (!p.session) {
    ctx.log(table(list));
    return;
  }
  const options = list.map((r, i) => ({ id: `w${i}`, label: label(r.w).slice(0, 80), description: describe(r.w, r.sessions) }));
  options.push({ id: 'close', label: '關閉', description: '' });
  await ctx.ui.ask({
    session: p.session,
    message: `${repo} 共有 ${list.length} 個 worktree。`,
    questions: [{ id: 'list', title: 'Worktrees', text: '目前的 worktree（選任一項即可關閉卡片）', kind: 'single', options }],
    waitSecs: 600,
  });
}

function yes(answer: unknown, question: string, option: string): boolean {
  const a = (answer as { answers?: Record<string, unknown> } | null)?.answers?.[question];
  return a === option || (Array.isArray(a) && a.includes(option));
}

async function remove(ctx: Context, p: CommandPayload, target: string | null): Promise<void> {
  const cwd = p.cwd ?? '';
  if (!p.session) return toast(ctx, '移除需要在 session 裡確認，請從 session 執行 /worktree remove。', 'warning');
  let pick = target;
  if (!pick) {
    const { rows: list } = await rows(ctx, cwd);
    const candidates = list.filter(r => !r.w.main);
    if (!candidates.length) {
      await toast(ctx, '除了主工作目錄以外沒有其他 worktree。');
      return;
    }
    const answer = await ctx.ui.ask({
      session: p.session,
      message: '只能移除沒有未 commit 變更的 worktree；分支會保留。',
      questions: [{
        id: 'pick', title: '移除 worktree', text: '要移除哪一個？', kind: 'single',
        options: [...candidates.map((r, i) => ({ id: `w${i}`, label: label(r.w).slice(0, 80), description: describe(r.w, r.sessions) })), { id: 'cancel', label: '取消', description: '' }],
      }],
      waitSecs: 600,
    });
    const chosen = candidates.findIndex((_, i) => yes(answer, 'pick', `w${i}`));
    if (chosen < 0) return;
    pick = candidates[chosen]!.w.path;
  }
  const e = await inspectRemoval(cwd, pick);
  const live = await liveSessionsIn(ctx, e.path);
  const blocked = liveSessionBlocker(process.platform, e.path, live);
  if (blocked) return toast(ctx, blocked, 'warning');
  const here = samePath(cwd, e.path) ? '這個 session 就在這個 worktree 裡，移除後它的資料夾會消失。' : '';
  const busy = live.length
    ? `有 ${live.length} 個 session 的工作目錄在這裡（${live.map(s => s.title || s.id).join('、')}），session 不會被刪除，但之後在它們裡面工作會找不到資料夾。`
    : '';
  const ignored = e.ignored ? `資料夾裡有 ${e.ignored} 個被 .gitignore 忽略的檔案或資料夾（例如 .env、build/），它們不算未 commit 的變更，但會一起被刪除，無法從 git 找回。` : '';
  const keeps = e.branch
    ? `分支「${e.branch}」不會刪除${e.unpushed ? `，上面有 ${e.unpushed} 個 commit 還沒 push，仍保存在這個分支上` : ''}。`
    : 'HEAD 是 detached，但它的 commit 都已在其他分支、tag 或遠端上。';
  const answer = await ctx.ui.ask({
    session: p.session,
    message: `將刪除資料夾 ${e.path} 並取消 git 的 worktree 登記（git worktree remove，不加 --force）。${keeps}session 不會刪除。${ignored}${here}${busy}`,
    questions: [{
      id: 'confirm', title: '確認移除', text: `確定要移除 worktree「${e.branch ?? e.path}」嗎？`, kind: 'single',
      options: [{ id: 'remove', label: '移除資料夾', description: e.path }, { id: 'keep', label: '取消', description: '' }],
    }],
    waitSecs: 600,
  });
  if (!yes(answer, 'confirm', 'remove')) {
    await toast(ctx, '已取消，worktree 保留。');
    return;
  }
  // A session may have started there while the card was open
  const again = liveSessionBlocker(process.platform, e.path, await liveSessionsIn(ctx, e.path));
  if (again) return toast(ctx, again, 'warning');
  let removedPath = e.path;
  try {
    removedPath = (await serial(() => removeWorktree(cwd, e.path))).path;
  } catch (err) {
    // Unregistered but the folder stayed: the link goes, since git no longer knows the worktree
    if (err instanceof WorktreeError && err.code === 'remove-incomplete' && err.registered === false) await unlink(ctx, e.path);
    throw err;
  }
  await unlink(ctx, removedPath);
  await toast(ctx, `已移除 worktree ${removedPath}；${e.branch ? `分支 ${e.branch} 保留` : 'detached HEAD 的 commit 都在其他參照上'}。`);
}

async function unlink(ctx: Context, dir: string): Promise<void> {
  const all = await links(ctx);
  if (!all[samePathKey(dir)]) return;
  delete all[samePathKey(dir)];
  await ctx.storage.set(LINKS, all);
}

// Sessions whose folder is `dir`, with their state when this engine has them open
async function liveSessionsIn(ctx: Context, dir: string): Promise<LiveSession[]> {
  const here = (await sessionsIn(ctx)).filter(s => typeof s.cwd === 'string' && samePath(s.cwd, dir));
  return Promise.all(here.map(async s => {
    const view = await ctx.session.get(s.id, 0).catch(() => null);
    return { id: s.id, title: s.title, status: typeof view?.status === 'string' ? view.status : null };
  }));
}

async function config(ctx: Context, p: CommandPayload, key: string | null, value: string | null): Promise<void> {
  const s = await settings(ctx);
  if (key === 'root' && value !== null) {
    const root = value === 'default' ? null : value;
    await ctx.storage.set(SETTINGS, { ...s, root });
    s.root = root;
  }
  let where = '';
  try {
    const { mainRoot } = await repoOf(p.cwd ?? '');
    where = `；這個 repo 的新 worktree 會放在 ${worktreeBase(mainRoot, s.root)}`;
  } catch {
    // not in a repo: the setting alone is shown
  }
  await toast(ctx, `worktree 放置位置：${s.root ? s.root : '預設（repo 旁的 <repo>.worktrees 資料夾）'}${where}`);
}

async function run(ctx: Context, p: CommandPayload): Promise<void> {
  const parsed = parseCommand(p.arguments ?? '');
  switch (parsed.kind) {
    case 'help':
      return toast(ctx, USAGE);
    case 'error':
      return toast(ctx, `${parsed.message}\n${USAGE}`, 'warning');
    case 'list':
      return showList(ctx, p);
    case 'remove':
      return remove(ctx, p, parsed.target);
    case 'config':
      return config(ctx, p, parsed.key, parsed.value);
    case 'create': {
      const r = await create(ctx, { cwd: p.cwd ?? '', branch: parsed.branch, start: parsed.start, agent: p.agent, session: p.session }, true);
      if (!r.ok) return toast(ctx, r.error, 'error');
      if (r.sessionId && r.sessionError) return toast(ctx, `已建立 worktree ${r.path}（新分支 ${r.branch}）與 session「${r.branch}」，但${r.sessionError}。`, 'warning');
      if (r.sessionId) return toast(ctx, `已建立 worktree ${r.path}（新分支 ${r.branch}）。新 session「${r.branch}」已在側欄的 session 清單，點它開始在這個 worktree 工作。`);
      return toast(ctx, `已建立 worktree ${r.path}（新分支 ${r.branch}），但沒有開出 session：${r.sessionError ?? '原因不明'}。可以手動在這個資料夾開新 session。`, 'warning');
    }
  }
}

export default definePlugin({
  hooks: {
    command: (payload: CommandPayload, ctx: Context) => {
      if (payload?.name !== 'worktree') return null;
      void run(ctx, payload).catch(async e => {
        ctx.log(`/worktree failed: ${e instanceof Error ? e.stack : String(e)}`);
        await toast(ctx, message(e), 'error');
      });
      return {};
    },
  },
  methods: {
    // { cwd, branch, start?, agent?, session?, open? } → { ok, path, branch, commit, repo, sessionId: null,
    // sessionPending } at once; the session opens in the background (`opened` tells how it went)
    create: (params: CreateParams, ctx: Context) => {
      if (!params || typeof params.cwd !== 'string' || typeof params.branch !== 'string') {
        return { ok: false, code: 'bad-params', error: '`cwd` 與 `branch` 是必填字串' };
      }
      return create(ctx, params, false);
    },
    // { path } → { state: 'pending' | 'done' | 'failed' | 'unknown', sessionId, sessionError? }
    opened: async (params: { path?: string }, ctx: Context) => {
      if (!params || typeof params.path !== 'string') return { state: 'unknown', sessionId: null, sessionError: '`path` 是必填字串' };
      const key = samePathKey(params.path);
      const known = opening.get(key);
      if (known) return known;
      const link = (await links(ctx))[key];
      return link ? { state: 'done', sessionId: link.session } : { state: 'unknown', sessionId: null };
    },
    // { cwd } → { ok, repo, worktrees: [{ path, branch, head, main, exists, dirty, upstream, unpushed, behind, locked, sessions }] }
    list: async (params: { cwd?: string }, ctx: Context) => {
      try {
        const r = await rows(ctx, params?.cwd ?? '');
        return { ok: true, repo: r.repo, worktrees: r.rows.map(x => ({ ...x.w, sessions: x.sessions })) };
      } catch (e) {
        return { ok: false, code: e instanceof WorktreeError ? e.code : 'error', error: message(e) };
      }
    },
  },
});
