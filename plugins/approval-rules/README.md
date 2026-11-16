# approval-rules

把「這些動作一定要先問我」從 agent 的自律變成 harness 強制執行的規則，但只對 **agent 有送到 Acpira 的權限請求**有效。

Acpira 在 agent 送來的每個權限請求交給完全存取（Acpira 合成的自動核准）、計畫自動核准或卡片之前，都會先問外掛的 `permission` hook。這個外掛檢查請求內容，命中規則時要求 Acpira 一定要出確認卡片，或依設定直接拒絕。外掛做不到核准，所以它只會讓規則更嚴，不會放寬使用者的決定。

**擋不住的情況：** Claude Code 的「完全存取」用的是它原生的 `bypassPermissions` 模式（引擎 `registry.rs` 的對應），Codex 的完全存取從不詢問；這兩種模式下 CLI 自己就放行，幾乎不送權限請求，`git push`、刪檔、改設定檔都不會經過這個外掛。外掛也擋不住它自己沒在執行或逾時的時候（見「限制」）。

## 預設規則

| id | 命中時 | 涵蓋 |
|---|---|---|
| `delete-files` | 卡片 | `rm` / `rmdir` / `unlink` / `shred` / `rimraf` / `find -delete` / `find -exec rm`、cmd 的 `del` / `erase` / `rd`、PowerShell 的 `Remove-Item`（含 `ri`、`rm`、`del` 等別名）與 `[IO.File]::Delete`、`mv x /dev/null`、刪除類工具（kind `delete`）、`node -e` / `python -c` 等內嵌程式碼裡的刪除 API |
| `git-discard` | 卡片 | `git rm`、`git clean`、`git reset --hard` / `--merge` / `--keep`、`git checkout -- <path>` / `checkout .` / `checkout <像檔案的名稱>`（`src/a.ts`）/ `checkout -f` / `-B`、`git restore`（只有 `--staged` 除外）、`git switch -f` / `-C` / `--discard-changes`、`git stash drop` / `clear`、`git worktree remove` / `prune`、`git filter-branch` |
| `git-push` | 卡片 | 任何 `git push` |
| `config-files` | 卡片 | 編輯類工具改到設定檔、shell 寫入設定檔（`>`、`>>`、`tee`、`sed -i`、`cp`、`mv`、`Set-Content`、`Add-Content`、`Out-File` …；相對路徑會接上 session 目錄與同一行前面的 `cd` / `pushd` / `Set-Location`）、`node -e` / `python -c` 等內嵌程式碼用寫檔 API 寫到字串裡的設定檔、`git config` 寫入、`git remote add` / `set-url` …、`npm` / `pnpm` / `yarn config set`、`npm pkg set`、`gh alias set` / `import` / `delete`、`setx` |
| `branch-delete` | 卡片 | `git branch -d` / `-D` / `--delete`、`git tag -d`、`git push --delete` / `-d` / `:branch` / `--prune`、`gh pr merge --delete-branch`、`DELETE …/git/refs/…` |
| `gh-merge` | 卡片 | `gh pr merge`、對 `…/pulls/N/merge` 的 API 寫入（`gh api`，或 `curl` / `wget` / `http` / `Invoke-RestMethod` 直接打 `api.github.com`）、GraphQL `mergePullRequest` |
| `foreign-repo` | 卡片 | `git push` 到 `allowedRemotes` 以外的遠端（預設只有 `origin`）或 `allowedRepos` 以外的 URL；`gh` 的寫入操作（`pr create`、`issue comment`、`release create`、非 GET 的 `gh api` …）沒有帶 `--repo`，或帶的 repo 不在 `allowedRepos`；`curl` 等直接對 `api.github.com` 的寫入；GraphQL mutation（或內容放在檔案裡、看不到的 GraphQL 請求）。只讀的 GraphQL query 不算 |
| `force-push` | 卡片（高風險） | `git push -f` / `--force` / `--force-with-lease[=…]` / `--force-if-includes` / `--mirror`、`+refspec`（`origin +main`）、短旗標組合（`-fu`） |
| `merge-auto` | 卡片（高風險） | `gh pr merge --auto`、`gh repo edit --enable-auto-merge`、GraphQL `enablePullRequestAutoMerge` |
| `merge-squash` | 卡片（高風險） | `gh pr merge --squash` / `-s`、`merge_method=squash`、本機的 `git merge --squash` |
| `merge-rebase` | 卡片（高風險） | `gh pr merge --rebase` / `-r`、`merge_method=rebase` |
| `repo-delete` | 卡片（高風險） | `gh repo delete`、`gh api -X DELETE repos/<owner>/<repo>`、GraphQL `deleteRepository` |
| `unparsed` | 卡片 | 解析不完整（引號沒關、巢狀太深、包了太多層、程式名稱是變數、`sh` 從輸入讀腳本、內嵌程式碼、無法解碼的 `-EncodedCommand`）而且含有危險關鍵字；不認得的 `gh` 子指令（`gh alias set` 設的別名或擴充指令） |
| `self-config` | 卡片（不能停用） | 改這個外掛自己的設定或程式：`<home>/plugins/.data/approval-rules/**`、任何專案的 `.agents/approval-rules.json`、`plugins/state.json`（Acpira 記錄哪些外掛啟用）、`plugins/approval-rules/**`、`plugins/.versions/approval-rules/**`。樣式比對任何深度，所以在這個 repo 裡改外掛原始碼也會出卡片 |
| `unreadable` | 卡片（不能停用） | 無法判斷要執行什麼或寫到哪裡：指令超過 16 KiB（不解析直接要求卡片）、判斷超過 2 秒、執行類請求（tool call 或 row 任一個 kind 是 `execute`）找不到指令內容、`cd $DIR` / `cd -` / 堆疊空掉的 `popd` 之後寫入或刪除相對路徑、路徑超過 4096 字元或含 8.3 短檔名（`GITHUB~1`） |

