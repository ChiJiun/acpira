# worktree-sessions

讓 acpira 做到「每件獨立的工作一個 session、一個 git worktree、一條分支」，兩個會寫檔的 session 不再共用同一個資料夾而互相覆蓋。

## 用途

| 指令 | 做什麼 |
|---|---|
| `/worktree <分支> [起點]` | 在目前 session 所在的 git repo 建立新分支與 worktree，然後在那個資料夾開一個新 session（使用同一個 agent，標題是分支名稱）。起點可以是分支、tag 或 commit，預設是目前工作目錄的 `HEAD`。 |
| `/worktree new <分支> [起點]` | 同上；分支名稱剛好是 `list`、`remove` 等子指令名稱時使用。 |
| `/worktree list` | 用一張卡片列出每個 worktree：分支、路徑、對應的 session、未 commit 的變更數、尚未 push 的 commit 數。 |
| `/worktree remove [分支或路徑]` | 先用確認卡片問過，再執行 `git worktree remove`（不加 `--force`）。有未 commit 變更（含未追蹤檔案）時拒絕並說明。分支與 session 都不會刪除。沒給參數時先跳出選單讓你選。 |
| `/worktree config` | 顯示目前的放置位置。`/worktree config root <資料夾>` 設定，`/worktree config root default` 還原預設。 |

結果以 toast（右下角通知）與問題卡片呈現，不會送任何東西給 agent，也不花模型呼叫。

### 放置位置

- 預設放在 repo 外面的同層資料夾：repo 在 `D:\Code\My Repo\app` 時，分支 `feature/login` 的 worktree 是 `D:\Code\My Repo\app.worktrees\feature-login`。
- `root` 可以是絕對路徑，或相對於 repo 上一層資料夾的路徑；`{repo}` 會換成 repo 的資料夾名稱，例如 `/worktree config root "D:\Worktrees\{repo}"`。含空白的路徑要加引號。
- 分支名稱裡的 `/`、空白與 Windows 不允許的字元會換成 `-` 當資料夾名稱。
- 從某個 worktree 裡再執行 `/worktree`，仍以主 repo 為準放置。

### 失敗時

不是 git repo、資料夾不存在、repo 還沒有 commit、分支名稱不合法、分支已存在、起點找不到、worktree 路徑已存在、git 仍登記著該路徑、`git worktree add` 失敗，都會有說明原因的錯誤通知。建立失敗時會還原：移除這次登記的 worktree、刪掉這次建立且仍停在起點的分支、刪掉這次建立的空資料夾。

worktree 建好但 session 沒開成功（例如 agent 無法啟動）時，worktree 會保留，通知會寫出路徑，可以自己在那個資料夾開 session。

## 安裝

acpira 只從資料目錄的 `plugins/<id>/` 載入使用者外掛（預設 `~/.acpira/plugins/`），而且要在 acpira 的介面上確認後才會啟用。

1. 把這個資料夾複製到 `~/.acpira/plugins/worktree-sessions/`（資料夾名稱必須是 `worktree-sessions`）。`README.md`、`acpira.d.ts`、`tsconfig.json` 只給編輯器與人看，留著也沒關係。
2. 在 acpira 的 設定 → 外掛 頁面啟用它（或在終端機執行 `acpira plugin propose worktree-sessions` 送出提案，再到外掛頁面確認）。
3. 需求：`node`（18 以上）與 `git` 在 PATH 上。TypeScript 由 acpira 自己編譯，不需要 `npm install`。

## 給其他外掛呼叫（`plugin/call`）

在你的外掛 `plugin.json` 的 `dependencies` 或 `optionalDependencies` 宣告 `"worktree-sessions": "^0.1"`，然後：

```ts
const wt = ctx.plugins.require('worktree-sessions');
const r = await wt.create({ cwd, branch: 'fix/login', start: 'origin/main', session, agent });
// { ok: true, path, branch, commit, repo, sessionId, sessionError? } 或 { ok: false, code, error }
const l = await wt.list({ cwd });
// { ok: true, repo, worktrees: [{ path, branch, head, main, exists, dirty, upstream, unpushed, behind, locked, sessions }] }
```

- `create` 要開 session 時必須帶 `session`（呼叫端所在、使用者正在看或已有對話的 session，見下方限制）；只要 worktree 不要 session 就傳 `open: false`。
- 預期內的失敗（分支已存在等）以 `{ ok: false, code, error }` 回傳，不丟例外；`code` 是 `git.ts` 的 `ErrorCode`。
- 外掛方法呼叫上限 10 秒（引擎的 `RUNTIME_TIMEOUT_SECS`），很大的 repo 在慢機器上 checkout 可能超時；超時時呼叫端拿到錯誤，但 worktree 仍可能在背景建好，請用 `list` 確認。
- 移除沒有提供給其他外掛：移除一定要經過使用者的確認卡片。

## 限制

- **新 session 不會自動切到畫面上。** 外掛的 `session/act` 走外掛自己的 viewer，引擎刻意不移動視窗的選取。新 session 會出現在側欄的 session 清單（標題是分支名稱），要自己點開。
- **空 session 的保留。** 引擎在同一個 viewer 開新 session 時，會丟掉目前那個「還沒有任何對話、也沒有其他視窗在看」的 session。外掛開新 session 前會先把自己的 viewer 移回下指令的 session（使用者正在看，所以不會被丟掉），讓先前開出、還沒用過的 worktree session 不受影響。若呼叫端傳入的 `session` 既沒有對話、也沒有視窗在看，它可能被引擎丟掉。
- 只建立**新**分支的 worktree；要替既有分支建 worktree 請自己用 `git worktree add`。
- 不會刪除分支或 session，也不會執行 `git worktree prune`；資料夾已被手動刪掉的 worktree 會在清單標示，請自己 prune。
- Windows 上若有程式（例如該 worktree 的 session 仍在執行的 agent，或編輯器）正在使用那個 worktree 資料夾，`git worktree remove` 可能失敗，甚至只刪掉部分檔案（worktree 是乾淨的，內容都在 git 裡，不會遺失），錯誤通知會帶出 git 的訊息。確認卡片會列出工作目錄在那裡的 session，建議先停止它們。
- 「對應的 session」是依 session 的工作目錄比對，加上外掛自己記錄的建立紀錄；SSH 遠端工作區沒有測試過。
- 「尚未 push」：有 upstream 時是 upstream 沒有的 commit 數；沒有 upstream 時是不在任何遠端分支上的 commit 數。
- 卡片的 `message` 以純文字顯示，所以清單把每個 worktree 放在選項的說明裡。
