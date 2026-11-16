// The pure part of the turn-report plugin: which turns are checked, whether a reply covers the three parts of a
// closing report (what was done, why, what is left or unverified), and the follow-up sent when it does not.
// Nothing here talks to Acpira, so test/plugin-turn-report.test.ts drives it directly; main.ts feeds it the
// session view (`session/get`) and the turn events.

export type SectionKey = 'done' | 'why' | 'todo';
export const SECTION_KEYS: readonly SectionKey[] = ['done', 'why', 'todo'];

export interface SectionRule {
  // How the section is named in the follow-up
  label: string;
  // Regular expression sources (case-insensitive, unicode); any match covers the section
  patterns: string[];
}

export interface ReportConfig {
  enabled: boolean;
  // Follow-ups per user request; 0 never asks. Capped at MAX_ASKS so a misconfiguration cannot loop
  maxAsks: number;
  // Tool kinds that make a turn "work" (ACP tool kinds as Acpira records them)
  workKinds: string[];
  // Commands that only look around (git status, ls, grep …) do not make a turn "work"
  ignoreReadOnlyCommands: boolean;
  // Regular expression sources for one read-only command segment (anchored at its start)
  readOnlyCommands: string[];
  // Sections a reply must cover to pass
  minCovered: number;
  // A reply at least `chars` long passes with `minCovered` sections: a long write-up rarely misses the point
  longReply: { chars: number; minCovered: number };
  sections: Record<SectionKey, SectionRule>;
  // The follow-up; {marker}, {missing} and {work} are filled in
  prompt: string;
  // Starts every follow-up, so the plugin recognises its own message when the turn it starts begins
  marker: string;
  // Only sessions of these agent ids (empty: every agent)
  agents: string[];
  // Ask Acpira's own model to look again before asking the agent (it can only turn an ask into a pass)
  model: { enabled: boolean; model?: string; maxTokens: number };
}

export const MAX_ASKS = 3;

// Characters shared by Traditional and Simplified Chinese are written once; the pairs are classes ([沒没])
const DONE_PATTERNS = [
  '做了', '完成', '實作', '实现', '實現',
  '(?:已經?|已)\\s*(?:修改|新增|建立|更新|刪除|删除|移除|修正|修復|修复|調整|调整|加入|執行|执行|改寫|改写|重構|重构)',
  '(?:修改|新增|建立|更新|刪除|删除|移除|修正|修復|修复|調整|调整|加入|執行|执行|跑|改|寫|写|重構|重构)了',
  '[變变]更', '改[動动]', '[異异][動动]', '[檔档]案', '文件', '指令', '命令',
  '\\b(?:changed|modified|updated|added|created|removed|deleted|renamed|implemented|fixed|refactored|wrote|ran|executed|installed|committed)\\b',
  '\\b(?:changes|summary|what i did|done)\\b',
  // A file path or a file name with a common extension. Each starts only where a word starts, so a long run of word
  // characters is scanned once rather than from every position in it
  '(?<![\\w.-])[\\w.-]+/[\\w.-]',
  '(?<![\\w-])[\\w-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|rs|py|go|java|kt|swift|css|scss|html|toml|yaml|yml|sh|ps1|txt|lock|sql)\\b',
];

const WHY_PATTERNS = [
  '[為为]什[麼么]', '[為为]了', '因[為为]', '由於', '由于', '原因', '理由', '目的', '用意', '所以', '因此', '以便', '好讓', '好让',
  '避免', '確保', '确保', '才能', '這樣(?:做|才|可以)', '这样(?:做|才|可以)', '考量', '考虑', '考慮', '取捨', '取舍',
  '\\b(?:why|because|since|so that|in order to|reason|reasons|rationale|motivation|due to|to (?:ensure|avoid|prevent|keep|make|allow|support|fix|match))\\b',
];

