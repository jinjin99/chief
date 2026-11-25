// 面板的类型合同：$.state 里存的东西（PluginState['chief']）。claude plugin validate 要它自成一体，不许 import，
// 所以数据文件的那几样照抄 plugin/engine/src/shared/types.ts（引擎写、面板读）。
// engine/test/contract.spec.ts 检查那边的每个类型都能当成这里的用：那边改了、这里没跟上，引擎的类型检查就过不了。
// 来源、场景写成 string：加来源不用改这里，名字和标签都从 shared/sources.ts 拿。

export type Source = string

export type ReplyRow = {
  id: number
  kind?: 'reply' | 'approve' | 'message'
  event: number
  thing?: number
  source: Source
  target: Record<string, string>
  context: { who: string | null; where: string; said: string; url: string | null }
  body: string
  custom?: number
  // 以你的名义发是怎么确认的：panel 面板上点的；chat 你在会话里说的（said 是你的原话）。
  confirm?: { how: 'panel' | 'chat'; said?: string; at: string; hash?: string }
  // 主会话说你在会话里同意发了，插件还没核对上。
  confirmAsk?: { at: string }
  // 附的图（只有 Slack）：正文发完发到同一个地方。file 是复制进 drafts/images 后的路径。
  images?: { file: string; name: string; bytes: number; mime: string }[]
  // 发之前引擎查到 PR 已经合了 / 关了，退回来等你看一眼（at 之后再点发送就照发）。
  prState?: { ref: string; state: 'merged' | 'closed'; at: string }
  original?: string
  status: 'pending' | 'queued' | 'sending' | 'sent' | 'failed' | 'dropped' | 'redo'
  by?: 'you' | 'policy'
  sendAt?: string
  sentAt?: string
  error?: string
  feedback?: string
  at: string
  url?: string
}

export type ThingRow = {
  id: number
  title: string
  session?: string
  status: 'doing' | 'waiting_you' | 'waiting_others' | 'done' | 'dropped'
  progress: string
  next?: string
  blocker?: string
  results?: string[]
  due?: string
  keys?: string[]
  origin?: 'chief' | 'import'
  // 稍后再说：until 之前不在进行中的列表里，到点引擎叫醒它。
  snooze?: { until: string; at: string }
  events: number[]
  updatedAt: string
  log: { at: string; text: string }[]
}

export type AskRow = {
  id: number
  thing: number
  question: string
  suggest: string
  status: 'open' | 'answered' | 'dismissed' | 'withdrawn'
  answer?: string
  reason?: string
  closedAt?: string
  // 这个问题挂着的待发出回复（chief ask add --reply R）：卡片上显示那条的摘要。
  reply?: number
  at: string
}

export type Verdict = 'ignored' | 'noted' | 'forwarded' | 'opened' | 'asked'

export type DecisionRow = {
  dry?: boolean
  at: string
  event: number
  scenario: string
  verdict: Verdict
  reason: string
  thing?: number
  session?: string
  what?: { source: Source; title: string; from: string | null; text: string }
}

export type Handle = 'dispatch' | 'note' | 'ignore' | 'approve' | 'command'
export type ReplyMode = 'ask' | 'auto'
export type Audience = 'direct' | 'group' | 'channel' | 'self'
export type Placement = 'inline' | 'thread'

export type Rule = { handle: Handle; reply: ReplyMode; brief?: string }

// rules.json：老文件可能缺后来加的几项，所以那几项是可选的。
export type PolicyFile = {
  scenarios: Record<string, Rule>
  // 固定回复：回复和其中一句一字不差，才能不问你直接发。
  quick?: string[]
  custom: (Rule & { id: number; when: string })[]
  notes: string[]
  signature?: string
  style?: string[]
  trusted?: string[]
  // 一定问我：这些人、对话的回复引擎一律不直接发（比白名单优先）。
  askAlways?: string[]
  placement?: Record<Audience, Placement>
  // 做事方式：缺省 normal。
  mode?: 'normal' | 'auto' | 'yolo'
  // change：放宽发送的改动（主会话没带钥匙改的），你采纳才生效。
  proposals: { id: number; text: string; basis: string; at: string; change?: { args: string[]; input: string } }[]
}

