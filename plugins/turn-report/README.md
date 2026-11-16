# turn-report

回合結束時檢查 agent 的收尾回報。若這個回合有改檔案或執行指令，但最後的回覆沒有交代下面三件事，外掛會自動追問 agent 一次：

1. 做了哪些事（改了哪些檔案、執行了哪些指令）
2. 為什麼這樣做
3. 還有哪些沒做完或沒驗證的地方

只有問答、沒有動手的回合不檢查。每個使用者請求預設最多追問一次，不會無限迴圈。

## 安裝

acpira 只會載入資料目錄 `plugins/<id>/` 底下的使用者外掛（預設 `~/.acpira/plugins/`），而且要使用者在 UI 上確認後才會啟用。這個資料夾只是原始碼。

1. 把整個資料夾複製到 `~/.acpira/plugins/turn-report/`（資料夾名稱必須是 `turn-report`）。
2. 在 acpira 的 Settings → Plugins 找到 Turn report，打開開關。也可以請 agent 呼叫 `plugin_activate`，再點它附上的卡片。
3. 需要 PATH 上有 Node 18 以上（`requires: ["node"]`）。acpira 會在凍結版本時自己把 TypeScript 編譯好，不需要 `npm install`。

之後若修改了資料夾內容，要重新啟用一次才會生效，因為 acpira 只執行使用者確認過的凍結版本。

## 運作方式

外掛只使用 runtime 的兩個事件和一個 session API，不註冊任何 hook：

- `turn.started`：使用者自己的新請求（`origin` 是 `user` 或 `goal`，而且不是外掛自己送的追問）會把追問次數歸零。
- `turn.ended`：只看 `stop: "end_turn"` 而且沒有錯誤的回合。等 0.6 秒後用 `session/get` 讀回 session，再交給 `report.ts` 判斷：
  - 範圍是「最後一則非自動的使用者訊息」之後的所有 agent 回合，所以 workspace gate 的自動追問、Retry 之後的 continue 都算同一個請求。
  - 只要有 `edit`、`delete`、`move` 或 `execute` 類的工具呼叫成功（失敗或取消的不算），就算有動手。純唯讀的指令（`git status`、`ls`、`rg`、`Get-ChildItem` 等，而且沒有重新導向寫入檔案）預設不算。
  - 「最後的回覆」是最後一個 agent 回合中，最後一個工具呼叫之後的文字。若 agent 有標記 `phase: "final"`（例如 Codex），就只看 final 的部分。
- 需要追問時，用 `session/act` 的 `send` 送出一則以 `[turn-report]` 開頭的訊息。訊息會列出缺少的部分，也會附上偵測到的檔案與指令，方便 agent 回想。

### 為什麼不用 `hooks.afterTurn`

外掛也能透過 `contributes.hooks.afterTurn` 掛上工作區 gate。被 block 時，引擎會把理由當成自動追問（`Origin::Gate`）送回 agent。比較程式碼後，沒有選這條路，原因如下：

- **拿不到回覆文字。** afterTurn 的 payload（`rust/crates/acpira-host/src/acp/session/hooks.rs` 的 `gate()`）只有 `session_id`、`agent`、`cwd`、`stop_hook_active`、`round`、`turn_files`、`changed_files`、`turn_tools`、`file_sources`、`read_files`，沒有 agent 的最後回覆。hook 又是一個 shell 指令，沒有 session API 可以查。要判斷有沒有涵蓋三件事就得另外接 runtime（例如 `transcript` hook 把文字寫進資料夾，再讓 afterTurn 腳本去讀），但兩者是非同步的，存在時序競爭。
- **追問次數不歸外掛管。** 外掛的 hooks 接在專案 `.agents/hooks.json` 之後（`HooksConfig.chained`），只有專案自己的 `rounds`（預設 2）與 `watch` 算數，外掛無法設定自己的上限。`round` 計數也和專案自己的 afterTurn 共用：專案的 gate 擋過一次後，外掛看到的 `round` 已經是 1；專案若把 `rounds` 設為 0，外掛一擋就會直接出現「gate 放棄」的錯誤通知。要做到「外掛最多追問一次」只能看 `round`，會和專案的 gate 互相干擾。
- **每個回合都多一段等待。** 有任何 afterTurn 時，引擎會在每個回合前後對 watch 的 work tree 拍 git snapshot，而且 gate 決定前，使用者排隊的訊息都要等著。這會發生在所有專案的所有回合，包括純問答。
- SSH 工作區不跑外掛的 hooks。

