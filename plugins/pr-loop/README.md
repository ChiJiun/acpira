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
5. **CI**：review 通過後用 `gh pr checks` 檢查。還在跑就等；失敗就把失敗的檢查送回實作 session，修完後重新 review。結果只看 `gh pr checks --json` 每個檢查的 `bucket` 欄位；檢查的名稱與描述是 PR 分支自己的 workflow 決定的，不拿來判斷任何狀態。不認得的 `bucket` 當成還在跑。只有 stdout 沒有 JSON、而 stderr 開頭是 gh 自己的「no checks reported」時才算「沒有檢查」，而且要持續 2 分鐘（同一個 head）才視為「repo 沒有 CI」，因為剛 push 時檢查可能還沒註冊。
6. **合併**：只有「最新一輪 review 的紀錄是可合併（沒有 blocking），而且那一輪 review 的 commit 就是 PR 目前的 head、review 時的目標分支就是 PR 目前的目標分支」才會往 CI 與合併走；進入 CI 檢查、出確認卡片、真正合併前都會再檢查一次，不符合就開新的 reviewer 重審，不會合併。PR 的目標分支在 review 之後被改掉（例如 `gh pr edit --base`）時一律停下來問你，不會自動重審後合併到新的分支；接續代表你確認新的目標分支是約定的合併目標，會對它開新的 reviewer 從頭 review。合併一律是 `gh pr merge <n> --repo <repo> --merge --match-head-commit <reviewed sha>`：一般 merge commit，只合併 review 過的 commit。不使用 `--auto`、`--squash`、`--rebase`，不刪分支，不 force push（`src/github.ts` 的 `guardArgs` 是每個子指令固定形狀的正向白名單，其他參數一律拒絕）。預設合併前出確認卡片，卡片內容取自那一輪的實際紀錄（輪次、reviewer session、commit、blocking 數）；可以改成條件都滿足時自動合併。`gh pr merge` 跑完後（不論成功失敗）都再用 `gh pr view` 確認狀態是 `MERGED` 才算完成，否則停下。合併後回報 merge commit 與合併內容。
7. **停下來通知你**：「必停條件」（見下一節：輪數上限、連續兩輪同一類問題、CI 連續兩次同一個檢查失敗、reviewer 回報衝突、PR 分支的歷史被改寫）之外，還有：reviewer 輸出無法解析或那一輪沒有正常結束（例如 `cancelled`、`max_tokens`）、`gh` 失敗或未登入、PR 被關閉或被別人合併、實作或 reviewer session 不見了、實作 session 沒有在這個引擎開著（修正清單送不進去）、PR 的目標分支和 review 時不同、等太久沒有進展（reviewer 60 分鐘沒有結論、修正清單送出後 4 小時沒有新的 push、CI 2 小時沒有結果）、引擎在開 reviewer、送修正清單或合併途中停止。停下時在實作 session 出一張卡片，說明卡在哪裡、已經做了什麼、建議的選項（接續／停止循環／稍後決定）。同時成立的必停條件會一起列在同一張卡片上，接續選項下面逐條寫明「按接續代表你同意」哪些事；toast 與 `/pr-loop status` 也列出全部原因與同意事項。接續時回到停下的那一步；接續途中再失敗，會停在同一步、保留同一種接續方式，不會跳到 CI 或合併。停在合併這一步的循環，接續時一定先問 GitHub 是否已經合併。每次停下都會出一張新卡片；舊卡片只對它描述的那一次停下有效，之後再按不會有作用。

## 必停條件（集中在一個函式判斷）

`src/gate.ts` 的 `mustStop` 是純函式：輸入所有輪次的原始紀錄（每一輪 reviewer 的判斷、每個 blocking 項目的 `category` 與 `file`、回報的衝突）、每個 head 的 CI 結果（失敗的檢查名稱）、目前輪次與輪數上限、這個循環固定的「同一類問題」判定方式、你已經同意過的項目，以及「接下來要做的那一步」，回傳**所有**成立的必停條件。狀態機在每一個讓循環往前走的步驟之前都呼叫它（`machine.ts` 的 `gate`）：開新的 reviewer（`review`）、送修正清單（`fix`）、進入 CI 等待（`ci`）、合併（`merge`）。有任何一條成立就停下，全部列在同一張卡片上。

