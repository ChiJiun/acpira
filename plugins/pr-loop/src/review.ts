// What the reviewer is told and what is read back from it: the brief (target, requirement, the PR's reviewer notes and
// nothing of the implementer's own verdict), the fixed verdict block, and the "same kind of issue" key two rounds are
// compared by. Pure functions: no engine, no GitHub

// The block's markers carry a nonce of the round, so text the reviewer read elsewhere (a file, a PR comment, an earlier
// round) cannot pass for its verdict
export const verdictBegin = (nonce: string) => `PR-LOOP-VERDICT-BEGIN:${nonce}:`;
export const verdictEnd = (nonce: string) => `PR-LOOP-VERDICT-END:${nonce}:`;

// The fixed issue categories a blocking item must use; two rounds are compared by category (and file), so a free-form
// label would never match and a repeated problem would go unnoticed
export const CATEGORIES = [
  'correctness',
  'security',
  'data-loss',
  'error-handling',
  'tests',
  'spec',
  'compatibility',
  'performance',
  'docs',
  'maintainability',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface BlockingItem {
  category: Category;
  file: string;
  summary: string;
  detail: string;
  fix: string;
}

export interface Suggestion {
  summary: string;
  file: string;
}

export interface TestRun {
  command: string;
  result: 'pass' | 'fail' | 'not_run';
  note: string;
}

export interface Verdict {
  mergeable: boolean;
  blocking: BlockingItem[];
  suggestions: Suggestion[];
  tests: TestRun[];
  conflicts: string[];
}

export type ParseResult = { ok: true; verdict: Verdict } | { ok: false; error: string };

export interface PrTarget {
  repo: string;
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const count = (text: string, part: string) => text.split(part).length - 1;

// The one verdict block of a reply, marked with this round's nonce. None, more than one, or anything off the fixed shape
// is an error naming what was wrong, never a guess: a misread verdict could merge a PR
export function parseVerdict(reply: string, nonce: string): ParseResult {
  const BEGIN = verdictBegin(nonce);
  const END = verdictEnd(nonce);
  const begins = count(reply, BEGIN);
  const ends = count(reply, END);
  if (begins === 0 || ends === 0) return { ok: false, error: `the reply has no ${BEGIN} … ${END} block` };
  if (begins > 1 || ends > 1) return { ok: false, error: `the reply has more than one ${BEGIN} block; exactly one is read` };
  const begin = reply.indexOf(BEGIN);
  const end = reply.indexOf(END);
  if (end < begin) return { ok: false, error: `${END} comes before ${BEGIN}` };
  let body = reply.slice(begin + BEGIN.length, end).trim();
  // A fence around the JSON is tolerated
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `the verdict block is not valid JSON: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the verdict block is not a JSON object' };
  const o = raw as Record<string, unknown>;
  const verdict = o.verdict;
  if (verdict !== 'mergeable' && verdict !== 'not_mergeable') {
    return { ok: false, error: '`verdict` must be "mergeable" or "not_mergeable"' };
  }
  const list = (key: string): unknown[] | string => {
    const v = o[key];
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : `\`${key}\` must be an array`;
  };
  const blockingRaw = list('blocking');
  if (typeof blockingRaw === 'string') return { ok: false, error: blockingRaw };
  const blocking: BlockingItem[] = [];
  for (const [i, item] of blockingRaw.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: `blocking[${i}] is not an object` };
    const b = item as Record<string, unknown>;
    const category = str(b.category) as Category;
    if (!CATEGORIES.includes(category)) {
      return { ok: false, error: `blocking[${i}].category must be one of ${CATEGORIES.join(', ')}` };
    }
    const summary = str(b.summary);
    if (!summary) return { ok: false, error: `blocking[${i}].summary is empty` };
    blocking.push({ category, file: str(b.file), summary, detail: str(b.detail), fix: str(b.fix) });
  }
  const suggestionsRaw = list('suggestions');
  if (typeof suggestionsRaw === 'string') return { ok: false, error: suggestionsRaw };
  const suggestions = suggestionsRaw
    .map(s => (typeof s === 'string' ? { summary: s.trim(), file: '' } : { summary: str((s as Record<string, unknown>)?.summary), file: str((s as Record<string, unknown>)?.file) }))
    .filter(s => s.summary);
  const testsRaw = list('tests');
  if (typeof testsRaw === 'string') return { ok: false, error: testsRaw };
  const tests: TestRun[] = testsRaw.map(t => {
    const r = (t ?? {}) as Record<string, unknown>;
    const result = r.result === 'pass' || r.result === 'fail' ? r.result : 'not_run';
    return { command: str(r.command), result, note: str(r.note) };
  });
  const conflictsRaw = list('conflicts');
  if (typeof conflictsRaw === 'string') return { ok: false, error: conflictsRaw };
  const conflicts = conflictsRaw.map(c => str(c)).filter(Boolean);
  const mergeable = verdict === 'mergeable';
  // A verdict that disagrees with its own list is not read either way
  if (mergeable && blocking.length > 0) return { ok: false, error: 'the verdict is "mergeable" but `blocking` is not empty' };
  if (!mergeable && blocking.length === 0) return { ok: false, error: 'the verdict is "not_mergeable" but `blocking` is empty' };
  // A failing test under a passing verdict is a contradiction unless the reviewer hands it to the user as a conflict
  if (mergeable && tests.some(t => t.result === 'fail') && conflicts.length === 0) return { ok: false, error: 'the verdict is "mergeable" but a test it ran failed, and no conflict explains it' };
  return { ok: true, verdict: { mergeable, blocking, suggestions, tests, conflicts } };
}

