# worktree-sessions

讓 acpira 做到「每件獨立的工作一個 session、一個 git worktree、一條分支」，兩個會寫檔的 session 不再共用同一個資料夾而互相覆蓋。

> **狀態：端到端尚未驗證。** git 操作有對真 repo 的自動測試；但「在 acpira 裡啟用外掛 → 下 `/worktree` → 開出 session → 卡片」這整段還沒有任何一次通過的紀錄：作者的測試機上 node 啟動就超過引擎給外掛的 10 秒初始化時限，外掛無法啟用。端到端測試要設 `ACPIRA_WORKTREE_E2E=1` 才會跑（見「測試」）。

## 用途

| 指令 | 做什麼 |
|---|---|
| `/worktree <分支> [起點]` | 在目前 session 所在的 git repo 建立新分支與 worktree，然後在那個資料夾開一個新 session（使用同一個 agent，標題是分支名稱）。起點可以是分支、tag 或 commit，預設是目前工作目錄的 `HEAD`。 |
| `/worktree new <分支> [起點]` | 同上；分支名稱剛好是 `list`、`remove` 等子指令名稱時使用。 |
| `/worktree list` | 用一張卡片列出每個 worktree：分支、路徑、對應的 session、未 commit 的變更數、被 ignore 的檔案數、尚未 push 的 commit 數。 |
| `/worktree remove [分支或路徑]` | 先用確認卡片問過，再執行 `git worktree remove`（不加 `--force`）。分支與 session 都不會刪除。沒給參數時先跳出選單讓你選。拒絕的情況見下方「移除」。 |
| `/worktree config` | 顯示目前的放置位置。`/worktree config root <資料夾>` 設定，`/worktree config root default` 還原預設。 |

結果以 toast（通知）與問題卡片呈現，不會送任何東西給 agent，也不花模型呼叫。

### 放置位置

- 預設放在 repo 外面的同層資料夾：repo 在 `D:\Code\My Repo\app` 時，分支 `feature/login` 的 worktree 是 `D:\Code\My Repo\app.worktrees\feature-login`。
- `root` 可以是絕對路徑，或相對於 repo 上一層資料夾的路徑；`{repo}` 會換成 repo 的資料夾名稱，例如 `/worktree config root "D:\Worktrees\{repo}"`。含空白的路徑要加引號。
- 分支名稱裡的 `/`、空白與 Windows 不允許的字元會換成 `-` 當資料夾名稱，所以 `x/y` 與 `x-y` 會用到同一個資料夾，第二個會因路徑已存在而被拒絕。
- 從某個 worktree 裡再執行 `/worktree`，仍以主 repo 為準放置。

### 建立與失敗時

- 先用 `git branch <分支> <起點 commit>` 建立分支（分支已存在時 git 會拒絕，這一步是原子的），再 `git worktree add <路徑> <分支>`。
- 不是 git repo、資料夾不存在、repo 還沒有 commit、分支名稱不合法、分支已存在、起點找不到、worktree 路徑已存在、git 仍登記著該路徑、git 指令失敗，都會有說明原因的錯誤通知。
- `git worktree add` 失敗時只還原這次確實建立的東西：登記在該路徑「而且是這個分支」的 worktree，以及這次建立的分支（只在它仍指向起點、沒有任何 worktree 使用時，用 `git update-ref -d` 比對後刪除）。資料夾交給 git 自己清理，不會去刪別人的資料夾。所以兩個引擎、或使用者與外掛同時建立同名分支或同一路徑時，失敗的一方不會刪掉成功一方的東西。
- worktree 建好但 session 沒開成功時，worktree 會保留，通知會寫出路徑，可以自己在那個資料夾開 session。session 開出來但 agent 啟動失敗或需要登入時，session 會保留，通知會說明（不當成成功）。

### 移除

會拒絕並說明原因的情況：

- 主工作目錄、bare repo、被 `git worktree lock` 鎖定、資料夾已不存在。
- 有未 commit 的變更（含未追蹤檔案）。
- detached HEAD 上有不在任何分支、tag 或遠端上的 commit（移除後只能從 reflog 找回）。
- **Windows 上，有工作目錄在該 worktree、而且 agent 可能還在執行的 session**（狀態為 starting / ready / auth_required）。Windows 無法刪除程式正在使用的資料夾，硬刪會留下「已取消登記、內容清空一半」的資料夾。請先讓那些 session 停下來再移除。確認卡片打開期間如果有 session 開始，按下確認後也會再檢查一次。

確認卡片會寫出：被 `.gitignore` 忽略的檔案數（例如 `.env`、`build/`；它們不算變更，但會一起被刪除，無法從 git 找回）、分支上還沒 push 的 commit 數、工作目錄在那裡的 session。

`git worktree remove` 仍然失敗時（例如被編輯器等其他程式占用），外掛會重新查看實際狀態再回報：git 是否已取消登記、資料夾裡還剩多少項目、要怎麼收拾；已取消登記時也會清掉外掛自己的 session 對應紀錄。

## 安裝

acpira 只從資料目錄的 `plugins/<id>/` 載入使用者外掛（預設 `~/.acpira/plugins/`），而且要在 acpira 的介面上確認後才會啟用。

