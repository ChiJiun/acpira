// Every GitHub call the loop makes, through `gh`. The runner is injected (the plugin's runs the real `gh`, the tests a
// fake), and every argv passes `guardArgs` first: only read calls and one plain merge-commit merge, never `--auto`,
// `--squash`, `--rebase`, a branch deletion or an admin override

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (args: string[], opts?: { cwd?: string }) => Promise<RunResult>;

// Flags no call of this plugin may carry, whatever builds the argv
export const FORBIDDEN_FLAGS = ['--auto', '--squash', '-s', '--rebase', '-r', '--delete-branch', '-d', '--admin', '--force', '-f', '--disable-auto'];

const ALLOWED: string[][] = [['auth', 'status'], ['pr', 'view'], ['pr', 'checks'], ['pr', 'merge']];

export class GhError extends Error {
  constructor(message: string, readonly args: string[], readonly result?: RunResult) {
    super(message);
  }
}

export function guardArgs(args: string[]): void {
  if (!ALLOWED.some(a => a.every((part, i) => args[i] === part))) {
    throw new GhError(`pr-loop does not run \`gh ${args.slice(0, 2).join(' ')}\``, args);
  }
  const bad = args.filter(a => FORBIDDEN_FLAGS.includes(a.split('=')[0]!));
  if (bad.length) throw new GhError(`pr-loop never passes ${bad.join(', ')} to gh`, args);
  if (args[0] === 'pr' && args[1] === 'merge' && !args.includes('--merge')) {
    throw new GhError('a merge always uses --merge (a merge commit)', args);
  }
}

export interface PullRequest {
  number: number;
  url: string;
  repo: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  title: string;
  body: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  mergeCommit: string | null;
}

export type CiState = { state: 'none' } | { state: 'pending'; pending: string[] } | { state: 'pass' } | { state: 'fail'; failed: { name: string; workflow: string; link: string; description: string }[] };

// `https://github.com/<owner>/<repo>/pull/<n>` → its parts; null for anything else
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

const PR_FIELDS = 'number,url,state,isDraft,title,body,headRefName,headRefOid,baseRefName,mergeable,mergeCommit';

export class GitHub {
  constructor(private readonly run: Runner) {}

  private async call(args: string[], opts?: { cwd?: string; okCodes?: number[] }): Promise<RunResult> {
    guardArgs(args);
    let r: RunResult;
    try {
      r = await this.run(args, opts);
    } catch (e) {
      throw new GhError(`gh could not run: ${(e as Error).message}`, args);
    }
    if (r.code !== 0 && !(opts?.okCodes ?? []).includes(r.code)) {
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-800)}`, args, r);
    }
    return r;
  }

  // Signed in on the default host; a failure is a GhError with gh's own words
  async authStatus(): Promise<void> {
    await this.call(['auth', 'status']);
  }

  // A PR by number (in `repo`, or the repository of `cwd` when none is given) or URL
  async pr(ref: string | number, repo?: string, cwd?: string): Promise<PullRequest> {
    const args = ['pr', 'view', String(ref), ...(repo ? ['--repo', repo] : []), '--json', PR_FIELDS];
    const r = await this.call(args, { cwd });
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(r.stdout);
    } catch {
      throw new GhError('gh pr view did not answer JSON', args, r);
    }
    const url = String(raw.url ?? '');
    const where = parsePrUrl(url);
    if (!where) throw new GhError(`gh pr view answered an unexpected url: ${url}`, args, r);
    const commit = raw.mergeCommit as { oid?: string } | null | undefined;
    return {
      number: Number(raw.number),
      url,
      repo: where.repo,
      state: (String(raw.state ?? '').toUpperCase() as PullRequest['state']) || 'OPEN',
      isDraft: raw.isDraft === true,
      title: String(raw.title ?? ''),
      body: String(raw.body ?? ''),
      headRefName: String(raw.headRefName ?? ''),
      headRefOid: String(raw.headRefOid ?? ''),
      baseRefName: String(raw.baseRefName ?? ''),
      mergeable: String(raw.mergeable ?? ''),
      mergeCommit: commit?.oid ?? null,
    };
  }

  // The PR's checks. A repository without CI has none, which is no failure. gh exits 8 while checks are pending and
  // non-zero after a failure, so the JSON is read whatever the code; only "no checks" and real errors differ
  async checks(repo: string, number: number): Promise<CiState> {
    const args = ['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state,bucket,link,workflow,description'];
    guardArgs(args);
    let r: RunResult;
    try {
      r = await this.run(args);
    } catch (e) {
      throw new GhError(`gh could not run: ${(e as Error).message}`, args);
    }
    const text = `${r.stderr}\n${r.stdout}`;
    if (/no checks reported/i.test(text)) return { state: 'none' };
    let list: { name?: string; state?: string; bucket?: string; link?: string; workflow?: string; description?: string }[];
    try {
      list = JSON.parse(r.stdout || 'null');
    } catch {
      throw new GhError(`gh pr checks failed (exit ${r.code}): ${text.trim().slice(-800)}`, args, r);
    }
    if (!Array.isArray(list)) throw new GhError(`gh pr checks failed (exit ${r.code}): ${text.trim().slice(-800)}`, args, r);
    if (list.length === 0) return { state: 'none' };
    const bucket = (c: (typeof list)[number]) => (c.bucket ?? '').toLowerCase();
    const failed = list.filter(c => bucket(c) === 'fail' || bucket(c) === 'cancel');
    if (failed.length) {
      return { state: 'fail', failed: failed.map(c => ({ name: c.name ?? '', workflow: c.workflow ?? '', link: c.link ?? '', description: c.description ?? '' })) };
    }
    const pending = list.filter(c => bucket(c) === 'pending' || (!bucket(c) && /pending|queued|in_progress|waiting/i.test(c.state ?? '')));
    if (pending.length) return { state: 'pending', pending: pending.map(c => c.name ?? '') };
    return { state: 'pass' };
  }

  // The one merge: a merge commit of exactly the reviewed head. No `--auto`, `--squash`, `--rebase`, no branch deletion
  mergeArgs(repo: string, number: number, headSha: string): string[] {
    return ['pr', 'merge', String(number), '--repo', repo, '--merge', '--match-head-commit', headSha];
  }

  async merge(repo: string, number: number, headSha: string): Promise<void> {
    await this.call(this.mergeArgs(repo, number, headSha));
  }
}
