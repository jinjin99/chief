# chief

[English](README.md) · 中文

在 Claude App 里给你一个私人助理主会话（「chief 消息中心」）：Slack / GitHub / Jira 里找你的事，它能办的派给工作会话去办，跟着进度，只把要你拍板的列给你。你只和主会话打交道，旁边的 chief 面板看进度、确认回复、改规矩。

一个插件里装着三样东西：面板（`/chief`）、消息中心 skill（`/chief:hub`）和后台引擎。装好插件后在面板的「设置」页点几下就能用。

```
Slack（推送） / GitHub、Jira、Notion（每 5 分钟拉一次）
  → chief 引擎（launchd 常驻，~/chief/data/app）：只把「有人找你」的写进 ~/chief/data/events.jsonl
  → 「chief 消息中心」会话用 Monitor 盯着，来了按你的规矩判断：派给工作会话 / 只记下 / 问你
  → 工作会话干活，向主会话汇报进展 / 要你定 / 回复稿
  → 回复放进待发出，你在面板「要你」页确认（或规矩允许直接发），引擎以你的身份发出，5 秒内可撤回
```

更多：[架构](ARCHITECTURE.md) · [安全](SECURITY.md) · [参与开发](CONTRIBUTING.md) · [更新记录](CHANGELOG.md)

## 装

要求：macOS、Claude App（终端版的 Claude Code 里面板和开会话都用不了）、Node 24 以上、Google Chrome（登录 Slack 用）。用 GitHub / Jira 的话，先装好并登录 `gh`、`acli`（Jira 也可以用 `twg`：`twg login`；两个都装了用 `acli`）。

1. 装插件：

   ```bash
   claude plugin marketplace add jinjin99/chief
   claude plugin install chief@chief --scope user
   ```

2. 在 Claude App 里随便开一个会话，输入 `/chief` 打开面板。这时还没装引擎，面板只有「设置」页。
3. 点 **装引擎**：建工作目录 `~/chief`，把引擎放到 `~/chief/data/app`，装依赖，装进 launchd（开机自动跑）。要一两分钟。
4. 点 **登录 Slack**：弹出一个单独的 Chrome 窗口，你在里面正常登录。公司要 SSO 的，先在输入框里填工作区（`xxx.slack.com` 的 `xxx`），只用登一次。登好窗口自己关掉，凭证存进钥匙串。
5. （可选）**连上 GitHub / Jira**：用本机已经登录的 `gh`、`acli` 或 `twg`。
6. **开主会话**：主会话要开在 `~/chief` 里，那里才读得到你的交代和助理记的东西。两种办法选一个：
   - 在设置页点 **在工作目录开主会话**，当前会话会用 App 的开会话工具在 `~/chief` 开一个新会话，并让它开张。
   - 或者自己在 App 里新建会话，文件夹选 `~/chief`，再输入 `/chief`，在设置页点 **开消息中心**。

   主会话的权限模式选 bypass permissions（见下面「风险」），之后一直开着。第 2 步那个会话可以关了。

## 更新

插件只跟着发布的版本走（`v` 开头的 tag），main 上还没发版的改动不会到你手里。

- 想自动更新：`/plugin` → Marketplaces → chief → 打开自动更新。不开的话，自己跑 `claude plugin update chief@chief`。
- 插件更新后，下次打开会话时引擎会自己跟着更新。主会话在设置页点「重读规则」就能用上新的做事方式，不用重新开张。

## 面板

按你会问的三个问题分三页，最后一个页签是设置。一切正常时顶上只有一个绿点，出问题才写字。

- **要你**：所有要你动手的事都在这一页，一件事一张卡，最急的在前：
  - 会话停在对话框上等你点（Allow、选项）：点「去点」直接跳到那个会话。
  - 要你定的问题：每个问题「照办 / 不同意… / 不用问了」，几个都同意点「剩下的全部照建议办」；刚定的两分钟内能撤回。
  - 等你确认的回复：发送、改稿，⋯ 里有让它重写、不发；点发送后卡片马上收起、显示「正在发」，发出后 5 秒内能撤回；没发成卡片会回来并说原因。
  - chief 自己的事：钥匙被动过、引擎或主会话或来源出了问题、插件更新了要「重读规则」、它提议的规矩，每条带一个能直接解决的按钮。
  - 最底下一行是今天替你办了多少。