const TODO_PATTERNS = [
  '未完成', '[沒没]做', '[沒没]有做', '尚未', '[還还][沒没]', '[還还]有', '未[驗验][證证]', '[沒没][驗验][證证]', '[沒没]有[驗验][證证]',
  '未[測测]', '[沒没][測测]', '[沒没]有[測测]', '待[辦办]', '待[確确][認认]', '後續', '后续', '限制', '風險', '风险', '注意', '已知問題', '已知问题',
  '剩下', '遺留', '遗留', '下一步', '都已', '無法', '无法', '[沒没]跑', '未跑', '[沒没]辦法', '[沒没]办法', '[還还]不能', '全部(?:完成|[驗验][證证]|通過|通过)', '[沒没]有(?:其他)?(?:未完成|遺留|遗留|待辦|待办)',
  '\\b(?:todo|not yet|unverified|untested|not (?:been )?(?:tested|verified|run|checked)|remaining|left to|follow[- ]?ups?|next steps?|limitations?|caveats?|known issues?|risks?|did not|didn\'t|could not|couldn\'t|have not|haven\'t|has not|hasn\'t|was not able|wasn\'t able|unable to|cannot|can\'t|pending|open questions?|nothing (?:left|remaining|else)|all (?:\\w+ )?(?:passed|verified|done))\\b',
];

// One command segment (after `env X=1`, `git -C dir` and the like are taken off), anchored at its start
const READ_ONLY_COMMANDS = [
  'git\\s+(?:status|log|diff|show|blame|grep|ls-files|ls-tree|describe|rev-parse|rev-list|shortlog|cat-file|merge-base|config\\s+(?:--get|--list|-l)\\b)',
  'git\\s+(?:branch|remote|tag|stash\\s+list|worktree\\s+list)\\b',
  '(?:ls|dir|cat|type|head|tail|less|more|nl|pwd|cd|pushd|popd|echo|printf|find|grep|egrep|fgrep|rg|ag|fd|tree|wc|which|where|whoami|env|printenv|stat|file|du|df|date|uname|hostname|ps|sort|uniq|cut|tr|column|diff|cmp|comm|jq|yq|sed|awk|basename|dirname|realpath|readlink|test|true|sleep)\\b',
  'gh\\s+(?:pr|issue|run|repo|release|workflow)\\s+(?:view|list|status|diff|checks)\\b',
  'gh\\s+(?:status|auth\\s+status)\\b',
  '(?:node|npm|pnpm|yarn|python3?|py|cargo|rustc|rustup|go|java|dotnet|gh|git)\\s+(?:-v|-V|--version)\\b',
  '(?:npm|pnpm|yarn)\\s+(?:ls|list|why|view|info|outdated|config\\s+get)\\b',
  'cargo\\s+(?:tree|metadata)\\b',
  '(?:Get-[A-Za-z]+|Select-String|Select-Object|Where-Object|Sort-Object|Measure-Object|Format-Table|Format-List|Out-String|ConvertFrom-Json|ConvertTo-Json|Test-Path|Resolve-Path|Split-Path|Join-Path|Write-Output|Write-Host|Set-Location)\\b',
];

