# 架构

chief 由三块组成：后台引擎、消息中心（一个 Claude App 会话加 hub skill）、面板。它们之间只通过 `~/chief` 里的文件和 `chief` 命令行打交道。

```
            ┌──────────── 引擎（launchd 常驻，~/chief/data/app）────────────┐
Slack 推送 ─┤ slack/       收私信、@我、我在的 thread                        │
GitHub ─────┤ sources/     每 5 分钟拉一次（只读，用本机的 gh / acli / twg）  ├─→ data/events.jsonl
Jira ───────┤                                                              │
Notion ─────┤                                                              │
会话动静 ────┤ activity.ts  读 App 的会话记录：会话说了新话、停在问你的框上    │
            │ archive.ts   办完 7 天的搬进 data/archive/                    │
            │ refs.ts      问题、稿子提到的 PR 变了 / 稿子放久了，交给主会话 │
            │ 发送         replies.json 里 queued 的、过了 5 秒撤回期的回复   │
            └──────────────────────────────────────────────────────────────┘
                                   │ chief events --follow
                                   ▼
            消息中心（Claude App 会话，开在 ~/chief，hub skill）
              按 rules.json 和你写的规矩判断每条事件：
              ├─ 派活：start_session / send_message 到工作会话，带上转交内容
              ├─ 只记下 / 忽略：chief mark、chief thing update
              └─ 问你：chief ask add（面板最上面出卡片）
                                   ▲  工作会话用 send_message 回「chief 进展 / 要你定 / 回复 / 完成」
                                   │
            回复稿 → chief reply add → 待发出
              ├─ 你在面板点发送（插件带钥匙确认）
              ├─ 你在主会话说「发」（chief reply ask-confirm，插件核对是你敲的字）
              └─ 规矩允许（chief reply queue --policy，引擎自己再算一遍）
                                   → 引擎发出
```

## 引擎

`plugin/engine/src/`，TypeScript，用 tsx 直接跑，不编译。`setup.sh` 把它复制到 `~/chief/data/app` 并装进 launchd（插件目录每升一版就换，launchd 要一个不变的位置）。插件版本变了，下次加载时面板在后台再跑一遍 `setup.sh`。

- `engine.ts`：主循环。收 Slack、轮询来源、对账（交给主会话 10 分钟还没判断的事件，补一条「漏掉了」）、发送、归档。
- `cli.ts`：`chief` 命令行的入口和命令表，主会话和面板都靠它读写数据。各个命令在 `commands/` 里按用途分文件（`events`、`things`、`rules`、`reply`、`key`、`eval`、`setup`），读参数、标准输入的小工具在 `args.ts`。所有写入（标题、问题、进展、回复）在这里检查格式（`plain.ts`），发送前在这里和引擎里把关。
- `sources/`：外部来源。每个来源实现 `Source`（拉动态、检查），再交一份 `SourceDescriptor`（怎么建、动态怎么变成事件、能不能评论 / approve、怎么连、怎么导入），放进 `sources/registry.ts`。引擎和命令行按注册表走，不写某个来源的分支。Slack 是推送的，收发在 `engine.ts` 里接 `slack/plugin.ts`，连和存 Cookie 在 `slack/source.ts`。
- `shared/`：引擎和面板共用的纯 TypeScript（不 import Node 的东西）：来源名单和场景（`sources.ts`）、数据的类型（`types.ts`）、规矩里的名字和默认值、回复放哪（`rules.ts`）、文件路径（`paths.ts`）、界面语言和两种语言的名字（`i18n.ts`）。面板直接 import 这几个文件。界面文字的字典：面板在 `hooks/i18n.ts`，引擎的通知在 `src/messages.ts`，语言看 `config.json` 的 `locale`。
- `store.ts`：数据文件的读写（带锁、先写临时文件再改名），路径按 `shared/paths.ts` 算。
- `keys.ts`：从文字里认出「是哪件事」的键（PR 地址、工单号、Notion 页面），同一件事在不同来源里出现时靠它归到同一个会话。
- `refs.ts`：外面的东西变了就提醒。开着的问题、待发出的回复、进行中的事情里提到的 GitHub PR，每 10 分钟用本机的 gh 批量查一次（GraphQL，只读），合了、关了、有冲突、推了新提交就交一条 `ref.changed`（带上受影响的问题、回复、事情）；待发出的回复放了半天还没发交一条 `reply.stale`；发到 GitHub 之前再查一次那个 PR，approve 不开着的 PR 不发，往合了、关了的 PR 上评论退回待发出。结果写进 `refs.json`，面板拿它在卡片上标「已合并」「有冲突」。
- `quiet.ts`、`shared/schedule.ts`：免打扰（时段里引擎的通知先攒着，要紧的照弹）和每天汇总（到点交一条 `digest` 事件，主会话用 `chief digest` 拿材料）怎么算。
- `secrets.ts`：macOS 钥匙串。`launchd.ts`：装卸 LaunchAgent。`images.ts`：回复附图。

引擎不调用 Claude，也不读你的会话内容以外的东西（会话动静只读 App 的会话记录和对话记录的末尾）。

## 消息中心

一个普通的 Claude App 会话，开在 `~/chief`，加载 `plugin/skills/hub/SKILL.md`。它用 Monitor 跑 `chief events --after <cursor> --follow`，每来一行事件就醒一次：归到哪件事 → 按规矩判断 → 派活或记下或问你 → `chief cursor` 记进度。不常用的流程（转交模板、导入、面板指令、开张、approve、回复、主动发消息）拆在 skill 目录下的几份 md 里，用到时再读。