選用 runtime 事件加 `send` 的代價（README 末段「限制」有完整列表）：追問會以一般使用者訊息的樣子出現在對話中，而不是灰色的自動訊息；它也會經過專案的 `beforePrompt`，並把 gate 的 `round` 歸零。

## 判斷方式

`report.ts` 是不依賴 acpira 的純模組，`test/plugin-turn-report.test.ts` 直接測它。

- 三個部分各有一組正規表示式（不分大小寫），涵蓋繁體中文、英文，也包含部分簡體字。任一條命中就算涵蓋。比對前會先去掉 fenced code block，避免程式碼裡的 `TODO` 被當成回報。
  - 做了哪些事：例如「修改了」「新增」「變更」「完成」、`changed` / `updated` / `ran`，或出現檔案路徑、常見副檔名的檔名。
  - 為什麼：例如「因為」「為了」「原因」「避免」「確保」、`because` / `so that` / `in order to`。
  - 沒做完／沒驗證：例如「未完成」「尚未」「沒驗證」「限制」「後續」，也接受「都已完成」「沒有遺留」、`nothing left` / `all tests passed` 這類「全部完成」的明確說法。
- 預設三項都要有才算通過。回覆長度達到 800 字元以上時，有兩項就算通過，因為長篇回報通常已經交代清楚。
- 設計原則是寧可少擋：只要有一點跡象就算涵蓋。

### 已知的誤判

- **該擋沒擋（放行）：** 關鍵字很寬，像「還有」「注意」「指令」「所以」「done」都會命中，所以只是順口提到也算數，即使內容並沒有真正說明。例如「改了 a.ts，所以好了，還有其他問題嗎？」會通過。
- **不該擋卻擋（追問）：**
  - 回報寫在程式碼區塊或表格裡，或改用其他語言、少見的說法（例如只寫「理由：無」以外的同義詞），可能被判成缺少。
  - 回報寫在工具呼叫之前，之後又跑了一個工具，最後只剩一句「好了」：外掛只看最後一個工具呼叫之後的文字。
  - 被當成「有動手」的指令其實是唯讀的，但不在唯讀清單中（例如 `pnpm test`、`cargo check`），這時回合不會被當成純問答。
- **看不到的工作：** 外部 CLI（Claude Code、Codex 等）的工具呼叫要透過 ACP 回報給 acpira 才看得到。agent 在子代理（subagent）裡做的事只算在委派那一列；若工具種類回報成 `other`（例如部分 MCP 工具），預設不算動手，可用 `workKinds` 調整。

### 選用：請模型再看一次

設定 `model.enabled: true` 後，關鍵字判斷要追問時，會先透過 `model/generate`（acpira 內建 agent 的模型來源）請模型判斷一次。模型只能把「追問」改成「放行」，不能反過來，所以結果一定不比關鍵字判斷嚴格。呼叫失敗或回答格式不對時，沿用關鍵字判斷。預設關閉：需要在 acpira 設好內建 agent 的模型來源，而且每次判斷都會多一次模型呼叫。

## 設定

設定檔放在外掛的資料夾：`~/.acpira/plugins/.data/turn-report/config.json`（換了 acpira 資料目錄時也跟著換）。每次判斷都會重新讀取，修改後從下一個回合開始生效，不需要重新啟用。JSON 壞掉時會使用預設值，並在 acpira 的 log 記一筆。型別不對的欄位會被忽略。

```jsonc
{
  "enabled": true,
  // 每個使用者請求最多追問幾次（0 = 只記錄、不追問；上限 3）
  "maxAsks": 1,
  // 算「有動手」的工具種類
  "workKinds": ["edit", "delete", "move", "execute"],
  // 唯讀指令不算動手；readOnlyCommands 會整組取代預設清單，readOnlyCommandsExtra 則是附加
  "ignoreReadOnlyCommands": true,
  "readOnlyCommandsExtra": ["cargo\\s+check\\b"],
  // 需要涵蓋幾項才算通過；長回覆的放寬條件
  "minCovered": 3,
  "longReply": { "chars": 800, "minCovered": 2 },
  // 每一項可改名稱，patterns 會取代預設的規則，extra 則附加在預設之後
  "sections": {
    "why": { "extra": ["\\bbecuz\\b"] },
    "todo": { "label": "還有哪些沒做完或沒驗證" }
  },
  // 只檢查這些 agent（空陣列 = 全部），例如 ["claude", "codex"]
  "agents": [],
  // 追問的內容：{marker} {missing} {work} 會被替換
  "prompt": "{marker} 請補上收尾回報，缺少：{missing}\n{work}",
  "marker": "[turn-report]",
  "model": { "enabled": false, "maxTokens": 200 }
}
```

