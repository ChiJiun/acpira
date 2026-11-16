import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@acpira/shared/transcript';
import { buildInbox, fuzzyMatch, highlightRuns, inboxCount, inboxSection, inboxStatus, listedSessions, matchSessions, readRecent, seedSearch, switcherOrder, takeSeed, touchRecent } from '../chat/attention';

const at = (m: number) => new Date(Date.UTC(2026, 10, 17, 12, 0) - m * 60_000).toISOString();
const s = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, title: id, agent: 'claude', cwd: '/work/a', updatedAt: at(10), ...extra });
const ids = (list: { id: string }[]) => list.map(x => x.id);

describe('inbox sections', () => {
  it('sorts waiting, finished and running sessions into their sections', () => {
    expect(inboxSection(s('a', { state: 'waiting' }))).toBe('reply');
    expect(inboxSection(s('a', { state: 'waiting', question: true }))).toBe('reply');
    expect(inboxSection(s('a', { state: 'unread' }))).toBe('review');
    expect(inboxSection(s('a', { state: 'error' }))).toBe('review');
    expect(inboxSection(s('a', { state: 'background', unread: true }))).toBe('review');
    expect(inboxSection(s('a', { state: 'working' }))).toBe('running');
    expect(inboxSection(s('a', { state: 'background' }))).toBe('running');
    expect(inboxSection(s('a', { state: 'background', wakeAt: 1 }))).toBe('running');
    expect(inboxSection(s('a'))).toBeUndefined();
  });
  it('leaves archived sessions out, and the one on screen out of review only', () => {
    expect(inboxSection(s('a', { state: 'waiting', archived: true }))).toBeUndefined();
    expect(inboxSection(s('a', { state: 'working', archived: true }))).toBeUndefined();
    expect(inboxSection(s('a', { state: 'unread' }), 'a')).toBeUndefined();
    expect(inboxSection(s('a', { state: 'error' }), 'a')).toBeUndefined();
    // Still waiting on the user, still running: shown even while on screen
    expect(inboxSection(s('a', { state: 'waiting' }), 'a')).toBe('reply');
    expect(inboxSection(s('a', { state: 'background', unread: true }), 'a')).toBe('running');
  });
  it('builds the sections latest first across every project, and counts what needs the user', () => {
    const inbox = buildInbox([
      s('w-old', { state: 'waiting', updatedAt: at(30) }),
      s('idle'),
      s('w-new', { state: 'waiting', cwd: '/work/b', updatedAt: at(1) }),
      s('u', { state: 'unread', updatedAt: at(5) }),
      s('e', { state: 'error', cwd: '/work/c', updatedAt: at(2) }),
      s('bg', { state: 'background', updatedAt: at(3) }),
      s('run', { state: 'working', updatedAt: at(4) }),
      s('gone', { state: 'unread', archived: true }),
    ], 'idle');
    expect(ids(inbox.reply)).toEqual(['w-new', 'w-old']);
    expect(ids(inbox.review)).toEqual(['e', 'u']);
    expect(ids(inbox.running)).toEqual(['bg', 'run']);
    expect(inboxCount(inbox)).toBe(4);
    expect(inboxCount(buildInbox([s('x', { state: 'working' })]))).toBe(0);
  });
  it('leaves out the sessions of folders the list keeps off, as the session column does', () => {
    const categories = {
      categories: [], collapsedProjects: [],
      projects: ['/work/a', 'ssh://box/srv'],
      removedProjects: ['/work/gone'],
      projectMeta: { '/work/a': { extra: ['/work/a-docs'] } },
    };
    const listed = listedSessions([
      s('here', { state: 'unread' }),
      s('extra', { state: 'error', cwd: '/work/a-docs' }),
      s('removed', { state: 'unread', cwd: '/work/gone' }),
      s('removed-wait', { state: 'waiting', cwd: '/work/gone' }),
      s('host', { state: 'unread', cwd: 'ssh://box/srv' }),
      s('stray-host', { state: 'unread', cwd: 'ssh://box/other' }),
      s('unlisted-local', { state: 'unread', cwd: '/work/new' }),
    ], categories);
    expect(ids(listed)).toEqual(['here', 'extra', 'host', 'unlisted-local']);
    const inbox = buildInbox(listed);
    expect(ids(inbox.review)).not.toContain('removed');
    expect(inbox.reply).toEqual([]);
    expect(inboxCount(inbox)).toBe(4);
    // Before a project shell first connects nothing is kept off
    expect(listedSessions([s('a', { cwd: '/work/gone' })])).toHaveLength(1);
  });
  it('names a waiting session by what it waits for', () => {
    expect(inboxStatus(s('a', { state: 'waiting' }))).toBe('permission');
    expect(inboxStatus(s('a', { state: 'waiting', question: true }))).toBe('question');
    expect(inboxStatus(s('a', { state: 'error' }))).toBe('error');
    expect(inboxStatus(s('a', { state: 'background', unread: true }))).toBe('backgroundUnread');
    expect(inboxStatus(s('a', { state: 'background', wakeAt: 5 }))).toBe('wakeup');
    expect(inboxStatus(s('a', { state: 'background' }))).toBe('background');
    expect(inboxStatus(s('a'))).toBeUndefined();
  });
});

