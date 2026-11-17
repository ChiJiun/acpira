// The conditions that must stop the loop for the user, in one pure function. Every step that moves the loop on (a new
// review round, a fix list sent, waiting for CI, the merge) asks `mustStop` first and stops on everything it returns,
// all at once on one card. It reads only raw facts (what each reviewer said, which checks failed) and the loop's own
// policy, never a value derived earlier under another setting, and a hold is let through only by the consent the user
// gave on the card that named it.

import { issueKey, repeatedKeys, type SameIssue } from './review';

// What the step about to happen is
export type Transition = 'review' | 'fix' | 'ci' | 'merge';

export interface Issue {
  category: string;
  file: string;
}

// One review round as it happened
export interface RoundFacts {
  round: number;
  sha: string;
  // 'mergeable' / 'not_mergeable': the reviewer's verdict without conflicts; 'conflict': a verdict with conflicts for the
  // user (`verdict` holds which); 'unparseable': no verdict could be read
  result: 'mergeable' | 'not_mergeable' | 'unparseable' | 'conflict';
  verdict?: 'mergeable' | 'not_mergeable';
  conflicts?: string[];
  issues: Issue[];
}

// One CI result for a head: the failing checks (`workflow/name`), empty when everything passed
export interface CiRun {
  sha: string;
  failed: string[];
}

export interface GateInput {
  transition: Transition;
  rounds: RoundFacts[];
  ciRuns: CiRun[];
  round: number;
  roundLimit: number;
  sameIssue: SameIssue;
  // Where the fix list about to go out came from (for `fix`)
  fixFrom: 'review' | 'ci' | null;
  // Holds the user already agreed to, by token
  consents: string[];
  // For `review`: the head moved from the last reviewed commit to one that does not descend from it, or to one whose
  // relation to it could not be read (`unknown` says why)
  rewritten?: { from: string; to: string; unknown?: string } | null;
}

export type HoldReason = 'max-rounds' | 'repeated' | 'conflict' | 'force-push';

export interface Hold {
  reason: HoldReason;
  // Why, for the card (built from raw facts; the caller quotes anything that came from a reviewer)
  detail: string;
  // What resuming after this hold agrees to, for the card
  agree: string;
  // Recorded on resume; a hold whose token is recorded is let through. Null for `max-rounds`, which a resume lets
  // through by raising the round limit by one
  token: string | null;
}

// The verdict a round's reviewer gave, a `conflict` round included; null for a round without one
export function verdictOf(r: RoundFacts): 'mergeable' | 'not_mergeable' | null {
  if (r.result === 'mergeable' || r.result === 'not_mergeable') return r.result;
  return r.result === 'conflict' ? (r.verdict ?? null) : null;
}

export const conflictToken = (round: number) => `conflict:${round}`;

// The round's verdict as it now stands: a conflict round counts as its verdict once the user accepted it
export function effectiveResult(r: RoundFacts, consents: string[]): RoundFacts['result'] {
  if (r.result === 'conflict' && r.verdict && consents.includes(conflictToken(r.round))) return r.verdict;
  return r.result;
}

// A round's issues as the keys `mode` compares them by (for display)
export const issueKeyList = (issues: Issue[], mode: SameIssue): string[] => [...new Set(issues.map(i => issueKey(i, mode)))];

// The same kind of issue in both rounds, compared under `mode` from the raw items of each
export function sameKind(previous: Issue[], current: Issue[], mode: SameIssue): string[] {
  return repeatedKeys(
    previous.map(i => issueKey(i, mode)),
    current.map(i => issueKey(i, mode)),
  );
}

export function mustStop(i: GateInput): Hold[] {
  const holds: Hold[] = [];
  const last = i.rounds[i.rounds.length - 1];

  // Conflicts the reviewer handed to the user: nothing goes on past them without the user's word
  if (i.transition !== 'review' && last && last.result === 'conflict' && !i.consents.includes(conflictToken(last.round))) {
    holds.push({
      reason: 'conflict',
      detail: `第 ${last.round} 輪 reviewer 回報需要你決定的衝突（${last.conflicts?.length ?? 0} 項），它的判斷是「${last.verdict === 'mergeable' ? '可合併' : '不可合併'}」。`,
      agree: '照 reviewer 的判斷處理它回報的衝突',
      token: conflictToken(last.round),
    });
  }

  // The same kind of issue sent back twice in a row
  if (i.transition === 'fix' && i.fixFrom === 'review' && last && verdictOf(last) === 'not_mergeable') {
    const previous = [...i.rounds.slice(0, -1)].reverse().find(r => verdictOf(r) !== null);
    if (previous && verdictOf(previous) === 'not_mergeable') {
      const same = sameKind(previous.issues, last.issues, i.sameIssue);
      const token = `repeated:review:${last.round}`;
      if (same.length && !i.consents.includes(token)) {
        holds.push({
          reason: 'repeated',
          detail: `第 ${previous.round} 輪與第 ${last.round} 輪都退回同一類問題：${same.join('、')}（比對方式：${i.sameIssue === 'category' ? '類別' : '類別＋檔案'}）。方向可能錯了，請先看過再決定。`,
          agree: '在同一類問題重複的情況下繼續修正',
          token,
        });
      }
    }
  }
  if (i.transition === 'fix' && i.fixFrom === 'ci') {
    const [before, now] = i.ciRuns.slice(-2);
    if (before && now && before.failed.length && now.failed.length) {
      const same = now.failed.filter(n => before.failed.includes(n));
      const token = `repeated:ci:${now.sha}`;
      if (same.length && !i.consents.includes(token)) {
        holds.push({
          reason: 'repeated',
          detail: `CI 連續兩次在同樣的檢查失敗：${same.join('、')}。`,
          agree: '在 CI 同一個檢查重複失敗的情況下繼續修正',
          token,
        });
      }
    }
  }

  // A new round past the limit: opening one, or sending a fix that will need one
  if ((i.transition === 'review' || i.transition === 'fix') && i.round >= i.roundLimit) {
    holds.push({
      reason: 'max-rounds',
      detail: `已經 review ${i.round} 輪（上限 ${i.roundLimit} 輪），${i.transition === 'review' ? '再開' : '修正後的'}下一輪 review 會超過上限。`,
      agree: `超過上限 ${i.roundLimit} 輪，再多 review 一輪（第 ${i.round + 1} 輪）`,
      token: null,
    });
  }

  // A head that does not descend from the reviewed one: history was rewritten (a force push)
  if (i.transition === 'review' && i.rewritten) {
    const token = `force:${i.rewritten.from}..${i.rewritten.to}`;
    if (!i.consents.includes(token)) {
      holds.push({
        reason: 'force-push',
        detail: i.rewritten.unknown
          ? `PR 的 head 從 \`${i.rewritten.from.slice(0, 8)}\` 變成 \`${i.rewritten.to.slice(0, 8)}\`，但無法確認新的 head 是舊 head 的後代（${i.rewritten.unknown}）：分支可能被 force push 或改寫過。`
          : `PR 的 head 從 \`${i.rewritten.from.slice(0, 8)}\` 變成 \`${i.rewritten.to.slice(0, 8)}\`，但新的 head 不是舊 head 的後代：分支被 force push 或改寫過。`,
        agree: '接受改寫過的歷史，對新的 head 重新 review',
        token,
      });
    }
  }
  return holds;
}
