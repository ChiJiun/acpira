import { memo, useMemo } from 'react';
import { Bell, BellRing, Inbox as InboxIcon } from 'lucide-react';
import type { SessionCategories, SessionSummary } from '@acpira/shared/transcript';
import { dateFormat, getLocale, t, useLocale } from '../i18n';
import { shortcutHint } from '../keybindings';
import { IconButton } from '../ui/Button';
import { cn } from '../ui/cn';
import { DropdownMenu } from '../ui/DropdownMenu';
import { buildInbox, inboxCount, inboxStatus, type Inbox, type InboxSection, type InboxStatus } from './attention';
import { StateMark, projectName } from './SessionList';
import { isChatFolder, projectOf } from './sessionTree';

// The title row's inbox (desktop): a bell whose badge counts the sessions that need the user, every project's, and a menu
// listing them in three sections (waiting on the user, to review, running in the background). The marks and their
// colours are the session list's (StateMark): amber waiting, red error, the bright unread dot, the running ring

// The name a session's project goes by: the project's own name, else its primary folder's; a chat's is the Chats section
export function projectLabel(s: SessionSummary, categories?: SessionCategories, chats?: string): string {
  if (isChatFolder(chats, s.cwd)) return t('session.group.chats');
  const meta = categories?.projectMeta;
  const key = projectOf(meta, s.cwd);
  return meta?.[key]?.name || projectName(key);
}

const STATUS_KEY = {
  permission: 'session.inbox.permission',
  question: 'session.inbox.question',
  error: 'session.inbox.error',
  unread: 'session.inbox.unread',
  backgroundUnread: 'session.inbox.backgroundUnread',
  working: 'session.inbox.working',
  background: 'session.inbox.background',
  wakeup: 'session.inbox.wakeup',
} as const satisfies Record<InboxStatus, string>;

// Waiting reads in the waiting dot's amber, a failure in the error dot's red; the rest stays quiet
const STATUS_TONE: Partial<Record<InboxStatus, string>> = { permission: 'text-warn', question: 'text-warn', error: 'text-danger' };

function statusText(s: SessionSummary): string {
  const status = inboxStatus(s);
  if (!status) return '';
  if (status === 'wakeup') return t(STATUS_KEY.wakeup, { time: dateFormat(getLocale(), { hour: 'numeric', minute: '2-digit' }).format(s.wakeAt!) });
  return t(STATUS_KEY[status]);
}

// "3 min ago", "yesterday": how long since the session last moved
const relative = new Map<string, Intl.RelativeTimeFormat>();
export function ago(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const locale = getLocale();
  let rtf = relative.get(locale);
  if (!rtf) relative.set(locale, rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }));
  const sec = Math.round((then - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(sec / 86_400), 'day');
  return dateFormat(locale, { month: 'numeric', day: 'numeric' }).format(then);
}

const SECTIONS: { key: InboxSection; label: 'session.inbox.reply' | 'session.inbox.review' | 'session.inbox.running' }[] = [
  { key: 'reply', label: 'session.inbox.reply' },
  { key: 'review', label: 'session.inbox.review' },
  { key: 'running', label: 'session.inbox.running' },
];

// Memoised: the shell renders on every streamed chunk, while the inbox only changes with the session list
export const AttentionInbox = memo(function AttentionInbox({ sessions, activeId, categories, chats, onSelect }: {
  sessions: SessionSummary[];
  // The session on screen: it needs no review
  activeId?: string;
  categories?: SessionCategories;
  chats?: string;
  onSelect: (id: string) => void;
}) {
  useLocale();
  const inbox = useMemo(() => buildInbox(sessions, activeId), [sessions, activeId]);
  const count = inboxCount(inbox);
  const urgent = inbox.reply.length > 0;
  const label = count ? t('session.inbox.labelCount', { n: count }) : t('session.inbox.label');
  const Glyph = urgent ? BellRing : Bell;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger render={
        <IconButton data-inbox={urgent ? 'urgent' : count ? 'review' : ''} title={label} aria-label={label}
          className={cn('relative data-[popup-open]:bg-active data-[popup-open]:text-fg-1', urgent && 'text-warn hover:text-warn data-[popup-open]:text-warn')}>
          <Glyph strokeWidth={1.5} />
          {count > 0 && <span aria-hidden className="inbox-badge">{count > 99 ? '99+' : count}</span>}
        </IconButton>
      } />
      <DropdownMenu.Portal><DropdownMenu.Positioner side="bottom" align="start" width="xl"><DropdownMenu.Popup data-inbox-menu aria-label={t('session.inbox.label')}>
        <InboxBody inbox={inbox} categories={categories} chats={chats} onSelect={onSelect} />
      </DropdownMenu.Popup></DropdownMenu.Positioner></DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
});

function InboxBody({ inbox, categories, chats, onSelect }: { inbox: Inbox; categories?: SessionCategories; chats?: string; onSelect: (id: string) => void }) {
  const shown = SECTIONS.filter(x => inbox[x.key].length > 0);
  if (!shown.length) return (
    <div className="flex flex-col items-center gap-1 px-pad py-pad text-center">
      <InboxIcon className="size-icon-ctl text-fg-3" strokeWidth={1.5} aria-hidden />
      <div className="text-2 text-fg-1">{t('session.inbox.empty')}</div>
      <div className="text-3 text-fg-3">{t('session.inbox.emptyHint')}</div>
    </div>
  );
  const now = Date.now();
  const next = shortcutHint('nextAttention');
  return <>
    <div className="scroll-thin flex min-h-0 flex-col overflow-y-auto">
      {shown.map(({ key, label }, i) => (
        <DropdownMenu.Group key={key} data-inbox-section={key} className={cn('flex shrink-0 flex-col', i > 0 && 'mt-1 border-t border-line pt-1')}>
          <DropdownMenu.GroupLabel className="flex items-center gap-2 pr-2 pl-2 pt-1 pb-0.5 text-3 text-fg-3">
            <span className={cn('min-w-0 flex-1 truncate', key === 'reply' && 'text-warn')}>{t(label)}</span>
            <span className="shrink-0 tabular-nums">{inbox[key].length}</span>
          </DropdownMenu.GroupLabel>
          {inbox[key].map(s => {
            const status = inboxStatus(s);
            return (
              <DropdownMenu.Item key={s.id} data-inbox-item={s.id} onClick={() => onSelect(s.id)} className="min-h-0 py-1">
                {s.state ? <StateMark state={s.state} unread={s.unread} wakeAt={s.wakeAt} /> : <span className="size-3 shrink-0" />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <span className="shrink-0 text-3 text-fg-3 tabular-nums">{ago(s.updatedAt, now)}</span>
                  </span>
                  <span className="flex min-w-0 items-baseline gap-1 text-3 text-fg-3">
                    <span className={cn('shrink-0', status && STATUS_TONE[status])}>{statusText(s)}</span>
                    <span aria-hidden className="shrink-0">{t('common.metaSep')}</span>
                    <span className="min-w-0 truncate" title={s.cwd}>{projectLabel(s, categories, chats)}</span>
                  </span>
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Group>
      ))}
    </div>
    {next && (
      <div className="mt-1 flex h-ctl shrink-0 items-center gap-2 border-t border-line px-2 pt-1 text-3 text-fg-3">
        <span className="min-w-0 flex-1 truncate">{t('settings.shortcuts.nextAttention')}</span>
        <kbd className="shrink-0 font-sans tabular-nums">{next}</kbd>
      </div>
    )}
  </>;
}
