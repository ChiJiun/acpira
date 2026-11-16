import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionView, Turn } from '@acpira/shared/transcript';
import {
  DEFAULT_CONFIG, applyJudge, checkReply, evaluateTurn, followUp, noteTurnStarted, parseJudge, readOnlyCommand, resolveConfig,
  summarizeWork, type SessionViewLike, type TurnView,
} from '../plugins/turn-report/report';
import type { SidecarMsg } from '@acpira/shared/sidecar';
import { Shell } from './sidecarShell';

// The turn-report plugin (plugins/turn-report/): its pure check against session views shaped like the engine's, then
// the plugin itself inside the Rust sidecar with the fake agent, asking once and only once

const cfg = resolveConfig(undefined);
const user = (text: string, auto?: boolean): TurnView => ({ role: 'user', text, ...(auto ? { auto } : {}) });
const tool = (kind: string, extra: Record<string, unknown> = {}) => ({ type: 'tool_call', kind, status: 'completed', ...extra });
const text = (markdown: string, phase?: 'commentary' | 'final') => ({ type: 'text', markdown, ...(phase ? { phase } : {}) });
const agent = (...blocks: Record<string, unknown>[]): TurnView => ({ role: 'agent', stop: 'end_turn', blocks: blocks as never });
const view = (...turns: TurnView[]): SessionViewLike => ({ id: 's', agent: 'fake', running: false, queued: [], turns });
const ended = { stop: 'end_turn', error: null, agent: 'fake' };

const FULL_ZH = '我修改了 `src/a.ts`，並執行 `pnpm test` 全部通過。這樣做是為了避免重複解析。尚未驗證 Windows 上的行為。';
const FULL_EN = 'I updated src/a.ts and ran the tests. I did this because the parser was called twice. Not yet verified on Windows.';

