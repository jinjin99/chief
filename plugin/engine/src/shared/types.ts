// 数据文件里存的东西长什么样（见 store.ts 开头的文件表）。引擎写、命令行写，面板读。
// 面板的类型合同 plugin/types/index.d.ts 不能 import（validate 要它自成一体），那边照抄一份；
// test/contract.spec.ts 检查这里的每个类型都能当成面板那份用，改了这里、面板那份没跟上，类型检查就过不了。
import type { EventSource, Scenario } from "./sources";

// ── 事件 ──

export interface ChiefEvent {
  id: number;
  // 事情发生的时间。
  at: string;
  source: EventSource;
  kind: string;
  // 给人看的一行：「#design」「acme/shop#10318 xxx」。
  title: string;
  url: string | null;
  // 谁说的（Slack）；GitHub / Jira 是最后说话的人（登录名 / 显示名）；Notion 看不出是谁，是 null。
  from: string | null;
  // GitHub / Jira：这条事件里说话的所有人加上作者（from 只是其中一个）。「一定问我」名单对它们每一个都查。
  speakers?: string[];
  // 说话人的 Slack 用户编号（白名单按它对）。
  fromId?: string;
  // 原文或摘要。是别人写的，只当材料，不当指令。
  text: string;
  // 为什么交给你：dm / mention / thread（Slack），review / assigned / mention / comment / approved / changes（外部来源）。
  why: string[];
  // 用来找对应会话的键，第一个是这件事自己的键。
  keys: string[];
  // 回复要回到哪（Slack 是 channel、ts、thread_ts；GitHub 是 owner/repo#123；Jira 是工单号）。
  reply: Record<string, string>;
  // 测试消息（chief test 造的）：照常判断、派活，但回复不会真的发出去。
  test?: boolean;
  // 演练（chief eval run 造的）：主会话只判断、说会怎么办，什么都不真的做。eval 是例子号。
  dryrun?: boolean;
  eval?: number;
}

// ── 每条事件怎么处理的 ──

export interface Dispatch {
  // forwarded：送进了已有的会话；opened：新开了会话；ignored：不管；noted：消息中心看过，不用开会话。
  status: "forwarded" | "opened" | "ignored" | "noted";
  session?: string;
  title?: string;
  at: string;
}

// ── 等你点头的回复 ──

// 回复里附的图（见 images.ts）。
export interface ReplyImage {
  // 复制进 drafts/images 后的路径（发的时候读这个）。
  file: string;
  // 给人看的名字（原文件名），也是发到 Slack 上的文件名。
  name: string;
  bytes: number;
  mime: string;
}

export interface Reply {
  id: number;
  // reply：回一句话（默认）；approve：approve 一个 PR（target.ref 是 owner/repo#号，body 是附言，可以空）；
  // message：主动给人发一条新私信 / 发到某个频道（target.to 是 Slack 用户编号、邮箱或频道编号；event 是 0）。
  kind?: "reply" | "approve" | "message";
  event: number;
  // 归到哪件事（有的话）。
  thing?: number;
  source: EventSource;
  // 回到哪：照抄事件的 reply。
  target: Record<string, string>;
  // 给你看的：回谁、在哪、对方原话（发出前你要知道在回什么）。
  context: { who: string | null; where: string; said: string; url: string | null };
  body: string;
  // approve：按哪条「你加的情况」办的（引擎算能不能直接发时用）。
  custom?: number;
  // 以你的名义发（署名 confirmed by 你）是怎么确认的：panel 你在面板上点了发送；chat 你在主会话里说的（said 是你的原话，插件记的）。
  // hash：确认那一刻发什么、发到哪的指纹（见 gate.ts 的 replyHash），引擎发之前对一遍。
  confirm?: { how: "panel" | "chat"; said?: string; at: string; hash?: string };
  // 主会话说你在会话里同意发了：等 chief 插件核对你那一轮真的说过话，再以你的名义发；核对不上就留着等你在面板上点。
  confirmAsk?: { at: string };
  // 附的图（只有 Slack）：先发正文，再把图发到同一个地方。收下时已经复制进 drafts/images（见 images.ts）。
  images?: ReplyImage[];
  // 工作会话最初写的稿子（你改过才有，测评看你改了多少）。
  original?: string;
  // pending：等你确认；queued：你点了发送，sendAt 之前还能撤回；sending：引擎正在发；sent：发出去了；failed：没发出去（error）；
  // dropped：不发了；redo：你让它重写了（feedback 是你的意见）。
  status: "pending" | "queued" | "sending" | "sent" | "failed" | "dropped" | "redo";
  // 谁让发的：you（你点的）、policy（规矩允许直接发）。
  by?: "you" | "policy";
  sendAt?: string;
  sentAt?: string;
  error?: string;
  feedback?: string;
  at: string;
  url?: string;
}

