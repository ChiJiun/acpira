// What `/worktree …` asks for, and how results read to the user. Pure functions, free of the plugin SDK, so the
// tests cover them directly.
import type { WorktreeStatus } from './git';

export type Parsed =
  | { kind: 'create'; branch: string; start: string | null }
  | { kind: 'list' }
  | { kind: 'remove'; target: string | null }
  | { kind: 'config'; key: string | null; value: string | null }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

// Split like a shell would for plain words: whitespace separates, "double" or 'single' quotes keep spaces in one word
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export const USAGE = [
  '/worktree <分支> [起點]：建立新分支與 worktree，並在裡面開新 session',
  '/worktree new <分支> [起點]：同上（分支名稱剛好是 list、remove 等字時用）',
  '/worktree list：列出 worktree、分支、對應 session、未 commit 變更與未 push 的 commit',
  '/worktree remove [分支或路徑]：確認後移除乾淨的 worktree 資料夾（分支保留）',
  '/worktree config [root <資料夾>|root default]：查看或設定 worktree 放置位置',
].join('\n');

export function parseCommand(args: string): Parsed {
  const words = splitArgs(args.trim());
  const [head, ...rest] = words;
  if (!head || head === 'help' || head === '-h' || head === '--help') return { kind: 'help' };
  switch (head) {
    case 'list':
    case 'ls':
      return rest.length ? { kind: 'error', message: '/worktree list 不需要參數。' } : { kind: 'list' };
    case 'remove':
    case 'rm':
      if (rest.length > 1) return { kind: 'error', message: '/worktree remove 一次只接受一個分支名稱或路徑（含空白的路徑請加引號）。' };
      return { kind: 'remove', target: rest[0] ?? null };
    case 'config':
      if (rest.length === 0) return { kind: 'config', key: null, value: null };
      if (rest[0] !== 'root') return { kind: 'error', message: `不認得的設定「${rest[0]}」；目前只有 root。` };
      if (rest.length > 2) return { kind: 'error', message: '含空白的資料夾路徑請加引號，例如 /worktree config root "D:\\My Work\\{repo}-wt"。' };
      return { kind: 'config', key: 'root', value: rest[1] ?? null };
    case 'new':
    case 'add':
      return create(rest);
    default:
      return create(words);
  }
}

function create(words: string[]): Parsed {
  const [branch, start, ...extra] = words;
  if (!branch) return { kind: 'error', message: '請給新分支名稱，例如 /worktree feature/login。' };
  if (extra.length) return { kind: 'error', message: `參數太多：${extra.join(' ')}。用法：/worktree <分支> [起點]。` };
  return { kind: 'create', branch, start: start ?? null };
}

export interface SessionRef {
  id: string;
  title: string;
}

// One line of facts about a worktree, for a card option's description
export function describe(w: WorktreeStatus, sessions: SessionRef[]): string {
  const parts: string[] = [w.path];
  if (w.main) parts.push('主工作目錄');
  if (!w.exists) parts.push('資料夾不存在（可 git worktree prune）');
  else if (w.dirty === null) parts.push('無法讀取狀態');
  else parts.push(w.dirty > 0 ? `${w.dirty} 個未 commit 變更` : '沒有未 commit 變更');
  if (w.upstream) {
    parts.push(w.unpushed ? `${w.unpushed} 個 commit 未 push 到 ${w.upstream}` : `已與 ${w.upstream} 同步`);
  } else if (w.branch && w.unpushed !== null) {
    parts.push(w.unpushed ? `沒有 upstream，${w.unpushed} 個 commit 不在任何遠端` : '沒有 upstream，commit 都已在遠端');
  }
  if (w.locked) parts.push('已鎖定');
  parts.push(sessions.length ? `session：${sessions.map(s => s.title || s.id).join('、')}` : 'session：無');
  return parts.join(' · ');
}

export function label(w: WorktreeStatus): string {
  const name = w.branch ?? (w.bare ? '(bare)' : `(detached ${w.head?.slice(0, 7) ?? ''})`);
  const flags = [w.dirty ? '有變更' : '', w.unpushed ? `${w.unpushed} 未 push` : ''].filter(Boolean);
  return flags.length ? `${name}（${flags.join('，')}）` : name;
}

// A plain-text table of the listing, for a method's answer or a log
export function table(list: { w: WorktreeStatus; sessions: SessionRef[] }[]): string {
  return list.map(({ w, sessions }) => `- ${label(w)}\n  ${describe(w, sessions)}`).join('\n');
}