describe('turn-report check', () => {
  it('passes a reply that covers all three parts, in Traditional Chinese and in English', () => {
    for (const reply of [FULL_ZH, FULL_EN]) {
      const d = evaluateTurn(ended, view(user('fix it'), agent(tool('edit', { locations: [{ path: '/w/src/a.ts' }] }), text(reply))), undefined, cfg);
      expect(d.action, reply).toBe('pass');
    }
  });

  it('asks when a turn that worked ends without the report, naming what is missing and what it saw', () => {
    const d = evaluateTurn(ended, view(user('fix it'), agent(tool('edit', { locations: [{ path: '/w/src/a.ts' }] }), tool('execute', { target: 'pnpm test' }), text('好了。'))), undefined, cfg);
    expect(d.action).toBe('ask');
    if (d.action !== 'ask') return;
    expect(d.check.missing).toEqual(['done', 'why', 'todo']);
    expect(d.prompt.startsWith('[turn-report]')).toBe(true);
    expect(d.prompt).toContain('做了哪些事、為什麼這樣做、還有哪些沒做完或沒驗證');
    expect(d.prompt).toContain('`/w/src/a.ts`');
    expect(d.prompt).toContain('`pnpm test`');
  });

  it('asks for just the missing part', () => {
    const d = evaluateTurn(ended, view(user('x'), agent(tool('execute', { target: 'pnpm build' }), text('I ran pnpm build because the bundle was stale.'))), undefined, cfg);
    expect(d.action).toBe('ask');
    if (d.action === 'ask') expect(d.check.missing).toEqual(['todo']);
  });

  it('leaves a question and its answer alone, read-only commands included', () => {
    const qa = [
      view(user('what does it do?'), agent(text('It parses the file.'))),
      view(user('where is it?'), agent(tool('read', { locations: [{ path: '/w/a.ts' }] }), tool('search'), text('In a.ts.'))),
      view(user('status?'), agent(tool('execute', { target: 'git status' }), tool('execute', { target: 'cd "D:/w" && git log --oneline -3 | head' }), text('Clean.'))),
    ];
    for (const v of qa) expect(evaluateTurn(ended, v, undefined, cfg)).toMatchObject({ action: 'skip', reason: expect.stringContaining('no edits') });
    // The same commands count as work once read-only commands are not ignored
    const strict = resolveConfig({ ignoreReadOnlyCommands: false });
    expect(evaluateTurn(ended, qa[2], undefined, strict).action).toBe('ask');
  });

  it('tells read-only commands from ones that write', () => {
    expect(readOnlyCommand('git status', cfg)).toBe(true);
    expect(readOnlyCommand('rg -n foo src 2>/dev/null | head -5', cfg)).toBe(true);
    expect(readOnlyCommand('Get-ChildItem -Recurse', cfg)).toBe(true);
    expect(readOnlyCommand('echo bad > a.txt', cfg)).toBe(false);
    expect(readOnlyCommand('git status && rm -rf dist', cfg)).toBe(false);
    expect(readOnlyCommand('pnpm test', cfg)).toBe(false);
  });

  it('asks at most maxAsks times per user request, and a new request starts the count again', () => {
    const bare = view(user('fix'), agent(tool('edit', { locations: [{ path: 'a.ts' }] }), text('ok')));
    let memo = noteTurnStarted(undefined, 'user', 'fix', cfg);
    expect(evaluateTurn(ended, bare, memo, cfg).action).toBe('ask');
    memo = { asks: memo.asks + 1 };
    // The follow-up's own turn keeps the count
    memo = noteTurnStarted(memo, 'user', '[turn-report] 請補上…', cfg);
    expect(memo.asks).toBe(1);
    // Its reply still lacks the report: the limit stops a second ask
    const after = view(user('fix'), agent(tool('edit', { locations: [{ path: 'a.ts' }] }), text('ok')), user('[turn-report] 請補上…'), agent(tool('edit', { locations: [{ path: 'b.ts' }] }), text('ok')));
    expect(evaluateTurn(ended, after, memo, cfg)).toMatchObject({ action: 'skip', reason: 'follow-up limit reached' });
    // Gate follow-ups and continues do not reset it
    expect(noteTurnStarted(memo, 'gate', 'findings', cfg).asks).toBe(1);
    // The user's next request does
    expect(noteTurnStarted(memo, 'user', 'next thing', cfg).asks).toBe(0);
    // maxAsks 0 never asks; a huge one is capped
    expect(evaluateTurn(ended, bare, undefined, resolveConfig({ maxAsks: 0 }))).toMatchObject({ action: 'skip', reason: 'follow-up limit reached' });
    expect(resolveConfig({ maxAsks: 99 }).maxAsks).toBe(3);
  });

  it('counts the work of the whole request, across automatic follow-ups, and reads the last turn\'s closing text', () => {
    const turns: TurnView[] = [
      user('earlier'), agent(tool('edit', { locations: [{ path: 'old.ts' }] }), text(FULL_EN)),
      user('fix'), agent(tool('edit', { locations: [{ path: 'a.ts' }] }), text('first')),
      user('gate findings', true), agent(text('working on it'), tool('execute', { target: 'pnpm test' }), text('closing words')),
    ];
    const w = summarizeWork(turns, cfg);
    expect(w).toMatchObject({ worked: true, files: ['a.ts'], commands: ['pnpm test'], reply: 'closing words' });
    // A turn marking its final message reads that, whatever follows
    expect(summarizeWork([user('x'), agent(text('the plan', 'commentary'), tool('edit'), text('the end', 'final'), text('p.s.', 'commentary'))], cfg).reply).toBe('the end');
    // Failed edits did not change anything
    expect(summarizeWork([user('x'), agent({ ...tool('edit'), status: 'failed' }, text('no'))], cfg).worked).toBe(false);
  });

  it('skips turns that did not finish, sessions still busy, and agents not listed', () => {
    const bare = view(user('fix'), agent(tool('edit'), text('ok')));
    expect(evaluateTurn({ ...ended, stop: 'cancelled' }, bare, undefined, cfg).action).toBe('skip');
    expect(evaluateTurn({ ...ended, error: { message: 'x' } }, bare, undefined, cfg).action).toBe('skip');
    expect(evaluateTurn(ended, { ...bare, running: true }, undefined, cfg).action).toBe('skip');
    expect(evaluateTurn(ended, { ...bare, queued: [{ text: 'next' }] }, undefined, cfg).action).toBe('skip');
    expect(evaluateTurn(ended, null, undefined, cfg).action).toBe('skip');
    expect(evaluateTurn(ended, bare, undefined, resolveConfig({ agents: ['claude'] })).action).toBe('skip');
    expect(evaluateTurn(ended, bare, undefined, resolveConfig({ agents: ['fake'] })).action).toBe('ask');
    expect(evaluateTurn(ended, bare, undefined, resolveConfig({ enabled: false })).action).toBe('skip');
  });

  it('is lenient: headings, "nothing left", long replies, and code fences do not count', () => {
    const headings = '## 變更\n- 新增 parser\n## 原因\n舊的太慢\n## 未驗證\n無';
    expect(checkReply(headings, cfg).pass).toBe(true);
    expect(checkReply('Changed a.ts so that the cache is used. All tests passed, nothing left.', cfg).pass).toBe(true);
    // Two of three in a long reply pass
    const long = `I updated a.ts and b.ts. ${'More details about the edit. '.repeat(40)}`;
    expect(checkReply(long, cfg)).toMatchObject({ pass: false, missing: ['why', 'todo'] });
    expect(checkReply(`${long} This was needed because the old one leaked.`, cfg).pass).toBe(true);
    // A TODO inside a snippet is not a report of what is left
    expect(checkReply('Updated a.ts because it leaked.\n```ts\n// TODO: later\n```', cfg).covered.todo).toBe(false);
  });

  it('takes its settings from config.json, ignoring what it does not understand', () => {
    const c = resolveConfig({ minCovered: 2, sections: { why: { label: 'Why', extra: ['\\bbecuz\\b'] }, todo: { patterns: ['\\bopen:'] } }, workKinds: 'nope', prompt: 'Report please: {missing}', marker: '[r]' });
    expect(c.minCovered).toBe(2);
    expect(c.workKinds).toEqual(DEFAULT_CONFIG.workKinds);
    expect(checkReply('becuz', c).covered.why).toBe(true);
    expect(checkReply('還有一件事沒驗證', c).covered.todo).toBe(false);
    expect(followUp(c, ['why'], { worked: true, files: [], commands: [], reply: '' })).toBe('[r] Report please: Why');
    // A broken pattern is skipped, not thrown
    expect(() => checkReply('x', resolveConfig({ sections: { done: { patterns: ['(unclosed'] } } }))).not.toThrow();
    expect(resolveConfig('garbage')).toEqual(DEFAULT_CONFIG);
  });

  it('lets the optional model only add coverage', () => {
    const check = checkReply('好了。', cfg);
    expect(parseJudge('sure: {"done": true, "why": true, "todo": true}')).toEqual({ done: true, why: true, todo: true });
    expect(parseJudge('no json')).toBeNull();
    expect(parseJudge('{"done": "yes"}')).toBeNull();
    expect(applyJudge(check, { done: true, why: true, todo: true }, '好了。', cfg).pass).toBe(true);
    const keywordPass = checkReply(FULL_EN, cfg);
    expect(applyJudge(keywordPass, { done: false, why: false, todo: false }, FULL_EN, cfg).pass).toBe(true);
  });
});

