import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pin, Search, TextSearch } from 'lucide-react';
import type { AgentInfo, SessionCategories, SessionSummary } from '@acpira/shared/transcript';
import { t, useLocale } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { cn } from '../ui/cn';
import { optionClass } from '../ui/DropdownMenu';
import { imeKey } from '../ui/ime';
import { highlightRuns, matchSessions, switcherOrder, type SwitcherGroup } from './attention';
import { projectLabel } from './AttentionInbox';
import { AgentMark } from './AgentMark';
import { StateMark } from './SessionList';

// ⌘K / Ctrl+K: a centred switcher over every session in reach, built like the file opener (panel/QuickOpen.tsx). With
// nothing typed, sessions waiting on the user lead, then those to review, then the rest by recent use; typing matches
// titles and project names fuzzily. Its last row hands the query to the session column's message search, which ⌘K used
// to focus

// Rows rendered at most: a typed query narrows the rest, and the last row still hands it to the message search
const MAX_ROWS = 100;

const GROUP_LABEL: Record<SwitcherGroup, 'session.inbox.reply' | 'session.inbox.review' | 'session.switcher.recent'> = {
  reply: 'session.inbox.reply',
  review: 'session.inbox.review',
  recent: 'session.switcher.recent',
};

function Marked({ text, at }: { text: string; at: number[] }) {
  return <>{highlightRuns(text, at).map((run, i) => i % 2 ? <mark key={i} className="bg-transparent font-medium text-fg-strong">{run}</mark> : <Fragment key={i}>{run}</Fragment>)}</>;
}