// What turns a command on the list into one that writes or runs something else; checked on every segment, whatever
// the configured list says
const WRITE_HINTS = [
  /^find\b.*\s-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/i,
  /^(?:sed|perl)\b.*\s(?:-i\S*|--in-place\S*)/i,
  /^awk\b.*(?:\bsystem\s*\(|\bprint[^|]*>)/i,
  /^git\s+branch\b.*\s(?:-[dDmMcCfu]\b|--delete|--move|--copy|--force|--set-upstream\S*|--unset-upstream|--edit-description)/,
  /^git\s+remote\s+(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i,
  /^git\s+tag\s+(?!-l\b|--list\b|-n\b)\S/i,
  /^(?:sort|yq|jq)\b.*\s(?:-o|--output|-i|--in-place)\b/i,
];

export const DEFAULT_PROMPT = [
  '{marker} 這個回合有修改檔案或執行指令，但最後的回覆看起來缺少：{missing}。',
  '請不要再做新的修改，直接補一段簡短的收尾回報，涵蓋：',
  '1. 做了哪些事（改了哪些檔案、執行了哪些指令）',
  '2. 為什麼這樣做',
  '3. 還有哪些沒做完或沒驗證的地方（都完成也請明說）',
  '{work}',
  '（這是 turn-report 外掛的自動提醒，每個使用者請求最多一次。）',
].join('\n');

export const DEFAULT_CONFIG: ReportConfig = {
  enabled: true,
  maxAsks: 1,
  workKinds: ['edit', 'delete', 'move', 'execute'],
  ignoreReadOnlyCommands: true,
  readOnlyCommands: READ_ONLY_COMMANDS,
  minCovered: 3,
  longReply: { chars: 800, minCovered: 2 },
  sections: {
    done: { label: '做了哪些事', patterns: DONE_PATTERNS },
    why: { label: '為什麼這樣做', patterns: WHY_PATTERNS },
    todo: { label: '還有哪些沒做完或沒驗證', patterns: TODO_PATTERNS },
  },
  prompt: DEFAULT_PROMPT,
  marker: '[turn-report]',
  agents: [],
  model: { enabled: false, maxTokens: 200 },
};

// ---- configuration ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every(s => typeof s === 'string') ? (v as string[]) : undefined);
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : undefined;

/**
 * The defaults with the user's `config.json` laid over them. Unknown keys and values of the wrong type are ignored,
 * so a broken file never switches the check off or makes it loop. `sections.<key>.extra` adds patterns to the
 * defaults, `sections.<key>.patterns` replaces them.
 */
export function resolveConfig(raw: unknown): ReportConfig {
  const d = DEFAULT_CONFIG;
  if (!isObject(raw)) return structuredClone(d);
  const sections = structuredClone(d.sections);
  if (isObject(raw.sections)) {
    for (const key of SECTION_KEYS) {
      const s = raw.sections[key];
      if (!isObject(s)) continue;
      if (typeof s.label === 'string' && s.label.trim()) sections[key].label = s.label;
      const replace = strings(s.patterns);
      if (replace) sections[key].patterns = replace;
      const extra = strings(s.extra);
      if (extra) sections[key].patterns = [...sections[key].patterns, ...extra];
    }
  }
  const long = isObject(raw.longReply) ? raw.longReply : {};
  const model = isObject(raw.model) ? raw.model : {};
  const readOnlyExtra = strings(raw.readOnlyCommandsExtra) ?? [];
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
    maxAsks: num(raw.maxAsks, 0, MAX_ASKS) ?? d.maxAsks,
    workKinds: strings(raw.workKinds) ?? [...d.workKinds],
    ignoreReadOnlyCommands: typeof raw.ignoreReadOnlyCommands === 'boolean' ? raw.ignoreReadOnlyCommands : d.ignoreReadOnlyCommands,
    readOnlyCommands: [...(strings(raw.readOnlyCommands) ?? d.readOnlyCommands), ...readOnlyExtra],
    minCovered: num(raw.minCovered, 0, 3) ?? d.minCovered,
    longReply: {
      chars: num(long.chars, 0, 1_000_000) ?? d.longReply.chars,
      minCovered: num(long.minCovered, 0, 3) ?? d.longReply.minCovered,
    },
    sections,
    prompt: typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt : d.prompt,
    marker: typeof raw.marker === 'string' && raw.marker.trim() ? raw.marker.trim() : d.marker,
    agents: strings(raw.agents) ?? [],
    model: {
      enabled: typeof model.enabled === 'boolean' ? model.enabled : d.model.enabled,
      ...(typeof model.model === 'string' && model.model ? { model: model.model } : {}),
      maxTokens: num(model.maxTokens, 16, 4000) ?? d.model.maxTokens,
    },
  };
}

// Patterns longer than this are skipped: they come from a hand-edited file and are matched against every reply
const PATTERN_MAX_CHARS = 500;
const compiled = new Map<string, RegExp | null>();

function regex(source: string, anchored = false): RegExp | null {
  const key = `${anchored ? '^' : ''}${source}`;
  let re = compiled.get(key);
  if (re === undefined) {
    try {
      re = source.length > PATTERN_MAX_CHARS ? null : new RegExp(anchored ? `^(?:${source})` : source, 'iu');
    } catch {
      re = null;
    }
    compiled.set(key, re);
  }
  return re;
}

// ---- the session view, as far as this plugin reads it ----

export interface ToolBlockView {
  type: 'tool_call';
  kind?: string;
  status?: string;
  target?: string;
  locations?: { path: string }[];
}
export interface TextBlockView {
  type: 'text';
  markdown?: string;
  phase?: 'commentary' | 'final';
}
export type BlockView = ToolBlockView | TextBlockView | { type: string };
export interface UserTurnView {
  role: 'user';
  text?: string;
  auto?: boolean;
  // Why Acpira sent it: absent on an automatic turn means the over-threshold /compact (packages/shared/transcript.ts)
  autoReason?: string;
  goalContinue?: boolean;
}
export interface AgentTurnView {
  role: 'agent';
  blocks?: BlockView[];
  stop?: string;
}
export type TurnView = UserTurnView | AgentTurnView;
export interface SessionViewLike {
  id?: string;
  agent?: string;
  running?: boolean;
  queued?: unknown[];
  turns?: TurnView[];
}

export interface Work {
  // A turn of this request edited files or ran a command that is not read-only
  worked: boolean;
  files: string[];
  commands: string[];
  // The agent's closing text: the last agent turn's prose after its last tool call (its `final` parts when it marks them)
  reply: string;
}

const isTool = (b: BlockView): b is ToolBlockView => b.type === 'tool_call';
const isText = (b: BlockView): b is TextBlockView => b.type === 'text';

const NULL_TARGETS = new Set(['/dev/null', '$null', 'nul']);

export interface ParsedCommand {
  // The pieces between `&&`, `||`, `;`, `|`, `&` and line breaks, outside quotes
  segments: string[];
  // A `>` / `>>` outside quotes into anything but the null device or another descriptor
  writes: boolean;
  // `$(...)` or backticks outside single quotes: another command runs inside this one
  substitutes: boolean;
}

/** A shell command split the way a shell would, as far as telling reads from writes needs: quotes are honoured */
export function parseCommand(command: string): ParsedCommand {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let writes = false;
  let substitutes = false;
  const end = () => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && (c === '`' || (c === '$' && command[i + 1] === '('))) substitutes = true;
      current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '`' || (c === '$' && command[i + 1] === '(')) substitutes = true;
    if (c === '\n' || c === ';') {
      end();
      continue;
    }
    if (c === '&' || c === '|') {
      // `>&2`, `2>&1` and `&>` are redirects, handled below
      if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
        current += c;
        continue;
      }
      if (command[i + 1] === c) i++;
      end();
      continue;
    }
    if (c === '>') {
      let j = i + 1;
      if (command[j] === '>') j++;
      // `>&2`: into another descriptor
      const descriptor = command[j] === '&';
      while (command[j] === ' ' || command[j] === '\t') j++;
      let target = '';
      while (j < command.length && !/[\s;&|<>]/.test(command[j]!)) target += command[j++];
      const bare = target.replace(/^["']|["']$/g, '').toLowerCase();
      if (!descriptor && !NULL_TARGETS.has(bare)) writes = true;
      current += command.slice(i, j);
      i = j - 1;
      continue;
    }
    current += c;
  }
  end();
  return { segments, writes, substitutes };
}