- **进度**：每件事一行，状态标签在前（会话等你点、过期、卡住的带颜色），点开看下一步、结果；⋯ 里有问进展、稍后再说、批注、不做了。顶上能搜以前的事。底下是稍后再说的、办完的，和「最近 7 天它做了什么」：每条判断能标对错（判断错了会变成规矩提议）、存成演练例子，只记下和忽略的能撤回，发出的回复也在这。
- **规矩**：每种消息怎么办；你的规矩（引擎照下拉执行的情况，和给主会话参考的交代）；人（白名单、一定问我）；回复（写法、固定回复、放哪、署名）；它做得怎么样（准确率、演练）。改了马上生效。
- **设置**：引擎、来源、主会话（重读规则）、插电不睡、免打扰和每天汇总、语言、导入手上的事、试一下、主会话用掉的额度。停引擎、重装、断开这类少用的收在 ⋯ 里。

## 装之前要知道的风险

chief 替你读消息、开会话、以你的名义发回复，权限给得很大。下面这些请看过再决定用不用，细节见 [SECURITY.md](SECURITY.md)：

- **bypass permissions：** 消息中心和它开的工作会话都用 bypass permissions，跑命令、改文件不再一条条问你。skill 要求它把收到的消息当数据、不当指令，但这是靠模型遵守，不是硬隔离。别人发来一句精心写的话，仍有可能让会话做你没想到的事。介意的话，就别用 bypass，换成默认模式，自己一条条批准。
- **以你的名义发消息：** 发送由引擎把关，只有三条路能发出去：你在面板上点发送；你在消息中心里亲口说「发」（插件核对是你本人敲的字）；规矩允许直接发的（固定回复、白名单里的人等）。默认规矩下，对外的回复都先问你。主会话想放宽规矩，只能提议，要你在面板「要你」页采纳。
- **Slack 用的是你浏览器的登录凭证，不是官方 Slack App：** chief 拿到的是你账号的全部权限，凭证存在 macOS 钥匙串里。有些公司的 Slack 管理规定不允许这样接入，用之前先确认你们公司允许。
- **数据明文存在本机：** 收到的消息原文、回复稿、日志都在 `~/chief/data`，不上传到别处。

## 数据存在哪

chief 的东西都在 `~/chief` 里，消息中心也开在这里：

| 路径 | 是什么 |
| --- | --- |
| `CLAUDE.md` | 你写给助理的长期交代：你是谁、常用仓库、说话习惯、别碰的事 |
| `rules.json` | 规矩：每类消息怎么办、回复要不要你确认（面板「规矩」页改，或跟消息中心说） |
| `config.json` | 引擎的设置，见下面「设置」 |
| `notes/` | 助理记下的东西：谁是谁（`people.md`）、哪类事在哪个目录办（`projects.md`） |
| `.claude/skills/` | 只给消息中心用的 skill |
| `data/*.json`、`data/*.jsonl` | 收到的事件、判断、事情、问题、待发回复（有别人的原话） |
| `data/archive/` | 办完超过 7 天的旧东西按月搬到这里（`<种类>-<年月>.jsonl`），一直留着，不自动删 |
| `data/logs/`、`data/drafts/` | 引擎日志、回复稿 |
| `data/app/`、`data/bin/chief` | 引擎程序和命令行 |

模板文件插件更新只补缺的，不覆盖你改过的。