`marker` 是外掛辨認自己送出訊息的依據。不管 `prompt` 怎麼寫，送出的訊息都會以它開頭。超過 500 字元或語法錯誤的正規表示式會被略過。

## 任務清單（第二部分的調查結果）

acpira 已經有固定可見、會隨進度更新的任務清單，所以這個外掛沒有重做：

- 引擎把 ACP 的 `plan` 更新存成該回合的 `plan` block（每次更新都整份取代）。沒有 `plan` 的 agent（內建 agent、OpenCode）改用 todo 工具的結果（`packages/shared/todoTools.ts`）。
- UI 的 `PlanBar`（`packages/ui/chat/PlanBar.tsx`、`dockPlan.ts`）浮在對話底部、composer 上方，顯示最新一份清單與 `完成數/總數`，可以展開或收合。有 session goal 時，goal 會成為卡片的標題列。
- 只要還有未完成的項目，清單會一直留著，跨回合也會；全部完成後只會在該回合執行期間保留。計畫還在草稿、尚未核准時（`plan_document` 未 approved），清單不會顯示。
- 外掛 UI 的 frame 透過 `useSession()` 只拿得到計數，拿不到任務文字，所以外掛本來就無法自己做一份有內容的清單。

## 限制

- 追問是一般的使用者訊息（`session/act` 的 `send`），會以使用者訊息的外觀出現在對話中，也會經過專案的 `beforePrompt` hook。acpira 的外掛 API 沒有送出「自動訊息」的途徑。
- 判斷是在回合結束後非同步進行。若使用者在這之前已經排了下一則訊息，或下一個回合已經開始，這次就不追問，以免打斷。
- 追問次數只存在記憶體中。外掛重新啟動（升級、停用後再啟用、acpira 重開）後會歸零，最壞情況是同一個請求多追問一次。
- 只看 acpira 記錄到的工具呼叫，看不到 agent 在 ACP 之外做的事。
- 外掛無法知道使用者自訂的規則；三件事的定義是固定的，只能透過 `sections` 調整判斷用的規則。

## 測試

`test/plugin-turn-report.test.ts` 分成三組：

- `turn-report check`：直接測 `report.ts`，包括該放行、該追問、追問上限、純問答回合、中英文回覆、設定與選用的模型判斷。
- `turn-report process`：用 esbuild 把 `main.ts` 照引擎啟動 `runtime.main` 的方式包起來（SDK 的 `start`），扮演引擎那一端的 JSON-RPC，驗證「問答不追問 → 動手沒回報時追問一次 → 追問的回覆仍不完整也不再追問 → 新請求重新計數」。
- `turn-report in the sidecar`：把外掛裝進暫存 home，用 Rust sidecar 與假 agent（`hook-turn:shell=…`）跑完整流程。引擎要求外掛行程在 10 秒內回應 `initialize`（`runtime.rs` 的 `INIT_TIMEOUT`），在 Node 啟動很慢的機器上會因此失敗，既有的 `test/pluginRpc.test.ts` 也會一樣失敗。

```sh
ACPIRA_SIDECAR_BIN=<已編好的 acpira> pnpm exec vitest run test/plugin-turn-report.test.ts
```

## 手動驗證

1. 用暫存 home 啟動，避免動到真正的 `~/.acpira`：桌面版的瀏覽器測試模式 `acpira-desktop-tauri --ws <port> --token <T> --home <暫存目錄>`（從 repo 根目錄執行），或 `pnpm harness`（先 `pnpm build`，加上 `--home <暫存目錄>`）。把本資料夾複製到 `<暫存目錄>/plugins/turn-report/`，再到 Settings → Plugins 啟用。
2. 開一個 session，請 agent 做一件會改檔或跑指令的小事，並要求它「最後只回『好了』」。
3. 回合結束後約 1 秒，應該出現一則以 `[turn-report]` 開頭的訊息，列出缺少的部分；agent 回覆後不會再出現第二則。
4. 再問一個純問題（不動手），不應出現追問。
5. acpira 的 log（引擎的 stderr）中，以 `plugin turn-report: turn-report:` 開頭的行會記錄每次判斷的結果：放行、追問了哪些項目，或跳過的原因。外掛也提供 `status` 方法（給介面元件或其他外掛呼叫），會回傳每個 session 目前的追問次數。