export type Reviews = Record<string, { ok: boolean; note?: string; at: string }>

// 能撤回的操作（undo.json）：不做了、只记下 / 忽略、跳过积下的。undone 是撤回的时间。
// events：只记下 / 忽略的那几条消息（进度页的「最近」把撤回挂在那条判断上）。
export type UndoRow = { id: number; at: string; kind: 'drop' | 'mark' | 'skip'; label: string; undone?: string; events?: { id: number }[] }

// chief search 的一条结果。
export type SearchHit = {
  kind: 'thing' | 'ask' | 'reply' | 'event' | 'decision'
  id: number
  date: string
  title: string
  snippet: string
  url?: string
  thing?: number
  session?: string
  archived?: boolean
}

export type Health = { ok: boolean; at: string; fails: number; error?: string }

// 提到的 PR 现在什么样（refs.json，引擎每 10 分钟查一次）。
export type PrRow = { state: 'open' | 'merged' | 'closed'; conflict: boolean; head: string; title: string; url: string; mergedAt: string | null; closedAt: string | null; checkedAt: string }
// prs：PR（owner/repo#号）→ 状态；links：a<问题号> / r<回复号> / t<事情号> → 它提到的 PR。
export type RefsFile = { checkedAt?: string; prs: Record<string, PrRow>; links: Record<string, string[]>; seen: Record<string, string>; missing: Record<string, string> }

export type EvalCaseRow = { id: number; text: string; from: string; expect: 'dispatch' | 'note' | 'ignore' | 'ask'; note?: string }
export type EvalRunRow = { id: number; at: string; events: Record<string, number> }

// 面板每次刷新读出来的一份。
export type Snapshot = {
  hub: { listening: boolean; lastAt: string | null }
  engineAt: string | null
  // 每个来源最近一次收 / 拉的结果（引擎写在 engine.json）：fails 是连着失败几次。数据文件坏了也在这里（键是「数据文件」）。
  health: Record<string, Health>
  unhandled: number
  maxEvent: number
  things: ThingRow[]
  asks: AskRow[]
  replies: ReplyRow[]
  decisions: DecisionRow[]
  reviews: Reviews
  policy: PolicyFile | null
  sources: Record<string, boolean>
  // 事情挂着的会话最近的动静（引擎读 Claude App 的会话记录得来）。
  activity: Record<string, { at: string; saidAt?: string | null; waiting?: string | null; title: string; last: string; permissionMode: string | null; archived: boolean }>
  // 界面语言（config.json 的 locale，没写是 zh）：变了面板跟着重画。
  locale: 'zh' | 'en'
  // 主会话的权限模式（和工作会话不是同一类时，主会话转告过去的消息会被扣住）。
  hubMode: string | null
  // 查过的 Slack 人：用户编号 → 名字（稿子里的 <@U…> 显示成 @名字）。
  people: Record<string, string>
  // 演练用的例子和最近一次演练（见 chief eval）。
  evals: { cases: EvalCaseRow[]; runs: EvalRunRow[] }
  // 演练消息的判断（不算进「替你做了」）。
  dryDecisions: DecisionRow[]
  // 主会话用掉的订阅额度（hub-usage.json）。
  hubUsage: HubUsage
  usage: Usage
  // 「以你的名义发」的钥匙被清过 / 换过、你还没在面板上点知道了的（key-log.jsonl）。
  keyAlerts: { at: string; what: 'reset' | 'set' }[]
  // 最近做的、能撤回的（新的在前）。
  undo: UndoRow[]
  // 插件更新过、主会话还没重读规则（插件自己的存储里记着上次重读时的插件版本）。
  reread: boolean
  // 卡片上的问题、回复提到的 PR 现在什么样（refs.json）。
  refs: { prs: Record<string, PrRow>; links: Record<string, string[]> }
  // 待发出的稿子放了几小时算久（config.json 的 staleDraftHours，默认 12）：卡片上写了多久的那行变黄。
  staleDraftHours: number
}