1. 把這個資料夾複製到 `~/.acpira/plugins/worktree-sessions/`（資料夾名稱必須是 `worktree-sessions`）。`README.md`、`acpira.d.ts`、`tsconfig.json` 只給編輯器與人看，留著也沒關係。
2. 在 acpira 的 設定 → 外掛 頁面啟用它（或在終端機執行 `acpira plugin propose worktree-sessions` 送出提案，再到外掛頁面確認）。
3. 需求：`node`（18 以上）與 `git`（2.31 以上，需要 `rev-parse --path-format`）在 PATH 上。TypeScript 由 acpira 自己編譯，不需要 `npm install`。

## 給其他外掛呼叫（`plugin/call`）

在你的外掛 `plugin.json` 的 `dependencies` 或 `optionalDependencies` 宣告 `"worktree-sessions": "^0.1"`，然後：

```ts
const wt = ctx.plugins.require('worktree-sessions');
const r = await wt.create({ cwd, branch: 'fix/login', start: 'origin/main', session, agent });
// { ok: true, path, branch, commit, repo, sessionId: null, sessionPending: true } 或 { ok: false, code, error }
const o = await wt.opened({ path: r.path });
// { state: 'pending' | 'done' | 'failed' | 'unknown', sessionId, sessionError? }
const l = await wt.list({ cwd });
// { ok: true, repo, worktrees: [{ path, branch, head, main, exists, dirty, ignored, upstream, unpushed, behind, noRemote, unreferenced, locked, sessions }] }
```

- `create` 在 worktree 建好後就回應，session 在背景開（啟動 agent 可能超過外掛方法的 10 秒上限，連續逾時 3 次會讓整個外掛暫停 60 秒），之後用 `opened` 或 `list` 查 session id。
- `create` 要開 session 時必須帶 `session`（呼叫端所在、使用者正在看或已有對話的 session，見下方限制）；只要 worktree 不要 session 就傳 `open: false`。
- 預期內的失敗（分支已存在等）以 `{ ok: false, code, error }` 回傳，不丟例外；`code` 是 `git.ts` 的 `ErrorCode`。
- 建立 worktree 本身仍受 10 秒上限；很大的 repo 在慢機器上 checkout 可能逾時，逾時時 worktree 仍可能在背景建好，請用 `list` 確認。
- `opened` 的進行中狀態只存在外掛行程的記憶體裡，外掛重啟後只查得到已完成的對應。
- 移除沒有提供給其他外掛：移除一定要經過使用者的確認卡片。

## 限制

- **新 session 不會自動切到畫面上。** 外掛的 `session/act` 走外掛自己的 viewer，引擎刻意不移動視窗的選取。新 session 會出現在側欄的 session 清單（標題是分支名稱），要自己點開。
- **空 session 的保留。** 引擎在同一個 viewer 開新 session 時，會丟掉目前那個「還沒有任何對話、也沒有其他視窗在看」的 session。外掛開新 session 前會先把自己的 viewer 切到下指令的 session，並確認引擎回報的 active 就是它、它也確實開著；不是的話就不開 session。開完後 viewer 會再切回去，不會停在新 session 上（停著的話引擎不會替新 session 標未讀）。若呼叫端傳入的 `session` 既沒有對話、也沒有視窗在看，它仍可能被引擎丟掉。
- 只建立**新**分支的 worktree；要替既有分支建 worktree 請自己用 `git worktree add`。
- 不會刪除分支或 session，也不會執行 `git worktree prune`；資料夾已被手動刪掉的 worktree 會在清單標示，請自己 prune。
- 「尚未 push」：有 upstream 時是 upstream 沒有的 commit 數；沒有 upstream 時是不在任何遠端分支上的 commit 數；repo 完全沒有遠端時顯示「沒有設定遠端」。
- 「對應的 session」是依 session 的工作目錄比對，加上外掛自己記錄的建立紀錄。
- 卡片的 `message` 以純文字顯示，所以清單把每個 worktree 放在選項的說明裡。
- 外掛在同一個行程內把建立與移除排成一個接一個做；不同引擎各跑一份外掛時不互相排隊，靠的是上面「先建分支」的原子性與只還原自己的東西。
- repo 佈局（以 `git rev-parse --show-toplevel --git-common-dir` 判斷，只讀程式碼推論，除了一般 repo 與 linked worktree 以外都沒有測試）：
  - 一般 repo、從 linked worktree 裡執行：以主工作目錄為準。
  - separate git dir（`.git` 是指向別處的檔案、common dir 不叫 `.git`）：以目前的工作目錄為準放置。
  - submodule：common dir 在上層 repo 的 `.git/modules/…` 底下，名稱不是 `.git`，所以以 submodule 自己的工作目錄為準；git 對 submodule 的 worktree 支援有限，不建議使用。
  - bare repo：沒有工作目錄，`--show-toplevel` 失敗，回報「不是 git repo 的工作目錄」。
  - SSH 遠端工作區（session 的資料夾是遠端 URI）：不支援，會回報資料夾不存在。

## 測試

在 repo 根目錄：

```sh
ACPIRA_SIDECAR_BIN=<acpira 執行檔> vitest run test/plugin-worktree-sessions.test.ts
# 連同端到端（經 sidecar、假 agent 啟用外掛並下指令）：
ACPIRA_WORKTREE_E2E=1 ACPIRA_SIDECAR_BIN=<acpira 執行檔> vitest run test/plugin-worktree-sessions.test.ts
```
