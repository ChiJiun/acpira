// The plugin's process: the engine's session API and storage behind the machine's interfaces, `gh` run as a child
// process, a poll timer, and the `/pr-loop` command. The loop itself is machine.ts

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { definePlugin, type Context } from '@acpira/plugin';
import { GitHub, type RunResult } from './github';
import { DEFAULT_CONFIG, PrLoop, type Host, type SessionInfo, type Store } from './machine';

function host(ctx: Context): Host {
  const sessions = async (): Promise<SessionInfo[]> =>
    ((await ctx.session.list()) ?? []).map((s: Record<string, unknown>) => ({ id: String(s.id), agent: String(s.agent ?? ''), cwd: String(s.cwd ?? ''), title: String(s.title ?? '') }));
  return {
    sessions,
    session: async (id, turns) => (await ctx.session.get(id, turns)) ?? null,
    async newSession(agent, cwd) {
      const before = new Set((await sessions()).map(s => s.id));
      const r = await ctx.session.act({ type: 'newSession', agent, cwd });
      // The plugin's own viewer moves to the new session; a failed start leaves it where it was. No guessing from the
      // list: a session the user opened meanwhile must never be taken for the reviewer
      const active = typeof r?.active === 'string' ? r.active : null;
      return active && !before.has(active) ? active : null;
    },
    async send(session, text) {
      await ctx.session.send(session, text);
    },
    async ask(session, message, options, waitSecs) {
      const r = await ctx.ui.ask({ session, message, waitSecs, questions: [{ id: 'choice', text: '請選擇', kind: 'single', options }] });
      if (!r || r.timedOut) return null;
      const a = r.answers?.choice;
      return typeof a === 'string' ? a : Array.isArray(a) && typeof a[0] === 'string' ? a[0] : null;
    },
    async toast(text, level = 'info') {
      await ctx.ui.toast(text, level as never);
    },
    log: text => ctx.log(text),
  };
}

function store(ctx: Context): Store {
  return {
    get: key => ctx.storage.get(key),
    set: async (key, value) => {
      await ctx.storage.set(key, value);
    },
    swap: async (key, expect, value) => Boolean((await ctx.request('storage/swap', { key, expect, value }))?.swapped),
  };
}

// `gh` with the configured argv; never through a shell, so no argument is reinterpreted
function runner(ctx: Context) {
  return async (args: string[], opts?: { cwd?: string }): Promise<RunResult> => {
    const c = { ...DEFAULT_CONFIG, ...((await ctx.storage.get<Record<string, unknown>>('config')) ?? {}) };
    const argv = Array.isArray(c.gh) && c.gh.length ? (c.gh as string[]) : ['gh'];
    return new Promise(resolve => {
      execFile(
        argv[0]!,
        [...argv.slice(1), ...args],
        { cwd: opts?.cwd || undefined, timeout: 120_000, maxBuffer: 16 << 20, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
        (err, stdout, stderr) => {
          const out = String(stdout ?? '');
          const errText = String(stderr ?? '');
          if (!err) return resolve({ code: 0, stdout: out, stderr: errText });
          const code = (err as { code?: unknown }).code;
          // A number is gh's exit code; a string (ENOENT …) or none (a timeout) means it never ran to the end
          if (typeof code === 'number') return resolve({ code, stdout: out, stderr: errText });
          resolve({ code: 127, stdout: out, stderr: `${err.message}\n${errText}` });
        },
      );
    });
  };
}

let machine: PrLoop | null = null;

export default definePlugin({
  activate(ctx) {
    machine = new PrLoop({ host: host(ctx), store: store(ctx), gh: new GitHub(runner(ctx)), owner: `${process.pid}-${randomUUID()}` });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const loop = async () => {
      if (closed) return;
      try {
        await machine!.tick();
      } catch (e) {
        ctx.log(`tick: ${(e as Error).message}`);
      }
      const c = await machine!.config().catch(() => DEFAULT_CONFIG);
      if (!closed) timer = setTimeout(loop, c.pollSecs * 1000);
    };
    // The first pass picks up loops left by an earlier process (an engine restart)
    timer = setTimeout(loop, 3000);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
  },
  events: {
    'turn.ended': e => {
      const session = e.data?.session;
      if (typeof session === 'string') void machine?.onTurnEnded(session);
    },
  },
  commands: {
    // Answered at once (a command hook has seconds); the work goes on in the background and reports in cards
    'pr-loop': (args, ctx) => {
      const session = ctx.session;
      if (!machine || !session) return null;
      void machine.command(session, args);
      return null;
    },
  },
});
