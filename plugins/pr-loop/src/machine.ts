// The PR loop as a state machine: review by a fresh reviewer session, fixes sent back to the implementing session, CI,
// then one merge commit. Every effect goes through injected interfaces (`Host` for sessions and cards, `Store` for the
// plugin's storage, `GitHub` over a `gh` runner), so the whole loop runs in tests without Acpira or GitHub.
//
// Persistence: one `state` key holds every loop, written compare-and-swap. A step that starts something that must not
// happen twice (a reviewer session, the merge) saves a transient phase (`launching`, `merging`) first; finding one of
// those outside a running step means the engine stopped mid-step, so the loop stops and says where instead of redoing it

import { GhError, type GitHub, type PullRequest } from './github';
import {
  brief,
  ciFailure,
  fixList,
  issueKey,
  NOTES_TITLES,
  parseVerdict,
  repeatedKeys,
  REQUIREMENT_TITLES,
  section,
  type PrTarget,
  type SameIssue,
} from './review';

export interface SessionInfo {
  id: string;
  agent: string;
  cwd: string;
  title?: string;
}

export interface SessionView {
  running?: boolean;
  turns?: Record<string, unknown>[];
}

export interface AskOption {
  id: string;
  label: string;
}

export interface Host {
  // Every session the engine knows (records, not only open ones)
  sessions(): Promise<SessionInfo[]>;
  // A session open in this engine, or null; `turns` keeps the newest that many
  session(id: string, turns?: number): Promise<SessionView | null>;
  // A new session of `agent` in `cwd`; its id, or null when none was made
  newSession(agent: string, cwd: string): Promise<string | null>;
  // A prompt into a session, as the user would send it. Resolves once it went out (or, on some engines, later): the
  // machine never waits on it inside a step
  send(session: string, text: string): Promise<void>;
  // A card in `session` with one choice; the option's id, or null when it timed out
  ask(session: string, message: string, options: AskOption[], waitSecs: number): Promise<string | null>;
  toast(text: string, level?: 'info' | 'warning' | 'error'): Promise<void>;
  log(text: string): void;
}

export interface Store {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  // Writes `value` only while the key still holds `expect`; whether it did
  swap(key: string, expect: unknown, value: unknown): Promise<boolean>;
}

export interface Config {
  // `owner/repo` the loop may run on and merge into; empty means nowhere
  allowedRepos: string[];
  // The reviewer's agent id; empty: the implementing session's agent
  reviewerAgent: string;
  // `confirm`: a card before the merge; `auto`: merge once every condition holds
  merge: 'confirm' | 'auto';
  pollSecs: number;
  sameIssue: SameIssue;
  // The argv that runs gh (`["gh"]`, or a test double)
  gh: string[];
}

export const DEFAULT_CONFIG: Config = { allowedRepos: [], reviewerAgent: '', merge: 'confirm', pollSecs: 30, sameIssue: 'category+file', gh: ['gh'] };

export const MAX_ROUNDS = 5;
// A reviewer that has not started its turn this long after the brief went out failed to start
export const START_GRACE_MS = 3 * 60_000;
// A loop whose owner wrote nothing this many polls ago is taken over by another engine
const STALE_POLLS = 3;
const LOG_MAX = 40;
const KEEP_FINISHED = 20;
const ASK_WAIT_SECS = 25 * 60;

export type Phase = 'launching' | 'reviewing' | 'waitingFix' | 'waitingCi' | 'confirmMerge' | 'merging' | 'merged' | 'stopped' | 'cancelled';

export type StopReason =
  | 'max-rounds'
  | 'repeated'
  | 'unparseable'
  | 'conflict'
  | 'gh'
  | 'pr-closed'
  | 'pr-merged-elsewhere'
  | 'impl-gone'
  | 'reviewer-gone'
  | 'reviewer-failed'
  | 'interrupted'
  | 'merge-declined'
  | 'draft'
  | 'merge-conflict'
  | 'not-allowed'
  | 'error';

// What `/pr-loop resume` does after a stop: a new review round, the stored fix list sent, the CI step again, or the
// step that failed retried
export type Resume = 'review' | 'fix' | 'ci' | 'retry';

export interface Round {
  round: number;
  sha: string;
  reviewer: string;
  at: number;
  result: 'mergeable' | 'not_mergeable' | 'unparseable' | 'conflict';
  keys: string[];
  blocking: number;
}

export interface Stop {
  reason: StopReason;
  step: Phase;
  detail: string;
  resume: Resume | null;
  at: number;
}

export interface Loop {
  key: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  headRef: string;
  baseRef: string;
  implSession: string;
  implAgent: string;
  cwd: string;
  requirement: string;
  requirementSource: 'command' | 'pr-body' | 'first-message';
  notes: string | null;
  phase: Phase;
  round: number;
  roundLimit: number;
  reviewedSha: string;
  baseSha: string;
  reviewer: { session: string; agent: string; sentAt: number } | null;
  rounds: Round[];
  pendingFix: string | null;
  lastCiFail: string[] | null;
  stop: Stop | null;
  merge: { commit: string | null; at: number } | null;
  owner: string;
  heartbeat: number;
  createdAt: number;
  updatedAt: number;
  log: string[];
}

interface State {
  version: 1;
  loops: Record<string, Loop>;
}

const ACTIVE: Phase[] = ['launching', 'reviewing', 'waitingFix', 'waitingCi', 'confirmMerge', 'merging'];
export const isActive = (l: Loop) => ACTIVE.includes(l.phase);

const PHASE_TEXT: Record<Phase, string> = {
  launching: '正在開 reviewer session',
  reviewing: '等 reviewer 完成 review',
  waitingFix: '等實作 session 修正並 push',
  waitingCi: '等 CI',
  confirmMerge: '等你確認合併',
  merging: '合併中',
  merged: '已合併',
  stopped: '已停下，等你決定',
  cancelled: '已停止',
};