| 條件 | 在哪一步檢查 | 接續代表你同意 |
|---|---|---|
| 輪數上限：目前輪次 ≥ 上限（預設 5），而這一步會需要新的一輪 review | `review`、`fix` | 上限加一輪（只加一輪，下次再到上限會再停） |
| 連續兩輪同一類問題：最近兩輪「有結論」的 review 都是不可合併，類別鍵有交集 | `fix`（修正清單來自 review） | `repeated:review:<輪次>`：只放行這一輪 |
| CI 連續兩次在同一個檢查失敗 | `fix`（修正清單來自 CI） | `repeated:ci:<head>`：只放行這個 head |
| reviewer 回報衝突（`conflicts` 不是空的） | `fix`、`ci`、`merge` | `conflict:<輪次>`：照那一輪 reviewer 的判斷處理；之後該輪就以它的判斷計算（例如可合併） |
| PR 分支的歷史被改寫：新的 head 不是上一次 review 的 head 的後代 | `review` | `force:<舊>..<新>`：接受這一次改寫 |

- 每一輪只記錄 reviewer 說了什麼（原始資料），不記錄依設定算出來的值；「同一類問題」每次都用循環固定的判定方式從原始資料重新比對。
- 同意是逐項、綁定輪次（或 head）的：同意第 1 輪的衝突，不會放行第 2 輪的衝突；同意了重複問題，不會放行輪數上限。
- 衝突的那一輪不會被改寫成「可合併」：紀錄永遠是「回報衝突」，合併條件 `passed` 會看你是否同意了那一輪（`conflict:<輪次>`）。
- 歷史改寫的偵測：PR 的 head 和上一次 review 的 commit 不同時，用唯讀的 `gh api repos/<owner>/<repo>/compare/<舊>...<新> --jq .status`（GitHub Enterprise 加 `--hostname`）查兩者關係；`ahead`／`identical` 才算後代，`behind`／`diverged`、查詢失敗或回傳其他值一律視為改寫並停下。

## 安裝

Acpira 只從資料目錄的 `plugins/<id>/`（預設 `~/.acpira/plugins/pr-loop/`）載入使用者外掛，而且要你在 Acpira 的 UI 上確認才會啟用。

1. 把這個資料夾複製到 `~/.acpira/plugins/pr-loop/`（整個資料夾，含 `plugin.json` 與 `src/`）。
2. 在 Acpira 的「設定 → 外掛」啟用 `pr-loop`，看過卡片內容後確認。Acpira 會凍結這個版本，並自己編譯 TypeScript（不需要 `npm install`）。
3. 需要 PATH 上有 `node`（18 以上）與 `gh`，並且 `gh auth login` 過。

之後修改資料夾內容不會生效，要重新啟用（產生新的凍結版本）。

## 設定

設定存在外掛自己的 storage，用指令修改：

