// chief 的东西都在工作目录 ~/chief 里：你的规矩在 ~/chief/rules.json，其余数据在 ~/chief/data（可用 CHIEF_HOME 改成别的绝对路径，
// 那时规矩也放那里）。全是本机文件，不含密钥（密钥在钥匙串）：
//   events.jsonl  引擎收到的、要交给消息中心的事件，一行一条，只追加。
//   state.json    引擎自己的：下一个事件编号、每个来源拉到哪了、收过的编号、你在的 Slack thread。
//   sources.json  开着哪些来源（chief connect 写，引擎启动时读）。
//   settings.json 这台电脑上的开关：awake（插电时不让电脑睡，默认开）。
//   routes.json   消息中心的对应表：事件的键（thread、PR、工单、Notion 页面）→ 工作会话。
//   hub.json      消息中心处理到第几条事件。
//   dispatch.json 每条事件怎么处理的：分发到哪个会话、新开了会话、还是忽略了（面板按这个分「新进来的」和「处理中」）。
//   replies.json  等你点头的回复。
//   things.json   事情清单：每件事在哪个会话、到哪了、下一步该谁；要你定的问题。
//   drafts/       消息中心写回复正文的地方（chief reply add 只认这个目录里的文件）。
//   decisions.jsonl 主会话对每条消息的判断（怎么处理、为什么），只追加。测评和纠正都看它。
//   alive.json    主会话在不在听：chief events --follow 跑着时每 20 秒写一次。
//   engine.json   引擎在不在跑：每 20 秒写一次。
//   activity.json 事情挂着的 Claude App 会话最近的动静（引擎每分钟看一次，见 activity.ts）。
//   rules.json    你的规矩（结构化）：每个场景怎么处理、回复要不要你确认，加上你写的自由规矩、主会话提议的规矩。
//   reviews.json  你给主会话的判断标的对错（事件号 → 对 / 错和你说的应该怎样）。
// 几个进程（引擎、主会话的命令、面板的命令）会同时写的文件（replies、things、policy、dispatch、routes、reviews、hub），都拿着 <文件>.lock 读改写。
// 引擎只写 events.jsonl、state.json；命令行（消息中心在用）只写另外几个。两边不抢同一个文件。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ReplyImage } from "./images";

// 工作目录：消息中心开在这里；你的交代、规矩、笔记、skill 和 chief 的数据都放在里面。
export function workspaceDir(): string {
  return join(homedir(), "chief");
}

export function chiefHome(): string {
  const dir = process.env.CHIEF_HOME;
  if (dir && !isAbsolute(dir)) throw new Error("CHIEF_HOME 要是绝对路径");
  return dir || join(workspaceDir(), "data");
}

export function paths(home = chiefHome()) {
  // 规矩是给你看、给你改的：数据在默认位置时放到工作目录最上层，不然（测试）就和数据放一起。
  const top = home === join(workspaceDir(), "data") ? workspaceDir() : home;
  return {
    home,
    events: join(home, "events.jsonl"),
    state: join(home, "state.json"),
    sources: join(home, "sources.json"),
    settings: join(home, "settings.json"),
    routes: join(home, "routes.json"),
    hub: join(home, "hub.json"),
    dispatch: join(home, "dispatch.json"),
    replies: join(home, "replies.json"),
    things: join(home, "things.json"),
    policy: join(top, "rules.json"),
    decisions: join(home, "decisions.jsonl"),
    reviews: join(home, "reviews.json"),
    evals: join(home, "evals.json"),
    alive: join(home, "alive.json"),
    engineAlive: join(home, "engine.json"),
    activity: join(home, "activity.json"),
    drafts: join(home, "drafts"),
    logs: join(home, "logs"),
    slackState: join(home, "slack-state"),
    // 查过的 Slack 人：用户编号 → 名字（面板把稿子里的 <@U…> 显示成 @名字）。
    people: join(home, "people.json"),
    // 办完的旧东西搬到这里（见 archive.ts）：<种类>-<年月>.jsonl。
    archive: join(home, "archive"),
  };
}

