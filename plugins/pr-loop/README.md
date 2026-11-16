# pr-loop

把「開 PR → 獨立 review → 退回修正 → 重新 review → CI → 合併」從「靠 agent 記得照做」變成 Acpira 外掛執行的流程。一個 PR 一個循環，由 `/pr-loop` 指令在實作 session 裡啟動。

## 流程

1. **啟動**：實作 session 開好 PR 後，在同一個 session 輸入 `/pr-loop <PR 編號或網址> [需求原文]`。
2. **檢查目標**：用 `gh auth status` 確認已登入，`gh pr view` 讀 PR，確認 PR 所在的 repo 在允許清單內、PR 是 OPEN。清單是空的或 repo 不在清單內就不啟動，並告訴你怎麼設定。
3. **獨立 review**：每一輪都用 `newSession` 開一個全新的 reviewer session（不 fork、不沿用上一輪、不帶實作 session 的對話），送出 brief。brief 只包含：
   - 要 review 的 PR（網址、分支、這一輪的 head commit）；
   - 需求原文；
   - PR 描述中「給 reviewer 的重點建議」那一段（標題含這幾個字的 Markdown 段落）。

   brief 不放 PR 描述的其他段落與實作者對正確性的結論。它要求 reviewer 只讀、以程式碼和實際測試結果為準，並在回覆最後輸出固定格式的結論區塊（見下面）。reviewer 用哪個 agent 可以設定。
4. **退回修正**：有 blocking 項目時，把它們整理成修正清單送回實作 session，等 PR 的 head commit 改變（實作 session push 了新 commit）後，再開新的 reviewer 重審。
5. **CI**：review 通過後用 `gh pr checks` 檢查。還在跑就等；失敗就把失敗的檢查送回實作 session，修完後重新 review；repo 沒有 CI 視為沒有失敗。
6. **合併**：最新一輪 review 判定可合併、沒有 blocking、CI 沒有失敗，而且 head 仍是 review 過的那個 commit，才會合併。一律是 `gh pr merge <n> --repo <repo> --merge --match-head-commit <reviewed sha>`：一般 merge commit，只合併 review 過的 commit。不使用 `--auto`、`--squash`、`--rebase`，不刪分支，不 force push（`src/github.ts` 的 `guardArgs` 擋掉任何其他 gh 子指令與這些旗標）。預設合併前出確認卡片；可以改成條件都滿足時自動合併。合併後回報 merge commit 與合併內容。
7. **停下來通知你**：循環超過 5 輪、連續兩輪退回同一類問題、CI 連續兩次在同一個檢查失敗、reviewer 輸出無法解析、reviewer 回報互相衝突的意見、`gh` 失敗或未登入、PR 被關閉或被別人合併、實作或 reviewer session 不見了、引擎在開 reviewer 或合併途中停止。停下時在實作 session 出一張卡片，說明卡在哪裡、已經做了什麼、建議的選項（接續／停止循環／稍後決定）。

## 安裝

Acpira 只從資料目錄的 `plugins/<id>/`（預設 `~/.acpira/plugins/pr-loop/`）載入使用者外掛，而且要你在 Acpira 的 UI 上確認才會啟用。

1. 把這個資料夾複製到 `~/.acpira/plugins/pr-loop/`（整個資料夾，含 `plugin.json` 與 `src/`）。
2. 在 Acpira 的「設定 → 外掛」啟用 `pr-loop`，看過卡片內容後確認。Acpira 會凍結這個版本，並自己編譯 TypeScript（不需要 `npm install`）。
3. 需要 PATH 上有 `node`（18 以上）與 `gh`，並且 `gh auth login` 過。

之後修改資料夾內容不會生效，要重新啟用（產生新的凍結版本）。

## 設定

設定存在外掛自己的 storage，用指令修改：

| 指令 | 說明 | 預設 |
|---|---|---|
| `/pr-loop config` | 顯示目前設定 | |
| `/pr-loop config allow <owner>/<repo>` | 加入允許自動循環（含合併）的 repo | 空清單：任何 PR 都不會啟動 |
| `/pr-loop config disallow <owner>/<repo>` | 移出清單 | |
| `/pr-loop config reviewer <agent id>` / `same` | reviewer 用的 agent（例如實作用 `claude`、review 用 `codex`） | 與實作 session 相同 |
| `/pr-loop config merge confirm` / `auto` | 合併前出確認卡片／條件都滿足時自動合併 | `confirm` |
| `/pr-loop config poll <秒>` | 輪詢 PR 與 CI 的間隔（5–3600） | 30 |
| `/pr-loop config same-issue category+file` / `category` | 「同一類問題」的判定方式 | `category+file` |
| `/pr-loop config gh <argv>` | 執行 gh 的指令，例如 `["node","C:/tools/fake-gh.mjs"]`（測試用） | `["gh"]` |

