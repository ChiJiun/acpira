import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionView } from '@acpira/shared/transcript';
import { Shell } from './sidecarShell';

// A prompt sent while a runtime plugin is in effect ends like any other turn, with the attached sidecar still up. On
// Windows its wire loop used to run on the main thread, whose 1 MB stack the first poll of a prompt overran in debug
// builds (docs/dev/windows-compatibility.md)

const STATUS = `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'rpc/status') return send({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no ' + m.method } });
});
`;

// Frozen plugin copies are read-only, folders included: open them up so the temp dir can go
function writable(dir: string): void {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) writable(p);
    else if (e.isFile()) chmodSync(p, 0o644);
  }
}

const ended = (id: string, turns: number) => (m: { session: SessionView }) => m.session.id === id && !m.session.running && m.session.turns.length === turns;

describe('a turn with a runtime plugin in effect', () => {
  const shells: Shell[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of shells.splice(0)) await s.kill();
    for (const d of dirs.splice(0)) {
      writable(d);
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  async function turn(withPlugin: boolean) {
    const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
    const home = temp('acpira-plugin-turn-home-');
    if (withPlugin) {
      const dir = join(home, 'plugins', 'status');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'status.mjs'), STATUS);
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
        schema: 1, id: 'status', version: '1.0.0', description: 'Answers status',
        contributes: { runtime: { command: ['node', 'status.mjs'], methods: ['status'] } },
      }));
    }
    // A temp profile keeps the CLIs' real logins out of reach, and this test's own node goes first on PATH: a launcher
    // shim (nvm-windows) would otherwise spend the plugin's start budget
    const profile = temp('acpira-plugin-turn-profile-');
    const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
    const s = new Shell(home, temp('acpira-plugin-turn-ws-'), undefined, {
      HOME: profile, USERPROFILE: profile, [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ''}`,
    });
    shells.push(s);
    await s.hello({ client: { name: 'contract', version: '0', capabilities: [] } });
    const init = await s.open('V');
    const id = init.state.active!.id;
    await s.hostMsg('V', 'session', m => m.session.id === id && m.session.status === 'ready', 60_000);

    if (withPlugin) {
      s.view('V', { type: 'pluginAction', action: { op: 'enable', id: 'status' } });
      const enabled = await s.hostMsg('V', 'plugins', m => m.view.plugins.some(p => p.id === 'status' && p.enabled) || !!m.error, 60_000);
      expect(enabled.error).toBeUndefined();
      let answer: { result?: unknown; error?: string } = {};
      for (let i = 0; i < 300; i++) {
        s.view('V', { type: 'pluginCall', id: `st${i}`, plugin: 'status', method: 'status' });
        answer = await s.hostMsg('V', 'pluginCalled', m => m.id === `st${i}`, 30_000);
        if (!answer.error) break;
        await new Promise(r => setTimeout(r, 200));
      }
      expect(answer, s.stderr.slice(-30).join('\n')).toMatchObject({ result: { ok: true } });
    }

    s.view('V', { type: 'send', sessionId: id, text: 'hello' });
    const done = await s.hostMsg('V', 'session', ended(id, 2), 60_000).catch((e: Error) => {
      throw new Error(`sidecar exit code ${s.exitCode}: ${e.message.slice(-2000)}`);
    });
    expect(done.session.turns.at(-1)?.role).toBe('agent');
    expect(s.exitCode).toBeNull();
  }

  it('ends the first prompt without a plugin', () => turn(false), 180_000);

  it('ends the first prompt after a runtime plugin started, and the sidecar stays up', () => turn(true), 180_000);
});