高風險規則預設同樣出卡片，`"highRisk": "deny"` 讓它們直接拒絕。

判斷前路徑會先正規化：`\` 與 `/` 一樣、`//` 與 `/./` 合併、`x/..` 消掉、檔名結尾的 `.` 與空白去掉（Windows 會忽略）、`::$DATA` 去掉，全部不分大小寫。

預設的設定檔樣式在 `rules.ts` 的 `DEFAULT_CONFIG_FILES`：`.env*`、`.envrc`、金鑰檔、`.npmrc`；CI（`.github/workflows/**`、`.gitlab-ci.yml`、`.circleci/**` …）；`.gitignore`、`.gitattributes`、`.git/config`、git hooks；`package.json`、`Cargo.toml`、`pyproject.toml`、`tsconfig*.json`、`*.config.{js,ts,…}`、ESLint / Prettier / Babel 設定、Dockerfile 與 compose 檔；agent 自己的規則與設定：`CLAUDE.md`、`AGENTS.md`、`GEMINI.md`、`.agents/**`、`.claude/**`、`.codex/**`、`.cursor/**`、`.mcp.json`、`.vscode/**`、`.idea/**`、`.acpira/**`。樣式不分大小寫、比對任何深度（`package.json` 就是 `**/package.json`），`dir/**` 也包含資料夾本身。

### 邊界的取捨

