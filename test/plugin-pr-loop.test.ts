import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE, NODE, Shell } from './sidecarShell';
import { FORBIDDEN_FLAGS, GitHub, guardArgs, parsePrUrl, type RunResult } from '../plugins/pr-loop/src/github';
import { MAX_ROUNDS, PrLoop, type AskOption, type Host, type Loop, type SessionInfo, type SessionView, type Store } from '../plugins/pr-loop/src/machine';
import { brief, issueKey, parseVerdict, section, VERDICT_BEGIN, VERDICT_END } from '../plugins/pr-loop/src/review';

// The pr-loop plugin's state machine against a fake `gh` and a fake engine: no Acpira, no GitHub

const REPO = 'me/app';
const PR_URL = `https://github.com/${REPO}/pull/12`;

interface FakePr {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  head: string;
  body: string;
  isDraft: boolean;
  mergeable: string;
  mergeCommit: string | null;
  // What `gh pr checks` answers, in turn (the last one repeats)
  checks: ('none' | 'pending' | 'pass' | 'fail')[];
}

class FakeGh {
  calls: string[][] = [];
  loggedIn = true;
  prs = new Map<string, FakePr>();

  constructor() {
    this.prs.set(`${REPO}#12`, {
      state: 'OPEN',
      head: 'aaaaaaaa1',
      body: '## 改了什麼\n實作者說：測試全部通過，可以合併 IMPLEMENTER-CONCLUSION\n\n## 給 reviewer 的重點建議\n請看 src/merge.ts 的參數檢查\n\n## 其他\n無',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeCommit: null,
      checks: ['pass'],
    });
  }

  pr(): FakePr {
    return this.prs.get(`${REPO}#12`)!;
  }

