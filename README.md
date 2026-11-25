# chief

English · [中文](README.zh.md)

chief gives you a personal-assistant session in the Claude App (the "chief 消息中心", message hub). When someone needs you on Slack, GitHub, Jira or Notion, the hub decides what to do by your rules, hands real work to separate Claude work sessions, tracks progress, and only surfaces what you must decide. You talk to the hub; a side panel (`/chief`) shows progress, pending replies and rules.

The plugin ships three parts: the panel (`/chief`), the hub skill (`/chief:hub`) and a background engine. Everything is set up from the panel's Setup tab.

**Language.** The panel, engine notifications and the hub default to Chinese. After the engine is installed, switch to English with the **Language · 语言** selector at the bottom of the Setup tab, or run `chief config set locale en`. The panel switches right away; the hub picks it up the next time it wakes (it reads `chief config`) and then talks to you, and writes titles, progress, questions and digests, in English. Replies it drafts to other people keep the language of that conversation.

```
Slack (push) / GitHub, Jira, Notion (polled every 5 min)
  → chief engine (launchd, ~/chief/data/app): writes only "someone needs you" items to ~/chief/data/events.jsonl
  → the hub session follows them with Monitor and decides by your rules: hand off / note / ask you
  → work sessions do the work and report back: progress / needs your decision / draft reply
  → drafts wait for you on the panel's For you page; you confirm there (or a rule allows sending directly); the engine sends as you, undoable for 5 s
```

See also: [Architecture](ARCHITECTURE.md) (Chinese) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Install

Requirements: macOS, the Claude App (the panel and opening sessions do not work in terminal Claude Code), Node 24+, Google Chrome (for Slack login). For GitHub / Jira, install and log in to `gh` and `acli` (Jira can also use `twg`: `twg login`; if both are installed chief uses `acli`).

Until the engine is installed the Setup tab is in Chinese, so the button names are given in both languages below.

1. Install the plugin:

   ```bash
   claude plugin marketplace add jinjin99/chief
   claude plugin install chief@chief --scope user
   ```