export function ensureHome(): void {
  const p = paths();
  for (const d of [p.home, p.drafts, p.logs, p.slackState]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// 先写临时文件再改名：写到一半被杀也不会留下半个文件。
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ── 事件 ──

// session：事情挂着的 Claude App 会话有了新进展（引擎看会话记录发现的）。
export type EventSource = "slack" | "github" | "jira" | "notion" | "session";

export interface ChiefEvent {
  id: number;
  // 事情发生的时间。
  at: string;
  source: EventSource;
  kind: string;
  // 给人看的一行：「#design」「acme/shop#10318 xxx」。
  title: string;
  url: string | null;
  // 谁说的（Slack）；外部来源是 null（谁评论的写在 text 里）。
  from: string | null;
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

export interface EngineState {
  nextId: number;
  // 每个外部来源上次拉到的时间。
  since: Partial<Record<EventSource, string>>;
  // 收过的编号（Slack 的 deliveryId、外部来源的 externalId），只留最近的。
  seen: string[];
  // 你说过话、或者找过你的 Slack thread：这些 thread 里的后续也算跟你有关。
  threads: string[];
  // chief 替你发到 Slack 的消息（频道:ts）：推回来时认出来跳过。存下来，引擎重启后 Slack 补推的也认得。
  sent: string[];
}

const MAX_SEEN = 5000;
const MAX_THREADS = 5000;
const MAX_SENT = 1000;

export function loadState(): EngineState {
  const s = readJson<Partial<EngineState>>(paths().state, {});
  return { nextId: s.nextId ?? 1, since: s.since ?? {}, seen: s.seen ?? [], threads: s.threads ?? [], sent: s.sent ?? [] };
}

// 开着的来源（GitHub、Jira 用本机登录的 gh、acli 或 twg，没有密钥，靠这个记「开着」）。
export type Enabled = Partial<Record<EventSource, boolean>>;

export function loadEnabled(): Enabled {
  return readJson<Enabled>(paths().sources, {});
}

// 这台电脑上的开关。awake：引擎跑着时挂一个 caffeinate -s，插电时电脑不会自己睡（屏幕照样关、照样锁）；没插电照常睡。
export interface Settings {
  awake: boolean;
  // 你的 Slack 工作区（子域名，比如 acme）：登录窗口从这里打开，公司 SSO 才走得通。登录成功时记下，下次重新登录不用再给。
  slackWorkspace?: string;
}

export function loadSettings(): Settings {
  const s = readJson<Partial<Settings>>(paths().settings, {});
  return { awake: s.awake ?? true, ...(s.slackWorkspace ? { slackWorkspace: s.slackWorkspace } : {}) };
}

export function saveState(s: EngineState): void {
  s.seen = s.seen.slice(-MAX_SEEN);
  s.threads = s.threads.slice(-MAX_THREADS);
  s.sent = s.sent.slice(-MAX_SENT);
  writeJson(paths().state, s);
}

export function readEvents(): ChiefEvent[] {
  const file = paths().events;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as ChiefEvent] : [];
    } catch {
      return [];
    }
  });
}

export function appendEvent(e: ChiefEvent): void {
  appendFileSync(paths().events, `${JSON.stringify(e)}\n`, { mode: 0o600 });
}

// ── 对应表 ──

export interface Route {
  session: string;
  title: string;
  at: string;
}

export type Routes = Record<string, Route>;

export function loadRoutes(): Routes {
  return readJson<Routes>(paths().routes, {});
}

// ── 消息中心的进度 ──

export function loadCursor(): number {
  return readJson<{ cursor?: number }>(paths().hub, {}).cursor ?? 0;
}

// ── 每条事件怎么处理的 ──

export interface Dispatch {
  // forwarded：送进了已有的会话；opened：新开了会话；ignored：不管；noted：消息中心看过，不用开会话。
  status: "forwarded" | "opened" | "ignored" | "noted";
  session?: string;
  title?: string;
  at: string;
}

export function loadDispatch(): Record<string, Dispatch> {
  return readJson<Record<string, Dispatch>>(paths().dispatch, {});
}

// ── 等你点头的回复 ──

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
  status: "open" | "answered";
  answer?: string;
  at: string;
}

export interface ThingsFile {
  nextThing: number;
  nextAsk: number;
  things: Thing[];
  asks: Ask[];
}

export function loadThings(): ThingsFile {
  return readJson<ThingsFile>(paths().things, { nextThing: 1, nextAsk: 1, things: [], asks: [] });
}

export interface RepliesFile {
  nextId: number;
  items: Reply[];
}

export function loadReplies(): RepliesFile {
  return readJson<RepliesFile>(paths().replies, { nextId: 1, items: [] });
}

