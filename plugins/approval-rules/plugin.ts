// approval-rules: the user's approval rules enforced by the harness. Every permission request an agent sends passes
// the `permission` hook; a request a rule matches gets the card even under Acpira's synthesized full access (or is
// refused when the rule says `deny`). An agent's own full-access mode that sends no request (Claude Code's
// bypassPermissions, Codex full access) never reaches it. A plugin can never approve, so nothing here loosens what the
// user decides.
import { definePlugin } from '@acpira/plugin';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, evaluate, resolveConfig } from './rules';

const USER_FILE = 'config.json';
const PROJECT_FILE = join('.agents', 'approval-rules.json');

// undefined when the file is absent; a parse error is reported and the file treated as absent
function readJson(path: string, warnings: string[]): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') warnings.push(`讀不到 ${path}：${(e as Error).message}`);
    return undefined;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    warnings.push(`${path} 不是有效的 JSON（${(e as Error).message}），改用預設規則`);
    return undefined;
  }
}

// Read on every request, so an edit takes effect at the next one
function load(data: string, cwd: unknown): { config: Config; warnings: string[]; files: string[] } {
  const warnings: string[] = [];
  const userPath = join(data, USER_FILE);
  const user = readJson(userPath, warnings);
  const files = [userPath];
  let project: unknown;
  if (typeof cwd === 'string' && cwd) {
    const projectPath = join(cwd, PROJECT_FILE);
    files.push(projectPath);
    project = readJson(projectPath, warnings);
  }
  const resolved = resolveConfig(user, project);
  return { config: resolved.config, warnings: [...warnings, ...resolved.warnings], files };
}

const warned = new Set<string>();

export default definePlugin({
  activate(ctx) {
    ctx.log(`approval-rules ${ctx.plugin.version} ready; user settings: ${join(ctx.plugin.data, USER_FILE)}`);
  },
  hooks: {
    permission: (payload: Record<string, unknown>, ctx) => {
      try {
        const { config, warnings } = load(ctx.plugin.data, payload.cwd);
        for (const w of warnings) {
          if (warned.has(w)) continue;
          warned.add(w);
          ctx.log(`config: ${w}`);
          void ctx.ui.toast(`approval-rules：${w}`, 'warn').catch(() => {});
        }
        const verdict = evaluate(payload, config);
        if (verdict.decision === 'pass') return null;
        ctx.log(`${verdict.decision} (autoApprove=${String(payload.autoApprove)}): ${verdict.reason}`);
        if (verdict.decision === 'deny') return { decision: 'deny', reason: `approval-rules 已拒絕：${verdict.reason}` };
        if (config.toast) void ctx.ui.toast(`approval-rules 需要你確認：${verdict.reason}`, 'warn').catch(() => {});
        return { decision: 'ask' };
      } catch (e) {
        // A fault here must not let the request through unseen: insist on the card
        ctx.log(`error, asking for the card: ${(e as Error)?.stack ?? String(e)}`);
        return { decision: 'ask' };
      }
    },
  },
  methods: {
    // The rules in effect for a folder (the plugin page, tests): which are on, their action, and what the files said
    status: (params: unknown, ctx) => {
      const cwd = typeof params === 'object' && params !== null ? (params as { cwd?: unknown }).cwd : undefined;
      const { config, warnings, files } = load(ctx.plugin.data, cwd);
      return {
        version: ctx.plugin.version,
        files,
        warnings,
        rules: config.rules,
        custom: config.custom.map(r => ({ id: r.id, description: r.description, action: r.action })),
        configFiles: config.configFiles,
        allowedRemotes: config.allowedRemotes,
        allowedRepos: config.allowedRepos,
      };
    },
    // Judge a payload without a request (manual checks): `{ toolCall, row, cwd }`
    check: (params: unknown, ctx) => {
      const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
      return evaluate(p, load(ctx.plugin.data, p.cwd).config);
    },
  },
});