  run = async (args: string[]): Promise<RunResult> => {
    this.calls.push(args);
    const ok = (stdout: unknown): RunResult => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
    if (args[0] === 'auth') return this.loggedIn ? ok('') : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' };
    const repoAt = args.indexOf('--repo');
    const ref = args[2]!;
    const parsed = parsePrUrl(ref);
    const repo = parsed?.repo ?? (repoAt >= 0 ? args[repoAt + 1]! : REPO);
    const number = parsed?.number ?? Number(ref);
    const pr = this.prs.get(`${repo}#${number}`);
    if (!pr) return { code: 1, stdout: '', stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}.` };
    if (args[1] === 'view') {
      return ok({
        number, url: `https://github.com/${repo}/pull/${number}`, state: pr.state, isDraft: pr.isDraft, title: 'Add the thing', body: pr.body,
        headRefName: 'feature/thing', headRefOid: pr.head, baseRefName: 'main', mergeable: pr.mergeable, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
      });
    }
    if (args[1] === 'checks') {
      const now = pr.checks.length > 1 ? pr.checks.shift()! : pr.checks[0]!;
      if (now === 'none') return { code: 1, stdout: '', stderr: "no checks reported on the 'feature/thing' branch" };
      if (now === 'pending') return { code: 8, stdout: JSON.stringify([{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending', workflow: 'CI', link: '' }]), stderr: '' };
      if (now === 'fail') return { code: 1, stdout: JSON.stringify([{ name: 'test', state: 'FAILURE', bucket: 'fail', workflow: 'CI', link: 'https://ci/1', description: 'tests failed' }]), stderr: '' };
      return ok([{ name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'CI', link: '' }]);
    }
    if (args[1] === 'merge') {
      const at = args.indexOf('--match-head-commit');
      if (at >= 0 && args[at + 1] !== pr.head) return { code: 1, stdout: '', stderr: 'head commit mismatch' };
      pr.state = 'MERGED';
      pr.mergeCommit = 'mmmmmmmm1';
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unknown ${args.join(' ')}` };
  };

  merges(): string[][] {
    return this.calls.filter(a => a[0] === 'pr' && a[1] === 'merge');
  }
}

interface Card {
  session: string;
  message: string;
  options: AskOption[];
  resolve: (id: string | null) => void;
}

class FakeHost implements Host {
  list: SessionInfo[] = [{ id: 'impl', agent: 'claude', cwd: '/work', title: 'impl' }];
  views = new Map<string, SessionView>();
  sent: { session: string; text: string }[] = [];
  made: { id: string; agent: string; cwd: string }[] = [];
  cards: Card[] = [];
  toasts: string[] = [];
  // Reviewer replies, one per new reviewer session
  replies: string[] = [];
  // Answer merge cards at once with this (null: leave open)
  mergeAnswer: string | null = 'merge';
  // Called when the implementing session is sent a fix list
  onFix: (text: string) => void = () => {};
  // The engine's `turn.ended` event, sent once a reviewer's scripted reply is in
  turnEnded: (session: string) => void = () => {};

  constructor() {
    this.views.set('impl', { running: false, turns: [{ role: 'user', text: '請實作 X 功能（需求原文）' }] });
  }

  async sessions() {
    return this.list;
  }
  async session(id: string) {
    return this.views.get(id) ?? null;
  }
  async newSession(agent: string, cwd: string) {
    const id = `rev-${this.made.length + 1}`;
    this.made.push({ id, agent, cwd });
    this.list.push({ id, agent, cwd });
    this.views.set(id, { running: false, turns: [] });
    return id;
  }
  async send(session: string, text: string) {
    this.sent.push({ session, text });
    if (session.startsWith('rev-')) {
      const reply = this.replies.shift() ?? 'no reply scripted';
      this.views.set(session, { running: false, turns: [{ role: 'user', text }, { role: 'agent', blocks: [{ type: 'text', markdown: reply }] }] });
      setTimeout(() => this.turnEnded(session), 0);
    } else {
      this.onFix(text);
    }
  }
  ask(session: string, message: string, options: AskOption[]) {
    return new Promise<string | null>(resolve => {
      this.cards.push({ session, message, options, resolve });
      if (options.some(o => o.id === 'ok')) resolve('ok');
      else if (options.some(o => o.id === 'merge') && this.mergeAnswer) resolve(this.mergeAnswer);
    });
  }
  async toast(text: string) {
    this.toasts.push(text);
  }
  log() {}
  said(): string {
    return this.cards.map(c => c.message).join('\n----\n');
  }
}

class FakeStore implements Store {
  data = new Map<string, string>();
  async get<T>(key: string) {
    const v = this.data.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set(key: string, value: unknown) {
    this.data.set(key, JSON.stringify(value));
  }
  async swap(key: string, expect: unknown, value: unknown) {
    const now = this.data.get(key) ?? 'null';
    if (now !== JSON.stringify(expect ?? null)) return false;
    this.data.set(key, JSON.stringify(value));
    return true;
  }
}

const verdict = (v: Record<string, unknown>, prose = '以下是 review 內容。') => `${prose}\n\n${VERDICT_BEGIN}\n${JSON.stringify(v)}\n${VERDICT_END}\n`;
const pass = () => verdict({ verdict: 'mergeable', blocking: [], suggestions: ['可以補註解'], tests: [{ command: 'pnpm test', result: 'pass' }], conflicts: [] });
const reject = (category = 'correctness', file = 'src/merge.ts') => verdict({ verdict: 'not_mergeable', blocking: [{ category, file, summary: `${category} 問題`, detail: '會壞', fix: '改掉' }], suggestions: [], tests: [], conflicts: [] });

function setup(opts: { allow?: string[]; merge?: 'confirm' | 'auto' } = {}) {
  const gh = new FakeGh();
  const host = new FakeHost();
  const store = new FakeStore();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const make = (owner: string) => {
    const machine = new PrLoop({ host, store, gh: new GitHub(gh.run), now: clock.now, owner });
    host.turnEnded = s => void machine.onTurnEnded(s);
    return machine;
  };
  const m = make('engine-1');
  void store.set('config', { allowedRepos: opts.allow ?? [REPO], merge: opts.merge ?? 'confirm' });
  // Settles every step and every background callback queued so far
  const flush = async (machine = m) => {
    for (let i = 0; i < 20; i++) {
      await machine.idle();
      await new Promise(r => setTimeout(r, 0));
    }
  };
  const loop = async (): Promise<Loop> => (await m.loop(`${REPO}#12`))!;
  // A push to the PR branch whenever the implementing session gets a fix list
  let pushes = 0;
  host.onFix = () => { gh.pr().head = `bbbbbbbb${++pushes}`; };
  return { gh, host, store, clock, m, make, flush, loop };
}

// Plain promises only, but a loaded machine needs more than the default 15 s
describe('pr-loop state machine', { timeout: 60_000 }, () => {
  it('passes in one round, asks before merging, and merges with a plain merge commit of the reviewed head', async () => {
    const { gh, host, m, flush, loop } = setup();
    host.replies.push(pass());
    await m.command('impl', '12');
    await flush();
    expect(host.made).toEqual([{ id: 'rev-1', agent: 'claude', cwd: '/work' }]);
    // The brief: target, requirement (the session's first message), the PR's reviewer notes; not the implementer's verdict
    const b = host.sent.find(s => s.session === 'rev-1')!.text;
    expect(b).toContain(PR_URL);
    expect(b).toContain('aaaaaaaa1');
    expect(b).toContain('請實作 X 功能（需求原文）');
    expect(b).toContain('請看 src/merge.ts 的參數檢查');
    expect(b).not.toContain('IMPLEMENTER-CONCLUSION');
    expect(b).toContain(VERDICT_BEGIN);
    const card = host.cards.find(c => c.options.some(o => o.id === 'merge'))!;
    expect(card.message).toContain('可以合併');
    expect(gh.merges()).toEqual([['pr', 'merge', '12', '--repo', REPO, '--merge', '--match-head-commit', 'aaaaaaaa1']]);
    const l = await loop();
    expect(l.phase).toBe('merged');
    expect(l.merge?.commit).toBe('mmmmmmmm1');
    expect(host.said()).toContain('mmmmmmmm1');
    expect(l.requirementSource).toBe('first-message');
  });

  it('takes the requirement from the command first and from the PR body section next', async () => {
    const a = setup();
    a.host.replies.push(pass());
    await a.m.command('impl', `${PR_URL} 指令裡的需求原文`);
    await a.flush();
    expect(a.host.sent[0]!.text).toContain('指令裡的需求原文');
    expect((await a.loop()).requirementSource).toBe('command');

    const b = setup();
    b.gh.pr().body += '\n\n## 需求原文\nPR 描述裡的需求';
    b.host.replies.push(pass());
    await b.m.command('impl', '#12');
    await b.flush();
    expect(b.host.sent[0]!.text).toContain('PR 描述裡的需求');
    expect((await b.loop()).requirementSource).toBe('pr-body');
  });

  it('sends the blocking items back, waits for a new head, reviews again with a fresh reviewer and then merges', async () => {
    const { gh, host, m, flush, loop } = setup();
    host.replies.push(reject(), pass());
    await m.command('impl', '12');
    await flush();
    const fix = host.sent.find(s => s.session === 'impl')!.text;
    expect(fix).toContain('必須修（blocking）');
    expect(fix).toContain('src/merge.ts');
    expect((await loop()).phase).toBe('waitingFix');
    // The fake pushed when it got the fix list; the next poll sees the new head
    await m.tick();
    await flush();
    expect(host.made.map(s => s.id)).toEqual(['rev-1', 'rev-2']);
    expect(host.sent.find(s => s.session === 'rev-2')!.text).toContain('bbbbbbbb1');
    // The second brief does not carry the first round's findings
    expect(host.sent.find(s => s.session === 'rev-2')!.text).not.toContain('correctness 問題');
    expect(gh.merges()).toEqual([['pr', 'merge', '12', '--repo', REPO, '--merge', '--match-head-commit', 'bbbbbbbb1']]);
    expect((await loop()).phase).toBe('merged');
  });

  it(`stops after ${MAX_ROUNDS} rounds without passing`, async () => {
    const { gh, host, m, flush, loop } = setup();
    const kinds = ['correctness', 'security', 'tests', 'docs', 'performance', 'spec', 'other'];
    host.replies.push(...kinds.map(k => reject(k, `src/${k}.ts`)));
    await m.command('impl', '12');
    await flush();
    for (let i = 0; i < 10; i++) {
      await m.tick();
      await flush();
    }
    const l = await loop();
    expect(l.phase).toBe('stopped');
    expect(l.stop?.reason).toBe('max-rounds');
    expect(host.made).toHaveLength(MAX_ROUNDS);
    expect(host.sent.filter(s => s.session === 'impl')).toHaveLength(MAX_ROUNDS - 1);
    expect(gh.merges()).toEqual([]);
    expect(host.said()).toContain('建議的選項');
  });

  it('stops when two rounds in a row send back the same kind of issue', async () => {
    const { gh, host, m, flush, loop } = setup();
    host.replies.push(reject('correctness', 'src/merge.ts'), reject('correctness', './src/merge.ts:40'));
    await m.command('impl', '12');
    await flush();
    await m.tick();
    await flush();
    const l = await loop();
    expect(l.stop?.reason).toBe('repeated');
    expect(l.round).toBe(2);
    expect(host.made).toHaveLength(2);
    expect(gh.merges()).toEqual([]);
    // Resuming is the user's call: the stored fix list goes out and a third round is allowed
    await m.command('impl', 'resume');
    await flush();
    expect((await loop()).phase).toBe('waitingFix');
    expect(host.sent.filter(s => s.session === 'impl')).toHaveLength(2);
  });

  it('a different issue in the next round is no repeat', async () => {
    const { host, m, flush, loop } = setup();
    host.replies.push(reject('correctness', 'src/a.ts'), reject('correctness', 'src/b.ts'), pass());
    await m.command('impl', '12');
    await flush();
    await m.tick();
    await flush();
    await m.tick();
    await flush();
    expect((await loop()).phase).toBe('merged');
  });

  it('stops on a reviewer reply it cannot parse, without merging', async () => {
    const { gh, host, m, flush, loop } = setup();
    host.replies.push('看起來不錯，可以合併！');
    await m.command('impl', '12');
    await flush();
    const l = await loop();
    expect(l.stop?.reason).toBe('unparseable');
    expect(host.said()).toContain('無法解析');
    expect(gh.merges()).toEqual([]);
  });

  it('stops on conflicts the reviewer reports', async () => {
    const { gh, host, m, flush, loop } = setup();
    host.replies.push(verdict({ verdict: 'mergeable', blocking: [], conflicts: ['需求說要刪分支，但規則說不能刪'] }));
    await m.command('impl', '12');
    await flush();
    expect((await loop()).stop?.reason).toBe('conflict');
    expect(gh.merges()).toEqual([]);
  });

  it('waits while CI is pending and merges once it passes', async () => {
    const { gh, host, m, flush, loop } = setup();
    gh.pr().checks = ['pending', 'pending', 'pass'];
    host.replies.push(pass());
    await m.command('impl', '12');
    await flush();
    expect((await loop()).phase).toBe('waitingCi');
    expect(gh.merges()).toEqual([]);
    await m.tick();
    await flush();
    expect((await loop()).phase).toBe('waitingCi');
    await m.tick();
    await flush();
    expect((await loop()).phase).toBe('merged');
    expect(gh.merges()).toHaveLength(1);
  });

  it('sends a CI failure back, then reviews the fix again before merging', async () => {
    const { gh, host, m, flush, loop } = setup();
    gh.pr().checks = ['fail', 'pass'];
    host.replies.push(pass(), pass());
    await m.command('impl', '12');
    await flush();
    const fix = host.sent.filter(s => s.session === 'impl');
    expect(fix).toHaveLength(1);
    expect(fix[0]!.text).toContain('CI 失敗');
    expect(fix[0]!.text).toContain('https://ci/1');
    expect(gh.merges()).toEqual([]);
    await m.tick();
    await flush();
    expect(host.made).toHaveLength(2);
    expect((await loop()).phase).toBe('merged');
    expect(gh.merges()[0]).toContain('bbbbbbbb1');
  });

  it('stops when CI fails the same check twice in a row', async () => {
    const { gh, host, m, flush, loop } = setup();
    gh.pr().checks = ['fail'];
    host.replies.push(pass(), pass());
    await m.command('impl', '12');
    await flush();
    await m.tick();
    await flush();
    expect((await loop()).stop?.reason).toBe('repeated');
    expect(gh.merges()).toEqual([]);
  });

  it('treats a repository without CI as no failure', async () => {
    const { gh, host, m, flush, loop } = setup();
    gh.pr().checks = ['none'];
    host.replies.push(pass());
    await m.command('impl', '12');
    await flush();
    expect((await loop()).phase).toBe('merged');
    expect(host.cards.find(c => c.options.some(o => o.id === 'merge'))!.message).toContain('沒有設定 CI');
  });

  it('does not start for a repository outside the allow list, nor with an empty list', async () => {
    const a = setup({ allow: ['someone/else'] });
    await a.m.command('impl', '12');
    await a.flush();
    expect(a.host.made).toEqual([]);
    expect(a.host.said()).toContain('不在允許自動循環的 repo 清單');
    expect(a.host.said()).toContain(`/pr-loop config allow ${REPO}`);
    expect(await a.loop()).toBeNull();

    const b = setup({ allow: [] });
    await b.m.command('impl', '12');
    await b.flush();
    expect(b.host.made).toEqual([]);
    expect(b.host.said()).toContain('還沒有設定允許自動循環的 repo');
    expect(b.gh.calls).toEqual([]);
  });

  it('does not start when gh is not signed in', async () => {
    const { gh, host, m, flush } = setup();
    gh.loggedIn = false;
    await m.command('impl', '12');
    await flush();
    expect(host.made).toEqual([]);
    expect(host.said()).toContain('gh auth login');
  });

  it('merges without a card when the configuration says auto', async () => {
    const { gh, host, m, flush, loop } = setup({ merge: 'auto' });
    host.replies.push(pass());
    await m.command('impl', '12');
    await flush();
    expect(host.cards.some(c => c.options.some(o => o.id === 'merge'))).toBe(false);
    expect((await loop()).phase).toBe('merged');
    expect(gh.merges()).toHaveLength(1);
  });

  it('does not merge when the card is declined, and resuming asks again', async () => {
    const { gh, host, m, flush, loop } = setup();
    host.mergeAnswer = 'later';
    host.replies.push(pass());
    await m.command('impl', '12');
    await flush();
    expect((await loop()).stop?.reason).toBe('merge-declined');
    expect(gh.merges()).toEqual([]);
    host.mergeAnswer = 'merge';
    await m.command('impl', 'resume');
    await flush();
    expect((await loop()).phase).toBe('merged');
    expect(gh.merges()).toHaveLength(1);
  });

  it('reviews again when the head moves after the review passed, even at the merge card', async () => {
    const { gh, host, m, flush, loop } = setup();
    host.mergeAnswer = null;
    host.replies.push(pass(), pass());
    await m.command('impl', '12');
    await flush();
    expect((await loop()).phase).toBe('confirmMerge');
    gh.pr().head = 'cccccccc1';
    const card = host.cards.find(c => c.options.some(o => o.id === 'merge'))!;
    card.resolve('merge');
    await flush();
    expect(host.made).toHaveLength(2);
    expect(gh.merges()).toEqual([]);
  });

  it('stops when the PR is closed', async () => {
    const a = setup();
    a.host.replies.push(reject());
    a.host.onFix = () => {};
    await a.m.command('impl', '12');
    await a.flush();
    a.gh.pr().state = 'CLOSED';
    await a.m.tick();
    await a.flush();
    expect((await a.loop()).stop?.reason).toBe('pr-closed');
  });

  it('stops when the PR was merged by someone else', async () => {
    const b = setup();
    b.host.replies.push(reject());
    b.host.onFix = () => {};
    await b.m.command('impl', '12');
    await b.flush();
    b.gh.pr().state = 'MERGED';
    b.gh.pr().mergeCommit = 'elsewhere1';
    await b.m.tick();
    await b.flush();
    expect((await b.loop()).stop?.reason).toBe('pr-merged-elsewhere');
    expect(b.gh.merges()).toEqual([]);
  });

  it('stops when the implementing session is gone', async () => {
    const c = setup();
    c.host.replies.push(reject());
    c.host.onFix = () => {};
    await c.m.command('impl', '12');
    await c.flush();
    c.host.list = c.host.list.filter(s => s.id !== 'impl');
    await c.m.tick();
    await c.flush();
    expect((await c.loop()).stop?.reason).toBe('impl-gone');
  });

  it('can be stopped by the user, and a stopped loop is never advanced', async () => {
    const { host, m, flush, loop } = setup();
    host.replies.push(reject());
    host.onFix = () => {};
    await m.command('impl', '12');
    await flush();
    await m.command('impl', 'stop');
    await flush();
    expect((await loop()).phase).toBe('cancelled');
    await m.tick();
    await flush();
    expect(host.made).toHaveLength(1);
    await m.command('impl', 'status');
    expect(host.said()).toContain('已停止');
  });

  describe('after an engine restart', () => {
    it('does not open a second reviewer when the first one can no longer be read', async () => {
      const { host, m, make, flush, loop, clock } = setup();
      // The reviewer never answers before the "restart"
      host.send = async (session, text) => { host.sent.push({ session, text }); };
      await m.command('impl', '12');
      await flush();
      expect((await loop()).phase).toBe('reviewing');
      // The engine restarts: open sessions are gone from memory, the records stay listed
      host.views.clear();
      clock.advance(10 * 60_000);
      const again = make('engine-2');
      await again.tick();
      await flush(again);
      const l = await loop();
      expect(l.phase).toBe('stopped');
      expect(l.stop?.reason).toBe('interrupted');
      expect(host.made).toHaveLength(1);
      expect(host.said()).toContain('不會自動再開一個 reviewer');
    });

    it('goes on waiting for the fix and continues the loop', async () => {
      const { host, gh, m, make, flush, loop, clock } = setup();
      host.replies.push(reject(), pass());
      host.onFix = () => {};
      await m.command('impl', '12');
      await flush();
      expect((await loop()).phase).toBe('waitingFix');
      clock.advance(10 * 60_000);
      const again = make('engine-2');
      gh.pr().head = 'dddddddd1';
      await again.tick();
      await flush(again);
      expect(host.made).toHaveLength(2);
      expect((await loop()).phase).toBe('merged');
      expect((await loop()).owner).toBe('engine-2');
    });

    it('never merges twice: a merge cut short is checked against GitHub', async () => {
      const { gh, store, make, flush, loop, clock, host } = setup();
      const base = { ...(await setupLoop()) };
      async function setupLoop(): Promise<Loop> {
        const l = setup();
        l.host.replies.push(pass());
        l.host.mergeAnswer = null;
        await l.m.command('impl', '12');
        await l.flush();
        return (await l.loop())!;
      }
      // A loop saved in `merging`, as a stopped engine leaves it, and the PR already merged
      await store.set('state', { version: 1, loops: { [base.key]: { ...base, phase: 'merging', owner: 'engine-1', heartbeat: 0 } } });
      gh.pr().state = 'MERGED';
      gh.pr().mergeCommit = 'mmmmmmmm9';
      clock.advance(10 * 60_000);
      const again = make('engine-2');
      await again.tick();
      await flush(again);
      expect((await loop()).phase).toBe('merged');
      expect((await loop()).merge?.commit).toBe('mmmmmmmm9');
      expect(gh.merges()).toEqual([]);

      // Not merged: it stops and says so, still without merging
      await store.set('state', { version: 1, loops: { [base.key]: { ...base, phase: 'merging', owner: 'engine-1', heartbeat: 0 } } });
      gh.pr().state = 'OPEN';
      await make('engine-3').tick();
      await flush();
      expect((await loop()).stop?.reason).toBe('interrupted');
      expect(gh.merges()).toEqual([]);
      expect(host.said()).toContain('不會自動再合併一次');
    });

    it('leaves a loop to the engine that still runs it', async () => {
      const { host, m, make, flush } = setup();
      host.replies.push(reject());
      host.onFix = () => {};
      await m.command('impl', '12');
      await flush();
      // The other engine does not hold the implementing session and the owner wrote just now
      host.views.delete('impl');
      const other = make('engine-2');
      await other.tick();
      await flush(other);
      expect((await m.loop(`${REPO}#12`))!.owner).toBe('engine-1');
    });
  });

  it('never passes --auto, --squash or --rebase to gh, in any scenario above or by construction', async () => {
    const { gh, host, m, flush } = setup({ merge: 'auto' });
    host.replies.push(reject(), pass());
    await m.command('impl', '12');
    await flush();
    await m.tick();
    await flush();
    for (const call of gh.calls) {
      for (const flag of ['--auto', '--squash', '--rebase', '--delete-branch', '--admin']) expect(call).not.toContain(flag);
    }
    for (const merge of gh.merges()) expect(merge).toContain('--merge');
    expect(new GitHub(gh.run).mergeArgs(REPO, 1, 'x')).toEqual(['pr', 'merge', '1', '--repo', REPO, '--merge', '--match-head-commit', 'x']);
    for (const flag of FORBIDDEN_FLAGS) expect(() => guardArgs(['pr', 'merge', '1', '--merge', flag])).toThrow();
    expect(() => guardArgs(['pr', 'merge', '1', '--auto=true', '--merge'])).toThrow();
    expect(() => guardArgs(['pr', 'merge', '1'])).toThrow('--merge');
    expect(() => guardArgs(['pr', 'comment', '1', '--body', 'x'])).toThrow();
    expect(() => guardArgs(['api', 'repos/x/y/merges'])).toThrow();
  });
});

describe('pr-loop review format', () => {
  it('reads the last verdict block and refuses anything off the fixed shape', () => {
    const good = parseVerdict(`前面引用格式：${VERDICT_BEGIN}\n{"verdict":"x"}\n${VERDICT_END}\n\n正式結論：\n${VERDICT_BEGIN}\n\`\`\`json\n{"verdict":"not_mergeable","blocking":[{"category":"tests","file":"a.ts","summary":"少測試"}]}\n\`\`\`\n${VERDICT_END}`);
    expect(good.ok && good.verdict.blocking[0]!.category).toBe('tests');
    expect(parseVerdict('沒有區塊').ok).toBe(false);
    expect(parseVerdict(`${VERDICT_BEGIN}\nnot json\n${VERDICT_END}`).ok).toBe(false);
    expect(parseVerdict(verdict({ verdict: 'mergeable', blocking: [{ category: 'tests', summary: 'x' }] })).ok).toBe(false);
    expect(parseVerdict(verdict({ verdict: 'not_mergeable', blocking: [] })).ok).toBe(false);
    expect(parseVerdict(verdict({ verdict: 'not_mergeable', blocking: [{ category: 'vibes', summary: 'x' }] })).ok).toBe(false);
    expect(parseVerdict(verdict({ verdict: 'maybe' })).ok).toBe(false);
  });

  it('compares issues by category and file, and finds PR body sections', () => {
    expect(issueKey({ category: 'tests', file: './src\\A.ts:12' })).toBe(issueKey({ category: 'tests', file: 'src/a.ts' }));
    expect(issueKey({ category: 'tests', file: 'src/a.ts' })).not.toBe(issueKey({ category: 'tests', file: 'src/b.ts' }));
    expect(issueKey({ category: 'tests', file: 'src/a.ts' }, 'category')).toBe(issueKey({ category: 'tests', file: 'src/b.ts' }, 'category'));
    expect(section('# A\nx\n### 給 reviewer 的重點建議\n- 看 a.ts\n#### 細節\n更多\n## B\ny', ['給 reviewer 的重點建議'])).toBe('- 看 a.ts\n#### 細節\n更多');
    expect(section('# A\nx', ['需求原文'])).toBeNull();
    const text = brief({ repo: REPO, number: 1, url: PR_URL, headSha: 'abc', headRef: 'f', baseRef: 'main' }, '需求', null);
    expect(text).toContain('（PR 描述中沒有這一段）');
    expect(text).toContain('只讀');
  });
});

// The plugin installed into a temp home and run by the real sidecar (slow: every node process, gh double included, is
// one start-up, which takes many seconds on a machine with an on-access scanner): the fake agent is the implementing session, a tiny
// ACP agent the reviewer, and `gh` a script on a state file. Nothing reaches GitHub
const FAKE_GH = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [state, ...args] = process.argv.slice(2);
const s = JSON.parse(readFileSync(state, 'utf8'));
appendFileSync(state + '.log', JSON.stringify(args) + '\\n');
const out = v => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
if (args[0] === 'auth') out('Logged in');
if (args[1] === 'view') out({ number: 12, url: 'https://github.com/me/app/pull/12', state: s.state, isDraft: false, title: 'Add the thing', body: '## 給 reviewer 的重點建議\\n看 src/a.ts', headRefName: 'feature/thing', headRefOid: s.head, baseRefName: 'main', mergeable: 'MERGEABLE', mergeCommit: s.mergeCommit ? { oid: s.mergeCommit } : null });
if (args[1] === 'checks') { process.stderr.write('no checks reported on the feature/thing branch'); process.exit(1); }
if (args[1] === 'merge') { s.state = 'MERGED'; s.mergeCommit = 'e2e-merge-commit'; writeFileSync(state, JSON.stringify(s)); out(''); }
process.stderr.write('unexpected ' + args.join(' ')); process.exit(1);
`;

// A minimal ACP agent that answers every prompt with a passing verdict and writes the prompt to a file
const REVIEWER = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.argv[2];
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const verdict = ${JSON.stringify(`看過了。\n\n${VERDICT_BEGIN}\n{"verdict":"mergeable","blocking":[],"suggestions":[],"tests":[{"command":"pnpm test","result":"pass"}],"conflicts":[]}\n${VERDICT_END}`)};
createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined || m.method === undefined) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} }, authMethods: [] } });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'reviewer-' + Date.now() } });
  if (m.method === 'session/prompt') {
    appendFileSync(log, JSON.stringify(m.params.prompt) + '\\n');
    send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: verdict } } } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: m.id, error: { code: -32601, message: 'not here: ' + m.method } });
});
`;

// Frozen plugin copies are read-only: open them up so the temp dir can go
function writable(dir: string): void {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) writable(p);
    else if (e.isFile()) chmodSync(p, 0o644);
  }
}

interface SeenCard {
  id: string;
  message?: string;
  outcome?: string;
}

// Every question card seen in the envelopes, newest state by id
function cards(s: Shell): Map<string, SeenCard> {
  const found = new Map<string, SeenCard>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (o.type === 'question' && typeof o.id === 'string' && Array.isArray(o.questions)) found.set(o.id, o as unknown as SeenCard);
    for (const x of Object.values(o)) walk(x);
  };
  for (const m of s.out) if (m.type === 'hostMessage') walk(m.message);
  return found;
}

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 250));
  }
}