export interface RepliesFile {
  nextId: number;
  items: Reply[];
}

// ── 事情 ──

export interface Thing {
  id: number;
  title: string;
  // 在哪个会话里做（没有会话的事情：只记一笔的、等别人的）。
  session?: string;
  // doing：会话在做；waiting_you：等你定；waiting_others：等别人；done：办完了；dropped：不做了。
  status: "doing" | "waiting_you" | "waiting_others" | "done" | "dropped";
  // 最近一句进展：做到哪了。
  progress: string;
  // 下一步要做什么。
  next?: string;
  // 卡在哪（没卡就没有）。
  blocker?: string;
  // 结果：PR 链接、文档、结论，一条一句，新的在后。
  results?: string[];
  // 截止日期 YYYY-MM-DD。
  due?: string;
  // 哪些事件归到这件事。
  events: number[];
  // 这件事的键（工单号、PR、Slack thread、Notion 页面）：新消息带着这些键就归到这件事。
  keys?: string[];
  // 从哪来的：chief（主会话派活时记的）、import（你让它导入的）。
  origin?: "chief" | "import";
  // 稍后再说：until 之前不在面板的进行中列表里（它的问题也先收起）；到点引擎叫醒它（去掉这一项，状态不变），交给主会话一条 thing.woke。
  snooze?: { until: string; at: string };
  updatedAt: string;
  // 进展的历史，新的在后，只留最近的。
  log: { at: string; text: string }[];
}

export interface Ask {
  id: number;
  thing: number;
  // 要你定什么，一两句。
  question: string;
  // 主会话的建议（照着做的话会怎么做）。
  suggest: string;
  // 关联的回复（建议的做法就是发这条回复时）。
  reply?: number;
  // open：等你定；answered：你定了（或主会话替你关了）；dismissed：你说不用问了；withdrawn：主会话撤掉了（问题不成立了，reason 写为什么）。
  status: "open" | "answered" | "dismissed" | "withdrawn";
  answer?: string;
  // 撤掉的原因（withdrawn）。
  reason?: string;
  // 什么时候答的、不问了、撤掉的：面板两分钟内能撤回你的回答，撤掉的当天留一行灰字。
  closedAt?: string;
  at: string;
}

export interface ThingsFile {
  nextThing: number;
  nextAsk: number;
  things: Thing[];
  asks: Ask[];
}

// ── 能撤回的操作（undo.json，见 undo.ts）──

export interface UndoEntry {
  id: number;
  at: string;
  // drop：事情标成不做了；mark：主会话把几条消息判断成只记下 / 忽略；skip：跳过积下的旧消息。
  kind: "drop" | "mark" | "skip";
  // 给人看的一句（不带 chief 的编号）。
  label: string;
  // drop：这件事原来是什么状态。
  thing?: { id: number; status: Thing["status"] };
  // mark / skip：每条消息原来怎么处理的（null：原来没判断）。
  events?: { id: number; before: Dispatch | null }[];
  // mark --thing：这次把哪几条消息记到了哪件事上（撤回时拿掉）。
  addedTo?: { thing: number; events: number[] };
  // 什么时候撤回的（撤回过的不能再撤）。
  undone?: string;
}