// `VAR=1 cmd`, `env VAR=1 cmd`, `git -C dir cmd`, `git --no-pager cmd`: the command that actually runs
function core(segment: string): string {
  const s = segment.replace(/^(?:env\s+(?=\w+=))?(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  return s.replace(/^git((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--no-pager|--git-dir=\S+|--work-tree=\S+|-P))+)(?=\s)/, 'git');
}

/** Whether a command only looks around: every segment is on the read-only list, and nothing writes into a file */
export function readOnlyCommand(command: string, config: ReportConfig): boolean {
  const parsed = parseCommand(command);
  if (parsed.writes || parsed.substitutes || parsed.segments.length === 0) return false;
  return parsed.segments.every(seg => {
    const run = core(seg);
    if (WRITE_HINTS.some(re => re.test(run))) return false;
    return config.readOnlyCommands.some(src => regex(src, true)?.test(run) ?? false);
  });
}

// The /compact Acpira sends on its own past the context threshold: automatic, with no reason (`prompt.rs`, Origin::Compact)
const isCompaction = (t: UserTurnView) => t.auto === true && !t.autoReason;
// Where a request begins: a message of the user's own, or a goal control from the dock (an automatic turn with reason
// `goal` that is not the goal carrying on)
const startsRequest = (t: UserTurnView) => t.auto !== true || (t.autoReason === 'goal' && t.goalContinue !== true);

/**
 * What the user's current request has done so far: the agent turns from the last turn that starts a request on. Gate
 * follow-ups, continues and the goal carrying on belong to it; the automatic /compact's turns are left out, since they
 * are no work of the agent's and close on no report
 */
export function summarizeWork(turns: TurnView[], config: ReportConfig): Work {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.role === 'user' && startsRequest(t)) {
      start = i + 1;
      break;
    }
  }
  const agentTurns: AgentTurnView[] = [];
  let compacting = false;
  for (const t of turns.slice(start)) {
    if (t.role === 'user') compacting = isCompaction(t);
    else if (!compacting) agentTurns.push(t);
  }
  const files = new Set<string>();
  const commands: string[] = [];
  let worked = false;
  for (const t of agentTurns) {
    for (const b of t.blocks ?? []) {
      if (!isTool(b) || !b.kind || !config.workKinds.includes(b.kind)) continue;
      if (b.status === 'failed' || b.status === 'cancelled') continue;
      if (b.kind === 'execute') {
        const cmd = (b.target ?? '').trim();
        if (cmd) commands.push(cmd);
        if (config.ignoreReadOnlyCommands && cmd && readOnlyCommand(cmd, config)) continue;
      } else {
        for (const l of b.locations ?? []) if (l.path) files.add(l.path);
      }
      worked = true;
    }
  }
  return { worked, files: [...files], commands, reply: closingText(agentTurns.at(-1)) };
}

