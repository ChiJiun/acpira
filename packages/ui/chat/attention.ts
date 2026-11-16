import type { SessionCategories, SessionSummary } from '@acpira/shared/transcript';
import { projectOf as projectOfMeta, projectSessions } from './sessionTree';

// What the title row's inbox (chat/AttentionInbox.tsx) and the session switcher (chat/SessionSwitcher.tsx) make of the
// session states the engine reports. Pure, so the sorting and the matching are tested on their own (test/attention.test.ts)

// The inbox's three sections: waiting on the user (a permission card or a question), something to look at (a finished
// turn nobody saw, a failed one), and work still running. A session sits in one section at most: one that runs in the
// background with an unread reply is something to look at (its row says it still runs), and goes back to running once
// it is the one on screen
export type InboxSection = 'reply' | 'review' | 'running';

export interface Inbox {
  reply: SessionSummary[];
  review: SessionSummary[];
  running: SessionSummary[];
}

// The sessions the desktop session column lists, whatever its view filter: a folder the app took off its list, or a host
// folder it never added, shows its sessions only in a search there (sessionTree.ts projectSessions), so the inbox and the
// switcher leave them out as well, as `nextAttention` does (sessionNav.ts orderedSessions)
export function listedSessions(sessions: readonly SessionSummary[], categories?: SessionCategories): SessionSummary[] {
  const meta = categories?.projectMeta;
  return projectSessions(sessions as SessionSummary[], {
    registered: categories?.projects ?? [], removed: categories?.removedProjects,
    filtering: false, expand: false, projectOf: cwd => projectOfMeta(meta, cwd),
  });
}

// The section a session belongs in, if any. Archived sessions never show; the session on screen needs no review
export function inboxSection(s: SessionSummary, activeId?: string): InboxSection | undefined {
  if (s.archived) return undefined;
  if (s.state === 'waiting') return 'reply';
  const fresh = s.state === 'unread' || s.state === 'error' || (s.state === 'background' && !!s.unread);
  if (fresh && s.id !== activeId) return 'review';
  if (s.state === 'working' || s.state === 'background') return 'running';
  return undefined;
}

const time = (s: SessionSummary) => {
  const t = Date.parse(s.updatedAt);
  return Number.isNaN(t) ? 0 : t;
};
// Latest activity first; equal times keep their incoming order (Array.prototype.sort is stable)
export const byRecent = (a: SessionSummary, b: SessionSummary) => time(b) - time(a);

// Every project's sessions sorted into the three sections, each latest first
export function buildInbox(sessions: readonly SessionSummary[], activeId?: string): Inbox {
  const inbox: Inbox = { reply: [], review: [], running: [] };
  for (const s of sessions) {
    const section = inboxSection(s, activeId);
    if (section) inbox[section].push(s);
  }
  inbox.reply.sort(byRecent);
  inbox.review.sort(byRecent);
  inbox.running.sort(byRecent);
  return inbox;
}

// The bell's badge: sessions that need the user, running work left out
export const inboxCount = (inbox: Inbox) => inbox.reply.length + inbox.review.length;

// The status line of an inbox row, as a key the component translates
export type InboxStatus = 'permission' | 'question' | 'error' | 'unread' | 'backgroundUnread' | 'working' | 'background' | 'wakeup';
export function inboxStatus(s: SessionSummary): InboxStatus | undefined {
  switch (s.state) {
    case 'waiting': return s.question ? 'question' : 'permission';
    case 'error': return 'error';
    case 'unread': return 'unread';
    case 'working': return 'working';
    case 'background': return s.unread ? 'backgroundUnread' : s.wakeAt ? 'wakeup' : 'background';
    default: return undefined;
  }
}

// Recently used sessions, most recent first: the window records each session it switches to (the engine keeps no such
// order). Capped so the stored list stays small
export const RECENT_MAX = 50;
export function touchRecent(recent: readonly string[], id: string, max = RECENT_MAX): string[] {
  if (recent[0] === id) return recent as string[];
  return [id, ...recent.filter(x => x !== id)].slice(0, max);
}
// A stored value read back defensively: anything but a list of strings is no history
export function readRecent(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
}

export type SwitcherGroup = 'reply' | 'review' | 'recent';
export interface SwitcherEntry {
  session: SessionSummary;
  group: SwitcherGroup;
}