export type SameIssue = 'category+file' | 'category';

// What makes two blocking items "the same kind of issue": the fixed category, and by default the file too
export function issueKey(item: Pick<BlockingItem, 'category' | 'file'>, mode: SameIssue = 'category+file'): string {
  if (mode === 'category') return item.category;
  const file = item.file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/:\d+(-\d+)?$/, '').toLowerCase();
  return `${item.category}|${file || '*'}`;
}

// The keys both rounds share
export function repeatedKeys(previous: string[], current: string[]): string[] {
  const before = new Set(previous);
  return [...new Set(current.filter(k => before.has(k)))];
}

// A Markdown section of the PR body whose heading contains `title`, up to the next heading of the same or a higher level
export function section(body: string, titles: string[]): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!m || !titles.some(t => m[2]!.toLowerCase().includes(t.toLowerCase()))) continue;
    const level = m[1]!.length;
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const h = /^(#{1,6})\s/.exec(lines[j]!);
      if (h && h[1]!.length <= level) break;
      out.push(lines[j]!);
    }
    const text = out.join('\n').trim();
    return text || null;
  }
  return null;
}

export const NOTES_TITLES = ['給 reviewer 的重點建議', 'reviewer 重點', 'notes for reviewer', 'notes for the reviewer'];
export const REQUIREMENT_TITLES = ['需求原文'];