export function SessionSwitcher({ sessions, activeId, recent, agents, categories, chats, onSelect, onSearchContent, onClose }: {
  // The sessions in reach (the window's scope); archived ones are left out here
  sessions: SessionSummary[];
  activeId?: string;
  // Session ids this window showed, most recent first
  recent: readonly string[];
  agents: AgentInfo[];
  categories?: SessionCategories;
  chats?: string;
  onSelect: (id: string) => void;
  // Present where the session column can search messages: the query goes there
  onSearchContent?: (query: string) => void;
  onClose: () => void;
}) {
  useLocale();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);
  // The order is taken once, when the switcher opens: a push reordering it under the reader's keys would move the row aimed at
  const [base] = useState(() => switcherOrder(sessions, activeId, recent));
  const project = useMemo(() => {
    const names = new Map<string, string>();
    return (s: SessionSummary) => {
      let name = names.get(s.cwd);
      if (name === undefined) names.set(s.cwd, name = projectLabel(s, categories, chats));
      return name;
    };
  }, [categories, chats]);
  // Rows read their state from the latest push, so a mark stays live while the switcher is open
  // (one deleted or archived since the switcher opened drops out)
  const latest = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  // Matching stays in step with the field (Enter picks what is shown); only the rendered rows are capped, the scoring
  // itself is cheap even over a long session list
  const typed = query.trim();
  const hits = useMemo(() => {
    const ordered = base.flatMap(e => { const s = latest.get(e.session.id); return s && !s.archived ? [s] : []; });
    return matchSessions(ordered, typed, project).slice(0, MAX_ROWS);
  }, [base, latest, typed, project]);
  const groupOf = useMemo(() => new Map(base.map(e => [e.session.id, e.group])), [base]);
  const searchRow = !!onSearchContent && !!typed;
  const total = hits.length + (searchRow ? 1 : 0);
  const at = Math.min(active, Math.max(0, total - 1));

  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => { setActive(0); }, [typed]);
  useLayoutEffect(() => {
    if (pointer.current) return;
    const box = list.current;
    const row = box?.querySelector<HTMLElement>('[data-highlighted]');
    if (!box || !row) return;
    const br = box.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top < br.top) box.scrollTop += rr.top - br.top;
    else if (rr.bottom > br.bottom) box.scrollTop += rr.bottom - br.bottom;
  }, [at, hits]);

  const pick = (i: number) => {
    if (i < hits.length) { onClose(); onSelect(hits[i]!.session.id); return; }
    if (searchRow) { onClose(); onSearchContent!(typed); }
  };
  const move = (delta: number) => { if (total) setActive((at + delta + total) % total); };
  const nameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id;

  return (
    <Dialog.Root open disablePointerDismissal onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        {/* The field takes the focus once the dialog has settled: a focus set on mount alone lost to the popup's own */}
        <Dialog.Popup
          initialFocus={() => input.current}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
          className="acp-settings absolute inset-0 z-30 flex items-center justify-center bg-scrim p-pad"
        >
          <div
            data-session-switcher
            data-palette="menu"
            className="popup-surface flex w-(--dialog-w) max-w-full flex-col overflow-hidden rounded-lg border p-1 shadow-pop"
          >
            <Dialog.Title className="sr-only">{t('session.switcher.label')}</Dialog.Title>
            <label className="mb-1 flex h-ctl shrink-0 items-center gap-2 border-b border-line px-2 text-fg-3">
              <Search className="size-icon shrink-0" strokeWidth={1.5} aria-hidden />
              <input
                ref={input}
                autoFocus
                value={query}
                spellCheck={false}
                role="combobox"
                aria-expanded
                aria-controls="session-switcher-list"
                aria-activedescendant={total ? `session-switcher-${at}` : undefined}
                placeholder={t('session.switcher.placeholder')}
                aria-label={t('session.switcher.label')}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (imeKey(e.nativeEvent)) return;
                  pointer.current = false;
                  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
                  else if (e.key === 'Home' && !query) { e.preventDefault(); setActive(0); }
                  else if (e.key === 'End' && !query) { e.preventDefault(); setActive(Math.max(0, total - 1)); }
                  else if (e.key === 'Enter') { e.preventDefault(); pick(at); }
                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
                }}
                className="min-w-0 flex-1 bg-transparent text-2 text-fg-1 outline-none placeholder:text-fg-3"
              />
            </label>
            {/* A fixed --pop height, so typing never resizes the dialog */}
            <div
              ref={list}
              id="session-switcher-list"
              role="listbox"
              aria-label={t('session.switcher.label')}
              onPointerMove={() => { pointer.current = true; }}
              className="scroll-thin scroll-stable flex h-pop flex-col overflow-y-auto"
            >
              {hits.map((h, i) => {
                const s = h.session;
                const group = groupOf.get(s.id) ?? 'recent';
                // Group labels only while nothing is typed; a match list is one ranking
                const label = !typed && (i === 0 || (groupOf.get(hits[i - 1]!.session.id) ?? 'recent') !== group);
                const current = s.id === activeId;
                const highlighted = i === at;
                return (
                  <Fragment key={s.id}>
                    {label && <div role="presentation" className={cn('shrink-0 truncate pr-2 pl-2 pt-1.5 pb-0.5 text-3', group === 'reply' ? 'text-warn' : 'text-fg-3')}>{t(GROUP_LABEL[group])}</div>}
                    <div
                      id={`session-switcher-${i}`}
                      role="option"
                      aria-selected={highlighted}
                      data-highlighted={highlighted ? '' : undefined}
                      data-switcher-item={s.id}
                      onPointerMove={() => { if (pointer.current && at !== i) setActive(i); }}
                      onClick={() => pick(i)}
                      className={cn(optionClass, 'cursor-pointer gap-gap')}
                    >
                      <span className="-mr-gap-half flex size-lead shrink-0 scale-90 items-center justify-center text-fg-3" title={nameOf(s.agent)}>
                        <AgentMark id={s.agent} name={nameOf(s.agent)} />
                      </span>
                      <span className="min-w-0 flex-1 truncate"><Marked text={s.title} at={h.title} /></span>
                      <span className="flex shrink-0 items-center gap-2 text-3 text-fg-3">
                        {current && <span className="shrink-0">{t('session.project.current')}</span>}
                        <span className="max-w-project truncate" title={s.cwd}><Marked text={project(s)} at={h.project} /></span>
                        {s.pinned && <Pin className="size-3 shrink-0" strokeWidth={1.5} aria-label={t('session.group.pinned')} role="img" />}
                        {s.state ? <StateMark state={s.state} unread={s.unread} wakeAt={s.wakeAt} /> : <span className="size-3 shrink-0" />}
                      </span>
                    </div>
                  </Fragment>
                );
              })}
              {typed && hits.length === 0 && (
                <div className="flex min-h-row shrink-0 items-center px-2 text-3 text-fg-3">{t('session.noMatch')}</div>
              )}
              {searchRow && (
                <div
                  id={`session-switcher-${hits.length}`}
                  role="option"
                  aria-selected={at === hits.length}
                  data-highlighted={at === hits.length ? '' : undefined}
                  data-switcher-search
                  onPointerMove={() => { if (pointer.current && at !== hits.length) setActive(hits.length); }}
                  onClick={() => pick(hits.length)}
                  className={cn(optionClass, 'cursor-pointer gap-gap', hits.length > 0 && 'mt-1')}
                >
                  <span className="-mr-gap-half flex size-lead shrink-0 items-center justify-center text-fg-3"><TextSearch className="size-icon" strokeWidth={1.5} /></span>
                  <span className="min-w-0 flex-1 truncate text-fg-2">{t('session.switcher.searchContent', { query: typed })}</span>
                </div>
              )}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
