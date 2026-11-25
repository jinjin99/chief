# 还没做的想法

2026-11-25 调研别人怎么做常驻 agent、压缩和省钱时记下的，等 01–03 的数据出来再挑着做。

## 1. 每次叫醒不背整段历史

OpenClaw（常驻个人 agent）默认每 30 分钟在主会话里带着全部历史醒一次，一次 3–11 万 token。它的文档说最有效的办法是 `isolatedSession`：每次醒来开一个一次性的小会话，只带 2–5K token，代价是看不到聊天历史。

chief 的状态本来就都在文件里，更适合这么做：把 Haiku 分诊从「只记一笔」扩大到「轻处理」（转告工作会话的进展、更新事情卡片），用小上下文的模型调用读需要的 chief 文件就够；只有要动脑、要和你对话的才叫醒主会话。收益最大，但等于重新设计主会话的工作方式。

- https://clawdocs.org/guides/heartbeat
- https://everpod.ai/guides/openclaw-heartbeat

## 2. 压缩前先清掉旧的工具输出

Anthropic 的「上下文编辑」：把旧的工具结果换成一句「已清除」，调用本身留着；他们自报 100 轮测试里 token 少了 84%。主会话的上下文大头是 chief 命令和读 Slack 的输出。插件的 `session.compact` 能改写要压的对话（`next({ ...e, messages })`），压之前先删旧工具输出，摘要更短更干净。每轮都清会让缓存失效，只在压缩时做。先确认这个接口在 App（SDK）会话里能用（`$.session.compact` 就不能）。

- https://www.anthropic.com/news/context-management
- https://platform.claude.com/docs/en/build-with-claude/context-editing

## 3. 压缩最容易丢的是规矩

论文（TRACE）：真实会话里，压缩丢掉「该怎么做、不许做什么」的概率是丢掉「要做什么」的 6 倍。现在的压缩说明只让它留待办和进行中的事。可以让压完后第一次醒来重读 hub skill 的要点，或者写进压缩说明。改动最小。

- https://arxiv.org/pdf/2610.08722

## 4. 用办对没有来量，不只看 token

便宜模型一次省 80%，失败率翻三倍就亏；路由本身也有开销（LangChain 的测试里路由花费是只用小模型的 4.2 倍，得分只高 2.3 分，在波动范围内）。01 要看 Haiku 挡错了多少（本该叫醒却只记了一笔的）；压缩和 Haiku 上线后各跑一遍「规矩」页的测评。

- https://langchain.com/blog/switchyard-agent-routing-benchmark
- https://openrouter.ai/blog/tutorials/model-routing-for-support-bots-cheap-first-faq-handling/

## 5. 量它到底有没有用（不只看省钱）

花费和 token 回答不了「值不值」。跑一两周看三个数：

- 漏判率：被「只记一笔」的消息里，事后你又自己去处理的有多少（错误看不见，只会在别人追问时暴露）。
- 回得快不快：别人找你到你回复平均多久，和没用 chief 之前比。
- 你还去不去 Slack 翻：你直接在 Slack 里回的，和经 chief 发出的，各占多少（面板会不会只是又多一个收件箱）。

顺带：回复稿命中率（11-19 到 11-25：165 条里不发 36、重写 6，约 1/4 没用上）。

## 别人在做的相近的东西

- Blazity ai-workflow（开源）：Jira 单和 PR 事件进来，自动用 Claude Code / Codex 写代码、开 PR、自审。只有派活，没有分诊和找你拍板。
- Vibe Kanban：任务看板，每张卡派给一个 Claude Code / Codex 会话，各自一个工作目录。原作者 2026 年停了，社区在维护。
- Claude Squad：终端里管多个 Claude Code 会话（每个一个 tmux 和 git worktree），只管切换，不派活。
- Claude Code 自带的子代理 / agent teams：一个会话里派子代理再汇总，不是跨独立会话的中枢。
- Anthropic Dispatch：手机上指挥 agent，能读邮件、日历、Slack；产品，不开源。

## Claude Code 插件接口里能用上的（还没在 App 会话里试过）

- `session.receive`：消息进主会话之前先拦下（Monitor 的事件、工作会话发来的「chief 进展」）。能自己处理的返回 `{ consumed }`，主会话根本不会读到、不会醒。想法 1 最直接的做法。
  - 现在的 Haiku 分诊只拦得到经引擎的事件（外部消息、引擎看到的 session.update），工作会话用 SendMessage 直接发来的「chief 进展 / 要你定 / 回复 / 完成」管不到。「chief 进展 #T」格式固定，主会话做的几乎是机械的 `chief thing update`，插件用代码就能记，只有新阻碍或离截止不到 2 天才放行。
  - 先做最小试验：只拦「chief 进展」，记一行日志原样放行，确认 App 会话里拦得到。
- `session.append`：每一行存进对话之前能改写。把冗长的命令输出、读 Slack 的大段结果在源头就缩短，等于一直在做想法 2。缩错了模型也看不到原文，只对认得出的输出动手。
- `turn.step`：每次调模型前能换模型（`next({ ...e, model })`）。主会话的常规步骤换便宜的模型；换模型用不上原来的缓存，要算清楚。
- `prompt.section`：系统提示词按段改或删，主会话用不上的段去掉，固定开销变小。
- `tool.check` / `agent.offer`：主会话不该用的工具、不该开的子代理，由代码拦，不靠 skill 里写的规矩（压缩后规矩会丢，见想法 3）。
- `session.measure`：上下文大小变了推过来，不用每分钟去问。
- `$.tool.register`：把常用的 chief 命令注册成主会话的工具，返回精简的结构化结果，不经 Bash 吐一大段。
