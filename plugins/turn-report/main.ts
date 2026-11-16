// turn-report's resident process: hears turns start and end, reads the session once a turn has ended, and when the
// turn edited files or ran commands but its closing reply leaves out what was done, why, or what is left unverified,
// sends the agent one follow-up asking for it (README.md says why this path and not an afterTurn hook)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { definePlugin, type Context } from '@acpira/plugin';
import { applyJudge, evaluateTurn, judgePrompt, noteTurnStarted, parseJudge, resolveConfig, type ReportConfig, type SessionMemo } from './report';

// Follow-ups sent per session for the user's current request; lost on a restart, which costs at most one extra ask
const memos = new Map<string, SessionMemo>();
// One check per session at a time: a second turn end waits for the first's decision
const checking = new Map<string, Promise<void>>();
// The queue flushes right after a turn settles; reading the session a moment later sees the next turn if one started
const SETTLE_MS = 600;
// Turns read back: enough for a request with gate follow-ups and continues in between
const TURNS_READ = 40;

const CONFIG_FILE = 'config.json';
let warned = '';
// The last configuration read, for turn.started, which must decide before the turn can end
let current = resolveConfig(undefined);

// Read every time, so an edit applies from the next turn without restarting the plugin
async function config(ctx: Context): Promise<ReportConfig> {
  let text: string;
  try {
    text = await readFile(join(ctx.plugin.data, CONFIG_FILE), 'utf8');
  } catch {
    return (current = resolveConfig(undefined));
  }
  try {
    return (current = resolveConfig(JSON.parse(text)));
  } catch (e) {
    const why = `turn-report: ${CONFIG_FILE} is not valid JSON, using the defaults (${(e as Error).message})`;
    if (warned !== why) {
      warned = why;
      ctx.log(why);
    }
    return (current = resolveConfig(undefined));
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
// A request the engine never answers must not hold this session's checks for good (`checking` chains them)
const ENGINE_WAIT_MS = 15_000;
const MODEL_WAIT_MS = 60_000;
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function check(data: Record<string, unknown>, ctx: Context): Promise<void> {
  const session = typeof data.session === 'string' ? data.session : undefined;
  if (!session) return;
  const cfg = await config(ctx);
  if (!cfg.enabled) return;
  await delay(SETTLE_MS);
  const view = await within(ctx.session.get(session, TURNS_READ), ENGINE_WAIT_MS, 'session/get');
  const end = { stop: typeof data.stop === 'string' ? data.stop : undefined, error: data.error ?? undefined, agent: typeof data.agent === 'string' ? data.agent : undefined };
  let decision = evaluateTurn(end, view, memos.get(session), cfg);
  if (decision.action === 'ask' && cfg.model.enabled) {
    try {
      const { system, prompt } = judgePrompt(decision.work.reply, cfg);
      const answer = await within(ctx.model.generate({ prompt, system, maxTokens: cfg.model.maxTokens, ...(cfg.model.model ? { model: cfg.model.model } : {}) }), MODEL_WAIT_MS, 'model/generate');
      const judged = applyJudge(decision.check, parseJudge(String(answer?.text ?? '')), decision.work.reply, cfg);
      if (judged.pass) decision = { action: 'pass', check: judged, work: decision.work };
    } catch (e) {
      // No model source, or the call failed: the keyword check stands
      ctx.log(`turn-report: model check failed, keeping the keyword check (${(e as Error).message})`);
    }
    // The model took its time: a turn that started meanwhile must not get the follow-up as its reply
    if (decision.action === 'ask') {
      const now = await within(ctx.session.get(session, 1), ENGINE_WAIT_MS, 'session/get');
      if (now?.running || (now?.queued?.length ?? 0) > 0) decision = { action: 'skip', reason: 'another turn started during the model check' };
    }
  }
  if (decision.action === 'skip') {
    ctx.log(`turn-report: ${session} skipped: ${decision.reason}`);
    return;
  }
  if (decision.action === 'pass') {
    ctx.log(`turn-report: ${session} passed`);
    return;
  }
  // Counted before sending: the follow-up's own turn.started must not look like a fresh request
  const memo = memos.get(session) ?? { asks: 0 };
  memos.set(session, { asks: memo.asks + 1 });
  ctx.log(`turn-report: ${session} asks for ${decision.check.missing.join(', ')} (${memo.asks + 1}/${cfg.maxAsks})`);
  try {
    await within(ctx.session.send(session, decision.prompt), ENGINE_WAIT_MS, 'session/act');
  } catch (e) {
    ctx.log(`turn-report: sending the follow-up failed: ${(e as Error).message}`);
  }
}

export default definePlugin({
  events: {
    'turn.started': e => {
      const data = (e.data ?? {}) as Record<string, unknown>;
      if (typeof data.session !== 'string') return;
      memos.set(data.session, noteTurnStarted(memos.get(data.session), String(data.origin ?? ''), String(data.text ?? ''), current));
    },
    'turn.ended': (e, ctx) => {
      const data = (e.data ?? {}) as Record<string, unknown>;
      const session = typeof data.session === 'string' ? data.session : '';
      const before = checking.get(session) ?? Promise.resolve();
      const next = before
        .then(() => check(data, ctx))
        .catch(err => ctx.log(`turn-report: check failed: ${(err as Error)?.message ?? err}`))
        .finally(() => { if (checking.get(session) === next) checking.delete(session); });
      checking.set(session, next);
      return next;
    },
  },
  methods: {
    // What the plugin is doing, for a quick look (and the end-to-end test's readiness probe)
    status: async (_params, ctx) => {
      const cfg = await config(ctx);
      return { enabled: cfg.enabled, maxAsks: cfg.maxAsks, sessions: Object.fromEntries(memos) };
    },
  },
});