| 指令 | 說明 | 預設 | 分類 | 對進行中循環的影響 |
|---|---|---|---|---|
| `/pr-loop config` | 顯示目前設定 | | 只讀 | 無 |
| `/pr-loop config allow <owner>/<repo>` | 加入允許自動循環（含合併）的 repo；github.com 以外的 host 寫成 `<host>/<owner>/<repo>` | 空清單：任何 PR 都不會啟動 | 放寬：先出確認卡片 | 合併前會重新讀清單 |
| `/pr-loop config disallow <owner>/<repo>` | 移出清單 | | 收緊：直接套用 | 進入合併前與合併前一刻都會重新讀清單，不在清單就停下 |
| `/pr-loop config reviewer <agent id>` / `same` | reviewer 用的 agent（例如實作用 `claude`、review 用 `codex`） | 與實作 session 相同 | 放寬：先出確認卡片 | 下一次開 reviewer 時採用；不影響必停條件與合併條件 |
| `/pr-loop config merge auto` | 條件都滿足時直接合併（建議：在真實引擎上完整跑通過一輪之前不要用） | | 放寬：先出確認卡片 | 下一次走到合併時採用 |
| `/pr-loop config merge confirm` | 合併前出確認卡片 | `confirm` | 收緊：直接套用 | 下一次走到合併時採用 |
| `/pr-loop config poll <秒>` | 輪詢 PR 與 CI 的間隔（5–3600） | 30 | 直接套用（只影響多久檢查一次，不影響任何停止或合併條件） | 下一次輪詢採用 |
| `/pr-loop config same-issue category` | 「同一類問題」只比類別（停得比較多） | | 收緊：直接套用 | **無**：循環在開始時取用並固定這個設定 |
| `/pr-loop config same-issue category+file` | 「同一類問題」比類別＋檔案（停得比較少） | `category+file` | 放寬：先出確認卡片 | **無**：同上 |
| `/pr-loop config gh <argv>` | 執行 gh 的指令，例如 `["node","C:/tools/fake-gh.mjs"]`（測試用） | `["gh"]` | 放寬：先出確認卡片（等於指定一個以你的權限執行的程式） | 下一次 gh 呼叫採用 |

只把約定的開發 repo（例如自己的 fork）加進允許清單。主 repo 不要加：清單外的 repo 一律不啟動，合併到主 repo 之前請自己處理。

允許清單比對包含 host：`me/app` 只代表 `github.com/me/app`，GitHub Enterprise 上同名的 `ghe.example.com/me/app` 要另外加入。

放寬限制的設定不會直接生效：先在實作 session 出一張「要變更設定嗎？」的確認卡片，按「確認變更」才套用，取消或 5 分鐘沒有回應就不變更。原因是 `/pr-loop` 指令不一定是你本人輸入的（見「限制」）。會影響必停條件的設定（`same-issue`）在循環開始時就固定在循環裡（開始的卡片與 `status` 會顯示），之後怎麼改都不會讓進行中的循環少停或多停一次；用 `/pr-loop stop` 停掉再重新開始也會沿用原本的判定方式（見「狀態保存」）。

## 指令

- `/pr-loop <PR 編號或網址> [需求原文]`：開始循環。編號會在實作 session 的資料夾用 `gh pr view` 解析成 repo；用網址最明確。
- `[PR]` 參數：網址會比對 host、owner、repo 與編號，全部相同才算；只給編號時先找這個 session 的循環，多個 repo 有同一個編號就要求改用網址。
- `/pr-loop status [PR]`：狀態（階段、第幾輪、每一輪的結論、停下原因）。
- `/pr-loop stop [PR]`：停止循環（不刪除已開的 reviewer session，不合併）。正在合併（`merging`）的循環不能停止：`gh pr merge` 可能已經在跑，停止只會讓合併結果沒有人回報。
- `/pr-loop resume [PR]`：接續停下的循環。接續會做什麼，停下的卡片和 `status` 都會寫出來：開新的 reviewer、送出修正清單、重新檢查 CI 與合併條件，或重試卡住的那一步。
- `/pr-loop resume confirm [PR]`：停下的原因包含必停條件（輪數上限、同一類問題、衝突、歷史改寫）時，接續等於同意放行它們，所以指令要加 `confirm`；只打 `/pr-loop resume` 會列出要同意的事項，什麼都不做。停下卡片上的「接續」按鈕也算同意（按鈕就在同意事項旁邊）；卡片沒顯示出來（例如 session 沒開著）不算。每次接續只同意那一次停下列出的事項：卡片寫了「超過上限，再多 review 一輪」，接續才會把上限加一輪；其他原因的停下（無法解析、gh 失敗、目標分支改變、逾時……）接續後若遇到必停條件，會在那一步之前再停一次，專門問這件事。

指令的回覆、停下的通知、合併確認與合併結果都以卡片顯示在實作 session（卡片標明來自外掛，agent 看不到）；實作 session 不在這個引擎開著時改用 toast。

## 需求原文從哪裡來

依序取第一個有內容的：