// The prose after the turn's last tool call; of it, the parts marked `final` when there are any. Only the tail counts:
// a detached continuation marks the stretch it continues from as final too (`queue.rs` mark_reply_final), so a `final`
// before the last tool call is an older closing
function closingText(turn: AgentTurnView | undefined): string {
  const blocks = turn?.blocks ?? [];
  let lastTool = -1;
  blocks.forEach((b, i) => {
    if (isTool(b)) lastTool = i;
  });
  const tail = blocks.slice(lastTool + 1).filter(isText);
  const finals = tail.filter(b => b.phase === 'final');
  return (finals.length > 0 ? finals : tail).map(b => b.markdown ?? '').join('\n\n').trim();
}

// ---- the check ----

export interface Check {
  covered: Record<SectionKey, boolean>;
  missing: SectionKey[];
  pass: boolean;
}

const MATCH_MAX_CHARS = 20_000;

/** Fenced code blocks say nothing about the work's report (a `TODO` in a snippet is not one) */
export function prose(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, ' ');
}

/** Whether a reply covers the three parts; lenient by design: any pattern of a section covers it */
export function checkReply(reply: string, config: ReportConfig): Check {
  // A report sits at the start or the end; a very long reply is read there only, which keeps every pattern's cost bounded
  const text = prose(reply.length > MATCH_MAX_CHARS ? `${reply.slice(0, MATCH_MAX_CHARS / 2)}\n${reply.slice(-MATCH_MAX_CHARS / 2)}` : reply);
  const covered = { done: false, why: false, todo: false } as Record<SectionKey, boolean>;
  for (const key of SECTION_KEYS) {
    covered[key] = config.sections[key].patterns.some(src => regex(src)?.test(text) ?? false);
  }
  return withCoverage(covered, reply, config);
}

function withCoverage(covered: Record<SectionKey, boolean>, reply: string, config: ReportConfig): Check {
  const missing = SECTION_KEYS.filter(k => !covered[k]);
  const have = SECTION_KEYS.length - missing.length;
  const needed = reply.length >= config.longReply.chars ? Math.min(config.minCovered, config.longReply.minCovered) : config.minCovered;
  return { covered, missing, pass: have >= needed };
}

// ---- per-session bookkeeping ----

export interface SessionMemo {
  // Follow-ups sent for the user's current request
  asks: number;
}

/**
 * A turn began (`turn.started`): a request of the user's own (or their goal's) starts the count again, unless it is
 * the plugin's own follow-up
 */
export function noteTurnStarted(memo: SessionMemo | undefined, origin: string, text: string, config: ReportConfig): SessionMemo {
  const ours = text.trimStart().startsWith(config.marker);
  if ((origin === 'user' || origin === 'goal') && !ours) return { asks: 0 };
  return memo ?? { asks: 0 };
}

export type Decision =
  | { action: 'skip'; reason: string }
  | { action: 'pass'; check: Check; work: Work }
  | { action: 'ask'; check: Check; work: Work; prompt: string };

export interface TurnEnd {
  stop?: string;
  error?: unknown;
  agent?: string;
}