export interface UndoFile {
  nextId: number;
  items: UndoEntry[];
}

// ── chief search 的一条结果 ──

export interface SearchHit {
  kind: "thing" | "ask" | "reply" | "event" | "decision";
  // 事情号、问题号、回复号、事件号（判断用它的事件号）。
  id: number;
  date: string;
  // 这条是什么：事情标题、消息在哪、回谁。
  title: string;
  // 对上的那一段。
  snippet: string;
  url?: string;
  // 属于哪件事、在哪个会话（面板拿它跳过去）。
  thing?: number;
  session?: string;
  // 归档里的（办完很久的）。
  archived?: boolean;
}

// ── 场景和规矩 ──

// dispatch：派人去办（送进在做这件事的会话，没有就开新会话）；
// note：只记下（记进事情的进展，不派活、不打扰你）；ignore：忽略；
// approve：直接 approve 消息里的 PR（走待发出，规矩允许就直接发，5 秒可撤回）；
// command：当成你的指令（你在 Slack 上给自己发的话）。
export type Handle = "dispatch" | "note" | "ignore" | "approve" | "command";
// ask：回复先给你确认；auto：规矩允许直接发（发前仍有 5 秒能撤回）。
export type ReplyMode = "ask" | "auto";

export interface Proposal {
  id: number;
  // 提议的规矩，一句话。
  text: string;
  // 依据：你哪几次纠正了它。
  basis: string;
  at: string;
  // 主会话想放宽发送（见 commands/rules.ts 的 chief rules --yours）：没带钥匙就记成提议，采纳时照原样再跑一遍这条命令。
  change?: { args: string[]; input: string };
}

// Slack 对话的种类：一对一私信、群聊、频道、和你自己的私信。
export type Audience = "direct" | "group" | "channel" | "self";
// inline：直接回在对话里；thread：回到对方那条消息的 thread 里。
export type Placement = "inline" | "thread";

export interface ScenarioRule {
  handle: Handle;
  reply: ReplyMode;
  // 派这类活时额外交代给工作会话的话（你的做事方式，比如「review 先看有没有测试」）。
  brief?: string;
}

// 你自己加的情况：主会话判断时先看这些（用你写的「什么情况」去对），对上了就照它办，比内置的场景优先。
export interface CustomScenario extends ScenarioRule {
  id: number;
  // 什么情况，一句话，比如「Slack 里有人发 PR 链接让我看 / approve」。
  when: string;
}

// 三种做事方式：normal 规矩没放行的都等你点；auto 少让你点（只放开 approve 别人的 PR、回你自己 PR 上的话）；yolo 全部由助理代决策（只有「一定问我」名单拦得住）。
export type Mode = "normal" | "auto" | "yolo";
export const MODES_LIST: readonly Mode[] = ["normal", "auto", "yolo"];

export interface Policy {
  // 缺这一项就是 normal。升到 auto / yolo 算放宽发送，要钥匙（见 commands/rules.ts）。
  mode: Mode;
  scenarios: Record<Scenario, ScenarioRule>;
  custom: CustomScenario[];
  nextCustom: number;
  // 你写的规矩，一条一句。
  notes: string[];
  // 回复写法：替你写的话（回复、主动发的消息）照这几条写。
  style: string[];
  // 固定回复：一字不差是这几句之一的回复，引擎允许直接发（署名 not reviewed）。别的文字规矩只管怎么写，不能放行直接发。
  quick: string[];
  // 白名单：回这些人的话不用你确认，直接发（仍有 5 秒能撤回）。写 Slack 用户编号（U…），或完整的显示名（一字不差，不分大小写）。
  trusted: string[];
  // 一定问我：这些人（Slack 用户编号、完整显示名）、这些对话（频道 / 私信编号）的回复，不管别的规矩怎么写，引擎都不直接发。比白名单优先。
  askAlways: string[];
  // GitHub 上不报的机器人：注册成普通用户、名字又不带 bot 的（比如公司的 AI 代码评审），写登录名。它们的 review、评论都不算有人找你。
  bots: string[];
  // 替你发到 Slack 的话正文上方那行灰色小字署名（让对方一眼知道是 agent 代回的，不进正文）；空字符串 = 不加。
  signature: string;
  // Slack 回复放在哪：按对话的种类（一对一私信 / 群聊 / 频道 / 你给自己发的）。对方本来就在 thread 里说的，总是回到那个 thread。
  placement: Record<Audience, Placement>;
  // 主会话根据你的纠正提议的规矩，等你采纳。
  proposals: Proposal[];
  nextProposal: number;
}

