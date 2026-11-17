// The PR loop as a state machine: review by a fresh reviewer session, fixes sent back to the implementing session, CI,
// then one merge commit. Every effect goes through injected interfaces (`Host` for sessions and cards, `Store` for the
// plugin's storage, `GitHub` over a `gh` runner), so the whole loop runs in tests without Acpira or GitHub.
//
// Persistence: one `state` key holds every loop, written compare-and-swap. A step that starts something that must not
// happen twice (a reviewer session, the merge) saves a transient phase (`launching`, `merging`) first; finding one of
// those outside a running step means the engine stopped mid-step, so the loop stops and says where instead of redoing it.
//
// The merge invariant: `gh pr merge` runs only while the newest round's verdict is `mergeable` for exactly the PR's
// current head (`passed`). Nothing else (a phase, a resume, a stored sha) stands in for it.
//
// The stop invariant: every step that moves the loop on (a review round opened, a fix list sent, CI waited on, the
// merge) first asks `gate`, which asks the pure `mustStop` (gate.ts) over the raw facts of every round, and stops on
// everything it returns at once. Only the user's consent to a stop that named a hold lets that hold through

import { randomBytes } from 'node:crypto';
import { effectiveResult, issueKeyList, mustStop, type CiRun, type Issue, type RoundFacts, type Transition } from './gate';
import { GhError, parsePrUrl, type GitHub, type PullRequest } from './github';
import {
  brief,
  ciFailure,
  fixList,
  NOTES_TITLES,
  oneLine,
  parseVerdict,
  REQUIREMENT_TITLES,
  section,
  verdictBegin,
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
  // machine never waits on it inside a step. The engine drops a prompt to a session it does not have open, so the
  // machine checks the session is open first
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
  // `owner/repo` (github.com) or `host/owner/repo` the loop may run on and merge into; empty means nowhere
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
// "No checks" right after a push may be checks not registered yet: it has to hold this long before it counts as no CI
export const NO_CI_GRACE_MS = 2 * 60_000;
// A loop whose owner wrote nothing this many polls ago (and at least STALE_MIN_MS, longer than one gh call may take) is
// taken over by another engine
const STALE_POLLS = 3;
const STALE_MIN_MS = 5 * 60_000;
// How long a step may wait on someone else before the loop stops and says so: a reviewer still working (or held by a
// permission card), the implementing session not pushing the fix, CI not finishing
export const REVIEW_WAIT_MS = 60 * 60_000;
export const FIX_WAIT_MS = 4 * 60 * 60_000;
export const CI_WAIT_MS = 2 * 60 * 60_000;
const LOG_MAX = 40;
// Merged loops kept beyond this many are let go; any loop that is not running (stopped and cancelled included) is let
// go once nothing happened to it for RETAIN_MS. Until then a restart of the same PR carries its rounds on
const KEEP_FINISHED = 20;
export const RETAIN_MS = 30 * 24 * 60 * 60_000;
const ASK_WAIT_SECS = 25 * 60;
const CONFIRM_WAIT_SECS = 5 * 60;

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
  | 'impl-closed'
  | 'reviewer-gone'
  | 'reviewer-failed'
  | 'interrupted'
  | 'merge-declined'
  | 'draft'
  | 'merge-conflict'
  | 'not-allowed'
  | 'base-changed'
  | 'force-push'
  | 'stalled'
  | 'error';

// What `/pr-loop resume` does after a stop: a new review round, the stored fix list sent, the CI step again, or the
// step that failed retried
export type Resume = 'review' | 'fix' | 'ci' | 'retry';

// A review round as it happened: what the reviewer said, never a value derived from a setting (`mustStop` derives what
// it needs each time). A `conflict` round keeps `result: 'conflict'` for good; the user accepting it is a consent
// (`conflict:<round>`), not a rewrite of the round
export interface Round extends RoundFacts {
  // The branch the PR targeted when this round was reviewed: the diff the reviewer saw
  base: string;
  reviewer: string;
  at: number;
  conflicts: string[];
  blocking: number;
}

export interface Stop {
  // The first reason; `also` holds the others that held at the same time, and the card names them all
  reason: StopReason;
  also: StopReason[];
  step: Phase;
  detail: string;
  resume: Resume | null;
  at: number;
  // Names this stop; a stop card acts only on the stop it was shown for
  id: string;
  // The holds this stop named, by token: resuming from it records exactly these as the user's consent
  consents: string[];
  // The stop said resuming goes past the round limit: resuming grants exactly one more round
  grantRound: boolean;
  // What resuming agrees to, as the card said it; non-empty means `/pr-loop resume` needs `confirm`
  agree: string[];
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
  // The target branch the current round reviews against
  reviewedBase: string;
  baseSha: string;
  reviewer: { session: string; agent: string; sentAt: number; nonce: string } | null;
  rounds: Round[];
  pendingFix: string | null;
  // The fix list (`pendingFix`) is decided but not yet handed to the implementing session
  fixPending: boolean;
  // The fix list's prompt was started at this time and has not been seen to go out yet; found after an engine restart it
  // means the fix list may or may not have reached the session
  fixSending: number | null;
  // When the current wait on someone else began (a reviewer, a fix, CI); a resume starts it again
  since: number;
  // Settings that decide a stop, fixed when the loop starts: a later `config` change never turns a hold off (or on) for
  // a loop already running
  policy: { sameIssue: SameIssue };
  // Holds the user agreed to on a stop that named them (tokens from `mustStop`)
  consents: string[];
  // Every CI result the loop saw, one per head
  ciRuns: CiRun[];
  // Where the pending fix list came from
  fixFrom: 'review' | 'ci' | null;
  // When "no checks" was first seen for the current head
  noCiSince: { sha: string; at: number } | null;
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
  'max-rounds': 'review 輪數已達上限',
  repeated: '連續兩輪退回同一類問題',
  unparseable: 'reviewer 的輸出無法解析',
  conflict: 'reviewer 回報互相衝突、需要你決定的意見',
  gh: 'gh 執行失敗或未登入',
  'pr-closed': 'PR 已被關閉',
  'pr-merged-elsewhere': 'PR 已被別人合併',
  'impl-gone': '實作 session 不見了',
  'impl-closed': '實作 session 沒有在這個引擎開著',
  'reviewer-gone': 'reviewer session 不見了',
  'reviewer-failed': 'reviewer session 沒有開始或沒有回覆',
  interrupted: '引擎在這一步中途停止',
  'merge-declined': '合併沒有被確認',
  draft: 'PR 是 draft，不能合併',
  'merge-conflict': 'PR 與目標分支有衝突',
  'not-allowed': 'PR 所在的 repo 不在允許清單',
  'base-changed': 'PR 的目標分支和 review 時不同',
  'force-push': 'PR 分支的歷史被改寫（force push）',
  stalled: '等太久沒有進展',
  error: '外掛內部錯誤',
};

const RESUME_TEXT: Record<Resume, string> = {
  review: '開一個新的 reviewer 重新 review 目前的 head',
  fix: '把修正清單送回實作 session，修完後再 review',
  ci: '重新檢查 review 結論、CI 與合併條件',
  retry: '重試卡住的那一步',
};

export const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const short = (sha: string) => sha.slice(0, 8);
const REQUIREMENT_SHOWN = 1200;
// Text that came from someone else (a requirement, a reviewer, a PR, gh) as a block quote on a card: every line of it
// starts with `> `, so none of it can pass for the card's own lines (its reasons or its options)
const quote = (text: string, max = REQUIREMENT_SHOWN) =>
  (text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字，後面省略）` : text)
    .split(/\r?\n|\r/)
    .map(l => `> ${l}`)
    .join('\n');
const FIX_SHOWN = 4000;
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// The reply to the prompt carrying `nonce`: the agent turns after that user turn, up to the next user turn (a later
// prompt from another plugin or a gate is not the reviewer's verdict)
export function lastReply(view: SessionView, nonce: string): { asked: boolean; replied: boolean; text: string; error: string; stop: string } {
  const turns = view.turns ?? [];
  let u = -1;
  turns.forEach((t, i) => {
    if (t.role === 'user' && typeof t.text === 'string' && t.text.includes(verdictBegin(nonce))) u = i;
  });
  if (u < 0) return { asked: false, replied: false, text: '', error: '', stop: '' };
  const after: Record<string, unknown>[] = [];
  for (const t of turns.slice(u + 1)) {
    if (t.role === 'user') break;
    if (t.role === 'agent') after.push(t);
  }
  const text = after
    .flatMap(t => (Array.isArray(t.blocks) ? (t.blocks as Record<string, unknown>[]) : []))
    .filter(b => b.type === 'text' && typeof b.markdown === 'string')
    .map(b => b.markdown as string)
    .join('\n');
  const error = after
    .map(t => (t.error && typeof t.error === 'object' ? String((t.error as Record<string, unknown>).message ?? '') : ''))
    .filter(Boolean)
    .join('; ');
  // How the reply's last agent turn ended (`end_turn`, `cancelled`, `max_tokens` …; empty while it runs or when the
  // engine did not say)
  const last = after[after.length - 1];
  const stop = typeof last?.stop === 'string' ? last.stop : '';
  return { asked: true, replied: after.length > 0, text, error, stop };
}

// A resume that lets a hold through: from a command it takes `/pr-loop resume confirm`
const needsConsent = (stop: Stop) => stop.consents.length > 0 || stop.grantRound;

const reasonsOf = (stop: Stop): StopReason[] => [stop.reason, ...stop.also];

// The newest round passed review for exactly `sha` against exactly the target branch `base`: the only ground for a
// merge or a merge card. A conflict round counts only once the user accepted its verdict
export function passed(loop: Loop, sha: string, base: string): boolean {
  const last = loop.rounds[loop.rounds.length - 1];
  return !!last && last.round === loop.round && effectiveResult(last, loop.consents) === 'mergeable' && !!sha && last.sha === sha && !!base && last.base === base;
}

// A loop written by an earlier version of the plugin, filled in so every field the steps read is there
function normalize(l: Loop): Loop {
  l.policy ??= { sameIssue: 'category' };
  l.consents ??= [];
  l.ciRuns ??= [];
  l.fixFrom ??= null;
  for (const r of l.rounds ?? []) {
    r.issues ??= [];
    r.conflicts ??= [];
  }
  if (l.stop) {
    l.stop.also ??= [];
    l.stop.consents ??= [];
    l.stop.agree ??= [];
    l.stop.grantRound ??= false;
  }
  return l;
}

const randomNonce = () => randomBytes(8).toString('hex');

export interface Deps {
  host: Host;
  store: Store;
  gh: GitHub;
  now?: () => number;
  // This process's identity among engines
  owner: string;
  nonce?: () => string;
}

export class PrLoop {
  private readonly host: Host;
  private readonly store: Store;
  private readonly gh: GitHub;
  private readonly now: () => number;
  private readonly nonce: () => string;
  readonly owner: string;
  private chain: Promise<unknown> = Promise.resolve();
  // Merge cards open right now, by loop key (the value names the card): a tick never shows a second one, and an old
  // card's answer never clears a newer one
  private readonly asking = new Map<string, number>();
  private cardSeq = 0;
  // Fix-list prompts this process started and has not seen go out
  private readonly inflight = new Set<string>();
  private staleMs = STALE_MIN_MS;

  constructor(deps: Deps) {
    this.host = deps.host;
    this.store = deps.store;
    this.gh = deps.gh;
    this.now = deps.now ?? Date.now;
    this.nonce = deps.nonce ?? randomNonce;
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
    if (!s || !s.loops) return { version: 1, loops: {} };
    for (const l of Object.values(s.loops)) normalize(l);
    return s;
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

  // Writes the loop back. A loop cancelled meanwhile stays cancelled, one another engine owns and still writes is not
  // overwritten, and neither is a newer loop for the same PR; `claim` (a user's command, a takeover) takes it over.
  // `merged` records a merge that happened: GitHub already did it, so nothing here may turn it away but a newer loop
  private async save(loop: Loop, claim = false, merged = false): Promise<void> {
    loop.updatedAt = this.now();
    loop.heartbeat = this.now();
    loop.log = loop.log.slice(-LOG_MAX);
    if (claim) loop.owner = this.owner;
    let abort: string | null = null;
    await this.update(s => {
      const stored = s.loops[loop.key];
      if (stored && stored.createdAt > loop.createdAt) {
        abort = 'a newer loop for this PR started';
        return;
      }
      if (stored && stored.createdAt === loop.createdAt && !merged) {
        if (stored.phase === 'cancelled' && loop.phase !== 'cancelled') {
          abort = 'the loop was cancelled';
          return;
        }
        if (!claim && stored.owner !== loop.owner && this.now() - stored.heartbeat < this.staleMs) {
          abort = `the loop is run by ${stored.owner}`;
          return;
        }
      }
      s.loops[loop.key] = loop;
      // The store stays small: old merged loops beyond the newest few, and anything not running that sat untouched
      // for RETAIN_MS (a stop nobody came back to included), are let go
      const done = Object.values(s.loops).filter(l => !isActive(l) && l.key !== loop.key);
      for (const l of done) if (this.now() - l.updatedAt > RETAIN_MS) delete s.loops[l.key];
      const merges = done.filter(l => l.phase === 'merged' && s.loops[l.key]).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const l of merges.slice(KEEP_FINISHED)) delete s.loops[l.key];
    });
    if (abort) throw new Aborted(abort);
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
          return await this.configCmd(session, rest);
        default:
          return await this.exclusive(() => this.start(session, head, tail));
      }
    } catch (e) {
      await this.say(session, `pr-loop：${(e as Error).message}`, 'error');
    }
  }

  // A setting change. One that loosens a limit (a repo allowed, the reviewer or gh program changed, merging without a
  // card) waits for a confirmation card first: the command may come from another plugin's prompt, not a person typing
  private async configCmd(session: string, args: string[]): Promise<void> {
    const [what = '', ...values] = args;
    const value = values.join(' ').trim();
    // `github.com/owner/repo` is the same repository the loop names `owner/repo`
    const repo = value.replace(/^github\.com\//i, '');
    const repoOk = (r: string) => /^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/.test(r);
    let change: ((c: Config) => void) | null = null;
    let loosens: string | null = null;
    switch (what.toLowerCase()) {
      case '':
        break;
      case 'allow':
        if (!repoOk(repo)) throw new Error('用法：/pr-loop config allow <owner>/<repo>（github.com 以外加上 host：<host>/<owner>/<repo>）');
        change = c => {
          if (!c.allowedRepos.some(r => sameRepo(r, repo))) c.allowedRepos.push(repo);
        };
        loosens = `允許在 \`${repo}\` 上自動循環並合併 PR`;
        break;
      case 'disallow':
        change = c => {
          c.allowedRepos = c.allowedRepos.filter(r => !sameRepo(r, repo));
        };
        break;
      case 'reviewer':
        change = c => {
          c.reviewerAgent = value === 'same' ? '' : value;
        };
        loosens = `reviewer 改用 agent \`${value === 'same' ? '與實作 session 相同' : value}\``;
        break;
      case 'merge':
        if (value !== 'confirm' && value !== 'auto') throw new Error('用法：/pr-loop config merge confirm|auto');
        change = c => {
          c.merge = value;
        };
        if (value === 'auto') loosens = '條件都滿足時不再出確認卡片，直接合併';
        break;
      case 'poll': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 5 || n > 3600) throw new Error('用法：/pr-loop config poll <5 到 3600 秒>');
        change = c => {
          c.pollSecs = Math.round(n);
        };
        break;
      }
      case 'same-issue':
        if (value !== 'category+file' && value !== 'category') throw new Error('用法：/pr-loop config same-issue category+file|category');
        change = c => {
          c.sameIssue = value;
        };
        // A loop takes this setting when it starts and keeps it: a running loop is never changed by it. `category+file`
        // counts fewer problems as the same kind (fewer stops) for loops started later, so it is confirmed first
        if (value === 'category+file') loosens = '之後新開的循環改用「類別＋檔案」判定同一類問題（比只看類別寬鬆，停下的次數會變少；已經在跑的循環不受影響）';
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
        change = c => {
          c.gh = argv as string[];
        };
        loosens = `之後的 gh 呼叫改成執行 \`${JSON.stringify(argv)}\`（這個程式會以你的權限執行）`;
        break;
      }
      default:
        throw new Error(`不認得的設定 \`${what}\`。\n\n${HELP}`);
    }
    const apply = async () => {
      const c = await this.config();
      if (change) {
        change(c);
        await this.store.set('config', c);
      }
      await this.say(session, configText(c));
    };
    if (!loosens) return this.exclusive(apply);
    const answer = await this.host
      .ask(session, `pr-loop：要變更設定嗎？\n\n${loosens}。\n\n這會放寬 pr-loop 的限制，請確認是你自己要求的。`, [{ id: 'confirm', label: '確認變更' }, { id: 'cancel', label: '取消' }], CONFIRM_WAIT_SECS)
      .catch(() => null);
    if (answer !== 'confirm') return this.say(session, 'pr-loop：設定沒有變更。');
    return this.exclusive(apply);
  }

  private async findLoop(session: string, ref: string | null, want: (l: Loop) => boolean): Promise<Loop | null> {
    const all = (await this.loops()).filter(want).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!ref) return all.find(l => l.implSession === session) ?? null;
    return pickLoop(all, session, ref);
  }

  private async cancel(session: string, ref: string | null): Promise<void> {
    const loop = await this.findLoop(session, ref, l => isActive(l) || l.phase === 'stopped');
    if (!loop) return this.say(session, 'pr-loop：沒有進行中或停下的循環可以停止。');
    // `gh pr merge` may be running in this or another engine: cancelling now would not stop it, only lose its report
    if (loop.phase === 'merging') {
      return this.say(session, `pr-loop：${loop.repo}#${loop.number} 正在合併，這一步不能停止。合併結束後會回報結果；之後可以用 \`/pr-loop status\` 查看。`, 'warning');
    }
    loop.phase = 'cancelled';
    this.note(loop, '使用者停止了循環');
    await this.save(loop, true);
    await this.say(session, `pr-loop：已停止 ${loop.repo}#${loop.number} 的循環。已開的 reviewer session 不會被刪除；PR 不會被合併。`);
  }

  // `/pr-loop resume [confirm] [PR]`. A stop whose resume lets a hold through (conflicts, a repeated issue, a round past
  // the limit, rewritten history) takes `confirm`: the command may come from another plugin's prompt, so agreeing is
  // never implied by it. The stop card's own button is the other way to agree
  private async resumeCmd(session: string, args: string | null): Promise<void> {
    const words = (args ?? '').split(/\s+/).filter(Boolean);
    const confirm = words[0]?.toLowerCase() === 'confirm';
    const ref = (confirm ? words.slice(1) : words).join(' ') || null;
    const loop = await this.findLoop(session, ref, l => l.phase === 'stopped');
    if (!loop || !loop.stop) return this.say(session, 'pr-loop：沒有停下等你決定的循環。');
    if (loop.stop.resume && needsConsent(loop.stop) && !confirm) {
      return this.say(
        session,
        [
          `pr-loop：${loop.repo}#${loop.number} 停下的原因是 ${reasonsOf(loop.stop).map(r => REASON_TEXT[r]).join('、')}，接續需要你明確同意：`,
          ...loop.stop.agree.map(a => `- ${a}`),
          '',
          `確認同意後執行 \`/pr-loop resume confirm${ref ? ` ${ref}` : ''}\`，或在停下時的卡片按「接續」。沒有接續任何東西。`,
        ].join('\n'),
        'warning',
      );
    }
    await this.resume(loop);
  }

  private async resume(loop: Loop): Promise<void> {
    const stop = loop.stop!;
    if (!stop.resume) {
      return this.say(loop.implSession, `pr-loop：${loop.repo}#${loop.number} 停在「${REASON_TEXT[stop.reason]}」，不能接續；要重來請重新執行 /pr-loop ${loop.url}`);
    }
    const action = stop.resume;
    this.note(loop, `使用者選擇接續：${RESUME_TEXT[action]}${stop.agree.length ? `（同意：${stop.agree.join('；')}）` : ''}`);
    // Back to the step it stopped at, so a failure while resuming records that step and the same way on
    loop.stop = null;
    loop.phase = stop.step;
    // A wait that ran out starts over
    loop.since = this.now();
    // Exactly what this stop named is agreed to: its holds by token, and one more round only when it said so. Anything
    // else that holds is stopped on again by the next `gate`
    loop.consents = [...new Set([...loop.consents, ...stop.consents])];
    if (stop.grantRound) loop.roundLimit = Math.max(loop.roundLimit, loop.round + 1);
    await this.save(loop, true);
    // Stopped around the merge: GitHub says whether it happened before anything else is done
    if (stop.step === 'merging') return this.guarded(loop, () => this.recoverMerge(loop), action);
    switch (action) {
      case 'review':
        // After a target branch change, resuming is the user's word that the new branch is the agreed one
        return this.guarded(loop, () => this.launchReview(loop, undefined, stop.reason === 'base-changed'), action);
      case 'fix':
        loop.phase = 'waitingFix';
        loop.fixPending = true;
        return this.guarded(loop, () => this.sendFix(loop), action);
      case 'ci':
        loop.phase = 'waitingCi';
        return this.guarded(loop, () => this.waitingCi(loop), action);
      case 'retry':
        if (stop.step === 'launching') return this.guarded(loop, () => this.launchReview(loop), action);
        return this.guarded(loop, () => this.advance(loop), action);
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
    if (!c.allowedRepos.some(r => sameRepo(r, pr.repo))) {
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
    // `createdAt` tells a loop from an earlier one for the same PR: never the same value
    const now = Math.max(this.now(), (existing?.createdAt ?? 0) + 1);
    // A loop stopped with `/pr-loop stop` for this PR: its rounds, round limit, consents and stop settings carry on, so
    // stopping and starting again never resets what makes the loop stop (the round count, a repeated issue)
    const prior = existing && existing.phase === 'cancelled' ? existing : null;
    const loop: Loop = {
      key,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: oneLine(pr.title),
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      implSession: session,
      implAgent: info.agent,
      cwd: info.cwd,
      requirement,
      requirementSource: source,
      notes,
      phase: 'launching',
      round: prior?.round ?? 0,
      roundLimit: prior?.roundLimit ?? MAX_ROUNDS,
      reviewedSha: prior?.reviewedSha ?? '',
      reviewedBase: pr.baseRefName,
      baseSha: pr.headRefOid,
      reviewer: null,
      rounds: prior?.rounds ?? [],
      pendingFix: null,
      fixPending: false,
      fixSending: null,
      since: now,
      policy: prior?.policy ?? { sameIssue: c.sameIssue },
      consents: prior?.consents ?? [],
      ciRuns: prior?.ciRuns ?? [],
      fixFrom: null,
      noCiSince: null,
      stop: null,
      merge: null,
      owner: this.owner,
      heartbeat: now,
      createdAt: now,
      updatedAt: now,
      log: [],
    };
    this.note(loop, `開始循環（需求原文來源：${SOURCE_TEXT[source]}${notes ? '' : '；PR 描述沒有「給 reviewer 的重點建議」'}${prior ? `；接續先前停止的循環，沿用 ${prior.round} 輪紀錄` : ''}）`);
    await this.say(
      session,
      [
        `pr-loop：開始 ${pr.repo}#${pr.number}「${loop.title}」的自動循環。`,
        ...(prior
          ? [
              `- 這個 PR 先前的循環是用 \`/pr-loop stop\` 停止的：沿用它已做的 ${prior.round} 輪 review 紀錄、輪數上限 ${loop.roundLimit} 輪、你已同意過的項目與同一類問題的判定方式（${loop.policy.sameIssue}），輪數不會從 0 重新計算。`,
            ]
          : []),
        `- 需求原文來源：${SOURCE_TEXT[source]}${source === 'pr-body' ? '（這段是實作者自己寫在 PR 描述裡的，請確認它就是你的需求；不對就 `/pr-loop stop` 後附上需求原文重新開始）' : ''}`,
        `- 送給 reviewer 的需求原文：\n${quote(requirement)}`,
        `- 給 reviewer 的重點建議：${notes ? '已從 PR 描述取得' : 'PR 描述中沒有這一段'}`,
        `- reviewer agent：${c.reviewerAgent || `${info.agent}（與實作 session 相同）`}`,
        `- 合併方式：${c.merge === 'auto' ? '條件都滿足時自動合併（merge commit）' : '合併前出確認卡片（merge commit）'}`,
        `- 同一類問題的判定：${loop.policy.sameIssue}（這個循環固定用這個方式，之後改設定不影響它）`,
        `- 最多 ${loop.roundLimit} 輪；用 \`/pr-loop status\` 查看、\`/pr-loop stop\` 停止。`,
      ].join('\n'),
    );
    await this.guarded(loop, () => this.launchReview(loop, pr), 'review');
  }

  private async firstMessage(session: string): Promise<string> {
    const view = await this.host.session(session, 100_000);
    const first = (view?.turns ?? []).find(t => t.role === 'user' && typeof t.text === 'string' && !(t.text as string).trim().startsWith('/pr-loop'));
    return typeof first?.text === 'string' ? first.text.trim() : '';
  }

  // ---- the loop ----

  // Runs a step; a GitHub failure or anything thrown stops the loop with what happened, never retried in silence.
  // `onError` is what resuming after such a failure does (a failure while resuming keeps the resume it came from)
  private async guarded(loop: Loop, fn: () => Promise<void>, onError: Resume = 'retry'): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof Aborted) return;
      if (e instanceof GhError) {
        return this.halt(loop, 'gh', `gh 的訊息：\n${quote(e.message)}\n\n先確認 \`gh auth status\` 已登入、網路正常。`, onError);
      }
      return this.halt(loop, 'error', quote((e as Error).stack ?? String(e)), onError);
    }
  }

  // Every hold `mustStop` finds before `transition`, all on one stop; true when there is none and the step may go on.
  // `resume` is what resuming after the stop does (it runs the same step again, which asks again); `context` is shown
  // after the reasons (the fix list waiting to go out, for one)
  private async gate(loop: Loop, transition: Transition, resume: Resume, context = '', rewritten: { from: string; to: string; unknown?: string } | null = null): Promise<boolean> {
    const holds = mustStop({
      transition,
      rounds: loop.rounds,
      ciRuns: loop.ciRuns,
      round: loop.round,
      roundLimit: loop.roundLimit,
      sameIssue: loop.policy.sameIssue,
      fixFrom: loop.fixFrom,
      consents: loop.consents,
      rewritten,
    });
    if (!holds.length) return true;
    const last = loop.rounds[loop.rounds.length - 1];
    const details = holds.map(h => (h.reason === 'conflict' && last?.conflicts.length ? `${h.detail}\n\nreviewer 回報的衝突：\n${quote(last.conflicts.map(x => `- ${x}`).join('\n'))}` : h.detail));
    await this.halt(loop, holds[0]!.reason, [...details, context].filter(Boolean).join('\n\n'), resume, {
      also: holds.slice(1).map(h => h.reason),
      consents: holds.flatMap(h => (h.token ? [h.token] : [])),
      grantRound: holds.some(h => h.reason === 'max-rounds'),
      agree: holds.map(h => h.agree),
    });
    return false;
  }

  // The loop stops for the user: where it is, what was done, and what resuming would do. `also`: further reasons that
  // hold at the same time, all named. `consents`, `grantRound`, `agree`: what resuming from this stop lets through (only
  // `gate` passes them), written on the card, in the toast and in `status`
  private async halt(
    loop: Loop,
    reason: StopReason,
    detail: string,
    resume: Resume | null,
    opts: { also?: StopReason[]; consents?: string[]; grantRound?: boolean; agree?: string[] } = {},
  ): Promise<void> {
    const step: Phase = loop.phase === 'stopped' ? (loop.stop?.step ?? 'launching') : loop.phase;
    const also = [...new Set((opts.also ?? []).filter(r => r !== reason))];
    const stop: Stop = {
      reason,
      also,
      step,
      detail,
      resume,
      at: this.now(),
      id: randomBytes(6).toString('hex'),
      consents: resume ? [...(opts.consents ?? [])] : [],
      grantRound: !!(resume && opts.grantRound),
      agree: resume ? [...(opts.agree ?? [])] : [],
    };
    loop.stop = stop;
    loop.phase = 'stopped';
    const reasons = reasonsOf(stop);
    this.note(loop, `停下：${reasons.map(r => REASON_TEXT[r]).join('、')}`);
    try {
      await this.save(loop);
    } catch (e) {
      if (e instanceof Aborted) return;
      throw e;
    }
    const done = loop.rounds.map(r => `第 ${r.round} 輪（${short(r.sha)}）：${ROUND_TEXT[r.result]}${r.blocking ? `，${r.blocking} 個 blocking` : ''}`);
    const message = [
      `pr-loop：${loop.repo}#${loop.number} 停下來了 —— ${reasons.map(r => REASON_TEXT[r]).join('；')}。`,
      ...(reasons.length > 1 ? ['', `同時成立的停止原因（${reasons.length} 個）：`, ...reasons.map(r => `- ${REASON_TEXT[r]}`)] : []),
      '',
      `卡在：${PHASE_TEXT[step]}（第 ${loop.round} 輪，上限 ${loop.roundLimit} 輪）`,
      '',
      detail,
      '',
      '已經做了：',
      ...(done.length ? done.map(d => `- ${d}`) : ['- 還沒有完成任何一輪 review']),
      '',
      '建議的選項：',
      ...(resume
        ? [
            `- 接續：${RESUME_TEXT[resume]}（按「接續」，或 \`/pr-loop resume${needsConsent(stop) ? ' confirm' : ''}\`）`,
            ...(stop.agree.length ? ['  按接續代表你同意：', ...stop.agree.map(a => `  - ${a}`)] : []),
          ]
        : []),
      `- 停止循環（\`/pr-loop stop\`），自己處理`,
      `- 查看狀態（\`/pr-loop status\`）`,
    ].join('\n');
    await this.host
      .toast(
        `pr-loop：${loop.repo}#${loop.number} 停下 —— ${reasons.map(r => REASON_TEXT[r]).join('、')}${stop.agree.length ? `。接續代表同意：${stop.agree.join('；')}` : ''}`.slice(0, 480),
        'warning',
      )
      .catch(() => {});
    // Every stop gets its own card: a card answers only the stop it describes, so an older one left open does nothing
    const options: AskOption[] = [...(resume ? [{ id: 'resume', label: '接續' }] : []), { id: 'stop', label: '停止循環' }, { id: 'later', label: '稍後決定' }];
    const createdAt = loop.createdAt;
    const stopId = loop.stop.id;
    this.background(
      this.host
        .ask(loop.implSession, message, options, ASK_WAIT_SECS)
        .catch(() => null)
        .then(answer =>
          this.exclusive(async () => {
            const now = await this.loop(loop.key);
            if (!now || now.createdAt !== createdAt || now.phase !== 'stopped' || now.stop?.id !== stopId) {
              if (answer === 'resume' || answer === 'stop') await this.say(now?.implSession ?? null, 'pr-loop：這張卡片說的那次停下已經過去了，請看最新的卡片或 `/pr-loop status`。');
              return;
            }
            if (answer === 'resume') await this.resume(now);
            else if (answer === 'stop') await this.cancel(now.implSession, now.url);
          }),
        ),
      'stop card',
    );
  }

  // A promise nobody awaits: a failure is logged, never left to end the plugin's process
  private background(p: Promise<unknown>, what: string): void {
    p.catch(e => {
      try {
        this.host.log(`${what}: ${(e as Error)?.stack ?? String(e)}`);
      } catch {
        /* nothing left to report to */
      }
    });
  }

  // Every loop this engine runs, one step each
  async tick(): Promise<void> {
    const c = await this.config();
    this.staleMs = Math.max(STALE_MIN_MS, c.pollSecs * 1000 * STALE_POLLS);
    for (const l of await this.loops()) {
      if (!isActive(l)) continue;
      await this.exclusive(async () => {
        const loop = await this.loop(l.key);
        if (!loop || !isActive(loop)) return;
        if (loop.owner !== this.owner) {
          // Another engine runs it while it writes; this one takes over when it went quiet or holds the session
          const mine = (await this.host.session(loop.implSession, 0)) !== null;
          const quiet = this.now() - loop.heartbeat >= this.staleMs;
          if (!mine && !quiet) return;
          // A merge may be under way in the other process (an upgrade runs old and new side by side for a moment): a
          // loop in `merging` is taken over only after it went quiet longer than a gh call may take
          if (loop.phase === 'merging' && !quiet) return;
          this.note(loop, `由這個引擎接手（前一個：${loop.owner}）`);
          try {
            await this.save(loop, true);
          } catch (e) {
            if (e instanceof Aborted) return;
            throw e;
          }
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

  // The PR as it is now, or a stop when it is closed, merged by someone else, or now targets another branch than the
  // one reviewed. `resume` is what resuming after such a stop does: the caller's own way on, so a reopened PR picks up
  // where it was. `acceptBase`: the user chose to review against the new target branch
  private async openPr(loop: Loop, resume: Resume, acceptBase = false): Promise<PullRequest | null> {
    const pr = await this.gh.pr(loop.number, loop.repo);
    if (pr.state === 'MERGED') {
      await this.halt(loop, 'pr-merged-elsewhere', `PR 已經在 pr-loop 之外被合併${pr.mergeCommit ? `（merge commit ${pr.mergeCommit}）` : ''}。`, null);
      return null;
    }
    if (pr.state === 'CLOSED') {
      await this.halt(loop, 'pr-closed', 'PR 已被關閉。重新打開後可以接續。', resume);
      return null;
    }
    if (!acceptBase && !(await this.sameBase(loop, pr))) return null;
    loop.headRef = pr.headRefName;
    loop.baseRef = pr.baseRefName;
    return pr;
  }

  // The PR still targets the branch this round reviews against; otherwise a stop for the user: a merge target other
  // than the agreed one is theirs to decide, and nothing reviewed so far covers the diff against the new one
  private async sameBase(loop: Loop, pr: PullRequest): Promise<boolean> {
    if (!loop.reviewedBase || pr.baseRefName === loop.reviewedBase) return true;
    await this.halt(
      loop,
      'base-changed',
      `PR 的目標分支從 \`${loop.reviewedBase}\` 改成了 \`${pr.baseRefName}\`。到目前為止的 review 都是對 \`${loop.reviewedBase}\` 的差異做的，不會合併到別的分支。\n\n請先確認 \`${pr.baseRefName}\` 是約定的合併目標；接續會對新的目標分支開一個新的 reviewer 從頭 review。`,
      'review',
    );
    return false;
  }

  private async implAlive(loop: Loop): Promise<boolean> {
    if ((await this.host.sessions()).some(s => s.id === loop.implSession)) return true;
    await this.halt(loop, 'impl-gone', `實作 session \`${loop.implSession}\` 已經不在 session 清單裡，修正清單沒有地方可以送。`, null);
    return false;
  }

  private async launchReview(loop: Loop, known?: PullRequest, acceptBase = false): Promise<void> {
    const pr = known ?? (await this.openPr(loop, 'review', acceptBase));
    if (!pr) return;
    if (known && !acceptBase && !(await this.sameBase(loop, pr))) return;
    if (!(await this.implAlive(loop))) return;
    // A head that moved since the last review must descend from the reviewed one: a rewritten history (a force push)
    // is the user's to look at. GitHub not saying how the two relate counts as rewritten
    let rewritten: { from: string; to: string; unknown?: string } | null = null;
    if (loop.reviewedSha && pr.headRefOid !== loop.reviewedSha) {
      try {
        const status = await this.gh.compare(loop.repo, loop.reviewedSha, pr.headRefOid);
        if (status !== 'ahead' && status !== 'identical') rewritten = { from: loop.reviewedSha, to: pr.headRefOid };
      } catch (e) {
        rewritten = { from: loop.reviewedSha, to: pr.headRefOid, unknown: oneLine((e as Error).message).slice(0, 300) };
      }
    }
    if (!(await this.gate(loop, 'review', 'review', '', rewritten))) return;
    const c = await this.config();
    const agent = c.reviewerAgent || loop.implAgent;
    loop.round += 1;
    loop.reviewedSha = pr.headRefOid;
    // The PR's notes for the reviewer as they are now: the implementer may have updated them with the fix
    loop.notes = section(pr.body, NOTES_TITLES);
    loop.reviewedBase = pr.baseRefName;
    loop.headRef = pr.headRefName;
    loop.baseRef = pr.baseRefName;
    loop.reviewer = null;
    loop.pendingFix = null;
    loop.fixPending = false;
    loop.fixSending = null;
    loop.phase = 'launching';
    this.note(loop, `第 ${loop.round} 輪：為 ${short(pr.headRefOid)} 開 reviewer（${agent}）`);
    await this.save(loop);
    const id = await this.host.newSession(agent, loop.cwd);
    if (!id) {
      loop.round -= 1;
      return this.halt(loop, 'reviewer-failed', `無法用 agent \`${agent}\` 開新的 reviewer session（agent 未安裝、未登入，或 id 打錯？用 \`/pr-loop config reviewer <agent id>\` 修改）。`, 'review');
    }
    const nonce = this.nonce();
    loop.reviewer = { session: id, agent, sentAt: this.now(), nonce };
    loop.phase = 'reviewing';
    loop.since = this.now();
    await this.save(loop);
    const text = brief(this.target(loop, pr), loop.requirement, loop.notes, nonce);
    const key = loop.key;
    this.background(
      this.host.send(id, text).catch(e =>
        this.exclusive(async () => {
          const now = await this.loop(key);
          if (now && now.phase === 'reviewing' && now.reviewer?.session === id) await this.halt(now, 'reviewer-failed', `brief 沒有送進 reviewer session：${oneLine((e as Error).message)}`, 'review');
        }),
      ),
      'reviewer brief',
    );
    await this.host.toast(`pr-loop：${loop.repo}#${loop.number} 第 ${loop.round} 輪 review 開始（${agent}）`).catch(() => {});
  }

  private async reviewing(loop: Loop): Promise<void> {
    const r = loop.reviewer;
    if (!r) return this.halt(loop, 'interrupted', '找不到這一輪 reviewer session 的紀錄。', 'review');
    // A reviewer's answer counts once: a round already recorded is never read again
    if (loop.rounds.some(x => x.round === loop.round && x.reviewer === r.session)) {
      return this.halt(loop, 'interrupted', `第 ${loop.round} 輪 reviewer session \`${r.session}\` 的結論已經記錄過，不會再讀一次。`, 'review');
    }
    const view = await this.host.session(r.session, 20);
    if (!view) {
      const listed = (await this.host.sessions()).some(s => s.id === r.session);
      return listed
        ? this.halt(loop, 'interrupted', `reviewer session \`${r.session}\` 沒有在這個引擎開著（多半是引擎重啟過），讀不到它的結論。不會自動再開一個 reviewer。`, 'review')
        : this.halt(loop, 'reviewer-gone', `reviewer session \`${r.session}\` 已經不在 session 清單裡。`, 'review');
    }
    const reply = lastReply(view, r.nonce);
    const stalled = () =>
      this.halt(
        loop,
        'stalled',
        `reviewer session \`${r.session}\` 已經 ${Math.round((this.now() - Math.max(r.sentAt, loop.since)) / 60_000)} 分鐘還沒有給出結論（可能卡在權限卡片，或還在跑測試）。請到那個 session 看一下；接續會再等 ${REVIEW_WAIT_MS / 60_000} 分鐘。`,
        'retry',
      );
    const waited = this.now() - Math.max(r.sentAt, loop.since);
    if (view.running && !(reply.replied && reply.text.includes(verdictBegin(r.nonce)))) return waited > REVIEW_WAIT_MS ? stalled() : this.save(loop);
    if (!reply.asked || !reply.replied) {
      if (this.now() - r.sentAt < START_GRACE_MS) return this.save(loop);
      return this.halt(loop, 'reviewer-failed', `reviewer session \`${r.session}\` 在 ${START_GRACE_MS / 60_000} 分鐘內沒有開始或沒有回覆。`, 'review');
    }
    // A reply still streaming may not hold its block yet
    if (view.running) return waited > REVIEW_WAIT_MS ? stalled() : this.save(loop);
    const parsed = parseVerdict(reply.text, r.nonce);
    // Only what the reviewer said is recorded; whether it stops the loop is `gate`'s to decide at the next step
    const record = (result: Round['result'], v?: { issues: Issue[]; conflicts: string[]; verdict?: Round['verdict'] }) =>
      loop.rounds.push({
        round: loop.round,
        sha: loop.reviewedSha,
        base: loop.reviewedBase,
        reviewer: r.session,
        at: this.now(),
        result,
        issues: v?.issues ?? [],
        conflicts: v?.conflicts ?? [],
        blocking: v?.issues.length ?? 0,
        ...(v?.verdict ? { verdict: v.verdict } : {}),
      });
    // Every outcome below leaves `reviewing` in the same save as its record, so a round is never read twice
    const broke = reply.error || (reply.stop && reply.stop !== 'end_turn' ? `stop reason ${reply.stop}` : '');
    if (broke) {
      // A turn that ended in an error (cancelled, out of tokens …) may hold a block written before it broke off
      record('unparseable');
      return this.halt(loop, 'reviewer-failed', `reviewer session \`${r.session}\` 這一輪沒有正常結束：\n${quote(oneLine(broke), 600)}\n\n即使回覆裡有結論區塊也不採用。`, 'review');
    }
    if (!parsed.ok) {
      record('unparseable');
      return this.halt(loop, 'unparseable', `reviewer session \`${r.session}\` 的回覆讀不到固定格式的結論：\n${quote(oneLine(parsed.error), 600)}`, 'review');
    }
    const v = parsed.verdict;
    const issues = v.blocking.map(b => ({ category: b.category, file: b.file }));
    if (v.mergeable) {
      // A passing verdict goes on to CI; a conflict on it is stopped on by the `ci` gate there
      record(v.conflicts.length ? 'conflict' : 'mergeable', { issues, conflicts: v.conflicts, ...(v.conflicts.length ? { verdict: 'mergeable' as const } : {}) });
      this.note(loop, `第 ${loop.round} 輪 review 判定可合併${v.conflicts.length ? `，但回報 ${v.conflicts.length} 個衝突` : ''}`);
      loop.phase = 'waitingCi';
      loop.since = this.now();
      await this.save(loop);
      return this.waitingCi(loop);
    }
    record(v.conflicts.length ? 'conflict' : 'not_mergeable', { issues, conflicts: v.conflicts, ...(v.conflicts.length ? { verdict: 'not_mergeable' as const } : {}) });
    loop.pendingFix = fixList(this.target(loop), loop.round, v);
    loop.fixPending = true;
    loop.fixFrom = 'review';
    loop.phase = 'waitingFix';
    this.note(loop, `第 ${loop.round} 輪 review 判定不可合併（${v.blocking.length} 個 blocking）`);
    await this.save(loop);
    return this.sendFix(loop);
  }

  // Hands the decided fix list to the implementing session, once
  private async sendFix(loop: Loop): Promise<void> {
    const text = loop.pendingFix;
    if (!text) return this.halt(loop, 'error', '沒有可送出的修正清單。', 'review');
    if (!(await this.gate(loop, 'fix', 'fix', `待送出的修正清單：\n${quote(text, FIX_SHOWN)}`))) return;
    const pr = await this.openPr(loop, 'fix');
    if (!pr) return;
    if (!(await this.implAlive(loop))) return;
    // The engine drops a prompt to a session it does not have open, without an error
    if ((await this.host.session(loop.implSession, 0)) === null) {
      return this.halt(loop, 'impl-closed', `實作 session \`${loop.implSession}\` 沒有在這個引擎開著，修正清單送不進去。打開那個 session 後接續。`, 'fix');
    }
    // `fixSending` is saved before the prompt starts and cleared once it went out: found set by a later process, the
    // engine stopped in between and the fix list may never have arrived
    const sending = this.now();
    loop.baseSha = pr.headRefOid;
    loop.fixPending = false;
    loop.fixSending = sending;
    loop.phase = 'waitingFix';
    loop.since = sending;
    this.note(loop, `修正清單送回實作 session，等 ${short(pr.headRefOid)} 之後的新 commit`);
    await this.save(loop);
    const key = loop.key;
    this.inflight.add(key);
    this.background(
      this.host.send(loop.implSession, text).then(
        () =>
          this.exclusive(async () => {
            this.inflight.delete(key);
            const now = await this.loop(key);
            if (!now || now.fixSending !== sending) return;
            now.fixSending = null;
            try {
              await this.save(now);
            } catch (e) {
              if (!(e instanceof Aborted)) throw e;
            }
          }),
        e =>
          this.exclusive(async () => {
            this.inflight.delete(key);
            const now = await this.loop(key);
            if (now && now.phase === 'waitingFix' && now.fixSending === sending) {
              now.fixSending = null;
              now.fixPending = true;
              await this.halt(now, 'impl-closed', `修正清單沒有送進實作 session：${oneLine((e as Error).message)}`, 'fix');
            }
          }),
      ),
      'fix list',
    );
  }

  private async waitingFix(loop: Loop): Promise<void> {
    if (loop.fixPending) return this.sendFix(loop);
    const pr = await this.openPr(loop, 'retry');
    if (!pr) return;
    if (!(await this.implAlive(loop))) return;
    if (pr.headRefOid !== loop.baseSha) {
      this.note(loop, `看到新的 head ${short(pr.headRefOid)}`);
      return this.launchReview(loop, pr);
    }
    if (loop.fixSending !== null && !this.inflight.has(loop.key)) {
      loop.fixSending = null;
      loop.fixPending = true;
      return this.halt(loop, 'interrupted', '送修正清單的途中引擎停止了，不確定實作 session 有沒有收到。可以到實作 session 確認；接續會再送一次修正清單。', 'fix');
    }
    if (this.now() - loop.since > FIX_WAIT_MS) {
      return this.halt(
        loop,
        'stalled',
        `修正清單送出後 ${Math.round((this.now() - loop.since) / 60_000)} 分鐘，PR 的 head 還是 \`${short(loop.baseSha)}\`，實作 session 沒有 push 新的 commit。請到實作 session 看一下；接續會再等 ${FIX_WAIT_MS / 3_600_000} 小時。`,
        'retry',
      );
    }
    return this.save(loop);
  }

  // The CI result for `sha`, one per head: a later result for the same head replaces the earlier one
  private ciRun(loop: Loop, sha: string, failed: string[]): void {
    loop.ciRuns = [...loop.ciRuns.filter(x => x.sha !== sha), { sha, failed }].slice(-20);
  }

  private async waitingCi(loop: Loop): Promise<void> {
    if (!(await this.gate(loop, 'ci', 'ci'))) return;
    const pr = await this.openPr(loop, 'ci');
    if (!pr) return;
    if (!(await this.implAlive(loop))) return;
    if (!passed(loop, pr.headRefOid, pr.baseRefName)) {
      // Nothing but a passing verdict on this very head and target branch leads on to CI and the merge
      this.note(loop, `head ${short(pr.headRefOid)} 沒有最新一輪「可合併」的 review，重新 review`);
      return this.launchReview(loop, pr);
    }
    const ci = await this.gh.checks(loop.repo, loop.number);
    if (ci.state !== 'none') loop.noCiSince = null;
    if (ci.state === 'pending') {
      loop.phase = 'waitingCi';
      if (this.now() - loop.since > CI_WAIT_MS) {
        return this.halt(
          loop,
          'stalled',
          `CI 已經跑了 ${Math.round((this.now() - loop.since) / 60_000)} 分鐘還沒有結果。還在跑的檢查：\n${quote(oneLine(ci.pending.join('、')) || '未知', 600)}\n\n接續會再等 ${CI_WAIT_MS / 3_600_000} 小時。`,
          'ci',
        );
      }
      return this.save(loop);
    }
    if (ci.state === 'fail') {
      const names = ci.failed.map(f => oneLine(`${f.workflow}/${f.name}`));
      this.ciRun(loop, pr.headRefOid, names);
      loop.pendingFix = ciFailure(this.target(loop, pr), ci.failed);
      loop.fixPending = true;
      loop.fixFrom = 'ci';
      loop.phase = 'waitingFix';
      this.note(loop, `CI 失敗：${names.join(', ')}`);
      await this.save(loop);
      return this.sendFix(loop);
    }
    if (ci.state === 'none') {
      // Checks may not be registered yet right after a push: "none" must hold a while
      if (!loop.noCiSince || loop.noCiSince.sha !== pr.headRefOid) loop.noCiSince = { sha: pr.headRefOid, at: this.now() };
      if (this.now() - loop.noCiSince.at < NO_CI_GRACE_MS) {
        loop.phase = 'waitingCi';
        return this.save(loop);
      }
    }
    this.ciRun(loop, pr.headRefOid, []);
    if (pr.isDraft) return this.halt(loop, 'draft', 'review 與 CI 都通過，但 PR 還是 draft。標成 ready for review 後接續。', 'ci');
    if (pr.mergeable === 'CONFLICTING') return this.halt(loop, 'merge-conflict', 'review 與 CI 都通過，但 PR 與目標分支有衝突，需要先解決（可請實作 session 處理後 push，接著會重新 review）。', 'ci');
    const c = await this.config();
    if (!c.allowedRepos.some(r => sameRepo(r, loop.repo))) {
      return this.halt(loop, 'not-allowed', `${loop.repo} 已經不在允許清單，不會合併。`, 'ci');
    }
    const ciText = ci.state === 'none' ? `這個 repo 沒有設定 CI（${NO_CI_GRACE_MS / 60_000} 分鐘內都沒有出現檢查）` : 'CI 全部通過';
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
    // Written from the round itself; this is only reached through `passed`
    const last = loop.rounds[loop.rounds.length - 1]!;
    const message = [
      `pr-loop：${loop.repo}#${loop.number}「${loop.title}」可以合併了。`,
      `- 第 ${last.round} 輪獨立 review（reviewer session \`${last.reviewer}\`，commit \`${short(last.sha)}\`）的結論：${ROUND_TEXT[effectiveResult(last, loop.consents)]}，${last.blocking} 個 blocking${last.result === 'conflict' ? `（reviewer 回報的 ${last.conflicts.length} 個衝突，你已同意照它的判斷處理）` : ''}`,
      `- ${ciText}`,
      `- 會用一般 merge commit 合併 \`${loop.headRef}\` → \`${last.base}\`（review 時的目標分支），只合併 review 過的 commit \`${short(last.sha)}\`；不 squash、不 rebase、不刪分支`,
      '',
      '要現在合併嗎？',
    ].join('\n');
    const key = loop.key;
    const createdAt = loop.createdAt;
    const card = ++this.cardSeq;
    this.asking.set(key, card);
    this.background(
      this.host
        .ask(loop.implSession, message, [{ id: 'merge', label: '合併' }, { id: 'later', label: '先不要' }], ASK_WAIT_SECS)
        .then(
          a => a,
          () => 'failed' as const,
        )
        .then(answer =>
          this.exclusive(async () => {
            // Only this card's own mark is cleared: a newer card for the same PR stays the open one
            if (this.asking.get(key) !== card) return;
            this.asking.delete(key);
            const now = await this.loop(key);
            if (!now || now.createdAt !== createdAt || now.phase !== 'confirmMerge') return;
            if (answer === 'merge') {
              this.note(now, '使用者確認合併');
              return this.guarded(now, async () => {
                const pr = await this.openPr(now, 'ci');
                if (pr) await this.merge(now, pr);
              }, 'ci');
            }
            const why = answer === 'failed' ? '確認卡片沒辦法顯示在實作 session（session 沒有開著？）。' : answer === null ? '確認卡片逾時沒有回應。' : '你選了先不要合併。';
            return this.halt(now, 'merge-declined', `${why}條件仍然滿足時，接續會重新檢查並再問一次。`, 'ci');
          }),
        ),
      'merge card',
    );
  }

  // The merge, re-checked against GitHub first: the newest round passed for this very head, no failing or pending CI,
  // still allowed
  private async merge(loop: Loop, pr: PullRequest): Promise<void> {
    if (!(await this.gate(loop, 'merge', 'ci'))) return;
    if (!(await this.sameBase(loop, pr))) return;
    if (!passed(loop, pr.headRefOid, pr.baseRefName)) {
      this.note(loop, `合併前發現 head ${short(pr.headRefOid)} 沒有最新一輪「可合併」的 review，重新 review`);
      return this.launchReview(loop, pr);
    }
    // Stopped here directly, not sent back to `waitingCi`: the two must never hand the loop to each other in a circle
    loop.phase = 'waitingCi';
    if (pr.isDraft) return this.halt(loop, 'draft', 'PR 在合併前變成了 draft。標成 ready for review 後接續。', 'ci');
    if (pr.mergeable === 'CONFLICTING') return this.halt(loop, 'merge-conflict', 'PR 在合併前與目標分支發生衝突，需要先解決（可請實作 session 處理後 push，接著會重新 review）。', 'ci');
    const ci = await this.gh.checks(loop.repo, loop.number);
    // "No CI" is accepted only as `waitingCi` accepted it: for this head, past the grace. Checks that vanished since
    // they passed go back to waiting
    const noCiOk = ci.state === 'none' && !!loop.noCiSince && loop.noCiSince.sha === pr.headRefOid && this.now() - loop.noCiSince.at >= NO_CI_GRACE_MS;
    if (ci.state === 'fail' || ci.state === 'pending' || (ci.state === 'none' && !noCiOk)) {
      loop.phase = 'waitingCi';
      await this.save(loop);
      return this.waitingCi(loop);
    }
    const c = await this.config();
    if (!c.allowedRepos.some(r => sameRepo(r, loop.repo))) {
      return this.halt(loop, 'not-allowed', `${loop.repo} 已經不在允許清單，不會合併。`, 'ci');
    }
    loop.phase = 'merging';
    await this.save(loop);
    let failure: string | null = null;
    try {
      await this.gh.merge(loop.repo, loop.number, pr.headRefOid);
    } catch (e) {
      failure = (e as Error).message;
    }
    // Whatever gh said, GitHub's state decides: a merge that failed on the way back may still have happened. A failure
    // reading it stops in `merging`, and resuming from there asks GitHub again before anything else
    const after = await this.gh.pr(loop.number, loop.repo);
    if (after.state !== 'MERGED') {
      loop.phase = 'waitingCi';
      return this.halt(
        loop,
        'gh',
        failure
          ? `合併失敗：\n${quote(failure, 1200)}`
          : `合併指令回報成功，但 PR 的狀態是 ${after.state}。如果這個 repo 用 merge queue，PR 可能只是排進了佇列：請到 PR 頁面確認，pr-loop 不會再合併一次。`,
        'ci',
      );
    }
    return this.finishMerge(loop, after);
  }

  // A loop found in `merging` (or resumed from a stop there): merged means done, anything else a stop, never a second
  // merge
  private async recoverMerge(loop: Loop): Promise<void> {
    const pr = await this.gh.pr(loop.number, loop.repo);
    if (pr.state === 'MERGED') {
      this.note(loop, '確認 PR 已經合併');
      return this.finishMerge(loop, pr);
    }
    loop.phase = 'waitingCi';
    return this.halt(loop, 'interrupted', `合併這一步中途中斷了，PR 目前是 ${pr.state}，沒有被合併。不會自動再合併一次；接續會重新檢查 review 結論、CI 與合併條件。`, 'ci');
  }

  // The PR is merged: recorded and reported. The report goes out whatever happens to the record — GitHub already merged
  // it, so a failed or refused write (another engine, a cancel racing it) must not swallow which commit it was
  private async finishMerge(loop: Loop, pr: PullRequest): Promise<void> {
    loop.phase = 'merged';
    loop.merge = { commit: pr.mergeCommit, at: this.now() };
    loop.pendingFix = null;
    this.note(loop, `已合併，merge commit ${pr.mergeCommit ?? '（gh 沒有回報）'}`);
    let unsaved: string | null = null;
    try {
      await this.save(loop, false, true);
    } catch (e) {
      unsaved = (e as Error).message;
      this.host.log(`${loop.key}: the merge could not be recorded: ${unsaved}`);
    }
    await this.say(
      loop.implSession,
      [
        `pr-loop：已合併 ${loop.repo}#${loop.number}「${loop.title}」。`,
        `- merge commit：\`${pr.mergeCommit ?? '（gh 沒有回報，請到 PR 頁面確認）'}\``,
        `- 合併內容：\`${loop.headRef}\` 的 \`${short(loop.reviewedSha)}\` → \`${loop.baseRef}\`（一般 merge commit，分支保留）`,
        `- 經過 ${loop.round} 輪獨立 review；最後一輪判定可合併、沒有 blocking`,
        `- ${loop.url}`,
        ...(unsaved ? [`- 注意：合併已完成，但 pr-loop 沒能把結果寫進自己的紀錄（${oneLine(unsaved)}），\`/pr-loop status\` 可能還顯示舊的狀態。`] : []),
      ].join('\n'),
    );
  }

  // ---- status ----

  async statusText(ref: string | null, session: string): Promise<string> {
    const all = (await this.loops()).sort((a, b) => b.updatedAt - a.updatedAt);
    const one = ref ? pickLoop(all, session, ref) : null;
    const shown = ref ? (one ? [one] : []) : all.filter(l => isActive(l) || l.phase === 'stopped' || l.implSession === session);
    if (!shown.length) return 'pr-loop：沒有循環。';
    return shown
      .map(l =>
        [
          `**${l.repo}#${l.number}**「${l.title}」：${PHASE_TEXT[l.phase]}（第 ${l.round}/${l.roundLimit} 輪）`,
          ...(l.stop
            ? [
                `- 停下原因：${reasonsOf(l.stop).map(r => REASON_TEXT[r]).join('、')}（卡在：${PHASE_TEXT[l.stop.step]}）`,
                l.stop.resume ? `- 接續（\`/pr-loop resume${needsConsent(l.stop) ? ' confirm' : ''}\`）會${RESUME_TEXT[l.stop.resume]}` : '- 這次停下不能接續',
                ...(l.stop.resume && l.stop.agree.length ? ['- 接續代表你同意：', ...l.stop.agree.map(a => `  - ${a}`)] : []),
              ]
            : []),
          l.reviewer ? `- 目前 reviewer session：\`${l.reviewer.session}\`（${l.reviewer.agent}）` : '',
          `- 實作 session：\`${l.implSession}\`；需求原文來源：${SOURCE_TEXT[l.requirementSource]}；同一類問題的判定：${l.policy.sameIssue}`,
          ...l.rounds.map(r => {
            const keys = issueKeyList(r.issues, l.policy.sameIssue);
            return `- 第 ${r.round} 輪（${short(r.sha)}）：${ROUND_TEXT[r.result]}${keys.length ? `（${keys.join(', ')}）` : ''}`;
          }),
          l.merge ? `- merge commit：\`${l.merge.commit ?? '?'}\`` : '',
          l.log.length ? `- 最近：${l.log[l.log.length - 1]}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
  }
}

// A step that must not write: the loop was cancelled, or another engine runs it
class Aborted extends Error {}

// The loop a `[PR]` argument names: a URL matches repo (with host) and number exactly; a bare number matches the
// session's own loop first and must not be ambiguous across repositories
function pickLoop(loops: Loop[], session: string, ref: string): Loop | null {
  const byUrl = parsePrUrl(ref);
  if (byUrl) return loops.find(l => sameRepo(l.repo, byUrl.repo) && l.number === byUrl.number) ?? null;
  const m = /^#?(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`\`${ref}\` 不是 PR 編號或網址。`);
  const hits = loops.filter(l => l.number === Number(m[1]));
  const mine = hits.filter(l => l.implSession === session);
  const pool = mine.length ? mine : hits;
  if (new Set(pool.map(l => l.key)).size > 1) throw new Error(`有多個 repo 的 #${m[1]}（${pool.map(l => l.repo).join('、')}），請改用 PR 網址。`);
  return pool[0] ?? null;
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
    `- 同一類問題的判定：${c.sameIssue}（新開的循環在開始時取用並固定）`,
    `- gh 指令：${JSON.stringify(c.gh)}`,
  ].join('\n');
}

export const HELP = [
  '用法：',
  '- `/pr-loop <PR 編號或網址> [需求原文]`：開始自動循環（review → 修正 → CI → 合併）',
  '- `/pr-loop status [PR]`：查看狀態',
  '- `/pr-loop stop [PR]`：停止循環',
  '- `/pr-loop resume [PR]`：接續停下的循環；停下原因需要你同意時（衝突、重複問題、超過輪數上限、歷史被改寫）要用 `/pr-loop resume confirm [PR]`',
  '- `/pr-loop config`：查看設定',
  '- `/pr-loop config allow <owner>/<repo>` / `disallow <owner>/<repo>`：允許清單（放寬限制的設定會先出確認卡片）',
  '- `/pr-loop config reviewer <agent id|same>`：reviewer 用的 agent',
  '- `/pr-loop config merge confirm|auto`：合併前確認或自動合併',
  '- `/pr-loop config poll <秒>`、`same-issue category+file|category`、`gh <argv>`',
].join('\n');