2. Open any session in the Claude App and type `/chief`. Before the engine is installed, the panel shows only the Setup (设置) tab.
3. Click **装引擎** (Install engine): creates the workspace `~/chief`, copies the engine to `~/chief/data/app`, installs dependencies and registers a launchd agent. Takes a minute or two. Now switch **Language · 语言** to English if you like.
4. Click **Log in to Slack** (登录 Slack): log in normally in the separate Chrome window. For SSO workspaces, type your workspace name (`xxx` in `xxx.slack.com`) first; you then log in only once. The window closes itself and the session cookie goes into the macOS Keychain.
5. Optional: **Connect** GitHub / Jira (uses your logged-in `gh`, `acli` or `twg`). Notion needs a token: `pbpaste | chief connect notion`.
6. Start the hub. It must run in `~/chief` so it can read your instructions and notes. Either click **Open hub in workspace** (在工作目录开主会话; the current session opens a new session in `~/chief` with the App's session tool), or create a session yourself with folder `~/chief`, type `/chief` and click **Start hub** (开消息中心). Use the bypass permissions mode (see Risks) and keep the hub open. The session from step 2 can be closed.

## The panel

Three pages for the three questions you ask, plus Setup. When everything is fine the top shows a single green dot; it only spells things out when something is wrong.

- **For you** — everything that needs you, one card per thing, most urgent first:
  - A session stuck on a dialog (Allow, a choice): **Go click** jumps straight to it.
  - Questions for you: each one has **OK / Disagree… / Skip it**; **Go with all remaining suggestions** when you agree with all of them. A decision can be undone for two minutes.
  - Replies waiting for your OK: send, edit, and under ⋯ rewrite or don't send. After you press send, the card collapses at once and shows "sending"; if the send fails, the card comes back with the reason. Sends can be undone for 5 seconds.
  - chief's own issues: the send key was changed, the engine, hub or a source is down, the plugin was updated and the hub should **Reload rules**, rules the hub proposes. Each comes with a button that fixes it.
  - At the bottom, one line on what chief did today.
- **Progress** — one row per thing with a status tag first (session waiting, overdue, blocked are coloured); open a row for the next step and results; ⋯ has ask for progress, **Later** (snooze: `chief thing snooze T --until 2h` / `tomorrow 09:00` / `next monday 09:00`), note and drop. Search past things at the top (`chief search <text>`). Below: snoozed, done, and **What it did in the last 7 days**: mark each judgment right or wrong (wrong becomes a rule proposal), save it as a drill case, undo "just note" / "ignore" calls; sent replies are listed there too (`chief undo --list`).
- **Rules** — how each kind of message is handled; your rules (cases the engine enforces through the dropdowns, plus guidance for the hub); people (trusted, always ask me); replies (style, canned replies, placement, signature); how it is doing (accuracy, drills). Changes take effect immediately.
- **Setup** — engine, sources, hub (reload rules), keep-awake, quiet hours and daily digest, language, import what you are working on, a test message, and the hub's usage. Rarely used actions (stop engine, reinstall, disconnect) are under ⋯.

## Update

The plugin follows released tags (`v*`) only; unreleased changes on main do not reach you. Turn on auto-update under `/plugin` → Marketplaces → chief, or run `claude plugin update chief@chief`. The engine updates itself the next time a session loads the new plugin; click **Reload rules** in Setup to make the hub pick up the new skill without restarting it.

## Risks

Read [SECURITY.md](SECURITY.md) before using chief.

- **Bypass permissions.** The hub and its work sessions run without per-command approval and read text written by other people. The skill tells them to treat messages as data, but that is model behaviour, not isolation: prompt injection is possible. If that worries you, use the default permission mode and approve commands yourself.
- **Sending as you.** The engine gates every outgoing message. There are only three ways out: you click Send in the panel; you say "send" in the hub (the plugin verifies you typed it); or a rule allows it (exact canned replies, trusted people, kinds of message set to send directly). By default every reply asks you first. The hub can only propose looser rules; you accept them on the Policy tab.
- **Slack uses your browser session cookie**, not an official Slack app. It has full access to your account and is kept in the macOS Keychain. Check that your workspace policy allows this.
- **Data is stored in plaintext locally** under `~/chief/data`. chief uploads nothing elsewhere.

## Where data lives

Everything is in `~/chief`, and the hub runs there:

| Path | What |
| --- | --- |
| `CLAUDE.md` | Your long-term instructions to the assistant: who you are, usual repos, how you write, what not to touch |
| `rules.json` | Rules: how each kind of message is handled, whether replies need your OK (Rules page, or tell the hub) |
| `config.json` | Engine settings, see Settings below |
| `notes/` | What the assistant noted: who is who (`people.md`), which work happens in which folder (`projects.md`) |
| `.claude/skills/` | Skills only the hub uses |
| `data/*.json`, `data/*.jsonl` | Events, decisions, things, questions, outbox (contains other people's messages) |
| `data/archive/` | Items finished more than 7 days ago, moved here by month (`<kind>-<yyyy-mm>.jsonl`) and kept |
| `data/logs/`, `data/drafts/` | Engine logs, reply drafts |
| `data/app/`, `data/bin/chief` | The engine and the command line |

Plugin updates only add missing template files; they never overwrite your edits.

- **Back up:** `chief export` packs rules, settings, instructions, notes, data files and archives into `~/chief/exports/chief-export-<time>.tar.gz` (`--out <dir>` to put it elsewhere). No secrets: Keychain credentials and the confirm key fingerprint are left out.
- **Remove everything:** run `chief uninstall --purge` in a terminal and type `purge`. It unloads the engine, deletes `~/chief` (keeping `exports/`) and chief's two Keychain items, and lists what it removed. It only deletes those known locations and refuses odd paths (symlinks, your home directory and so on). Uninstall the plugin itself in Claude (`/plugin` → chief → uninstall). To just stop chief and keep the data, use `chief uninstall`.

Outside `~/chief` there are only system-defined locations:

- macOS Keychain: `chief:slack.cookie_d` (Slack session), `chief:notion.token` (Notion token).
- Login item: `~/Library/LaunchAgents/dev.chief.engine.plist`.
- The plugin and its store (in Claude's plugin directory): the store holds the confirm key the panel uses to prove a send was yours; `~/chief/data` only has its fingerprint.

## Modes: normal / auto / yolo

How much the hub may decide for you. Set it at the top of the panel's Rules tab.

- **normal**: today's behaviour; the rules decide what is sent directly and what asks you.
- **auto**: fewer clicks. Approving other people's PRs (a "review requested from me" event) and replying on your own PRs (comments, approvals, requested changes) no longer ask you. Replies to other people on Slack, GitHub, Jira and Notion, approvals of PRs mentioned elsewhere, and new messages still follow the scenario rules and the trusted list. The approval case covers only the first notice of a review request. Comments from bots are never reported, so there is nothing to answer.
- **yolo**: the assistant decides everything. Slack replies and approvals go out without asking, and neither the scenario rules nor your custom cases apply any more; only the "Always ask me" list can stop it. New messages the assistant starts itself (to a channel, a person, a DM or an email address) still ask you in every mode, because they are not a response to anything.

Switching up to auto or yolo loosens sending, so it must be clicked in the panel (it carries the confirm key); the hub cannot switch it itself and can only propose it. Switching back to normal needs no key.

Yolo risk: replies and approvals go out directly. A sent reply can be undone within the undo window (5 seconds by default, `undoSeconds`); a decision made for you on a "needs your call" question can be undone within two minutes, but undoing only changes the answer: a reply already sent or an approval already given is not taken back. To make decisions, the hub reads your own typed messages in past Claude sessions (`~/.claude/projects/*/*.jsonl`) and your memory notes, and quotes only a one-line summary. Tool results and other people's words are not evidence. Before turning it on, add the people and conversations you do not trust it with to the "Always ask me" list.

## Settings

Engine settings live in `~/chief/config.json`. `chief config` lists every setting and its current value; `chief config set <key> <value>` changes one. Rules (`rules.json`) are changed on the Rules page or by telling the hub, not here.

These are also on the Setup page and take effect immediately:

- **New decisions**: when a work session registers a new decision with `chief ask add`, the engine pops a notification (within a minute) telling you to check the panel; each one notifies once, and ones that already exist when the engine starts do not. Quiet hours hold it like any other notification.
- **Language** (`locale`, `"zh"` or `"en"`, default `"zh"`): `chief config set locale en`. Panel, engine notifications and how the hub talks to you.
- **Quiet hours** (`quietHours`, e.g. `{"start":"22:00","end":"08:00"}`, may cross midnight): the engine holds its notifications and the hub holds its pushes; they go into the next digest, and when quiet hours end the held engine notifications pop up as one. A broken data file or a changed confirm key still notifies; things you marked urgent or due during quiet hours still get pushed. Replies the rules allow to send directly still go out (quiet hours are about not disturbing you, not about ignoring others). `chief quiet` shows whether it is quiet now.
- **Daily digest** (`digest.morning`, `digest.evening`, `"08:30"` or `null`, both off by default): at that time the hub writes up what is waiting on you, your open decisions, the outbox, what changed and notifications held during quiet hours, in the hub session. If the Mac slept through the time it catches up within 3 hours, otherwise skips; restarts do not repeat it. `chief digest` prints the raw material.

Other keys (poll interval, how long to keep finished items, undo seconds and so on) are listed with their ranges at the top of `plugin/engine/src/config.ts`; they take effect after `chief engine restart`.

## Command line

After the engine is installed there is `~/chief/data/bin/chief` (add an alias to type `chief`). Its help and error messages are in Chinese.

```bash
chief status            # engine, sources, progress
chief doctor            # the checks the Setup tab uses (JSON)
chief logs              # last 50 lines of the engine log
chief config            # engine settings; chief config set locale en
chief connect slack     # log in in a browser window; --workspace acme logs in through the workspace; --stdin pastes the cookie
chief connect github    # use the locally logged-in gh
chief quiet             # whether it is quiet hours now, and until when
chief digest            # digest material (JSON)
chief export            # back up (no secrets), to ~/chief/exports by default
chief search checkout   # search current and archived things, questions, replies, messages
chief thing snooze 3 --until "next monday 09:00"   # later; chief thing wake 3 brings it back early
chief undo --list       # recent undoable actions; chief undo <id> undoes one
chief uninstall         # unload from launchd (keeps ~/chief)
chief uninstall --purge # unload and delete chief's data and Keychain items (type purge to confirm)
```

## Troubleshooting

Start with `chief status`, `chief logs` and `chief doctor`.

- **Node too old / not found**: install Node 24+ (nodejs.org or `brew install node`), then click Install engine again. Processes started by the App have a short PATH; the Homebrew default location is the safest.
- **Chrome missing**: install Google Chrome; chief only opens a separate login window and does not touch your normal Chrome profile.
- **SSO login loops**: enter the workspace name in Setup and log in again, or run `chief connect slack --workspace xxx` to see the error.
- **Slack session expired**: the Slack row turns red and chief notifies you; click **Log in again**. Events are not lost.
- **Send does not work, confirm key mismatch**: usually after reinstalling the plugin. Run `~/chief/data/bin/chief key reset` in a real terminal, then `/reload-plugins`. A reset always notifies you; if you did not do it, find out who did.
- **Engine not running**: click Start engine or Restart engine in Setup; check `chief logs`. No messages arrive while the Mac sleeps; turn on "Keep the Mac awake on power" in Setup.
- **The hub does not handle messages**: check the Hub block in Setup. If it is not listening, say "开 chief 消息中心" in the hub session; "已经有一个主会话在听" means another session is already the hub.
- **Messages between sessions are "held"**: the work session's permission mode differs from the hub's; switch the work session to bypass permissions, or answer in that session yourself.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Code layout:

| Path | What |
| --- | --- |
| `plugin/hooks/` | The panel (`/chief`); its zh / en strings are in `hooks/i18n.ts` |
| `plugin/skills/hub/` | The hub skill (`SKILL.md` plus a few docs read on demand) |
| `plugin/engine/` | Background engine and the `chief` command line (TypeScript, run with tsx); notification strings in `src/messages.ts`, shared labels in `src/shared/i18n.ts` |
| `plugin/setup.sh` | The script behind Install engine |
| `plugin/workspace/` | Initial files for the `~/chief` workspace |

## License

MIT