只把約定的開發 repo（例如自己的 fork）加進允許清單。主 repo 不要加：清單外的 repo 一律不啟動，合併到主 repo 之前請自己處理。

## 指令

- `/pr-loop <PR 編號或網址> [需求原文]`：開始循環。編號會在實作 session 的資料夾用 `gh pr view` 解析成 repo；用網址最明確。
- `/pr-loop status [PR]`：狀態（階段、第幾輪、每一輪的結論、停下原因）。
- `/pr-loop stop [PR]`：停止循環（不刪除已開的 reviewer session，不合併）。
- `/pr-loop resume [PR]`：接續停下的循環。接續會做什麼，停下的卡片和 `status` 都會寫出來：開新的 reviewer、送出修正清單、重新檢查 CI 與合併條件，或重試卡住的那一步。超過 5 輪或同類問題重複時，接續代表你同意再多跑一輪。

指令的回覆、停下的通知、合併確認與合併結果都以卡片顯示在實作 session（卡片標明來自外掛，agent 看不到）；實作 session 不在這個引擎開著時改用 toast。

## 需求原文從哪裡來

依序取第一個有內容的：

1. 指令參數：`/pr-loop 12 <需求原文>`，PR 編號之後的全部文字（可以多行）。
2. PR 描述中標題含「需求原文」的段落（`## 需求原文`）。
3. 實作 session 的第一則使用者訊息（`/pr-loop` 指令本身除外）。

都沒有就不啟動。循環開始時就把需求原文存下來，之後不會再變。用了哪個來源會寫在開始的卡片與 `status`。

## reviewer 結論的固定格式

reviewer 回覆的最後要有一個區塊，`PR-LOOP-VERDICT-BEGIN` 與 `PR-LOOP-VERDICT-END` 各自單獨一行，中間是一個 JSON 物件（可以包在 ```json 圍欄裡）：

```
PR-LOOP-VERDICT-BEGIN
{"verdict": "not_mergeable",
 "blocking": [{"category": "correctness", "file": "src/a.ts", "summary": "…", "detail": "…", "fix": "…"}],
 "suggestions": [{"summary": "…", "file": ""}],
 "tests": [{"command": "pnpm test", "result": "pass", "note": ""}],
 "conflicts": []}
