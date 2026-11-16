// Every GitHub call the loop makes, through `gh`. The runner is injected (the plugin's runs the real `gh`, the tests a
// fake), and every argv passes `guardArgs` first: only read calls and one plain merge-commit merge, never `--auto`,
// `--squash`, `--rebase`, a branch deletion or an admin override

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (args: string[], opts?: { cwd?: string }) => Promise<RunResult>;

// The only argv shapes this plugin runs, position by position: anything else (another subcommand, an extra flag such as
// `--auto`, `--squash`, `--rebase`, `--delete-branch`, `--admin`, `--watch`, `--web`, `--body`, combined short flags) is
// refused before gh starts
export const FORBIDDEN_FLAGS = ['--auto', '--squash', '-s', '--rebase', '-r', '--delete-branch', '-d', '-sd', '-rd', '--admin', '--force', '-f', '--disable-auto', '--watch', '--web', '-w', '--body', '-b'];

export class GhError extends Error {
  constructor(message: string, readonly args: string[], readonly result?: RunResult) {
    super(message);
  }
}

const REPO_ARG = /^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/;
const NUMBER_ARG = /^\d+$/;
const PR_REF = (a: string) => NUMBER_ARG.test(a) || parsePrUrl(a) !== null;
const SHA_ARG = /^[0-9a-f]{7,64}$/i;
const FIELDS_ARG = /^[a-zA-Z]+(,[a-zA-Z]+)*$/;

type Slot = string | ((a: string) => boolean);
const SHAPES: Slot[][] = [
  ['auth', 'status'],
  ['pr', 'view', PR_REF, '--json', a => FIELDS_ARG.test(a)],
  ['pr', 'view', PR_REF, '--repo', a => REPO_ARG.test(a), '--json', a => FIELDS_ARG.test(a)],
  ['pr', 'checks', a => NUMBER_ARG.test(a), '--repo', a => REPO_ARG.test(a), '--json', a => FIELDS_ARG.test(a)],
  ['pr', 'merge', a => NUMBER_ARG.test(a), '--repo', a => REPO_ARG.test(a), '--merge', '--match-head-commit', a => SHA_ARG.test(a)],
];

export function guardArgs(args: string[]): void {
  const fits = (shape: Slot[]) => shape.length === args.length && shape.every((slot, i) => (typeof slot === 'string' ? args[i] === slot : slot(args[i]!)));
  if (!SHAPES.some(fits)) throw new GhError(`pr-loop does not run \`gh ${args.join(' ')}\` (only its fixed read calls and one plain merge-commit merge)`, args);
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

// `https://<host>/<owner>/<repo>/pull/<n>` → `owner/repo` on github.com, `host/owner/repo` elsewhere (the form gh's
// `--repo` takes), so the allow list and the loop keys tell hosts apart; null for anything else
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/([^/\s]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  return { repo: `${host === 'github.com' ? '' : `${host}/`}${m[2]}/${m[3]}`, number: Number(m[4]) };
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
    const failure = () => new GhError(`gh pr checks failed (exit ${r.code}): ${`${r.stderr}\n${r.stdout}`.trim().slice(-800)}`, args, r);
    // stdout is JSON whose names and descriptions come from the PR branch's own workflows: once it parses, only the
    // `bucket` fields decide. gh's own "no checks" message is read from stderr alone, and only when stdout holds no JSON
    let list: unknown = null;
    const out = r.stdout.trim();
    if (out) {
      try {
        list = JSON.parse(out);
      } catch {
        throw failure();
      }
    } else {
      if (r.code !== 0 && /^\s*no checks reported\b/i.test(r.stderr)) return { state: 'none' };
      if (r.code === 0) list = [];
      else throw failure();
    }
    if (!Array.isArray(list)) throw failure();
    const checks = list as { name?: string; state?: string; bucket?: string; link?: string; workflow?: string; description?: string }[];
    if (checks.length === 0) return { state: 'none' };
    const bucket = (c: (typeof checks)[number]) => String(c?.bucket ?? '').toLowerCase();
    const failed = checks.filter(c => bucket(c) === 'fail' || bucket(c) === 'cancel');
    if (failed.length) {
      return { state: 'fail', failed: failed.map(c => ({ name: String(c.name ?? ''), workflow: String(c.workflow ?? ''), link: String(c.link ?? ''), description: String(c.description ?? '') })) };
    }
    // Anything but a known passing bucket waits: an unknown one is never taken for a pass
    const pending = checks.filter(c => bucket(c) !== 'pass' && bucket(c) !== 'skipping');
    if (pending.length) return { state: 'pending', pending: pending.map(c => String(c.name ?? '')) };
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