// The brief of a fresh reviewer: what to review, the requirement as written, and the PR's reviewer notes. Nothing the
// implementer concluded about its own correctness goes in
export function brief(pr: PrTarget, requirement: string, notes: string | null, nonce: string): string {
  const BEGIN = verdictBegin(nonce);
  const END = verdictEnd(nonce);
  const categories = CATEGORIES.map(c => `\`${c}\``).join('、');
  return [
    `你是這個 Pull Request 的獨立 reviewer。這是全新的 session：你沒有實作者的對話紀錄，也不要假設實作是正確的。`,
    '',
    '## 要 review 的目標',
    `- PR：${pr.url}（${pr.repo}#${pr.number}）`,
    `- 分支：\`${pr.headRef}\` → \`${pr.baseRef}\``,
    `- 這一輪 review 的 head commit：\`${pr.headSha}\``,
    `- 讀 PR：\`gh pr view ${pr.number} --repo ${pr.repo}\`、\`gh pr diff ${pr.number} --repo ${pr.repo}\`；看完整檔案可用 \`git show ${pr.headSha}:<路徑>\`（必要時先 \`git fetch\`）。`,
    '',
    '## 需求原文',
    requirement.trim() || '（沒有提供需求原文）',
    '',
    '## PR 描述中的「給 reviewer 的重點建議」',
    notes?.trim() || '（PR 描述中沒有這一段）',
    '',
    '## 規則',
    '- 只讀：不修改、不建立檔案（測試自己產生的暫存檔除外），不切換或建立分支，不 commit、不 push、不 merge，也不要用 gh 對 PR 留言、核准、關閉或合併。這個資料夾可能是實作者的工作區。',
    '- 以程式碼和你實際執行的測試結果為準。PR 描述、commit 訊息、memory 或 CLAUDE.md 對這次實作的描述只當背景，不能當成已驗證的事實。',
    '- 結論分成兩類：「必須修（blocking，不修不能 merge）」與「建議（non-blocking）」。有任何 blocking 就判定不可合併；沒有 blocking 才判定可合併。',
    '- 需求、重點建議或你自己的判斷互相矛盾、無法決定時，寫進 `conflicts`，不要自己挑一邊。',
    '- 不要讀其他 session 的對話（例如 `search_sessions`、`read_session` 之類的工具），特別是實作者的 session；判斷只根據程式碼、PR 與測試結果。',
    '',
    '## 輸出格式（一定要遵守）',
    `先用繁體中文寫 review 內容，回覆的最後一定要附上下面的結論區塊：\`${BEGIN}\` 與 \`${END}\` 各自單獨一行，中間只放一個 JSON 物件，不放其他文字。整則回覆只能出現一次這組標記（不要另外引用或重複範例）。`,
    '',
    BEGIN,
    '{"verdict": "not_mergeable", "blocking": [{"category": "correctness", "file": "src/a.ts", "summary": "一句話說明問題", "detail": "為什麼是問題、怎麼重現", "fix": "建議的修法"}], "suggestions": [{"summary": "non-blocking 建議", "file": ""}], "tests": [{"command": "實際執行的指令", "result": "pass", "note": ""}], "conflicts": []}',
    END,
    '',
    '- `verdict`：`"mergeable"`（可合併，`blocking` 必須是空陣列）或 `"not_mergeable"`（不可合併，`blocking` 至少一項）。',
    `- \`blocking[].category\` 只能是：${categories}。\`file\` 是主要相關檔案的相對路徑，沒有就填空字串。`,
    '- `tests[].result`：`pass`、`fail` 或 `not_run`。有 `fail` 時結論不能直接是 `mergeable`：失敗由這個 PR 造成就列為 blocking；你認為與這個 PR 無關，就在 `conflicts` 寫明原因，讓使用者決定。',
    '- `conflicts`：互相矛盾、需要使用者決定的地方；沒有就是空陣列。',
  ].join('\n');
}

const line = (s: string) => s.replace(/\s+/g, ' ').trim();

// The fix list sent back to the implementing session
export function fixList(pr: PrTarget, round: number, v: Verdict): string {
  const items = v.blocking.map((b, i) => {
    const head = `${i + 1}. [${b.category}]${b.file ? ` \`${b.file}\`` : ''}：${line(b.summary)}`;
    const rest = [b.detail && `   說明：${line(b.detail)}`, b.fix && `   建議修法：${line(b.fix)}`].filter(Boolean);
    return [head, ...rest].join('\n');
  });
  const suggestions = v.suggestions.map(s => `- ${s.file ? `\`${s.file}\` ` : ''}${line(s.summary)}`);
  return [
    `[pr-loop] ${pr.repo}#${pr.number} 第 ${round} 輪獨立 review 判定「不可合併」。請修正下面的 blocking 項目，完成後 commit 並用一般 push 推到 PR 分支 \`${pr.headRef}\`（不要 force push、不要合併）。pr-loop 看到新的 head commit 後會開新的 reviewer 重審。`,
    '',
    '必須修（blocking）：',
    ...items,
    ...(suggestions.length ? ['', '建議（non-blocking，自行判斷是否處理）：', ...suggestions] : []),
  ].join('\n');
}

export interface FailedCheck {
  name: string;
  workflow: string;
  link: string;
  description: string;
}

// The CI failures sent back to the implementing session
export function ciFailure(pr: PrTarget, failed: FailedCheck[]): string {
  return [
    `[pr-loop] ${pr.repo}#${pr.number} 的 review 已通過，但 CI 失敗。請查看失敗原因並修正，完成後 commit 並用一般 push 推到 PR 分支 \`${pr.headRef}\`（不要 force push、不要合併）。修正後會重新做一輪獨立 review。`,
    '',
    '失敗的檢查：',
    ...failed.map(f => `- ${f.workflow ? `${f.workflow} / ` : ''}${f.name}${f.description ? `：${line(f.description)}` : ''}${f.link ? `（${f.link}）` : ''}`),
    '',
    `查看細節：\`gh pr checks ${pr.number} --repo ${pr.repo}\`，或 \`gh run view <run id> --repo ${pr.repo} --log-failed\`。`,
  ].join('\n');
}