const REASON_TEXT: Record<StopReason, string> = {
  'max-rounds': `已經 review ${MAX_ROUNDS} 輪仍未通過`,
  repeated: '連續兩輪退回同一類問題',
  unparseable: 'reviewer 的輸出無法解析',
  conflict: 'reviewer 回報互相衝突、需要你決定的意見',
  gh: 'gh 執行失敗或未登入',
  'pr-closed': 'PR 已被關閉',
  'pr-merged-elsewhere': 'PR 已被別人合併',
  'impl-gone': '實作 session 不見了',
  'reviewer-gone': 'reviewer session 不見了',
  'reviewer-failed': 'reviewer session 沒有開始或沒有回覆',
  interrupted: '引擎在這一步中途停止',
  'merge-declined': '合併沒有被確認',
  draft: 'PR 是 draft，不能合併',
  'merge-conflict': 'PR 與目標分支有衝突',
  'not-allowed': 'PR 所在的 repo 不在允許清單',
  error: '外掛內部錯誤',
};

const RESUME_TEXT: Record<Resume, string> = {
  review: '開一個新的 reviewer 重新 review 目前的 head',
  fix: '把修正清單送回實作 session，修完後再 review',
  ci: '重新檢查 CI 與合併條件',
  retry: '重試卡住的那一步',
};

export const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const short = (sha: string) => sha.slice(0, 8);

// Text of the agent's turns after the last user turn, and whether the session has such a turn yet
export function lastReply(view: SessionView): { asked: boolean; replied: boolean; text: string; error: string } {
  const turns = view.turns ?? [];
  let u = -1;
  turns.forEach((t, i) => {
    if (t.role === 'user') u = i;
  });
  if (u < 0) return { asked: false, replied: false, text: '', error: '' };
  const after = turns.slice(u + 1).filter(t => t.role === 'agent');
  const text = after
    .flatMap(t => (Array.isArray(t.blocks) ? (t.blocks as Record<string, unknown>[]) : []))
    .filter(b => b.type === 'text' && typeof b.markdown === 'string')
    .map(b => b.markdown as string)
    .join('\n');
  const error = after
    .map(t => (t.error && typeof t.error === 'object' ? String((t.error as Record<string, unknown>).message ?? '') : ''))
    .filter(Boolean)
    .join('; ');
  return { asked: true, replied: after.length > 0, text, error };
}

export interface Deps {
  host: Host;
  store: Store;
  gh: GitHub;
  now?: () => number;
  // This process's identity among engines
  owner: string;
}

export class PrLoop {
  private readonly host: Host;
  private readonly store: Store;
  private readonly gh: GitHub;
  private readonly now: () => number;
  readonly owner: string;
  private chain: Promise<unknown> = Promise.resolve();
  // Cards open right now, by loop key: a tick never shows a second one
  private readonly asking = new Set<string>();

  constructor(deps: Deps) {
    this.host = deps.host;
    this.store = deps.store;
    this.gh = deps.gh;
    this.now = deps.now ?? Date.now;
    this.owner = deps.owner;
  }

  // One step at a time in this process: ticks, events and commands never interleave
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // Waits for every step queued so far (tests)
  idle(): Promise<void> {
    return this.chain.then(() => {});
  }

  // ---- storage ----

  async config(): Promise<Config> {
    const c = (await this.store.get<Partial<Config>>('config')) ?? {};
    return { ...DEFAULT_CONFIG, ...c, allowedRepos: Array.isArray(c.allowedRepos) ? c.allowedRepos : [] };
  }

  private async state(): Promise<State> {
    const s = await this.store.get<State>('state');
    return s && s.loops ? s : { version: 1, loops: {} };
  }

  async loops(): Promise<Loop[]> {
    return Object.values((await this.state()).loops);
  }

  async loop(key: string): Promise<Loop | null> {
    return (await this.state()).loops[key] ?? null;
  }