/** What to do about a turn that just ended, given the session as `session/get` shows it after the end */
export function evaluateTurn(end: TurnEnd, view: SessionViewLike | null | undefined, memo: SessionMemo | undefined, config: ReportConfig): Decision {
  if (!config.enabled) return { action: 'skip', reason: 'disabled' };
  const agent = end.agent ?? view?.agent;
  if (config.agents.length > 0 && !(agent && config.agents.includes(agent))) return { action: 'skip', reason: 'agent not listed' };
  if (end.stop !== 'end_turn' || end.error) return { action: 'skip', reason: `turn did not finish (${end.stop ?? 'unknown'})` };
  if (!view) return { action: 'skip', reason: 'session not open' };
  // Another turn already runs or waits: interrupting it with a follow-up would read as a reply to the wrong thing
  if (view.running) return { action: 'skip', reason: 'another turn is running' };
  if ((view.queued?.length ?? 0) > 0) return { action: 'skip', reason: 'the user queued a message' };
  const work = summarizeWork(view.turns ?? [], config);
  if (!work.worked) return { action: 'skip', reason: 'no edits or commands (a question and its answer)' };
  const check = checkReply(work.reply, config);
  if (check.pass) return { action: 'pass', check, work };
  if ((memo?.asks ?? 0) >= config.maxAsks) return { action: 'skip', reason: 'follow-up limit reached' };
  return { action: 'ask', check, work, prompt: followUp(config, check.missing, work) };
}

const LIST_MAX = 8;
const ITEM_MAX = 120;
const clip = (s: string) => (s.length > ITEM_MAX ? `${s.slice(0, ITEM_MAX - 1)}…` : s);
const list = (items: string[]) => {
  const shown = items.slice(0, LIST_MAX).map(i => `\`${clip(i).replaceAll('`', "'")}\``).join('、');
  return items.length > LIST_MAX ? `${shown} 等 ${items.length} 項` : shown;
};

/** The follow-up text: the template with what is missing and what the turn was seen doing */
export function followUp(config: ReportConfig, missing: SectionKey[], work: Work): string {
  const parts: string[] = [];
  if (work.files.length > 0) parts.push(`本回合偵測到的檔案：${list(work.files)}`);
  if (work.commands.length > 0) parts.push(`本回合偵測到的指令：${list(work.commands)}`);
  const text = config.prompt
    // Functions, not strings: a replacement string reads `$&`, `$'` and `$$` in a command or label as patterns
    .replaceAll('{marker}', () => config.marker)
    .replaceAll('{missing}', () => missing.map(k => config.sections[k].label).join('、'))
    .replaceAll('{work}', () => parts.join('\n'));
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
  // The marker is how the plugin knows its own message; a template that drops it still starts with it
  return trimmed.startsWith(config.marker) ? trimmed : `${config.marker} ${trimmed}`;
}

// ---- the optional model check ----

const REPLY_MAX_CHARS = 6000;

/** The prompt for `model/generate`: the reply and the three questions, answered as JSON */
export function judgePrompt(reply: string, config: ReportConfig): { system: string; prompt: string } {
  const labels = SECTION_KEYS.map(k => `- ${k}: ${config.sections[k].label}`).join('\n');
  return {
    system: 'You check whether a coding agent\'s closing message covers required parts. Answer with one JSON object and nothing else.',
    prompt: `Does this closing message cover each part? A part counts if it is addressed at all, even briefly or as "nothing left".\n${labels}\n\nAnswer as {"done": true|false, "why": true|false, "todo": true|false}.\n\n<message>\n${reply.slice(0, REPLY_MAX_CHARS)}\n</message>`,
  };
}

/** The model's answer as coverage; null when it is not the JSON asked for */
export function parseJudge(text: string): Record<SectionKey, boolean> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(m[0]);
    if (!isObject(v) || !SECTION_KEYS.every(k => typeof v[k] === 'boolean')) return null;
    return { done: v.done === true, why: v.why === true, todo: v.todo === true };
  } catch {
    return null;
  }
}

/** The model can only add coverage the keywords missed, never take it away: the check stays at least as lenient */
export function applyJudge(check: Check, judged: Record<SectionKey, boolean> | null, reply: string, config: ReportConfig): Check {
  if (!judged) return check;
  const covered = { ...check.covered };
  for (const k of SECTION_KEYS) covered[k] = covered[k] || judged[k];
  return withCoverage(covered, reply, config);
}