PR-LOOP-VERDICT-END
```

- 取回覆中**最後一個**區塊（reviewer 可能先引用格式）。
- `verdict` 只能是 `mergeable` 或 `not_mergeable`；`mergeable` 時 `blocking` 必須是空的，`not_mergeable` 時至少一項。自相矛盾、不是合法 JSON、`category` 不在清單內，都算「無法解析」並停下，不猜。
- `category` 只能是：`correctness`、`security`、`data-loss`、`error-handling`、`tests`、`spec`、`compatibility`、`performance`、`docs`、`maintainability`、`other`。
- `conflicts` 不是空的就停下，讓你決定；接續時照 reviewer 的判斷繼續。

## 「同一類問題」怎麼判定

每個 blocking 項目的類別鍵是 `category|file`（路徑正規化：反斜線轉斜線、去掉 `./` 與 `:行號`、小寫；沒有檔案記為 `*`）。最近兩輪「有結論的 review」都是不可合併，而且兩輪的類別鍵有交集，就停下。中間有一輪通過（例如 review 過了但 CI 失敗）就不算連續。`/pr-loop config same-issue category` 改成只比類別，判定更嚴格。CI 則是連續兩次失敗的檢查名稱（workflow/name）有重疊就停下。

reviewer 每一輪都是全新的，看不到上一輪的意見，所以這個判定由外掛比對，不靠 reviewer 自己說「這跟上次一樣」。

## 狀態保存與引擎重啟

- 所有循環存在外掛 storage 的 `state` 鍵，用 compare-and-swap 寫入；設定在 `config` 鍵。
- 一個循環由啟動它的引擎負責（`owner` 與心跳）。另一個引擎只在原本的引擎超過 3 次輪詢沒寫入、或實作 session 開在自己這裡時接手，避免兩個引擎同時推進同一個循環。
- 會產生無法重來的動作之前，先存一個過渡階段：開 reviewer 前存 `launching`，合併前存 `merging`。重啟後看到這兩個階段，表示引擎在這一步中途停了：
  - `launching`：不確定 reviewer 是否已經開好，停下來問你，不會自動再開一個。
  - `merging`：用 `gh pr view` 確認；已合併就回報，沒合併就停下，不會自動再合併。
- `reviewing` 階段重啟後，如果 reviewer session 已經不在這個引擎開著（讀不到它的結論），停下來問你，不會自動開新的 reviewer。
- `waitingFix`、`waitingCi` 重啟後直接接續；`confirmMerge` 重啟後重新檢查條件並再出一次確認卡片。
- 結束的循環保留最近 20 個，供 `status` 查看。

## 限制

- 外掛不能切換完全存取模式，也不能回答權限卡：reviewer 要執行測試時出現的權限卡要你自己按。reviewer 的「只讀」是寫在 brief 裡的要求，外掛無法強制。
- reviewer 和實作 session 用同一個資料夾（實作者的工作區）。reviewer 只讀，所以可以共用；如果要隔離，請搭配讓 session 開在獨立 git worktree 的外掛，但這個外掛不依賴它。
- 讀 reviewer 結論靠 `turn.ended` 事件與輪詢 `session/get`；事件可能在佇列滿時被丟掉，輪詢會補上（最多晚一個輪詢間隔）。
- 實作 session 修完後要自己 push；外掛只看 PR 的 head commit 有沒有變，不檢查 push 的內容。
- 「需要先問我」的情況（主 repo、force push、刪分支）一律不做：允許清單外不啟動，gh 呼叫經過 `guardArgs` 白名單。
- 卡片最多等 25 分鐘（引擎上限）；合併確認逾時就停下，`/pr-loop resume` 會重新檢查並再問一次。資訊卡片（指令回覆）開著的時候實作 session 不會被閒置釋放，最多 10 分鐘。

## 檔案

- `plugin.json`：manifest（`/pr-loop` 指令、`runtime.main`、`turn.ended` 事件）。
- `src/index.ts`：外掛行程，把引擎的 session API、storage 與 `gh` 子行程接到狀態機上，並每隔 `poll` 秒推進一次。
- `src/machine.ts`：狀態機（注入 `Host`、`Store`、`GitHub`，可以不靠 Acpira 與 GitHub 測試）。
- `src/github.ts`：所有 `gh` 呼叫與參數白名單。
- `src/review.ts`：brief、結論格式解析、修正清單、「同一類問題」的鍵。
- 測試：repo 根目錄的 `test/plugin-pr-loop.test.ts`。狀態機測試用假 gh 與假 host；端到端測試（真 sidecar＋暫存 home＋假 agent＋gh 替身）預設跳過，設 `ACPIRA_PR_LOOP_E2E=1` 才執行。

## 手動驗證步驟

不會碰到真實 GitHub 的做法：

1. 準備一個暫存資料夾當 home，把這個資料夾複製到 `<home>/plugins/pr-loop/`。
2. 寫一個 gh 替身（例如 `fake-gh.mjs`，依參數回應 `auth status`、`pr view --json …`、`pr checks --json …`、`pr merge`，並把每次的參數記到檔案），測試檔裡的 `FAKE_GH` 可以直接拿來用。
3. 用 `acpira --home <home>`（或桌面版的 `--ws <port> --token <t> --home <home>`）啟動，在外掛頁啟用 `pr-loop`。
4. 在一個 session 依序輸入：`/pr-loop config allow me/app`、`/pr-loop config gh ["node","<路徑>/fake-gh.mjs","<狀態檔>"]`、`/pr-loop config reviewer <agent id>`、`/pr-loop 12 <需求原文>`。
5. 確認：出現新的 reviewer session、收到的 brief 只有 PR／需求原文／重點建議；reviewer 回覆固定格式後，實作 session 出現合併確認卡片；按「合併」後 gh 替身記錄到的合併參數是 `pr merge 12 --repo me/app --merge --match-head-commit <sha>`。