  private async update(fn: (s: State) => void): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const before = await this.store.get<State>('state');
      const next: State = before && before.loops ? (JSON.parse(JSON.stringify(before)) as State) : { version: 1, loops: {} };
      fn(next);
      if (await this.store.swap('state', before ?? null, next)) return;
    }
    throw new Error('the loop state kept changing under this engine');
  }

  // Writes the loop back. A loop another engine (or a command) cancelled meanwhile stays cancelled
  private async save(loop: Loop): Promise<void> {
    loop.updatedAt = this.now();
    loop.heartbeat = this.now();
    loop.log = loop.log.slice(-LOG_MAX);
    let cancelled = false;
    await this.update(s => {
      const stored = s.loops[loop.key];
      if (stored && stored.phase === 'cancelled' && loop.phase !== 'cancelled' && stored.createdAt === loop.createdAt) {
        cancelled = true;
        return;
      }
      s.loops[loop.key] = loop;
      // Finished loops beyond the newest few are let go, so the store stays small
      const done = Object.values(s.loops).filter(l => !isActive(l) && l.phase !== 'stopped').sort((a, b) => b.updatedAt - a.updatedAt);
      for (const l of done.slice(KEEP_FINISHED)) delete s.loops[l.key];
    });
    if (cancelled) throw new Cancelled();
  }

  private note(loop: Loop, text: string): void {
    loop.log.push(`${new Date(this.now()).toISOString()} ${text}`);
    this.host.log(`${loop.key}: ${text}`);
  }

  // ---- talking to the user ----

  // A card in the session (or a toast when the session is not open here): the card is the only place long text fits
  private async say(session: string | null, text: string, level: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
    if (session) {
      // Not awaited: an information card waits for its click, the loop does not
      void this.host.ask(session, text, [{ id: 'ok', label: '知道了' }], 10 * 60).catch(() => this.host.toast(text.slice(0, 480), level).catch(() => {}));
      return;
    }
    await this.host.toast(text.slice(0, 480), level).catch(() => {});
  }

  // ---- commands ----

  // `/pr-loop …` from session `session`; every answer goes to that session as a card
  async command(session: string, args: string): Promise<void> {
    const text = args.trim();
    const [head = '', ...rest] = text.split(/\s+/);
    const tail = text.slice(head.length).trim();
    try {
      switch (head.toLowerCase()) {
        case '':
        case 'help':
          return await this.say(session, HELP);
        case 'status':
          return await this.say(session, await this.statusText(tail || null, session));
        case 'stop':
          return await this.exclusive(() => this.cancel(session, tail || null));
        case 'resume':
          return await this.exclusive(() => this.resumeCmd(session, tail || null));
        case 'config':
          return await this.exclusive(() => this.configCmd(session, rest));
        default:
          return await this.exclusive(() => this.start(session, head, tail));
      }
    } catch (e) {
      await this.say(session, `pr-loop：${(e as Error).message}`, 'error');
    }
  }

  private async configCmd(session: string, args: string[]): Promise<void> {
    const c = await this.config();
    const [what = '', ...values] = args;
    const value = values.join(' ').trim();
    const repoOk = (r: string) => /^[\w.-]+\/[\w.-]+$/.test(r);
    switch (what.toLowerCase()) {
      case '':
        break;
      case 'allow':
        if (!repoOk(value)) throw new Error('用法：/pr-loop config allow <owner>/<repo>');
        if (!c.allowedRepos.some(r => r.toLowerCase() === value.toLowerCase())) c.allowedRepos.push(value);
        break;
      case 'disallow':
        c.allowedRepos = c.allowedRepos.filter(r => r.toLowerCase() !== value.toLowerCase());
        break;
      case 'reviewer':
        c.reviewerAgent = value === 'same' ? '' : value;
        break;
      case 'merge':
        if (value !== 'confirm' && value !== 'auto') throw new Error('用法：/pr-loop config merge confirm|auto');
        c.merge = value;
        break;
      case 'poll': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 5 || n > 3600) throw new Error('用法：/pr-loop config poll <5 到 3600 秒>');
        c.pollSecs = Math.round(n);
        break;
      }
      case 'same-issue':
        if (value !== 'category+file' && value !== 'category') throw new Error('用法：/pr-loop config same-issue category+file|category');
        c.sameIssue = value;
        break;
      case 'gh': {
        let argv: unknown;
        try {
          argv = value.startsWith('[') ? JSON.parse(value) : value ? [value] : null;
        } catch {
          argv = null;
        }
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string' && a)) {
          throw new Error('用法：/pr-loop config gh gh  或  /pr-loop config gh ["node","C:/path/fake-gh.mjs"]');
        }
        c.gh = argv as string[];
        break;
      }
      default:
        throw new Error(`不認得的設定 \`${what}\`。\n\n${HELP}`);
    }
    if (what) await this.store.set('config', c);
    await this.say(session, configText(c));
  }

  private async findLoop(session: string, ref: string | null, want: (l: Loop) => boolean): Promise<Loop | null> {
    const all = await this.loops();
    if (ref) {
      const n = Number(ref.replace(/^#/, ''));
      const byUrl = /\/pull\/(\d+)/.exec(ref);
      return all.find(l => l.url === ref || (byUrl && l.url.startsWith(ref.split('/pull/')[0]!) && l.number === Number(byUrl[1])) || (Number.isInteger(n) && l.number === n && want(l))) ?? null;
    }
    const mine = all.filter(l => l.implSession === session && want(l)).sort((a, b) => b.updatedAt - a.updatedAt);
    return mine[0] ?? null;
  }

  private async cancel(session: string, ref: string | null): Promise<void> {
    const loop = await this.findLoop(session, ref, l => isActive(l) || l.phase === 'stopped');
    if (!loop) return this.say(session, 'pr-loop：這個 session 沒有進行中的循環。');
    loop.phase = 'cancelled';
    this.note(loop, '使用者停止了循環');
    await this.save(loop);
    await this.say(session, `pr-loop：已停止 ${loop.repo}#${loop.number} 的循環。已開的 reviewer session 不會被刪除；PR 不會被合併。`);
  }

  private async resumeCmd(session: string, ref: string | null): Promise<void> {
    const loop = await this.findLoop(session, ref, l => l.phase === 'stopped');
    if (!loop || loop.phase !== 'stopped' || !loop.stop) return this.say(session, 'pr-loop：沒有停下等你決定的循環。');
    await this.resume(loop);
  }

  private async resume(loop: Loop): Promise<void> {
    const stop = loop.stop!;
    if (!stop.resume) {
      return this.say(loop.implSession, `pr-loop：${loop.repo}#${loop.number} 停在「${REASON_TEXT[stop.reason]}」，不能接續；要重來請重新執行 /pr-loop ${loop.url}`);
    }
    this.note(loop, `使用者選擇接續：${RESUME_TEXT[stop.resume]}`);
    loop.stop = null;
    loop.owner = this.owner;
    // Going on after a stop is the user's call, so the round it needs is granted
    if (stop.resume === 'review' || stop.resume === 'fix') loop.roundLimit = Math.max(loop.roundLimit, loop.round + 1);
    switch (stop.resume) {
      case 'review':
        return this.guarded(loop, () => this.launchReview(loop));
      case 'fix':
        return this.guarded(loop, () => this.sendFix(loop));
      case 'ci':
        loop.phase = 'waitingCi';
        await this.save(loop);
        return this.guarded(loop, () => this.advance(loop));
      case 'retry':
        loop.phase = stop.step === 'launching' ? 'waitingCi' : stop.step;
        if (stop.step === 'launching') return this.guarded(loop, () => this.launchReview(loop));
        await this.save(loop);
        return this.guarded(loop, () => this.advance(loop));
    }
  }

  // `/pr-loop <PR> [requirement]`
  private async start(session: string, ref: string, requirementArg: string): Promise<void> {
    const c = await this.config();
    if (c.allowedRepos.length === 0) {
      return this.say(session, `pr-loop：還沒有設定允許自動循環的 repo，所以不會啟動。\n\n先用 \`/pr-loop config allow <owner>/<repo>\` 加入約定的開發 repo（例如自己的 fork），再重新執行。合併到主 repo 不要加進清單：清單外的 repo 一律不啟動。`, 'warning');
    }
    const info = (await this.host.sessions()).find(s => s.id === session);
    if (!info) throw new Error('找不到執行指令的 session');
    const m = /^#?(\d+)$/.exec(ref);
    const url = /^https?:\/\//i.test(ref) ? ref : null;
    if (!m && !url) throw new Error(`\`${ref}\` 不是 PR 編號或網址。\n\n${HELP}`);
    await this.gh.authStatus();
    const pr = await this.gh.pr(url ?? m![1]!, undefined, info.cwd);
    if (!c.allowedRepos.some(r => r.toLowerCase() === pr.repo.toLowerCase())) {
      return this.say(session, `pr-loop：${pr.repo} 不在允許自動循環的 repo 清單（目前：${c.allowedRepos.join('、')}），所以不會啟動。\n\n如果這是約定的開發 repo，用 \`/pr-loop config allow ${pr.repo}\` 加入；要合併到主 repo 請自己處理。`, 'warning');
    }
    if (pr.state !== 'OPEN') return this.say(session, `pr-loop：${pr.repo}#${pr.number} 的狀態是 ${pr.state}，不會啟動。`, 'warning');
    const key = keyOf(pr.repo, pr.number);
    const existing = await this.loop(key);
    if (existing && (isActive(existing) || existing.phase === 'stopped')) {
      return this.say(session, `pr-loop：${pr.repo}#${pr.number} 已經有循環（${PHASE_TEXT[existing.phase]}）。用 \`/pr-loop status\` 查看、\`/pr-loop resume\` 接續或 \`/pr-loop stop\` 停止。`);
    }
    // The requirement: what the command says, else the PR's own section, else the session's first prompt
    let requirement = requirementArg;
    let source: Loop['requirementSource'] = 'command';
    if (!requirement) {
      requirement = section(pr.body, REQUIREMENT_TITLES) ?? '';
      source = 'pr-body';
    }
    if (!requirement) {
      requirement = await this.firstMessage(session);
      source = 'first-message';
    }
    if (!requirement) {
      return this.say(session, 'pr-loop：找不到需求原文。請在指令後面附上（`/pr-loop <PR> <需求原文>`），或在 PR 描述加一段「## 需求原文」。', 'warning');
    }
    const notes = section(pr.body, NOTES_TITLES);
    const now = this.now();
    const loop: Loop = {
      key,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      implSession: session,
      implAgent: info.agent,
      cwd: info.cwd,
      requirement,
      requirementSource: source,
      notes,
      phase: 'waitingCi',
      round: 0,
      roundLimit: MAX_ROUNDS,
      reviewedSha: '',
      baseSha: pr.headRefOid,
      reviewer: null,
      rounds: [],
      pendingFix: null,
      lastCiFail: null,
      stop: null,
      merge: null,
      owner: this.owner,
      heartbeat: now,
      createdAt: now,
      updatedAt: now,
      log: [],
    };
    this.note(loop, `開始循環（需求原文來源：${SOURCE_TEXT[source]}${notes ? '' : '；PR 描述沒有「給 reviewer 的重點建議」'}）`);
    await this.say(
      session,
      [
        `pr-loop：開始 ${pr.repo}#${pr.number}「${pr.title}」的自動循環。`,
        `- 需求原文來源：${SOURCE_TEXT[source]}`,
        `- 給 reviewer 的重點建議：${notes ? '已從 PR 描述取得' : 'PR 描述中沒有這一段'}`,
        `- reviewer agent：${c.reviewerAgent || `${info.agent}（與實作 session 相同）`}`,
        `- 合併方式：${c.merge === 'auto' ? '條件都滿足時自動合併（merge commit）' : '合併前出確認卡片（merge commit）'}`,
        `- 最多 ${MAX_ROUNDS} 輪；用 \`/pr-loop status\` 查看、\`/pr-loop stop\` 停止。`,
      ].join('\n'),
    );
    await this.guarded(loop, () => this.launchReview(loop, pr));
  }

  private async firstMessage(session: string): Promise<string> {
    const view = await this.host.session(session, 100_000);
    const first = (view?.turns ?? []).find(t => t.role === 'user' && typeof t.text === 'string' && !(t.text as string).trim().startsWith('/pr-loop'));
    return typeof first?.text === 'string' ? first.text.trim() : '';
  }

  // ---- the loop ----

  // Runs a step; a GitHub failure or anything thrown stops the loop with what happened, never retried in silence
  private async guarded(loop: Loop, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof Cancelled) return;
      if (e instanceof GhError) {
        return this.halt(loop, 'gh', `${e.message}\n\n先確認 \`gh auth status\` 已登入、網路正常。`, 'retry');
      }
      return this.halt(loop, 'error', (e as Error).stack ?? String(e), 'retry');
    }
  }

  // The loop stops for the user: where it is, what was done, and what resuming would do
  private async halt(loop: Loop, reason: StopReason, detail: string, resume: Resume | null): Promise<void> {
    const step = loop.phase === 'stopped' ? (loop.stop?.step ?? 'waitingCi') : loop.phase;
    loop.stop = { reason, step, detail, resume, at: this.now() };
    loop.phase = 'stopped';
    this.note(loop, `停下：${REASON_TEXT[reason]}`);
    try {
      await this.save(loop);
    } catch (e) {
      if (e instanceof Cancelled) return;
      throw e;
    }
    const done = loop.rounds.map(r => `第 ${r.round} 輪（${short(r.sha)}）：${ROUND_TEXT[r.result]}${r.blocking ? `，${r.blocking} 個 blocking` : ''}`);
    const message = [
      `pr-loop：${loop.repo}#${loop.number} 停下來了 —— ${REASON_TEXT[reason]}。`,
      '',
      `卡在：${PHASE_TEXT[step]}（第 ${loop.round} 輪）`,
      '',
      detail,
      '',
      '已經做了：',
      ...(done.length ? done.map(d => `- ${d}`) : ['- 還沒有完成任何一輪 review']),
      '',
      '建議的選項：',
      ...(resume ? [`- 接續：${RESUME_TEXT[resume]}（\`/pr-loop resume\`）`] : []),
      `- 停止循環（\`/pr-loop stop\`），自己處理`,
      `- 查看狀態（\`/pr-loop status\`）`,
    ].join('\n');
    await this.host.toast(`pr-loop：${loop.repo}#${loop.number} 停下 —— ${REASON_TEXT[reason]}`, 'warning').catch(() => {});
    if (this.asking.has(loop.key)) return;
    const options: AskOption[] = [...(resume ? [{ id: 'resume', label: '接續' }] : []), { id: 'stop', label: '停止循環' }, { id: 'later', label: '稍後決定' }];
    this.asking.add(loop.key);
    const createdAt = loop.createdAt;
    void this.host
      .ask(loop.implSession, message, options, ASK_WAIT_SECS)
      .catch(() => null)
      .then(answer =>
        this.exclusive(async () => {
          this.asking.delete(loop.key);
          const now = await this.loop(loop.key);
          if (!now || now.createdAt !== createdAt || now.phase !== 'stopped') return;
          if (answer === 'resume') await this.resume(now);
          else if (answer === 'stop') await this.cancel(now.implSession, now.url);
        }),
      );
  }

  // Every loop this engine runs, one step each
  async tick(): Promise<void> {
    const c = await this.config();
    const stale = Math.max(90_000, c.pollSecs * 1000 * STALE_POLLS);
    for (const l of await this.loops()) {
      if (!isActive(l)) continue;
      await this.exclusive(async () => {
        const loop = await this.loop(l.key);
        if (!loop || !isActive(loop)) return;
        if (loop.owner !== this.owner) {
          // Another engine runs it while it writes; this one takes over when it went quiet or holds the session
          const mine = (await this.host.session(loop.implSession, 0)) !== null;
          if (!mine && this.now() - loop.heartbeat < stale) return;
          this.note(loop, `由這個引擎接手（前一個：${loop.owner}）`);
          loop.owner = this.owner;
        }
        await this.guarded(loop, () => this.advance(loop));
      });
    }
  }

  // A session's turn ended: a reviewer's answer is read at once instead of at the next poll
  async onTurnEnded(session: string): Promise<void> {
    const hit = (await this.loops()).some(l => isActive(l) && (l.reviewer?.session === session || l.implSession === session));
    if (hit) await this.tick();
  }

  private async advance(loop: Loop): Promise<void> {
    switch (loop.phase) {
      case 'launching':
        // A reviewer may or may not have been made before the engine stopped: never a second one without the user
        return this.halt(loop, 'interrupted', '開 reviewer session 的途中引擎停止了，不確定 reviewer 是否已經開好。可以到 session 清單確認，再決定是否開新的 reviewer。', 'review');
      case 'merging':
        return this.recoverMerge(loop);
      case 'reviewing':
        return this.reviewing(loop);
      case 'waitingFix':
        return this.waitingFix(loop);
      case 'waitingCi':
        return this.waitingCi(loop);
      case 'confirmMerge':
        if (!this.asking.has(loop.key)) return this.waitingCi(loop);
        loop.heartbeat = this.now();
        return this.save(loop);
      default:
        return;
    }
  }

  private target(loop: Loop, pr?: PullRequest): PrTarget {
    return {
      repo: loop.repo,
      number: loop.number,
      url: loop.url,
      headSha: pr?.headRefOid ?? loop.reviewedSha,
      headRef: pr?.headRefName ?? loop.headRef,
      baseRef: pr?.baseRefName ?? loop.baseRef,
    };
  }

  // The PR as it is now, or a stop when it is closed or merged by someone else
  private async openPr(loop: Loop): Promise<PullRequest | null> {
    const pr = await this.gh.pr(loop.number, loop.repo);
    if (pr.state === 'MERGED') {
      await this.halt(loop, 'pr-merged-elsewhere', `PR 已經在 pr-loop 之外被合併${pr.mergeCommit ? `（merge commit ${pr.mergeCommit}）` : ''}。`, null);
      return null;
    }
    if (pr.state === 'CLOSED') {
      await this.halt(loop, 'pr-closed', 'PR 已被關閉。重新打開後可以接續。', 'retry');
      return null;
    }
    loop.headRef = pr.headRefName;
    loop.baseRef = pr.baseRefName;
    return pr;
  }

  private async implAlive(loop: Loop): Promise<boolean> {
    if ((await this.host.sessions()).some(s => s.id === loop.implSession)) return true;
    await this.halt(loop, 'impl-gone', `實作 session \`${loop.implSession}\` 已經不在 session 清單裡，修正清單沒有地方可以送。`, null);
    return false;
  }

  private async launchReview(loop: Loop, known?: PullRequest): Promise<void> {
    const pr = known ?? (await this.openPr(loop));
    if (!pr) return;
    if (!(await this.implAlive(loop))) return;
    if (loop.round >= loop.roundLimit) {
      return this.halt(loop, 'max-rounds', `已經 review ${loop.round} 輪，再開下一輪會超過上限 ${MAX_ROUNDS} 輪。`, 'review');
    }
    const c = await this.config();
    const agent = c.reviewerAgent || loop.implAgent;
    loop.round += 1;
    loop.reviewedSha = pr.headRefOid;
    loop.reviewer = null;
    loop.phase = 'launching';
    this.note(loop, `第 ${loop.round} 輪：為 ${short(pr.headRefOid)} 開 reviewer（${agent}）`);
    await this.save(loop);
    const id = await this.host.newSession(agent, loop.cwd);
    if (!id) {
      loop.round -= 1;
      return this.halt(loop, 'reviewer-failed', `無法用 agent \`${agent}\` 開新的 reviewer session（agent 未安裝、未登入，或 id 打錯？用 \`/pr-loop config reviewer <agent id>\` 修改）。`, 'review');
    }
    loop.reviewer = { session: id, agent, sentAt: this.now() };
    loop.phase = 'reviewing';
    await this.save(loop);
    const text = brief(this.target(loop, pr), loop.requirement, loop.notes);
    const key = loop.key;
    void this.host.send(id, text).catch(e =>
      this.exclusive(async () => {
        const now = await this.loop(key);
        if (now && now.phase === 'reviewing' && now.reviewer?.session === id) await this.halt(now, 'reviewer-failed', `brief 沒有送進 reviewer session：${(e as Error).message}`, 'review');
      }),
    );
    await this.host.toast(`pr-loop：${loop.repo}#${loop.number} 第 ${loop.round} 輪 review 開始（${agent}）`).catch(() => {});
  }

  private async reviewing(loop: Loop): Promise<void> {
    const r = loop.reviewer;
    if (!r) return this.halt(loop, 'interrupted', '找不到這一輪 reviewer session 的紀錄。', 'review');
    const view = await this.host.session(r.session, 5);
    if (!view) {
      const listed = (await this.host.sessions()).some(s => s.id === r.session);
      return listed
        ? this.halt(loop, 'interrupted', `reviewer session \`${r.session}\` 沒有在這個引擎開著（多半是引擎重啟過），讀不到它的結論。不會自動再開一個 reviewer。`, 'review')
        : this.halt(loop, 'reviewer-gone', `reviewer session \`${r.session}\` 已經不在 session 清單裡。`, 'review');
    }
    const reply = lastReply(view);
    if (view.running) {
      loop.heartbeat = this.now();
      return this.save(loop);
    }
    if (!reply.asked || !reply.replied) {
      if (this.now() - r.sentAt < START_GRACE_MS) {
        loop.heartbeat = this.now();
        return this.save(loop);
      }
      return this.halt(loop, 'reviewer-failed', `reviewer session \`${r.session}\` 在 ${START_GRACE_MS / 60_000} 分鐘內沒有開始或沒有回覆。`, 'review');
    }
    const parsed = parseVerdict(reply.text);
    const record = (result: Round['result'], keys: string[] = [], blocking = 0) =>
      loop.rounds.push({ round: loop.round, sha: loop.reviewedSha, reviewer: r.session, at: this.now(), result, keys, blocking });
    if (!parsed.ok) {
      record('unparseable');
      return this.halt(loop, 'unparseable', `reviewer session \`${r.session}\` 的回覆讀不到固定格式的結論：${parsed.error}${reply.error ? `\n\n這一輪的錯誤：${reply.error}` : ''}`, 'review');
    }
    const v = parsed.verdict;
    const c = await this.config();
    const keys = v.blocking.map(b => issueKey(b, c.sameIssue));
    if (v.conflicts.length) {
      record('conflict', keys, v.blocking.length);
      if (!v.mergeable) loop.pendingFix = fixList(this.target(loop), loop.round, v);
      return this.halt(loop, 'conflict', `reviewer 回報需要你決定的衝突：\n${v.conflicts.map(x => `- ${x}`).join('\n')}\n\n它的判斷是「${v.mergeable ? '可合併' : '不可合併'}」。接續就照這個判斷繼續。`, v.mergeable ? 'ci' : 'fix');
    }
    if (v.mergeable) {
      record('mergeable');
      this.note(loop, `第 ${loop.round} 輪 review 判定可合併`);
      loop.phase = 'waitingCi';
      await this.save(loop);
      return this.waitingCi(loop);
    }
    // The previous round that reached a verdict; a passed round in between breaks the run
    const previous = [...loop.rounds].reverse().find(x => x.result === 'mergeable' || x.result === 'not_mergeable');
    record('not_mergeable', keys, v.blocking.length);
    loop.pendingFix = fixList(this.target(loop), loop.round, v);
    this.note(loop, `第 ${loop.round} 輪 review 判定不可合併（${v.blocking.length} 個 blocking：${keys.join(', ')}）`);
    const repeated = previous?.result === 'not_mergeable' ? repeatedKeys(previous.keys, keys) : [];
    if (repeated.length) {
      return this.halt(loop, 'repeated', `第 ${previous!.round} 輪與第 ${loop.round} 輪都退回同一類問題：${repeated.join('、')}（類別${c.sameIssue === 'category' ? '' : '＋檔案'}相同）。方向可能錯了，請先看過再決定。\n\n這一輪的修正清單：\n\n${loop.pendingFix}`, 'fix');
    }
    if (loop.round >= loop.roundLimit) {
      return this.halt(loop, 'max-rounds', `第 ${loop.round} 輪仍判定不可合併，再修一次就會超過 ${MAX_ROUNDS} 輪。\n\n這一輪的修正清單：\n\n${loop.pendingFix}`, 'fix');
    }
    return this.sendFix(loop);
  }

  private async sendFix(loop: Loop): Promise<void> {
    const pr = await this.openPr(loop);
    if (!pr) return;
    if (!(await this.implAlive(loop))) return;
    const text = loop.pendingFix;
    if (!text) return this.halt(loop, 'error', '沒有可送出的修正清單。', 'review');
    loop.baseSha = pr.headRefOid;
    loop.phase = 'waitingFix';
    this.note(loop, `修正清單送回實作 session，等 ${short(pr.headRefOid)} 之後的新 commit`);
    await this.save(loop);
    const key = loop.key;
    void this.host.send(loop.implSession, text).catch(e =>
      this.exclusive(async () => {
        const now = await this.loop(key);
        if (now && now.phase === 'waitingFix') await this.halt(now, 'impl-gone', `修正清單沒有送進實作 session：${(e as Error).message}`, 'fix');
      }),
    );
  }

  private async waitingFix(loop: Loop): Promise<void> {
    const pr = await this.openPr(loop);
    if (!pr) return;
    if (!(await this.implAlive(loop))) return;
    if (pr.headRefOid === loop.baseSha) {
      loop.heartbeat = this.now();
      return this.save(loop);
    }
    this.note(loop, `看到新的 head ${short(pr.headRefOid)}`);
    loop.pendingFix = null;
    return this.launchReview(loop, pr);
  }

  private async waitingCi(loop: Loop): Promise<void> {
    const pr = await this.openPr(loop);
    if (!pr) return;
    if (!(await this.implAlive(loop))) return;
    if (pr.headRefOid !== loop.reviewedSha) {
      // The code changed after the review passed: the latest round must cover what gets merged
      this.note(loop, `review 之後 head 變成 ${short(pr.headRefOid)}，重新 review`);
      return this.launchReview(loop, pr);
    }
    const ci = await this.gh.checks(loop.repo, loop.number);
    if (ci.state === 'pending') {
      loop.phase = 'waitingCi';
      loop.heartbeat = this.now();
      return this.save(loop);
    }
    if (ci.state === 'fail') {
      const names = ci.failed.map(f => `${f.workflow}/${f.name}`);
      const repeated = loop.lastCiFail ? names.filter(n => loop.lastCiFail!.includes(n)) : [];
      loop.pendingFix = ciFailure(this.target(loop, pr), ci.failed);
      loop.lastCiFail = names;
      this.note(loop, `CI 失敗：${names.join(', ')}`);
      if (repeated.length) {
        return this.halt(loop, 'repeated', `CI 連續兩次在同樣的檢查失敗：${repeated.join('、')}。\n\n${loop.pendingFix}`, 'fix');
      }
      if (loop.round >= loop.roundLimit) {
        return this.halt(loop, 'max-rounds', `CI 失敗，但修正後需要的下一輪 review 會超過 ${MAX_ROUNDS} 輪。\n\n${loop.pendingFix}`, 'fix');
      }
      return this.sendFix(loop);
    }
    loop.lastCiFail = null;
    if (pr.isDraft) return this.halt(loop, 'draft', 'review 與 CI 都通過，但 PR 還是 draft。標成 ready for review 後接續。', 'ci');
    if (pr.mergeable === 'CONFLICTING') return this.halt(loop, 'merge-conflict', 'review 與 CI 都通過，但 PR 與目標分支有衝突，需要先解決（可請實作 session 處理後 push，接著會重新 review）。', 'ci');
    const c = await this.config();
    if (!c.allowedRepos.some(r => r.toLowerCase() === loop.repo.toLowerCase())) {
      return this.halt(loop, 'not-allowed', `${loop.repo} 已經不在允許清單，不會合併。`, 'ci');
    }
    const ciText = ci.state === 'none' ? '這個 repo 沒有設定 CI' : 'CI 全部通過';
    if (c.merge === 'auto') {
      this.note(loop, `review 通過、${ciText}，依設定自動合併`);
      return this.merge(loop, pr);
    }
    loop.phase = 'confirmMerge';
    this.note(loop, `review 通過、${ciText}，等使用者確認合併`);
    await this.save(loop);
    this.askMerge(loop, ciText);
  }

  private askMerge(loop: Loop, ciText: string): void {
    const last = loop.rounds[loop.rounds.length - 1];
    const message = [
      `pr-loop：${loop.repo}#${loop.number}「${loop.title}」可以合併了。`,
      `- 第 ${loop.round} 輪獨立 review（reviewer session \`${last?.reviewer ?? '?'}\`）判定可合併，沒有 blocking`,
      `- ${ciText}`,
      `- 會用一般 merge commit 合併 \`${loop.headRef}\` → \`${loop.baseRef}\`，只合併 review 過的 commit \`${short(loop.reviewedSha)}\`；不 squash、不 rebase、不刪分支`,
      '',
      '要現在合併嗎？',
    ].join('\n');
    const key = loop.key;
    const createdAt = loop.createdAt;
    this.asking.add(key);
    void this.host
      .ask(loop.implSession, message, [{ id: 'merge', label: '合併' }, { id: 'later', label: '先不要' }], ASK_WAIT_SECS)
      .then(
        a => a,
        () => 'failed' as const,
      )
      .then(answer =>
        this.exclusive(async () => {
          this.asking.delete(key);
          const now = await this.loop(key);
          if (!now || now.createdAt !== createdAt || now.phase !== 'confirmMerge') return;
          if (answer === 'merge') {
            this.note(now, '使用者確認合併');
            return this.guarded(now, async () => {
              const pr = await this.openPr(now);
              if (pr) await this.merge(now, pr);
            });
          }
          const why = answer === 'failed' ? '確認卡片沒辦法顯示在實作 session（session 沒有開著？）。' : answer === null ? '確認卡片逾時沒有回應。' : '你選了先不要合併。';
          return this.halt(now, 'merge-declined', `${why}條件仍然滿足時，接續會重新檢查並再問一次。`, 'ci');
        }),
      );
  }

  // The merge, re-checked against GitHub first: the reviewed head, no failing or pending CI, still allowed
  private async merge(loop: Loop, pr: PullRequest): Promise<void> {
    if (pr.headRefOid !== loop.reviewedSha) {
      this.note(loop, `合併前發現 head 變成 ${short(pr.headRefOid)}，重新 review`);
      return this.launchReview(loop, pr);
    }
    const ci = await this.gh.checks(loop.repo, loop.number);
    if (ci.state === 'fail' || ci.state === 'pending') {
      loop.phase = 'waitingCi';
      await this.save(loop);
      return this.waitingCi(loop);
    }
    const c = await this.config();
    if (!c.allowedRepos.some(r => r.toLowerCase() === loop.repo.toLowerCase())) {
      return this.halt(loop, 'not-allowed', `${loop.repo} 已經不在允許清單，不會合併。`, 'ci');
    }
    loop.phase = 'merging';
    await this.save(loop);
    try {
      await this.gh.merge(loop.repo, loop.number, loop.reviewedSha);
    } catch (e) {
      // A merge that failed on the way back may still have happened
      const after = await this.gh.pr(loop.number, loop.repo).catch(() => null);
      if (after?.state !== 'MERGED') {
        return this.halt(loop, 'gh', `合併失敗：${(e as Error).message}`, 'ci');
      }
    }
    return this.finishMerge(loop);
  }

  private async recoverMerge(loop: Loop): Promise<void> {
    const pr = await this.gh.pr(loop.number, loop.repo);
    if (pr.state === 'MERGED') {
      this.note(loop, '引擎重啟後確認 PR 已合併');
      return this.finishMerge(loop, pr);
    }
    return this.halt(loop, 'interrupted', `合併途中引擎停止了，PR 目前是 ${pr.state}，沒有被合併。不會自動再合併一次。`, 'ci');
  }

  private async finishMerge(loop: Loop, known?: PullRequest): Promise<void> {
    const pr = known ?? (await this.gh.pr(loop.number, loop.repo));
    loop.phase = 'merged';
    loop.merge = { commit: pr.mergeCommit, at: this.now() };
    loop.pendingFix = null;
    this.note(loop, `已合併，merge commit ${pr.mergeCommit ?? '（gh 沒有回報）'}`);
    await this.save(loop);
    await this.say(
      loop.implSession,
      [
        `pr-loop：已合併 ${loop.repo}#${loop.number}「${loop.title}」。`,
        `- merge commit：\`${pr.mergeCommit ?? '（gh 沒有回報，請到 PR 頁面確認）'}\``,
        `- 合併內容：\`${loop.headRef}\` 的 \`${short(loop.reviewedSha)}\` → \`${loop.baseRef}\`（一般 merge commit，分支保留）`,
        `- 經過 ${loop.round} 輪獨立 review；最後一輪判定可合併、沒有 blocking`,
        `- ${loop.url}`,
      ].join('\n'),
    );
  }

  // ---- status ----

  async statusText(ref: string | null, session: string): Promise<string> {
    const all = (await this.loops()).sort((a, b) => b.updatedAt - a.updatedAt);
    const shown = ref ? all.filter(l => l.url === ref || String(l.number) === ref.replace(/^#/, '')) : all.filter(l => isActive(l) || l.phase === 'stopped' || l.implSession === session);
    if (!shown.length) return 'pr-loop：沒有循環。';
    return shown
      .map(l =>
        [
          `**${l.repo}#${l.number}**「${l.title}」：${PHASE_TEXT[l.phase]}（第 ${l.round}/${l.roundLimit} 輪）`,
          l.stop ? `- 停下原因：${REASON_TEXT[l.stop.reason]}（卡在：${PHASE_TEXT[l.stop.step]}）${l.stop.resume ? `；\`/pr-loop resume\` 會${RESUME_TEXT[l.stop.resume]}` : ''}` : '',
          l.reviewer ? `- 目前 reviewer session：\`${l.reviewer.session}\`（${l.reviewer.agent}）` : '',
          `- 實作 session：\`${l.implSession}\`；需求原文來源：${SOURCE_TEXT[l.requirementSource]}`,
          ...l.rounds.map(r => `- 第 ${r.round} 輪（${short(r.sha)}）：${ROUND_TEXT[r.result]}${r.keys.length ? `（${r.keys.join(', ')}）` : ''}`),
          l.merge ? `- merge commit：\`${l.merge.commit ?? '?'}\`` : '',
          l.log.length ? `- 最近：${l.log[l.log.length - 1]}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
  }
}

class Cancelled extends Error {
  constructor() {
    super('the loop was cancelled');
  }
}

const SOURCE_TEXT: Record<Loop['requirementSource'], string> = {
  command: '指令參數',
  'pr-body': 'PR 描述的「需求原文」段落',
  'first-message': '實作 session 的第一則使用者訊息',
};

const ROUND_TEXT: Record<Round['result'], string> = {
  mergeable: '可合併',
  not_mergeable: '不可合併',
  unparseable: '輸出無法解析',
  conflict: '回報衝突',
};

export function configText(c: Config): string {
  return [
    'pr-loop 設定：',
    `- 允許自動循環的 repo：${c.allowedRepos.length ? c.allowedRepos.join('、') : '（空，任何 PR 都不會啟動）'}`,
    `- reviewer agent：${c.reviewerAgent || '與實作 session 相同'}`,
    `- 合併：${c.merge === 'auto' ? 'auto（條件都滿足時自動合併）' : 'confirm（合併前出確認卡片）'}`,
    `- 輪詢間隔：${c.pollSecs} 秒`,
    `- 同一類問題的判定：${c.sameIssue}`,
    `- gh 指令：${JSON.stringify(c.gh)}`,
  ].join('\n');
}

export const HELP = [
  '用法：',
  '- `/pr-loop <PR 編號或網址> [需求原文]`：開始自動循環（review → 修正 → CI → 合併）',
  '- `/pr-loop status [PR]`：查看狀態',
  '- `/pr-loop stop [PR]`：停止循環',
  '- `/pr-loop resume [PR]`：接續停下的循環',
  '- `/pr-loop config`：查看設定',
  '- `/pr-loop config allow <owner>/<repo>` / `disallow <owner>/<repo>`：允許清單',
  '- `/pr-loop config reviewer <agent id|same>`：reviewer 用的 agent',
  '- `/pr-loop config merge confirm|auto`：合併前確認或自動合併',
  '- `/pr-loop config poll <秒>`、`same-issue category+file|category`、`gh <argv>`',
].join('\n');