// 拿着锁读、改、写一个文件。锁是 <文件>.lock 目录（mkdir 是原子的）；拿锁的进程死了，30 秒后当它作废。
// fn 里出错要 throw（不要 process.exit）：finally 才会放锁。
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30_000) {
        try {
          rmdirSync(lock);
        } catch {
          // 别人刚好也在清。
        }
        continue;
      }
      if (i > 200) throw new Error(`${file} 被占着，过一会儿再试`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

// 锁着读、改、写一个 JSON 文件。
export function updateJson<F, T>(file: string, fallback: F, fn: (data: F) => T): T {
  return withLock(file, () => {
    const data = readJson<F>(file, fallback);
    const out = fn(data);
    writeJson(file, data);
    return out;
  });
}

export function updateReplies<T>(fn: (r: RepliesFile) => T): T {
  return updateJson<RepliesFile, T>(paths().replies, { nextId: 1, items: [] }, fn);
}

// ── 场景和规矩 ──

// 一条消息属于哪个场景（规矩按场景定）。
export type Scenario =
  | "slack_self" | "slack_dm" | "slack_mention" | "slack_thread"
  | "github_review" | "github_mention" | "github_comment" | "github_assigned" | "github_approved" | "github_changes"
  | "jira_assigned" | "jira_mention" | "jira_comment"
  | "notion_comment" | "session_update" | "other";

export const SCENARIOS: Record<Scenario, string> = {
  slack_self: "我在 Slack 上给自己发的话",
  slack_dm: "Slack 私信",
  slack_mention: "Slack 频道里 @我",
  slack_thread: "我在的 Slack thread 有后续",
  github_review: "PR 请我 review",
  github_mention: "GitHub 上 @我",
  github_comment: "别人评论了我的 PR / issue",
  github_assigned: "GitHub 指派给我",
  github_approved: "我的 PR 被 approve 了",
  github_changes: "我的 PR 被要求修改",
  jira_assigned: "Jira 指派给我",
  jira_mention: "Jira 评论里提到我",
  jira_comment: "别人评论了我的 Jira 单",
  notion_comment: "Notion 页面有新评论",
  session_update: "我的会话有新进展",
  other: "其他",
};

// why 里认得的几种（拼成「来源_why」就是场景名）。
const WHYS = new Set(["self", "dm", "mention", "thread", "review", "assigned", "comment", "approved", "changes"]);

export function scenarioOf(e: Pick<ChiefEvent, "source" | "why">): Scenario {
  const why = e.why[0] ?? "";
  if (e.source === "session") return "session_update";
  const s = `${e.source}_${WHYS.has(why) ? why : ""}`;
  return s in SCENARIOS ? (s as Scenario) : "other";
}

// dispatch：派人去办（送进在做这件事的会话，没有就开新会话）；
// note：只记下（记进事情的进展，不派活、不打扰你）；ignore：忽略；
// approve：直接 approve 消息里的 PR（走待发出，规矩允许就直接发，5 秒可撤回）；
// command：当成你的指令（你在 Slack 上给自己发的话）。
export type Handle = "dispatch" | "note" | "ignore" | "approve" | "command";

export const HANDLE_LABELS: Record<Handle, string> = {
  dispatch: "派人去办", note: "只记下", ignore: "忽略", approve: "直接 approve PR", command: "当成我的指令",
};
// ask：回复先给你确认；auto：规矩允许直接发（发前仍有 5 秒能撤回）。
export type ReplyMode = "ask" | "auto";

export interface Proposal {
  id: number;
  // 提议的规矩，一句话。
  text: string;
  // 依据：你哪几次纠正了它。
  basis: string;
  at: string;
}

// Slack 对话的种类：一对一私信、群聊、频道、和你自己的私信。
export type Audience = "direct" | "group" | "channel" | "self";
// inline：直接回在对话里；thread：回到对方那条消息的 thread 里。
export type Placement = "inline" | "thread";

export const AUDIENCE_LABELS: Record<Audience, string> = { direct: "一对一私信", group: "群聊", channel: "频道", self: "你给自己发的" };

// 一条 Slack 回复最终放哪：对方在 thread 里 → 回 thread；稿子自己指定了（target.in）→ 照它；否则按规矩里这种对话的默认。
export function placementOf(target: Readonly<Record<string, string>>, placement: Record<Audience, Placement>): Placement {
  if (target.thread_ts) return "thread";
  if (target.in === "thread" || target.in === "inline") return target.in;
  const audience = (target.audience as Audience | undefined) ?? (target.channel?.startsWith("D") ? "direct" : "channel");
  return placement[audience] ?? "thread";
}

// 这个人在不在白名单里：编号完全一样，或者名字里包含白名单写的那段（不分大小写）。
export function isTrusted(trusted: readonly string[], from: string | null | undefined, fromId: string | null | undefined): boolean {
  return trusted.some((t) => {
    const k = t.trim().toLowerCase();
    if (!k) return false;
    if (fromId && fromId.toLowerCase() === k) return true;
    return !!from && from.toLowerCase().includes(k);
  });
}

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

export interface Policy {
  scenarios: Record<Scenario, ScenarioRule>;
  custom: CustomScenario[];
  nextCustom: number;
  // 你写的规矩，一条一句。
  notes: string[];
  // 回复写法：替你写的话（回复、主动发的消息）照这几条写。
  style: string[];
  // 白名单：回这些人的话不用你确认，直接发（仍有 5 秒能撤回）。写 Slack 用户编号（U…）或名字的一部分。你写的「一定问我」的规矩照样优先。
  trusted: string[];
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

export function defaultPolicy(): Policy {
  const d = (handle: Handle): ScenarioRule => ({ handle, reply: "ask" });
  return {
    scenarios: {
      slack_self: { handle: "command", reply: "auto" },
      slack_dm: d("dispatch"), slack_mention: d("dispatch"), slack_thread: d("note"),
      github_review: d("dispatch"), github_mention: d("dispatch"), github_comment: d("dispatch"), github_assigned: d("dispatch"),
      github_approved: { handle: "dispatch", reply: "ask", brief: "看 CI 过没过、还有没有没回的评论；能合就问我要不要合，别自己合" },
      github_changes: d("dispatch"),
      jira_assigned: d("dispatch"), jira_mention: d("dispatch"), jira_comment: d("note"),
      notion_comment: d("note"), session_update: d("note"), other: d("note"),
    },
    signature: "🤖 agent reply",
    trusted: [],
    bots: [],
    style: [
      "像同事在 Slack 上聊天，不像写报告：不加粗小标题，不写「主要原因是」「整体估计」「具体看」这类报告腔。",
      "第一句就说结论（做完了没、行不行、要对方做什么），单独一行，链接紧跟在后面。",
      "要讲几点理由或几件事，就分成短行，每行一点，用「- 」开头；结论、理由、下一步之间空一行。不要把好几层意思挤成一大段。",
      "整条一般不超过 6 行，每行一两句。细节、数据、推理过程放进 PR、文档或链接里；只留对方最关心的一两个数字。",
      "对方问什么答什么，没问的不展开。",
      "称呼和语气跟着对方：对方随意就随意，对方正式就正式。",
    ],
    placement: { direct: "inline", group: "inline", channel: "thread", self: "thread" },
    custom: [{ id: 1, when: "Slack 里有人发 PR 链接，让我看一下 / 帮忙 approve", handle: "approve", reply: "auto", brief: "PR 已合并、已关闭、是我自己开的，就不 approve，只记下；CI 没过的先问我" }],
    nextCustom: 2,
    proposals: [],
    nextProposal: 1,
    notes: [
      "我在的 thread 的后续：只有点了我的名、或者在问我负责的东西，才派人去办；其余只记下。",
      "只是告知、道谢、「嗯」「好的」这类：只记下，不派活。",
      "答应排期、给承诺、拒绝别人、合并 PR、改别人的工单：一定问我（approve PR 按「我加的情况」办）。",
    ],
  };
}

export function loadPolicy(): Policy {
  const base = defaultPolicy();
  const p = readJson<Partial<Policy>>(paths().policy, {});
  return {
    scenarios: { ...base.scenarios, ...(p.scenarios ?? {}) }, notes: p.notes ?? base.notes, signature: p.signature ?? base.signature,
    style: p.style ?? base.style,
    trusted: p.trusted ?? base.trusted,
    bots: p.bots ?? base.bots,
    placement: { ...base.placement, ...(p.placement ?? {}) },
    custom: p.custom ?? base.custom, nextCustom: p.nextCustom ?? base.nextCustom,
    proposals: p.proposals ?? [], nextProposal: p.nextProposal ?? 1,
  };
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

export function expectOf(verdict: Decision["verdict"]): Expect {
  return verdict === "forwarded" || verdict === "opened" ? "dispatch" : verdict === "asked" ? "ask" : verdict === "ignored" ? "ignore" : "note";
}

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

export function loadReviews(): Reviews {
  return readJson<Reviews>(paths().reviews, {});
}

export function appendDecision(d: Decision): void {
  // 拿着锁追加：归档会重写这个文件，不锁的话这一行可能被冲掉。
  withLock(paths().decisions, () => appendFileSync(paths().decisions, `${JSON.stringify(d)}\n`, { mode: 0o600 }));
}

export function loadDecisions(): Decision[] {
  const file = paths().decisions;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as Decision] : [];
    } catch {
      return [];
    }
  });
}