1. 指令參數：`/pr-loop 12 <需求原文>`，PR 編號之後的全部文字（可以多行）。
2. PR 描述中標題含「需求原文」的段落（`## 需求原文`）。
3. 實作 session 的第一則使用者訊息（`/pr-loop` 指令本身除外）。

都沒有就不啟動。循環開始時就把需求原文存下來，之後不會再變。用了哪個來源會寫在開始的卡片與 `status`，開始的卡片也會顯示送給 reviewer 的需求原文（太長時只顯示前 1200 字）。

注意第 2 個來源：PR 描述是實作者自己寫的，等於讓被審的一方決定 reviewer 拿什麼標準審。取自 PR 描述時開始的卡片會特別提醒；不是你的需求就 `/pr-loop stop`，再用指令參數附上需求原文重新開始。最穩當的做法是一律在指令後面附上需求原文。

## reviewer 結論的固定格式

每一輪的 brief 都帶一個隨機的 nonce（16 個十六進位字元，用 `crypto.randomBytes` 產生）。reviewer 回覆的最後要有一個區塊，`PR-LOOP-VERDICT-BEGIN:<nonce>:` 與 `PR-LOOP-VERDICT-END:<nonce>:` 各自單獨一行，中間是一個 JSON 物件（可以包在 ```json 圍欄裡）：

```
PR-LOOP-VERDICT-BEGIN:3f9a0c1d7e2b4a65:
{"verdict": "not_mergeable",
 "blocking": [{"category": "correctness", "file": "src/a.ts", "summary": "…", "detail": "…", "fix": "…"}],
 "suggestions": [{"summary": "…", "file": ""}],
 "tests": [{"command": "pnpm test", "result": "pass", "note": ""}],
 "conflicts": []}