describe('recent sessions', () => {
  it('moves the session switched to to the front, once, within the cap', () => {
    expect(touchRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(touchRecent(['a', 'b'], 'x')).toEqual(['x', 'a', 'b']);
    const same = ['a', 'b'];
    expect(touchRecent(same, 'a')).toBe(same);
    expect(touchRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
  it('reads a stored list defensively', () => {
    expect(readRecent(undefined)).toEqual([]);
    expect(readRecent('a')).toEqual([]);
    expect(readRecent(['a', 1, 'b'])).toEqual(['a', 'b']);
  });
});

describe('switcher order', () => {
  const sessions = [
    s('old', { updatedAt: at(50) }),
    s('new', { updatedAt: at(1) }),
    s('mid', { updatedAt: at(20) }),
    s('wait', { state: 'waiting', updatedAt: at(40) }),
    s('read', { state: 'unread', updatedAt: at(30) }),
    s('fail', { state: 'error', updatedAt: at(35) }),
    s('here', { updatedAt: at(0) }),
    s('arch', { archived: true, updatedAt: at(0) }),
  ];
  it('puts waiting, then review, then recently used, then latest activity, the current one last', () => {
    const list = switcherOrder(sessions, 'here', ['mid', 'here', 'old']);
    expect(list.map(e => e.session.id)).toEqual(['wait', 'read', 'fail', 'mid', 'old', 'new', 'here']);
    expect(list.map(e => e.group)).toEqual(['reply', 'review', 'review', 'recent', 'recent', 'recent', 'recent']);
  });
  it('falls back to latest activity with no history', () => {
    expect(switcherOrder(sessions, undefined, []).map(e => e.session.id)).toEqual(['wait', 'read', 'fail', 'here', 'new', 'mid', 'old']);
  });
  it('keeps a finished session on screen out of review', () => {
    const list = switcherOrder([s('read', { state: 'unread' }), s('b')], 'read', []);
    expect(list.map(e => [e.session.id, e.group])).toEqual([['b', 'recent'], ['read', 'recent']]);
  });
});

describe('fuzzy matching', () => {
  it('matches characters in order, ignoring case', () => {
    expect(fuzzyMatch('ATT', 'attention inbox')?.at).toEqual([0, 1, 2]);
    expect(fuzzyMatch('atin', 'attention inbox')).toBeDefined();
    expect(fuzzyMatch('xyz', 'attention inbox')).toBeUndefined();
    expect(fuzzyMatch('ba', 'ab')).toBeUndefined();
    expect(fuzzyMatch('', 'x')).toEqual({ score: 0, at: [] });
  });
  it('prefers a substring, a word start and an early match', () => {
    const word = fuzzyMatch('inbox', 'attention inbox')!;
    expect(word.at).toEqual([10, 11, 12, 13, 14]);
    expect(fuzzyMatch('box', 'boxes')!.score).toBeGreaterThan(fuzzyMatch('box', 'inbox')!.score);
    expect(fuzzyMatch('ab', 'a-b')!.score).toBeLessThan(fuzzyMatch('ab', 'ab')!.score);
  });
  it('handles CJK and astral characters by character', () => {
    expect(fuzzyMatch('切換', '工作階段快速切換器')?.at).toEqual([6, 7]);
    expect(fuzzyMatch('b', '😀b')?.at).toEqual([1]);
  });
  it('keeps one index per character when a capital lowers to several', () => {
    expect(fuzzyMatch('istan', 'İstanbul')?.at).toEqual([0, 1, 2, 3, 4]);
    expect(fuzzyMatch('bul', 'İstanbul')?.at).toEqual([5, 6, 7]);
    expect(fuzzyMatch('İst', 'İstanbul')?.at).toEqual([0, 1, 2]);
    expect(fuzzyMatch('sb', 'İstanbul')?.at).toEqual([1, 5]);
  });
  it('matches an accent typed composed or decomposed, either way round', () => {
    const nfd = 'école'.normalize('NFD');
    expect(fuzzyMatch('éc', nfd)?.at).toEqual([0, 1]);
    expect(fuzzyMatch('éc'.normalize('NFD'), 'école')?.at).toEqual([0, 1]);
    expect(highlightRuns(nfd, [0])).toEqual(['', 'é'.normalize('NFD'), 'cole']);
    // Not folded to the bare letter: an accent the reader typed is meant
    expect(fuzzyMatch('ecole', 'école')).toBeUndefined();
  });
  it('keeps an emoji joined with ZWJ whole', () => {
    const dev = '\u{1F469}‍\u{1F4BB} dev';
    expect(fuzzyMatch('\u{1F469}', dev)).toBeUndefined();
    expect(fuzzyMatch('dev', dev)?.at).toEqual([2, 3, 4]);
    expect(highlightRuns(dev, [0])).toEqual(['', '\u{1F469}‍\u{1F4BB}', ' dev']);
  });
  it('puts a substring at the start of a word before an earlier one inside a word', () => {
    expect(fuzzyMatch('box', 'inbox boxes')?.at).toEqual([6, 7, 8]);
    expect(fuzzyMatch('box', 'inbox')?.at).toEqual([2, 3, 4]);
  });
  it('splits text into highlight runs', () => {
    expect(highlightRuns('inbox', [0, 1])).toEqual(['', 'in', 'box']);
    expect(highlightRuns('inbox', [2])).toEqual(['in', 'b', 'ox']);
    expect(highlightRuns('inbox', [])).toEqual(['inbox']);
  });
});

describe('matching sessions', () => {
  const project = (x: SessionSummary) => x.cwd.split('/').pop()!;
  const list = [
    s('1', { title: 'Fix login bug', cwd: '/work/web' }),
    s('2', { title: 'Write release notes', cwd: '/work/acpira' }),
    s('3', { title: 'Refactor inbox', cwd: '/work/acpira' }),
  ];
  it('matches the title or the project, every term somewhere', () => {
    expect(ids(matchSessions(list, 'acpira', project).map(h => h.session))).toEqual(['2', '3']);
    expect(ids(matchSessions(list, 'acpira inbox', project).map(h => h.session))).toEqual(['3']);
    expect(ids(matchSessions(list, 'LOGIN', project).map(h => h.session))).toEqual(['1']);
    expect(matchSessions(list, 'zzz', project)).toEqual([]);
  });
  it('ranks a title match over a project match and keeps the order on ties', () => {
    const hits = matchSessions([s('p', { title: 'Other', cwd: '/work/notes' }), s('t', { title: 'notes', cwd: '/work/x' })], 'notes', project);
    expect(ids(hits.map(h => h.session))).toEqual(['t', 'p']);
    expect(hits[0]!.title).toEqual([0, 1, 2, 3, 4]);
    expect(hits[1]!.project).toEqual([0, 1, 2, 3, 4]);
    expect(ids(matchSessions(list, '', project).map(h => h.session))).toEqual(['1', '2', '3']);
  });
});

describe('search seed', () => {
  it('puts a query with a new seq each time, and drops it once the column took that seq', () => {
    const a = seedSearch(undefined, 'readme');
    const b = seedSearch(a, 'readme');
    expect(a).toEqual({ query: 'readme', seq: 1 });
    expect(b.seq).toBe(2);
    expect(takeSeed(b, 2)).toBeUndefined();
    // A seed put after the one taken stays for the column to take
    expect(takeSeed(b, 1)).toBe(b);
    expect(takeSeed(undefined, 1)).toBeUndefined();
  });
  // The shell owns the seed and the column takes it: without the handler wired, the seed would stay and a session column
  // mounted again later (the list moved back from hidden) would put the old query once more. No DOM in this suite, so
  // the wiring is checked in the source
  it('is handed to the session column together with the handler that drops it', () => {
    const shell = readFileSync(join(import.meta.dirname, '../chat/Shell.tsx'), 'utf8');
    const passed = shell.match(/\bsearchSeed=\{/g)?.length ?? 0;
    expect(passed).toBeGreaterThan(0);
    expect(shell.match(/\bonSeedTaken=\{seedTaken\}/g)?.length ?? 0).toBe(passed);
    expect(shell).toMatch(/const seedTaken = useCallback\(\(seq: number\) => setSearchSeed\(cur => takeSeed\(cur, seq\)\), \[\]\)/);
    const list = readFileSync(join(import.meta.dirname, '../chat/SessionList.tsx'), 'utf8');
    expect(list).toMatch(/onSeedTaken\?\.\(searchSeed\.seq\)/);
  });
});