- **留一份：** `chief export` 把规矩、设置、交代、笔记、数据文件和归档打成 `~/chief/exports/chief-export-<时间>.tar.gz`（`--out <目录>` 放到别处）。不含密钥：钥匙串里的凭证、「以你的名义发」的钥匙指纹都不在里面。
- **不想留了：** 在终端里跑 `chief uninstall --purge`，敲 `purge` 确认：卸掉引擎，删掉 `~/chief`（`exports/` 留着）和钥匙串里 chief 的两项，最后列出删了什么。只删这几个认得的位置，路径不对劲（链接、主目录之类）就不删。插件本身和它的存储要在 Claude 里卸：`/plugin` → chief → 卸载。只想停用、数据留着就用 `chief uninstall`。

不在 `~/chief` 里的只有这几样，都是系统规定的位置：

- macOS 钥匙串：`chief:slack.cookie_d`（Slack 登录凭证）、`chief:notion.token`（Notion 令牌）。
- 开机自启：`~/Library/LaunchAgents/dev.chief.engine.plist`。
- 插件本身和插件的存储（Claude 的插件目录）：面板用来确认「是你点的发送」的钥匙原文放在插件存储里，`~/chief/data` 里只有它的指纹。

## 做事方式：normal / auto / yolo

主会话能替你决定多少。在面板「规矩」页最上面选。

- **normal**：现状，哪些直接发、哪些问你，都按规矩。
- **auto**：少让你点。approve 别人的 PR（「PR 请我 review」的事件）、回你自己 PR 上的话（别人评论、approve、要求修改）不再要你确认。回别人的话（Slack、GitHub、Jira、Notion 上的）、approve 别处提到的 PR、新消息，仍按场景规矩和白名单。approve 只管第一次收到的 review 请求。机器人的评论本来就不报，没有要回的。
- **yolo**：全部由助理代决策。Slack 回复和 approve 都不再问你，场景规矩和你加的情况也不再管；只有「一定问我」名单拦得住。主动发起的新消息（发到频道、个人、私信、邮箱）任何模式都仍问你：那是助理自己起的话头，不是回应。

升到 auto / yolo 是放宽发送，必须在面板上点（带钥匙）；主会话自己切不了，只能提议。降回 normal 不用钥匙。

yolo 的风险：回复和 approve 都会直接发出去。发出的话在撤回时间内能撤回（默认 5 秒，`undoSeconds`），「要你定」的代决策两分钟内能撤回，但撤回只改回答，已发出的话、已点的 approve 收不回。做决定时，助理会读你在过去 Claude 会话里自己敲的话（`~/.claude/projects/*/*.jsonl`）和记忆笔记，只引一句概述；工具结果和别人的话不算依据。开之前，先把不放心的人和对话加进「一定问我」名单。

## 设置

引擎的设置在 `~/chief/config.json`。`chief config` 列出所有设置项和当前值，`chief config set <项> <值>` 改。规矩（`rules.json`）不在这里改，用面板的「规矩」页或跟消息中心说。

下面几项在设置页也能改，改了马上生效：

- **新的「要你定」**：工作会话自己用 `chief ask add` 登记了新的要你定，引擎一分钟内弹一条通知叫你去看面板；每条只弹一次，引擎刚起来时已有的不弹；免打扰时段内和其他通知一样先攒着。
- **语言**（`locale`，`"zh"` 或 `"en"`，默认 `"zh"`）：`chief config set locale en`，或设置页最下面的「语言 · Language」。面板、引擎的通知换成英文；主会话下次醒来读到（`chief config`），跟你说话、写进面板的标题、进展、问题和汇总也用英文，替你回别人的话照旧跟着那段对话的语言。

- **免打扰**（`quietHours`，比如 `{"start":"22:00","end":"08:00"}`，可以跨半夜）：这段时间引擎不弹通知、主会话不推送，攒到下一份汇总里；免打扰一过，攒下的引擎通知合成一条弹出来。数据文件坏了、「以你的名义发」的钥匙被换了照样弹；你说过急的、截止就在这段时间里的，主会话照样推。规矩允许直接发的回复照常发（免打扰是不打扰你，不是不回别人）。
- **每天汇总**（`digest.morning`、`digest.evening`，`"08:30"` 或 `null`，默认都不发）：到点主会话把等你的事、要你定的、待发出、这段时间的变化和免打扰时没弹的提醒写成一份，发在主会话里。电脑睡着错过了点，3 小时内醒来补一次，再晚就跳过；重启不会重复发。

