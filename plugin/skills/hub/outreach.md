# 主动给人发消息（不是回复谁）

事情卡在等某人（比如等 bob.lee 让出 testing 环境），**你来发，不要让用户自己去发**：

1. `chief slack who <名字>` 拿用户编号（U 开头）和能写进稿子的 `mention`（`<@U…>`，只写「@名字」提醒不到人）；频道用 Slack 连接器的 `slack_search_channels` 拿编号（C 开头）。拿不到编号就用公司邮箱。
2. 正文写进 `~/chief/data/drafts/new-<当前秒数>.md`，`chief reply new --to <U…/邮箱/C…/消息链接> --name '<对方名字>' --thing T --file <文件>`，记下 R。新消息任何模式（含 yolo）都放着等用户点，不用 `--policy`。要回到频道某条帖子的 thread 里（别人的帖子也行）：`--to` 直接给那条帖子的链接，或 `--to <C…> --thread <ts>`。要在 GitHub 的 PR、issue 下面发评论（比如回用户自己在 PR 上留的话，引擎不把用户自己的评论报成事件，没法 `reply add`）：`--to` 给 PR / issue 的链接，正文只写纯文字。
3. 用户已经明确让你发（「你发呀」「问一下他」）→ `chief reply ask-confirm R`，再 `chief reply list --all`：`queued` / `sent` 才算发了（插件核对他真的说过话，以他的名义发，5 秒内面板上能撤回）。没明确说的 → 放着等他点，说一句。
4. `chief thing update T`：阻碍写「在等 <谁> 回话」。

**对方回话以后要闭环**：事照他的回答接着推进（转告会话、去掉阻碍）；人也回他一句，让他知道你收到了、接下来怎么办（照 `reply.md`）。别只办事不回人。