// The switcher's list before anything is typed: sessions waiting on the user first, then those to review, then the rest
// by when this window last showed them, then by latest activity. The session on screen goes last whatever its state:
// the switcher is for going somewhere else
export function switcherOrder(sessions: readonly SessionSummary[], activeId: string | undefined, recent: readonly string[]): SwitcherEntry[] {
  const rank = new Map(recent.map((id, i) => [id, i]));
  const live = sessions.filter(s => !s.archived);
  const byUse = (a: SessionSummary, b: SessionSummary) => {
    const ra = rank.get(a.id), rb = rank.get(b.id);
    if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity);
    return byRecent(a, b);
  };
  const group = (s: SessionSummary): SwitcherGroup => {
    const section = inboxSection(s, activeId);
    return section === 'reply' || section === 'review' ? section : 'recent';
  };
  const order: SwitcherGroup[] = ['reply', 'review', 'recent'];
  const others = live.filter(s => s.id !== activeId);
  const entries = order.flatMap(g => others.filter(s => group(s) === g).sort(g === 'recent' ? byUse : byRecent).map(session => ({ session, group: g })));
  const active = live.find(s => s.id === activeId);
  return active ? [...entries, { session: active, group: 'recent' }] : entries;
}

// A fuzzy match of `query` in `text`, ignoring case: every character of the query in order, not necessarily side by side.
// The score favours runs of consecutive characters, characters at the start of a word and an early first match;
// `at` lists the matched character indices of `text` (for highlighting). Undefined: no match
export interface Fuzzy { score: number; at: number[] }
const WORD_BREAK = /[\s\-_/\\.:,()[\]{}「」『』（）、，。·]/;
// One character's case fold, kept to one character: a few lower to several ('İ' to 'i' and a combining dot), which would
// shift every index after them
const fold = (c: string) => [...c.toLowerCase()][0] ?? c;
export function fuzzyMatch(query: string, text: string): Fuzzy | undefined {
  const q = [...query].map(fold);
  const chars = [...text];
  const lower = chars.map(fold);
  if (!q.length) return { score: 0, at: [] };
  // A plain substring scores best: try it first so "inbox" in "Attention inbox" lands on the word, not on scattered letters
  const joined = lower.join('');
  const needle = q.join('');
  const direct = joined.indexOf(needle);
  if (direct >= 0) {
    // Map the string index back to a character index (astral characters take two code units)
    let ci = 0, unit = 0;
    while (unit < direct) unit += lower[ci++]!.length;
    const at = Array.from({ length: q.length }, (_, i) => ci + i);
    const start = ci === 0 || WORD_BREAK.test(chars[ci - 1]!);
    return { score: 100 + q.length * 10 + (start ? 30 : 0) - Math.min(ci, 30), at };
  }
  const at: number[] = [];
  let score = 0;
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) continue;
    const prev = at[at.length - 1];
    score += 1;
    if (prev !== undefined && prev === i - 1) score += 5;
    if (i === 0 || WORD_BREAK.test(chars[i - 1]!)) score += 8;
    at.push(i);
    qi++;
  }
  if (qi < q.length) return undefined;
  return { score: score - Math.min(at[0]!, 20) / 2, at };
}

export interface SwitcherHit {
  session: SessionSummary;
  score: number;
  // Matched character indices in the title and in the project's name
  title: number[];
  project: number[];
}

// The sessions matching what was typed, best first: each whitespace-separated term must match the title or the project's
// name (fuzzily); a title match counts more than a project match. Ties keep `ordered`'s order
export function matchSessions(ordered: readonly SessionSummary[], query: string, projectOf: (s: SessionSummary) => string): SwitcherHit[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return ordered.map(session => ({ session, score: 0, title: [], project: [] }));
  const hits: SwitcherHit[] = [];
  for (const session of ordered) {
    const project = projectOf(session);
    let score = 0;
    const title = new Set<number>();
    const proj = new Set<number>();
    let ok = true;
    for (const term of terms) {
      const inTitle = fuzzyMatch(term, session.title);
      const inProject = fuzzyMatch(term, project);
      const t = inTitle ? inTitle.score * 1.5 : -Infinity;
      const p = inProject ? inProject.score : -Infinity;
      if (t === -Infinity && p === -Infinity) { ok = false; break; }
      if (t >= p) { score += t; inTitle!.at.forEach(i => title.add(i)); }
      else { score += p; inProject!.at.forEach(i => proj.add(i)); }
    }
    if (ok) hits.push({ session, score, title: [...title].sort((a, b) => a - b), project: [...proj].sort((a, b) => a - b) });
  }
  return hits.map((h, i) => ({ h, i })).sort((a, b) => b.h.score - a.h.score || a.i - b.i).map(x => x.h);
}

// Splits `text` into runs for highlighting: odd entries are matched characters
export function highlightRuns(text: string, at: readonly number[]): string[] {
  if (!at.length) return [text];
  const marked = new Set(at);
  const runs: string[] = [];
  let cur = '';
  let on = false;
  for (const [i, c] of [...text].entries()) {
    const m = marked.has(i);
    if (m !== on) { runs.push(cur); cur = ''; on = m; }
    cur += c;
  }
  runs.push(cur);
  return runs;
}