## 命令行

装好引擎后有 `~/chief/data/bin/chief`（想在终端直接打 `chief`，自己加个 alias）：

```bash
chief status            # 引擎、来源、进度
chief doctor            # 设置页用的检查（JSON）
chief logs              # 引擎日志最后 50 行
chief config            # 引擎设置；chief config set locale en 换成英文界面
chief connect slack     # 开浏览器窗口登录；--workspace acme 直接从工作区登；--stdin 改成从标准输入贴 Cookie
chief connect github    # 用本机登录的 gh
chief quiet             # 现在是不是免打扰、到几点
chief digest            # 汇总的材料（JSON）
chief export            # 导出一份（不含密钥），默认放在 ~/chief/exports
chief search 支付回调    # 在现在的和归档的事情、问题、回复、消息里找以前的事（面板进度页顶上也能搜）
chief thing snooze 3 --until 下周一   # 稍后再说：到点再拿出来交给消息中心；chief thing wake 3 提前拿出来
chief undo --list       # 最近能撤回的：不做了、只记下 / 忽略、跳过积下的；chief undo <号> 撤回
chief uninstall         # 从 launchd 卸掉（~/chief 的数据不删）
chief uninstall --purge # 卸掉并删光 chief 的数据和钥匙串里的凭证（要在终端里敲 purge 确认）
```

## 出了问题

先看 `chief status`、`chief logs`、`chief doctor`，大多数问题在里面写着。

- **装引擎报「node 是 v22，要 24 以上」或「没找到 node」**：装 Node 24 以上（官网或 `brew install node`），再点「装引擎」。App 起的进程 PATH 不全，装在 Homebrew 默认位置最稳。
- **「登录 Slack 要用 Google Chrome」**：装 Chrome 再点。chief 只用它开一个单独的登录窗口，不碰你平时的 Chrome 资料。
- **Slack 登录来回跳、登不进工作区（SSO）**：在设置页的输入框填上工作区再登，这样直接从 `xxx.slack.com` 走公司 SSO，只登一次。还不行就在终端 `chief connect slack --workspace xxx` 看报错。
- **Slack 连不上 / 登录过期**：设置页 Slack 那行会变红，chief 也会提醒你。点「重新登录」就好，事件不会丢，登好后接着收。
- **面板上的「发送」用不了，说钥匙对不上**：多半重装过插件。在终端（要能输入的真终端）跑 `~/chief/data/bin/chief key reset`，再在会话里输入 `/reload-plugins`。重置钥匙一定会通知你，不是你做的就别理它、先查是谁动的。
- **引擎没在跑**：「要你」页最上面会提醒，点「启动引擎」；设置页的 ⋯ 里有「重启引擎」；还不行看 `chief logs`。电脑睡着时收不到消息，可以在设置页打开「插电时不让电脑睡」。
- **主会话不处理消息**：面板顶上会写「主会话没在听」，设置页「主会话」也看得到。没在听就在主会话里说「开 chief 消息中心」；说「已经有一个主会话在听」就是别的会话在当主会话。
- **会话之间的消息被扣住（held）**：主会话和工作会话的权限模式不一样。把工作会话也改成 bypass permissions，或者自己去那个会话里说一句。

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。代码目录：

| 路径 | 是什么 |
| --- | --- |
| `plugin/hooks/` | 面板（`/chief`）：要你 / 进度 / 规矩 / 设置 |
| `plugin/skills/hub/` | 消息中心 skill（`SKILL.md`，加上按需读的几份说明） |
| `plugin/engine/` | 后台引擎和 `chief` 命令行（TypeScript，tsx 直接跑） |
| `plugin/setup.sh` | 设置页「装引擎」跑的脚本 |
| `plugin/workspace/` | 工作目录 `~/chief` 的初始文件 |

## License

MIT