PR-LOOP-VERDICT-END:3f9a0c1d7e2b4a65:
```

- 只認這一輪 nonce 的標記；整則回覆裡這組標記必須**剛好出現一次**，零次或多於一次都算「無法解析」並停下。這是為了讓 PR 內容、測試輸出或其他文字裡夾帶的假結論區塊沒辦法冒充 reviewer 的結論（nonce 在送出 brief 時才產生，PR 作者事先猜不到）。所以 reviewer 不能在回覆裡先引用一次格式。nonce 不是秘密：它寫在 brief 裡（reviewer session 的對話紀錄看得到），也存在外掛 storage 的循環紀錄裡（`reviewer.nonce`），能讀這兩處的外掛或程式都拿得到。
- 卡片上來自 reviewer、PR 或 gh 的文字（衝突、檔名、PR 標題、錯誤訊息、修正清單、檢查名稱）一律先壓成單行或以 `> ` 引用區塊顯示，不能在卡片上冒充卡片自己的段落（例如另一個「建議的選項」）。
- 只讀 brief 那則訊息之後、下一則使用者訊息之前的 agent 回覆；之後別的外掛或 gate 再送進 reviewer session 的訊息與回覆不算結論。
- `verdict` 只能是 `mergeable` 或 `not_mergeable`；`mergeable` 時 `blocking` 必須是空的，`not_mergeable` 時至少一項。自相矛盾、不是合法 JSON、`category` 不在清單內，都算「無法解析」並停下，不猜。
- `category` 只能是：`correctness`、`security`、`data-loss`、`error-handling`、`tests`、`spec`、`compatibility`、`performance`、`docs`、`maintainability`、`other`。
- `conflicts` 不是空的就停下，讓你決定；接續（`confirm`）時照 reviewer 的判斷繼續。

## 「同一類問題」怎麼判定

每個 blocking 項目的類別鍵是 `category|file`（路徑正規化：反斜線轉斜線、去掉 `./` 與 `:行號`、小寫；沒有檔案記為 `*`）。最近兩輪「有結論的 review」（回報衝突的那一輪也算，以它的判斷為準）都是不可合併，而且兩輪的類別鍵有交集，就停下。中間有一輪通過（例如 review 過了但 CI 失敗）就不算連續。`same-issue category` 只比類別：不同檔案的同一類問題也算重複，所以停得比較多。判定方式在循環開始時固定，每次比對都從兩輪的原始項目重新算，不會因為中途改設定而失效（改成 `category+file` 會停得比較少，所以要確認卡片，而且只影響之後新開的循環）。CI 則是連續兩次失敗的檢查名稱（workflow/name）有重疊就停下。

reviewer 每一輪都是全新的，看不到上一輪的意見，所以這個判定由外掛比對，不靠 reviewer 自己說「這跟上次一樣」。

## 狀態保存與引擎重啟

- 所有循環存在外掛 storage 的 `state` 鍵，用 compare-and-swap 寫入；設定在 `config` 鍵。
- 一個循環由啟動它的引擎負責（`owner` 與心跳）。另一個引擎只在原本的引擎超過 `max(5 分鐘, 3 次輪詢)` 沒寫入、或實作 session 開在自己這裡時接手（5 分鐘大於單次 `gh` 呼叫的 120 秒逾時）。每次寫回前都會比對儲存的 `owner`：已經被另一個仍在寫入的引擎接手，這個引擎就放棄這一步，不覆寫。
- 一輪 review 的結論和下一個階段在同一次寫入裡存下（例如「第 2 輪不可合併＋待送修正清單」），之後的 `gh` 呼叫失敗再接續，不會把同一輪再記一次。
- 會產生無法重來的動作之前，先存一個過渡階段：開 reviewer 前存 `launching`，合併前存 `merging`。重啟後看到這兩個階段，表示引擎在這一步中途停了：
  - `launching`：不確定 reviewer 是否已經開好，停下來問你，不會自動再開一個。
  - `merging`：用 `gh pr view` 確認；已合併就回報，沒合併就停下，不會自動再合併。
- `reviewing` 階段重啟後，如果 reviewer session 已經不在這個引擎開著（讀不到它的結論），停下來問你，不會自動開新的 reviewer。
- 送修正清單前先存「正在送」，送出後才清掉；重啟後看到還在「正在送」而 head 沒變，表示不確定實作 session 有沒有收到，停下來問你（接續會再送一次）。
- `waitingFix`、`waitingCi` 重啟後直接接續；`confirmMerge` 重啟後重新檢查條件並再出一次確認卡片。
- 合併完成後一定回報 merge commit：即使寫回紀錄時被拒絕（例如另一個舊版引擎同時把循環標成已停止，或同一個 PR 已經開了新的循環），回報照樣送出，並註明紀錄沒寫成。
- **停止後重新開始不會歸零**：同一個 PR 用 `/pr-loop stop` 停掉後再 `/pr-loop <PR>`，新的循環沿用舊循環的輪次、每一輪的紀錄、輪數上限、CI 結果、你同意過的項目與「同一類問題」判定方式；開始的卡片會說明。所以停掉再開不能用來繞過輪數上限或重複問題。
- 不在進行中的循環（已合併、已停止、停下等你決定）沒有任何變動超過 30 天就從 storage 移除；已合併的另外只保留最近 20 個。移除之後同一個 PR 再開始就是全新的循環（輪次從 0 算）。

## 限制

- 外掛不能切換完全存取模式，也不能回答權限卡：reviewer 要執行測試時出現的權限卡要你自己按。reviewer 的「只讀」是寫在 brief 裡的要求，外掛無法強制。
- reviewer 和實作 session 用同一個資料夾（實作者的工作區）。reviewer 只讀，所以可以共用；如果要隔離，請搭配讓 session 開在獨立 git worktree 的外掛，但這個外掛不依賴它。
- 讀 reviewer 結論靠 `turn.ended` 事件與輪詢 `session/get`；事件可能在佇列滿時被丟掉，輪詢會補上（最多晚一個輪詢間隔）。
- 實作 session 修完後要自己 push；外掛只看 PR 的 head commit 有沒有變，不檢查 push 的內容。
- 「需要先問我」的情況（主 repo、force push、刪分支）一律不做：允許清單外不啟動，gh 呼叫經過 `guardArgs` 白名單。
- **卡片也可能不是你按的**：其他外掛可以用 `session/act answer` 回答任何 session 的問題卡片（`rust/crates/acpira-host/src/plugins/host_api.rs` 的 `answer` 動作），包括設定確認卡片、合併確認卡片與停下的卡片。所以這些卡片防的是「不經意的指令」，不是「惡意的外掛」：只安裝你信任的外掛。
- **合併前的最後一段**：外掛讀 PR、確認目標分支後才呼叫 `gh pr merge`；這兩步之間目標分支被改掉不會被擋（`gh pr merge` 只能比對 head commit，沒有比對目標分支的參數）。
- **合併時段**：專案的合併時段限制（code freeze、只在週末合併等）外掛不知道也不處理；`merge auto` 會在條件滿足時直接合併，有這類限制的專案請維持 `merge confirm`。
- **reviewer 開不起來也算一輪**：reviewer 在 3 分鐘內沒有開始時停下；接續開的新 reviewer 算下一輪。
- **同一類問題跨過無法解析的一輪**：判定時拿的是最近一輪「有結論」的 review，中間無法解析的那一輪會被跳過，所以「第 1 輪 A 類、第 2 輪無法解析、第 3 輪 A 類」也算重複。這是刻意偏向多停一次。
- **等待逾時**：reviewer 60 分鐘、修正 4 小時、CI 2 小時沒有進展就停下通知（接續會重新計時）；目前不能設定。
- 卡片最多等 25 分鐘（引擎上限）；合併確認逾時就停下，`/pr-loop resume` 會重新檢查並再問一次。資訊卡片（指令回覆）開著的時候實作 session 不會被閒置釋放，最多 10 分鐘。
- **指令來源**：Acpira 的 `command` hook 不分辨 `/pr-loop` 是使用者在輸入框打的，還是其他外掛用 `session/act send` 送進 session 的文字。所以會放寬限制的設定都要先按確認卡片（但見上一項：卡片本身也可能被其他外掛回答），放行必停條件的接續要明確打 `resume confirm`；`/pr-loop <PR>`、`stop`、不涉及必停條件的 `resume` 不需要確認（允許清單與合併確認卡片仍然有效）。`resume confirm` 一樣可能是其他外掛送的文字：它防的是「不經意的接續」，不是「惡意的外掛」。agent 自己無法送出 `/pr-loop`（它的輸出不會被當成指令），但其他外掛可以。
- **送到沒開著的 session**：引擎把送往「不在這個引擎開著」的 session 的訊息直接丟掉，不回傳錯誤（`rust/crates/acpira-host/src/session_manager/dispatch.rs` 約 77–84 行，log 為 "dropped: not live"）。所以送修正清單前會先用 `session/get` 確認實作 session 開著，沒開著就停下（`impl-closed`）；但「確認後、送出前」被關掉的競態仍然偵測不到，只能靠之後的輪詢發現 head 沒變。
- **reviewer 回覆的來源**：外掛只讀得到 session 的對話紀錄，分不出一則 agent 回覆是 reviewer agent 自己產生的，還是被其他外掛插入的訊息影響。nonce 與「只讀 brief 之後的回覆」降低了偽造的機會，但不是密碼學上的保證。
- **合併後的狀態**：`gh pr merge` 之後一定再讀一次 PR；狀態不是 `MERGED` 就停下（`gh` 失敗），不會記成已合併。`gh pr view` 沒有回傳 `state`（或回傳不認得的值）時當成讀取失敗，不會當成 OPEN。
- **merge queue**：repo 開了 merge queue 時，`gh pr merge` 只會把 PR 排進佇列並成功結束，PR 仍是 OPEN。外掛會因為狀態不是 `MERGED` 而停下（並提示可能是 merge queue），不會再合併一次，但也不會等佇列跑完；這種 repo 請自己看 PR 頁面確認結果。
- **「沒有 CI」只靠 2 分鐘的寬限**：`gh pr checks` 回報沒有檢查、而且同一個 head 持續 2 分鐘，就當成這個 repo 沒有 CI。檢查很晚才註冊、或 fork 來的 PR 需要維護者核准才會跑 workflow（在核准前看不到任何檢查）時，會被當成「沒有 CI」而進入合併條件（`merge confirm` 時是確認卡片，卡片會寫「這個 repo 沒有設定 CI」）。有這類情況的 repo 請維持 `merge confirm`，看到這句時先確認。
- **歷史改寫的偵測靠 GitHub 的 compare API**：只比對「上一次 review 的 commit」和「目前的 head」。查不到（例如舊 commit 已被 GitHub 回收、網路錯誤）也當成改寫而停下。
- **e2e 測試**：`test/plugin-pr-loop.test.ts` 的端到端測試（真 sidecar＋暫存 home＋假 agent＋gh 替身）預設跳過，設 `ACPIRA_PR_LOOP_E2E=1` 才執行（執行時也請把 `HOME`／`USERPROFILE` 指到暫存資料夾）。它只走「一輪通過 → 確認卡片 → 合併」這條路徑；它需要包含外掛 runtime 修正的 sidecar（較舊的 debug 版會在啟用 runtime 外掛後的第一個 prompt stack overflow，或在 node 啟動很慢的機器上超過 initialize 逾時）。退回修正、CI 失敗、必停條件等路徑只由假 gh＋假 host 的單元測試覆蓋。
- **型別檢查**：`src/index.ts` 不在 repo 任何 `tsconfig` 的範圍內（`machine.ts`、`github.ts`、`review.ts` 經由測試檔被 `test/tsconfig.json` 涵蓋）。開發時是用一個暫存的 tsconfig（extends `tsconfig.base.json`，加上 `rust/crates/acpira-host/src/plugins/acpira.d.ts`）檢查；要納入 CI 需要改共用的 tsconfig，這個外掛沒有動它。

## 檔案

- `plugin.json`：manifest（`/pr-loop` 指令、`runtime.main`、`turn.ended` 事件）。
- `src/index.ts`：外掛行程，把引擎的 session API、storage 與 `gh` 子行程接到狀態機上，並每隔 `poll` 秒推進一次。
- `src/machine.ts`：狀態機（注入 `Host`、`Store`、`GitHub`，可以不靠 Acpira 與 GitHub 測試）。
- `src/gate.ts`：必停條件的純函式 `mustStop`。
- `src/github.ts`：所有 `gh` 呼叫與參數白名單。
- `src/review.ts`：brief、結論格式解析、修正清單、「同一類問題」的鍵。
- 測試：repo 根目錄的 `test/plugin-pr-loop.test.ts`。狀態機測試用假 gh 與假 host；端到端測試（真 sidecar＋暫存 home＋假 agent＋gh 替身）預設跳過，設 `ACPIRA_PR_LOOP_E2E=1` 才執行。

## 手動驗證步驟

不會碰到真實 GitHub 的做法：

1. 準備一個暫存資料夾當 home，把這個資料夾複製到 `<home>/plugins/pr-loop/`。
2. 寫一個 gh 替身（例如 `fake-gh.mjs`，依參數回應 `auth status`、`pr view --json …`、`pr checks --json …`、`pr merge`，並把每次的參數記到檔案），測試檔裡的 `FAKE_GH` 可以直接拿來用。
3. 用 `acpira --home <home>`（或桌面版的 `--ws <port> --token <t> --home <home>`）啟動，在外掛頁啟用 `pr-loop`。
4. 在一個 session 依序輸入：`/pr-loop config allow me/app`、`/pr-loop config gh ["node","<路徑>/fake-gh.mjs","<狀態檔>"]`、`/pr-loop config reviewer <agent id>`（這三個都會先出確認卡片，按「確認變更」），再輸入 `/pr-loop 12 <需求原文>`。
5. 確認：出現新的 reviewer session、收到的 brief 只有 PR／需求原文／重點建議；reviewer 回覆固定格式後，實作 session 出現合併確認卡片；按「合併」後 gh 替身記錄到的合併參數是 `pr merge 12 --repo me/app --merge --match-head-commit <sha>`。