// ---- end to end: the plugin in a sidecar on a temp home, with the fake agent ----

const SOURCE = fileURLToPath(new URL('../plugins/turn-report', import.meta.url));

// Frozen plugin copies are read-only, folders included: open them up so the temp dir can go
function writable(dir: string): void {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) writable(p);
    else if (e.isFile()) chmodSync(p, 0o644);
  }
}

describe('turn-report in the sidecar', () => {
  const shells: Shell[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of shells.splice(0)) await s.kill();
    for (const d of dirs.splice(0)) {
      writable(d);
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('asks once, and only once, after a turn that ran a command without reporting', async () => {
    const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
    const home = temp('acpira-turn-report-home-');
    const ws = temp('acpira-turn-report-ws-');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    cpSync(SOURCE, join(home, 'plugins', 'turn-report'), { recursive: true });
    // A temp profile too: the sidecar would otherwise pick up the CLIs' real logins from the user's own folders
    const profile = temp('acpira-turn-report-profile-');
    // The plugin runs on the `node` of PATH and must answer initialize within 10 s: put this test's own node first, so a
    // slow launcher shim on PATH (nvm-windows' proxy) does not eat that budget
    const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
    const path = `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ''}`;
    const s = new Shell(home, ws, undefined, { HOME: profile, USERPROFILE: profile, [pathKey]: path });
    shells.push(s);
    // Shell.hello waits 10 s, which a slow machine overruns: wait for the answer longer
    const hello = s.hello().catch(() => undefined);
    const ok = await s.next((m): m is Extract<SidecarMsg, { type: 'helloOk' }> => m.type === 'helloOk', 60_000);
    expect(ok.type).toBe('helloOk');
    await hello;
    // As Shell.open, with room for a slow machine
    s.send({ type: 'attachView', viewId: 'V', host: 'sidebar' });
    s.view('V', { type: 'ready' });
    const init = await s.hostMsg('V', 'init', () => true, 60_000);
    const id = init.state.active!.id;

    s.view('V', { type: 'pluginAction', action: { op: 'enable', id: 'turn-report' } });
    const enabled = await s.hostMsg('V', 'plugins', m => m.view.plugins.some(p => p.id === 'turn-report' && p.enabled) || !!m.error, 60_000);
    expect(enabled.error).toBeUndefined();
    // The process starts after the commit and must answer initialize before it hears events
    let status: { result?: unknown; error?: string } = {};
    for (let i = 0; i < 300; i++) {
      s.view('V', { type: 'pluginCall', id: `st${i}`, plugin: 'turn-report', method: 'status' });
      status = await s.hostMsg('V', 'pluginCalled', m => m.id === `st${i}`, 30_000);
      if (!status.error) break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(status, s.stderr.slice(-30).join('\n')).toMatchObject({ result: { enabled: true, maxAsks: 1 } });

    const latest = (): SessionView | undefined => {
      const msgs = s.hostMsgs('V').filter((m): m is Extract<typeof m, { type: 'session' }> => m.type === 'session' && m.session.id === id);
      return msgs.at(-1)?.session;
    };
    const userTexts = () => (latest()?.turns ?? []).filter((t): t is Extract<Turn, { role: 'user' }> => t.role === 'user').map(t => t.text);

    // A turn that runs a shell command and replies "done": no report
    s.view('V', { type: 'send', sessionId: id, text: `hook-turn:shell=${join(ws, 'out.txt')}` });
    await s.hostMsg('V', 'session', m => m.session.id === id && !m.session.running && m.session.turns.length >= 4, 60_000);
    // The follow-up's turn ends too; then nothing more may come
    await s.hostMsg('V', 'session', m => m.session.id === id && !m.session.running && m.session.turns.length >= 4 && m.session.turns.at(-1)?.role === 'agent' && (m.session.turns.at(-1) as { stop?: string }).stop !== undefined, 60_000);
    await new Promise(r => setTimeout(r, 4000));
    const asks = userTexts().filter(t => t.startsWith('[turn-report]'));
    expect(asks, JSON.stringify(userTexts())).toHaveLength(1);
    expect(asks[0]).toContain('還有哪些沒做完或沒驗證');
    expect(latest()?.turns).toHaveLength(4);
  }, 120_000);
});

// ---- the plugin's process over the plugin wire, without the engine ----

// main.ts bundled the way the engine boots a `runtime.main` (the SDK's `start` with the module's default export), then
// driven as the engine would: initialize, turn events, and answers to session/get, session/act and storage/*
describe('turn-report process', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('asks once per request, never for a question, and again for the next request', async () => {
    const out = mkdtempSync(join(tmpdir(), 'acpira-turn-report-proc-'));
    dirs.push(out);
    const { buildSync } = await import('esbuild');
    mkdirSync(join(out, '__acpira'), { recursive: true });
    cpSync(fileURLToPath(new URL('../rust/crates/acpira-host/src/plugins/sdk.mjs', import.meta.url)), join(out, '__acpira', 'plugin.mjs'));
    // The engine points the SDK import at its frozen copy; the bundle keeps the bare name, which is pointed there after
    const bundle = buildSync({ entryPoints: [join(SOURCE, 'main.ts')], bundle: true, platform: 'node', format: 'esm', write: false, external: ['@acpira/plugin'], logLevel: 'warning' });
    writeFileSync(join(out, 'main.mjs'), bundle.outputFiles[0]!.text.replaceAll('"@acpira/plugin"', '"./__acpira/plugin.mjs"'));
    writeFileSync(join(out, '__main.mjs'), "import { start } from './__acpira/plugin.mjs';\nstart((await import('./main.mjs')).default ?? {});\n");

    const turns: TurnView[] = [];
    const sent: { type: string; sessionId: string; text: string }[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, [join(out, '__main.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const write = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    const waits = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
    let next = 1;
    const request = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: unknown }>(r => { const id = next++; waits.set(id, r); write({ id, method, params }); });
    const event = (type: string, data: Record<string, unknown>) => write({ method: 'event', params: { type, at: Date.now(), data: { session: 's1', agent: 'fake', cwd: '/w', ...data } } });
    // A scripted agent: the user's text in, these blocks out
    const turn = (text: string, blocks: Record<string, unknown>[]) => {
      turns.push({ role: 'user', text });
      event('turn.started', { origin: 'user', text });
      turns.push(agent(...blocks));
      event('turn.ended', { stop: 'end_turn', error: null, usage: null });
    };
    createInterface({ input: child.stdout }).on('line', line => {
      const m = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, any>; result?: unknown; error?: unknown };
      if (m.method === undefined) { waits.get(m.id as number)?.(m); return; }
      if (m.method === 'log') return void logs.push(String(m.params?.message));
      const answer = (result: unknown) => write({ id: m.id, result });
      if (m.method === 'storage/get') return answer({ value: null });
      if (m.method === 'storage/set') return answer({});
      if (m.method === 'session/get') return answer({ session: { id: 's1', agent: 'fake', running: false, queued: [], turns: structuredClone(turns) } });
      if (m.method === 'session/act') {
        sent.push(m.params?.message);
        answer({ active: null });
        // The agent answers the follow-up without a report again: a second ask would be a loop
        setTimeout(() => turn(m.params?.message.text, [tool('edit', { locations: [{ path: 'b.ts' }] }), text('ok')]), 50);
        return;
      }
      write({ id: m.id, error: { code: -32601, message: `not here: ${m.method}` } });
    });
    const until = async (ok: () => boolean, ms = 30_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(r => setTimeout(r, 100)); expect(ok(), logs.join('\n')).toBe(true); };
    try {
      const init = await request('initialize', { protocolVersion: 1, plugin: { id: 'turn-report', version: '0.1.0', snapshot: 'x', dir: out, data: out }, engine: { name: 'acpira' }, hooks: [], events: ['turn.started', 'turn.ended'], methods: ['status'] });
      expect(init.result).toMatchObject({ protocolVersion: 1 });

      turn('what is this?', [text('A parser.')]);
      await until(() => logs.some(l => l.includes('skipped: no edits')));
      turn('fix it', [tool('execute', { target: 'echo bad > a.txt' }), text('done')]);
      await until(() => logs.some(l => l.includes('follow-up limit reached')));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'send', sessionId: 's1', text: expect.stringMatching(/^\[turn-report\].*為什麼這樣做、還有哪些沒做完或沒驗證/) });
      expect(sent[0]!.text).toContain('`echo bad > a.txt`');

      turn('next', [tool('edit', { locations: [{ path: 'c.ts' }] }), text(FULL_ZH)]);
      await until(() => logs.some(l => l.includes('passed')));
      turn('again', [tool('edit', { locations: [{ path: 'd.ts' }] }), text('ok')]);
      await until(() => logs.filter(l => l.includes('follow-up limit reached')).length === 2);
      expect(sent).toHaveLength(2);
      expect((await request('rpc/status', { params: {}, from: 'page' })).result).toEqual({ enabled: true, maxAsks: 1, sessions: { s1: { asks: 1 } } });
    } finally {
      child.stdin.end();
      await new Promise(r => { if (child.exitCode !== null) r(null); else child.on('exit', r); });
    }
  }, 120_000);
});