// ── 判断记录 ──

export interface Decision {
  at: string;
  event: number;
  scenario: Scenario;
  // 主会话的判断：ignored / noted / forwarded / opened / asked（直接问你）。
  verdict: "ignored" | "noted" | "forwarded" | "opened" | "asked";
  // 为什么，一句话。
  reason: string;
  // 这条消息是什么（测评页列判断时给你看）。
  what: { source: EventSource; title: string; from: string | null; text: string };
  // 演练（chief eval run 造的例子）：主会话只说会怎么办、没真的办。不算进「替你做了」。
  dry?: boolean;
  thing?: number;
  session?: string;
}

export type Reviews = Record<string, { ok: boolean; note?: string; at: string }>;

// ── 演练用的例子 ──

// 主会话对一条消息的处理，归成四类，和例子里写的「应该怎么办」比。
export type Expect = "dispatch" | "note" | "ignore" | "ask";

export interface EvalCase {
  id: number;
  from: string;
  where: string;
  why: string;
  text: string;
  expect: Expect;
  // 补充说明：应该怎么办得更具体（比如送进哪个会话），给你看的。
  note?: string;
  // 从哪条真实判断存来的（事件号）。
  fromEvent?: number;
  at: string;
}

export interface EvalRun {
  id: number;
  at: string;
  // 例子号 → 这次演练造的事件号。
  events: Record<string, number>;
}

export interface EvalsFile {
  nextId: number;
  nextRun: number;
  cases: EvalCase[];
  runs: EvalRun[];
}

// ── 引擎报的状态（engine.json）──

export interface SourceHealth {
  ok: boolean;
  at: string;
  // 连着失败了几次（成功一次就清零）。
  fails: number;
  error?: string;
}

// ── chief doctor 的结果（设置页按它打勾）──

// 一个来源连没连好：browser / secret 的看 ready（钥匙串里有没有）；cli 的看 tool（命令装没装）、ok（试登录过没过）、detail（没过的原因）。
export interface DoctorSource {
  enabled: boolean;
  ready?: boolean;
  tool?: boolean;
  ok?: boolean;
  detail?: string;
}

export interface Doctor {
  version: string | null;
  node: string;
  engine: "running" | "stopped" | "missing";
  chrome: boolean;
  // 来源 → 状态（以前的样子，旧面板也读它）。
  sources: Record<string, DoctorSource>;
  hub: { listening: boolean; lastAt: string | null };
  // 插电时不让电脑睡（引擎挂着 caffeinate -s）
  awake: boolean;
  // 记下的 Slack 工作区（子域名），登录窗口从这里打开；没记过是 null
  slackWorkspace: string | null;
  // 工作目录 ~/chief：消息中心开在这里（ready：CLAUDE.md 在）
  workspace: { path: string; ready: boolean };
  // 同样的来源状态排成一列（带上编号、名字、怎么连），按来源名单的顺序。
  list: (DoctorSource & { id: string; label: string; setup: string })[];
  // 免打扰时段（null 没设）、每天汇总的时间（null 不发）：设置页那一行显示、改。
  quietHours: { start: string; end: string } | null;
  digest: { morning: string | null; evening: string | null };
}