- 只寫入不了東西的「試跑」不出卡片：`git push --dry-run` / `-n`（含 `--dry-run --force`）、`git clean -n`、`git rm -n`。它們不會改到任何東西；想連試跑都要確認，可加一條自訂規則。
- `git checkout <name>` 只在名稱像檔案時出卡片（`./x`、含 `\` 或 `*`、結尾是英文字母開頭的副檔名，例如 `a.ts`、`package.json`）；`feature/login`、`v1.2.3` 這類分支與 tag 不出卡片。沒有副檔名的檔案（`git checkout Makefile`）會漏掉，名稱結尾像副檔名的分支（`release-1.x`）會多出卡片。
- `git rm --cached` 仍然出卡片（屬於 `git rm`）。
- 引號裡的文字是資料：`git commit -m "fix git push docs"`、`echo "rm -rf /"`、`grep "git push"` 都不會命中；quoted heredoc（`$(cat <<'EOF' … EOF)` 的 commit message）也是資料。
- 讀取設定檔（kind `read`、`cat .env`）不出卡片。
- PowerShell 的 `{ … }` 在 POSIX 讀法下也會拆開（`if (…) {Remove-Item x}`、`ForEach-Object {rm $_}`、`& {git push}`）；單字開頭的 `{a,b}`、`{1..3}` 與 `find` 的 `{}` 仍當成一般的字。
- 內嵌程式碼只在同時出現寫檔 API（`writeFileSync`、`write_text`、`File.write`、`open(…, 'w')` …）時，才拿字串常值去比對設定檔樣式；`require('./package.json')` 這種讀取不出卡片。

## 安裝

Acpira 只從資料目錄載入外掛，而且要使用者在 UI 確認才會啟用；這個 repo 裡的是原始碼。

1. 把整個 `plugins/approval-rules/` 資料夾複製到 `~/.acpira/plugins/approval-rules/`（用 `--home` / `ACPIRA_HOME` 換過資料目錄時，是 `<home>/plugins/approval-rules/`）。
2. 在 Acpira 的「設定 → 外掛」啟用它，或請 agent 呼叫 `plugin_activate`（`approval-rules`）後點卡片；`acpira plugin propose approval-rules` 只會送出提案，仍要在 UI 確認。
3. 需要 PATH 上有 Node 18 以上。TypeScript 由 Acpira 在凍結版本時自己編譯，不需要 `npm install`。

修改資料夾內容後要重新啟用才會換成新版本（Acpira 只執行凍結過的版本）。設定檔不用：每次權限請求都會重新讀。

## 設定

### 使用者層級：`<home>/plugins/.data/approval-rules/config.json`

可以新增、停用、調整規則，範例在 `config.example.json`：

```json
{
  "highRisk": "deny",
  "allowedRemotes": ["origin"],
  "allowedRepos": ["ChiJiun/acpira"],
  "rules": { "git-push": { "enabled": false }, "delete-files": { "action": "deny" } },
  "configFiles": { "add": ["deploy/**/*.yaml"], "remove": ["package.json"] },
  "custom": [
    { "id": "terraform-apply", "description": "terraform apply", "command": ["terraform", "apply"] },
    { "id": "prod", "description": "正式環境", "pattern": "kubectl\\b.*--context[= ]prod", "action": "deny" },
    { "id": "migrations", "paths": ["migrations/**"] }
  ],
  "toast": true
}
```

- `highRisk`：`"ask"`（預設）或 `"deny"`，套用到所有高風險規則。
- `rules.<id>`：`{ "enabled": false }` 停用、`{ "action": "ask" | "deny" }` 改動作（比 `highRisk` 優先）。`self-config` 不能停用。
- `configFiles`：`add`、`remove`（逐字比對預設清單裡的樣式）、`replace`（整份換掉）。
- `allowedRemotes`：`git push` 可以直接指名、不觸發 `foreign-repo` 的遠端名稱。`allowedRepos`：`owner/repo`（視為 `github.com/owner/repo`）或 `host/owner/repo`，`gh` 寫入時帶的 `--repo` 與 push 的 URL 在清單內才不觸發 `foreign-repo`；比對包含主機，GitHub Enterprise 上的同名 repo 不算。沒設定 `allowedRepos` 時，所有 `gh` 寫入都會出卡片。
- `custom`：自訂規則，`action` 預設 `"ask"`。`command` 是程式名稱加上必須依序出現的字（中間的旗標忽略，`["terraform", "apply"]` 會命中 `terraform -chdir=x apply`）；`paths` 是檔案樣式（編輯、刪除、shell 寫入）；`pattern` 是對每行指令的正規表示式（不分大小寫）。
- `toast`：出卡片時是否另外跳通知說明命中哪條規則（預設 `true`）。

### 專案層級：`<專案>/.agents/approval-rules.json`

agent 自己改得到專案檔，所以專案層級**只能新增規則**：只接受 `configFiles.add` 與 `custom`（`command`、`paths`；不接受 `pattern`，避免一條惡意的正規表示式拖到 hook 逾時而讓規則失效）。glob 不用正規表示式比對（逐段比對，不會回溯爆炸），每個 glob 最多 300 字元、16 個 `*`、32 種 `{a,b}` 組合，專案層級全部加起來最多 500 個；超過的略過並警告。其他欄位（`rules`、`highRisk`、`allowedRepos`、`allowedRemotes`、`configFiles.remove` …）一律忽略並跳出警告。這個檔案本身受 `self-config` 保護。

```json
{ "configFiles": { "add": ["secrets/**"] }, "custom": [{ "id": "deploy", "description": "部署", "command": ["make", "deploy"] }] }
```

設定檔讀不到或不是有效 JSON 時，該層改用預設值並跳出一次警告通知；預設規則永遠有效。

## 限制

- **不能核准，也沒有自動放行清單。** Acpira 的 `permission` hook 只能拒絕或要求出卡片（`acp/session/gates.rs`、`plugin_hooks.rs`）。要讓某些請求自動放行，得改引擎的 `gates.rs`，不在這個外掛的範圍。
- **卡片上看不到命中哪條規則。** hook 的「要求出卡片」不帶說明（引擎的 `PermVerdict::Ask` 沒有 reason），所以外掛改用通知（toast）說明命中的規則與指令，並寫進 Acpira 的 log。拒絕時的理由會出現在引擎的通知裡。
- **只看得到 agent 真的送出的權限請求。** 外部 CLI 的工具呼叫不經過引擎，只有它們的權限請求會到 `permission`。CLI 自己放行、沒送請求的動作，這個外掛看不到：
  - Claude Code 的「完全存取」對應它原生的 `bypassPermissions` 模式，CLI 幾乎不再送權限請求（只有它自己的 bypass-immune 檢查，例如部分刪除類 Bash，仍會送）。在這個模式下 `git push`、改設定檔都不會經過本外掛。`acceptEdits` / `auto` 等級下 CLI 自己放行的編輯與指令也一樣。
  - Codex 的完全存取從不詢問。
  - 會經過本外掛的是：CLI 送出的每一個權限請求，包括 Acpira 自己合成的完全存取（agent 沒有原生完全存取模式、由 Acpira 自動核准，例如端到端測試裡的假 agent）、計畫模式的自動核准，以及 Claude Code「詢問」等級下的所有請求。
  - 要在 Claude Code 的原生完全存取下也擋住，需要搭配 Claude Code 自己的 `permissions.ask` / `deny` 設定，或讓引擎在原生完全存取時改用合成的自動核准（要改引擎，不在這次範圍）。
- **外掛掛掉時規則不會生效。** 引擎把 hook 失敗、逾時（這個外掛設成上限 10 秒；外掛自己在 2 秒內判斷不完、或指令超過 16 KiB 時直接要求卡片，避免拖到逾時）、程序沒在執行（啟動中、當掉後重啟的空檔）、連續 3 次失敗後暫停 60 秒、safe mode，一律當成「沒有意見」，請求照原本的流程走（完全存取下就是直接核准）。外掛自己的程式碼丟出例外時會回「要求出卡片」（fail closed），但程序層級的失敗只能靠引擎，外掛做不到。
- **不保證擋住刻意繞過。** 解析是保守的字面分析，不會展開變數或執行任何東西：用變數拼出程式名稱再搭配看不出危險的參數、`$'\x72m'` 這類編碼、`~/.gitconfig` 裡的 git alias、腳本檔（`bash deploy.sh`）的內容、其他程式間接執行的指令，都可能漏掉。目標是擋住 agent 正常寫法的各種變體，不是對抗惡意程式。已知還會漏的：
  - 內嵌程式碼用變數組出的檔名（`p = 'package' + '.json'`）、或不在清單裡的寫檔 API；內嵌程式碼裡的 `chdir` 不追蹤。
  - `( cd x )` 子 shell 裡的 `cd` 會被當成延續到後面（通常只會多出卡片，因為樣式比對任何深度）；`git -C <dir>`、`npm --prefix` 之類換目錄的旗標不追蹤。
  - `gh` 以外的 GitHub API 用戶端（SDK、`octokit` 腳本），以及 GitHub Enterprise 的 API 網址（`curl` 只認得 `api.github.com`）。
  - 8.3 短檔名只出 `unreadable` 卡片，不會還原成原本的名稱；符號連結、junction、硬連結指到設定檔不會發現。
  - 只認得列出來的 wrapper（`sudo`、`env`、`xargs`、`uv run`、`poetry run`、`busybox`、`trap` …），其他會執行參數的程式（`make`、`just`、`task` 等任務工具的內容）看不到。
- SSH 遠端 session 的專案路徑在遠端，外掛讀不到遠端的 `.agents/approval-rules.json`（使用者層級設定照常生效）。這點沒有實測。

## 檔案

- `plugin.json`：manifest，宣告 `permission` hook 與 `status`、`check` 兩個 method。
- `plugin.ts`：接上 Acpira：讀兩層設定、呼叫規則、回覆 hook、通知與 log。
- `rules.ts`：規則、設定合併、權限請求解讀，純模組，不依賴 Acpira。
- `shell.ts`：保守的指令解析（POSIX shell、PowerShell、cmd），純模組。
- `config.example.json`：使用者設定範例。
- `acpira.d.ts`、`tsconfig.json`：只給編輯器用的型別，Acpira 編譯時會剝掉型別、不做檢查。

`status` method（`{ cwd }`）回傳目前生效的規則、設定檔路徑與警告；`check` method（`{ toolCall, row, cwd }`）不經過權限請求直接判斷一個 payload，方便手動驗證。

## 測試

規則與解析的案例、設定層級、效能上限，以及一次端到端驗證都在 repo 的 `test/plugin-approval-rules.test.ts`：

```sh
pnpm vitest run test/plugin-approval-rules.test.ts
# 連端到端一起跑（需要能正常回應 prompt 的 sidecar，見下面的說明）
ACPIRA_APPROVAL_RULES_E2E=1 ACPIRA_SIDECAR_BIN=<已編好的 acpira 執行檔> ACPIRA_AGENT_PRIORITY=normal pnpm vitest run test/plugin-approval-rules.test.ts
```

端到端測試把外掛複製到暫存 home、從外掛頁面啟用，切到完全存取（合成的 yolo）後讓假 agent 送權限請求：無害的指令直接核准、刪除與改 `.env` 仍然出卡片，寫入使用者設定把 `delete-files` 改成 `deny` 後，下一個刪除請求不出卡片直接被拒絕。

端到端測試預設跳過，要設 `ACPIRA_APPROVAL_RULES_E2E=1` 才會跑。原因：Windows 的 debug 版 sidecar 主執行緒只有 1 MB stack，送出第一個 prompt 時就會 `thread 'main' has overflowed its stack`（`0xC00000FD`）結束，不裝外掛也一樣（既有的 `test/sidecarContract.test.ts` 同樣失敗）；改用 64 MB stack 的 sidecar 可以跑過（第一輪 review 時確認）。這是 sidecar 建置的問題，不是外掛的，所以不讓它擋住一般的測試。引擎端同一條路徑（hook 回 `ask` 時 yolo 仍出卡片）由 `rust/crates/acpira-host/tests/engine/plugin_hooks.rs` 覆蓋。慢機器上 agent 預設在 below-normal 優先權下可能啟動不了，可設 `ACPIRA_AGENT_PRIORITY=normal`。

手動驗證（不要用真正的 `~/.acpira`）：

1. `acpira-desktop --ws <port> --token <token> --home <暫存目錄>`（或 `pnpm harness --home <暫存目錄>`），把這個資料夾複製到 `<暫存目錄>/plugins/approval-rules/`。
2. 在「設定 → 外掛」啟用 approval-rules。
3. 開一個 session，把權限等級切到完全存取，請 agent 執行 `git push --dry-run` 與 `git push origin HEAD`（或在測試 repo 裡 `rm` 一個檔案）。前者應該直接執行，後者應該出現確認卡片與一則說明命中規則的通知。注意 Claude Code 的完全存取是原生 `bypassPermissions`，見上面的限制。