工作会话是 App 里独立的会话，各自开在那件事该在的仓库目录里。它们不直接对外发东西，只把进展和回复稿用 `send_message` 交回主会话。

## 面板

`plugin/hooks/`，Claude Code 插件的 hooks 模块（JSX），跑在插件运行时里（没有 Node，碰外面只能通过 `$`）。`data.ts` 读 `~/chief/data` 里的文件（有变化时 `chief watch` 通知，另外每分钟保底读一次）；`actions.ts` 是按钮背后的命令；`tabs/` 里一个页签一个文件，`setup.tsx` 是设置页，共用的小东西在 `ui.tsx`；`confirm.ts` 管确认钥匙：钥匙原文只在插件自己的存储里，面板点发送、或你在主会话说「发」时，插件带着钥匙调 `chief reply confirm`。

页面按你会问的三个问题分，不按数据分：

- **要你**（`tabs/now.tsx`）：所有要你动手的事。`inbox.ts` 是一个纯函数，从一份数据算出来：chief 自己的事（钥匙、引擎、主会话、来源、要重读规则、规矩提议），和一件事一张卡（会话等你点、要你定的、等你确认的回复），排好序。页签上的数字也按它算。
- **进度**（`tabs/things.tsx`、`tabs/timeline.tsx`）：只看。每件事一行；最近 7 天它做了什么（判断、发出的回复、能撤回的），判断错了在这里说。
- **规矩**（`tabs/policy.tsx`、`tabs/eval.tsx` 的「它做得怎么样」）：它怎么做事、做得怎么样。
- **设置**（`setup.tsx`）：出问题或第一次装时才来。

加东西时守这几条：

1. 一件事是一个单位：哪里提到它都显示成同一个样子，点了都去同一个地方。
2. 只报不正常的：正常的不显示，或者一个小点。
3. 要你动手的只在「要你」：别的页最多放一个跳过去的链接；新的要你做的事，加进 `inbox.ts`。
4. 每条最多两个按钮，其余进 ⋯。
5. 按窄栏（约 360px）排：背景默认一行，点开看全文。

场景和来源的名字、做法的名字、回复放哪、文件路径，面板从 `engine/src/shared/` 直接 import，和引擎同一份。类型合同 `plugin/types/index.d.ts`（`$.state` 里存什么）按 `claude plugin validate` 的要求不能 import，数据文件的几个类型照抄了一份，`engine/test/contract.spec.ts` 在类型上检查它和 `shared/types.ts` 对得上。

## 数据文件（`~/chief`）

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `rules.json` | `chief rules`、面板规矩页 | 每个场景怎么办、白名单、固定回复、「一定问我」、你写的规矩、提议 |
| `config.json` | `chief config set` | 引擎设置 |
| `data/events.jsonl` | 引擎 | 交给主会话的事件，一行一条 |
| `data/decisions.jsonl` | `chief mark` | 主会话对每条事件的判断和理由 |
| `data/things.json` | `chief thing` | 事情：标题、会话、进展、下一步、阻碍、截止 |
| `data/replies.json` | `chief reply`、引擎 | 待发出和发过的回复 |
| `data/routes.json` | `chief route` | 事情的键 → 会话 |
| `data/activity.json` | 引擎 | 工作会话的最近动静 |
| `data/undo.json` | `chief thing`、`chief mark`、`chief undo` | 最近能撤回的操作（不做了、只记下 / 忽略、跳过积下的）和撤回要用的原样，留最近 50 笔 |
| `data/refs.json` | 引擎 | 问题、回复、事情提到的 PR 现在什么样，和每条上次看到的样子（比出变了没有） |
| `data/archive/` | 引擎 | 办完 7 天的旧记录，按月一个文件 |
| `data/logs/` | 引擎 | 日志（不写密钥和消息原文） |
| `data/held.json` | 引擎 | 免打扰时没弹的通知（免打扰一过合成一条弹，也进汇总） |
| `exports/` | `chief export` | 导出的备份（不含密钥；`uninstall --purge` 不删它） |

## 加一个来源

来源都登记在一张表上，加一个只碰这几处：

1. `plugin/engine/src/shared/sources.ts` 的 `SOURCE_META` 加一项：名字、推送还是轮询（`mode`）、带来哪几种场景（键是事件的 `why`，每种写名字、英文名 `en` 和默认做法）、设置页怎么连（`cli` 写装和登录的命令，`secret` 从终端给令牌，`browser` 开浏览器登录）、只读的写 `readOnly`。场景表、默认规矩、`Scenario` 类型、面板上的名字和设置页那一行都从这里来。
2. `plugin/engine/src/sources/<名字>.ts`：实现 `sources/types.ts` 里的 `Source`（`poll`、`check`），返回 `SourceItem`，标出 `mine` 和 `asks`；文件末尾导出一份 `SourceDescriptor`：`build`（引擎怎么建）、`event`（这件事的键、回复回到哪）、能发的写 `comment` / `approve`、`connect`、用本机命令的写 `local`，存钥匙的写 `secret`，能导入的写 `open`。
3. 把它放进 `sources/registry.ts` 的 `SOURCES`（漏了类型检查过不了）。
4. 跑 `npx vitest run test/registry.spec.ts`：名单和注册表对不上（场景没名字、轮询的没有 `build`、存钥匙的没写钥匙名……）会说哪里不对。
5. hub skill（`plugin/skills/hub/SKILL.md`）里认场景的那句补上新来源的几种场景；文字里有它自己的编号格式（像工单号）的话，在 `keys.ts` 里加上认法。

引擎、命令行（`connect` / `disconnect` / `doctor` / `status` / `import`）、面板都不用改。