describe('pr-loop end to end against the sidecar', () => {
  const shells: Shell[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of shells.splice(0)) await s.kill();
    for (const d of dirs.splice(0)) {
      try { writable(d); } catch { /* best effort */ }
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  // Opt-in (ACPIRA_PR_LOOP_E2E=1): it starts the sidecar, two agents, the plugin and a node gh double per call. On the
  // machine it was written on a node start took 25 s, past the plugin runtime's 10 s initialize limit, so it never passed there
  it.skipIf(!process.env.ACPIRA_PR_LOOP_E2E)('reviews with a fresh reviewer session, asks, and merges through the gh double', async () => {
    const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
    const home = temp('acpira-prloop-home-');
    const ws = temp('acpira-prloop-ws-');
    const tools = temp('acpira-prloop-tools-');
    const source = fileURLToPath(new URL('../plugins/pr-loop', import.meta.url));
    mkdirSync(join(home, 'plugins'), { recursive: true });
    cpSync(source, join(home, 'plugins', 'pr-loop'), { recursive: true });
    const slash = (p: string) => p.replace(/\\/g, '/');
    const ghState = slash(join(tools, 'gh.json'));
    writeFileSync(ghState, JSON.stringify({ state: 'OPEN', head: 'e2ehead01', mergeCommit: null }));
    writeFileSync(join(tools, 'gh.mjs'), FAKE_GH);
    writeFileSync(join(tools, 'reviewer.mjs'), REVIEWER);
    const promptLog = join(tools, 'reviewer.log');

    const s = new Shell(home, ws);
    shells.push(s);
    // The helpers wait 10 s; a slow machine needs longer, so their own timeouts are ignored
    s.hello({ settings: { defaultAgent: 'fake', agents: {
      fake: { name: 'Fake', command: NODE, args: [FAKE] },
      reviewer: { name: 'Reviewer', command: NODE, args: [join(tools, 'reviewer.mjs'), promptLog] },
    } } } as never).catch(() => {});
    const hello = await s.next((m): m is Extract<typeof m, { type: 'helloOk' | 'helloReject' }> => m.type === 'helloOk' || m.type === 'helloReject', 300_000);
    expect(hello.type).toBe('helloOk');
    s.open('V', 'sidebar', { mostRecent: true }).catch(() => {});
    const init = await s.hostMsg('V', 'init', () => true, 300_000);
    const impl = init.state.active!.id;
    s.view('V', { type: 'pluginAction', action: { op: 'enable', id: 'pr-loop' } } as never);
    const enabled = await s.hostMsg('V', 'plugins', m => m.view.plugins.some(p => p.id === 'pr-loop' && p.enabled), 600_000);
    expect(enabled.error).toBeUndefined();
    s.view('V', { type: 'send', sessionId: impl, text: 'say:實作完成', attachments: [] } as never);

    const answered = new Set<string>();
    const open = (text: string) => [...cards(s).values()].find(c => !answered.has(c.id) && !c.outcome && c.message?.includes(text));
    // Waits for the plugin's card holding `text` and clicks `choice` on it; `resend` again while the process starts
    const card = async (text: string, choice = 'ok', resend?: string) => {
      const end = Date.now() + 900_000;
      let next = Date.now() + 180_000;
      for (;;) {
        const c = open(text);
        if (c) {
          answered.add(c.id);
          s.view('V', { type: 'answer', sessionId: impl, blockId: c.id, answers: { choice } } as never);
          return c;
        }
        if (Date.now() > end) throw new Error(`no card with ${text}; stderr:\n${s.stderr.slice(-40).join('\n')}`);
        if (resend && Date.now() > next) {
          s.view('V', { type: 'send', sessionId: impl, text: resend, attachments: [] } as never);
          next = Date.now() + 180_000;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    };
    const run = (text: string, expectText: string) => {
      s.view('V', { type: 'send', sessionId: impl, text, attachments: [] } as never);
      return card(expectText, 'ok', text);
    };

    await run('/pr-loop config allow me/app', '允許自動循環的 repo：me/app');
    await run(`/pr-loop config gh ${JSON.stringify([slash(NODE), slash(join(tools, 'gh.mjs')), ghState])}`, 'gh.mjs');
    await run('/pr-loop config reviewer reviewer', 'reviewer agent：reviewer');
    await run('/pr-loop 12 端到端的需求原文', '開始 me/app#12');
    // The reviewer got the brief in a session of its own; the merge card follows
    const mergeCard = await card('要現在合併嗎', 'merge');
    expect(mergeCard.message).toContain('沒有設定 CI');
    const done = await card('已合併 me/app#12');
    expect(done.message).toContain('e2e-merge-commit');

    const brief = readFileSync(promptLog, 'utf8');
    expect(brief).toContain('端到端的需求原文');
    expect(brief).toContain('看 src/a.ts');
    expect(brief).toContain('e2ehead01');
    const calls = readFileSync(`${ghState}.log`, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);
    expect(calls.filter(a => a[1] === 'merge')).toEqual([['pr', 'merge', '12', '--repo', 'me/app', '--merge', '--match-head-commit', 'e2ehead01']]);
    for (const c of calls) for (const f of ['--auto', '--squash', '--rebase', '--delete-branch']) expect(c).not.toContain(f);
    expect(existsSync(promptLog)).toBe(true);
  }, 3_000_000);
});