// 主会话一天调了几次模型、按价钱折算的份量（hooks/usage.ts 记）；readings 是账号两个窗口的百分比读数（变了才记），
// 引擎拿它和本机所有会话的用量算主会话分到多少（见 engine/src/usage.ts、Usage）。
export type UsageDay = { calls: number; weight: number }
export type UsageReading = { at: number; five: number | null; week: number | null }
export type HubUsage = {
  days: Record<string, UsageDay>
  readings?: UsageReading[]
  // 最近一次读数：上下文多长、整个账号两个窗口用了多少、什么时候重置。
  now?: { at: string; context: number | null; window: number; five: number | null; week: number | null; fiveReset?: string; weekReset?: string }
}

// 引擎算的（usage.json）：每天主会话占本机所有会话用量的份额，账号两个窗口涨了几个点、分给主会话几个点；
// weights 是各种 token 折成份量的比例，fitted 说明是用你账号的数据拟合的（否则是社区实测的默认值）。
export type Usage = {
  at?: string
  fitted?: boolean
  weights?: { input: number; output: number; cacheWrite: number; cacheRead: number }
  days: Record<string, { share: number | null; accountFive: number; accountWeek: number; five: number; week: number }>
}

export type Tab = 'now' | 'outbox' | 'things' | 'policy' | 'eval' | 'setup'

// 一个来源连没连好：browser / secret 的看 ready；cli 的看 tool（命令装没装）、ok（试登录过没过）、detail（没过的原因）。
export type DoctorSource = { enabled: boolean; ready?: boolean; tool?: boolean; ok?: boolean; detail?: string }

// chief doctor 的结果：设置页按它打勾。
export type Doctor = {
  version: string | null
  node: string
  engine: 'running' | 'stopped' | 'missing'
  chrome: boolean
  // 来源 → 状态（旧引擎没有的来源这里就没有）。
  sources: Record<string, DoctorSource>
  hub: { listening: boolean; lastAt: string | null }
  // 插电时不让电脑睡（引擎挂着 caffeinate -s）
  awake: boolean
  // 记下的 Slack 工作区（子域名），登录窗口从这里打开；没记过是 null
  slackWorkspace: string | null
  // 工作目录 ~/chief：消息中心开在这里（ready：CLAUDE.md 在）
  workspace: { path: string; ready: boolean }
  // 同样的来源状态排成一列（旧引擎没有）。
  list?: (DoctorSource & { id: string; label: string; setup: string })[]
  // 免打扰时段（null 没设）、每天汇总的时间（null 不发）。旧引擎没有。
  quietHours?: { start: string; end: string } | null
  digest?: { morning: string | null; evening: string | null }
}

// 设置页：引擎装没装（~/chief/data/bin/chief 在不在）、doctor 的结果、正在做哪一步（engine、来源编号、awake、config、check）、上一步的输出。
export type Setup = {
  installed: boolean
  doctor: Doctor | null
  busy: string
  said: string
  // 本会话开在哪个目录：和工作目录对不上时，提醒消息中心换个地方开
  cwd: string
  // 「以你的名义发」的钥匙：ok 配好了；mismatch 引擎记的是另一把（重装过插件），面板上的发送用不了；none 引擎还没装
  key: 'ok' | 'mismatch' | 'none'
}

declare module 'claude-code' {
  interface PluginState {
    'chief': {
      snap: Snapshot | null
      note: string
      tab: Tab
      // 你在待发出里改了还没发的稿子：回复号 → 改后的文字。
      edits: Record<string, string>
      // 点了发送、命令还没跑完的回复：回复号 → 点的时间。面板先把这些卡片收起、显示「正在发」。
      sending: Record<string, number>
      // 展开着的行（事情、判断）。
      open: string[]
      // 设置页里看的最近日志。
      logs: string
      // 攒着要一起发给主会话的批注：批在哪（t<事情号> / a<问题号> / r<回复号> / d<事件号> / note）、那是什么、你说的话。
      basket: { key: string; label: string; text: string }[]
      setup: Setup
      // 你在这个会话里最近亲口说的一句话（插件核对「你在会话里说了发」用）。
      said: { text: string; at: number } | null
      // 本会话是不是主会话（挂过 chief events --follow 的 Monitor）。
      hub: boolean
      // 进度页上搜以前的事：搜的字和结果。
      found: { q: string; hits: SearchHit[]; error?: string } | null
    }
  }
}
