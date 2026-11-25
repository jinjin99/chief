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
//   confirm-key.sha256  「以你的名义发」用的钥匙的指纹：钥匙原文只在 chief 插件自己的存储里，主会话拿不到（见 cli.ts 的 chief key）。
//   key-log.jsonl 钥匙什么时候配的、清的、换的，只追加；面板拿它提醒你钥匙被换过。
//   reviews.json  你给主会话的判断标的对错（事件号 → 对 / 错和你说的应该怎样）。
//   held.json     免打扰时没弹的通知（见 quiet.ts）。
//   undo.json     最近能撤回的操作（不做了、只记下 / 忽略、跳过积下的）和撤回要用的原样（见 undo.ts）。
// 几个进程（引擎、主会话的命令、面板的命令）会同时写的文件（replies、things、policy、dispatch、routes、reviews、hub、undo），都拿着 <文件>.lock 读改写。
// 引擎只写 events.jsonl、state.json，外加拿着锁改 things.json（叫醒稍后再说的、归档）、replies.json（发送）；命令行（消息中心在用）也往 events.jsonl 追加（测试消息、撤回），拿着 state 的锁取号。
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { layoutOf, topOf } from "./shared/paths";
import { DEFAULT_PLACEMENT, DEFAULT_SIGNATURE } from "./shared/rules";
import { SCENARIO_META, type EventSource, type Scenario } from "./shared/sources";
import type { ChiefEvent, Decision, Policy, RepliesFile, Reviews, ScenarioRule, ThingsFile, Dispatch } from "./shared/types";

// 数据的样子在 shared/types.ts（面板也用），场景和来源在 shared/sources.ts，这里照旧都能 import 到。
export type * from "./shared/types";
export { AUDIENCE_LABELS, DEFAULT_PLACEMENT, HANDLE_LABELS, expectOf, placementOf } from "./shared/rules";
export { SCENARIOS, scenarioOf, type EventSource, type Scenario, type SourceId } from "./shared/sources";

// 工作目录：消息中心开在这里；你的交代、规矩、笔记、skill 和 chief 的数据都放在里面。
export function workspaceDir(): string {
  return join(homedir(), "chief");
}

export function chiefHome(): string {
  const dir = process.env.CHIEF_HOME;
  if (dir && !isAbsolute(dir)) throw new Error("CHIEF_HOME 要是绝对路径");
  return dir ? resolve(dir) : join(workspaceDir(), "data");
}

// 每个文件的名字见 shared/paths.ts（面板按同一份算）。
export function paths(home = chiefHome()) {
  return layoutOf(home, topOf(home, homedir()));
}

export function ensureHome(): void {
  const p = paths();
  for (const d of [p.home, p.drafts, p.logs, p.slackState]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

// 数据文件的格式版本：writeJson 写这些文件时盖上 version，chief 每次起来按它升级旧文件（见 migrate.ts）。
// 改了某个文件的样子：这里加一，migrate.ts 里补一步。
export const SCHEMA: Readonly<Record<string, number>> = {
  "state.json": 1, "replies.json": 1, "things.json": 1, "rules.json": 1, "evals.json": 1, "settings.json": 1, "hub.json": 1, "config.json": 1,
  "undo.json": 1,
};

// 这几个坏了不能当空的用：编号会从头算、等你的回复和事情全没了、规矩变回默认。读到坏的就报错，不往下走，也不覆盖它。
const CRITICAL = new Set(["replies.json", "things.json", "rules.json", "state.json"]);

export class CorruptFileError extends Error {}

export interface CorruptRecord {
  file: string;
  moved: string;
  at: string;
  error: string;
  critical: boolean;
  notified?: boolean;
}

export function loadCorrupt(): Record<string, CorruptRecord> {
  try {
    return JSON.parse(readFileSync(paths().corrupt, "utf8")) as Record<string, CorruptRecord>;
  } catch {
    return {};
  }
}

// 读到坏文件：留一份 <名字>.corrupt-<时间>，记进 corrupt.json。要紧的文件原样留着、复制一份（不挪走：挪走了下一次就当成没有、从头开始），
// 同一份坏内容只复制一次、只记一次（引擎崩了反复重启也不会一直复制、一直通知）；其余的挪走，下次就用默认的。
function quarantine(file: string, text: string, error: unknown): string {
  const name = basename(file);
  const critical = CRITICAL.has(name);
  const dir = dirname(file);
  const same = critical ? readdirSync(dir).find((f) => {
    if (!f.startsWith(`${name}.corrupt-`)) return false;
    try {
      return readFileSync(join(dir, f), "utf8") === text;
    } catch {
      return false;
    }
  }) : undefined;
  if (same) return join(dir, same);
  const moved = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (critical) copyFileSync(file, moved);
  else renameSync(file, moved);
  try {
    const all = loadCorrupt();
    all[name] = { file, moved, at: new Date().toISOString(), error: (error instanceof Error ? error.message : String(error)).slice(0, 200), critical };
    writeJson(paths().corrupt, all);
  } catch {
    // 记不上也不影响下面报错 / 用默认的。
  }
  return moved;
}

// 读一个 JSON 文件。没有（或是空的）就用 fallback。坏了（不是合法的 JSON）见 quarantine：要紧的文件抛 CorruptFileError。
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  // 空的：要紧的文件不会写出空的来（先写临时文件再改名），空了多半是以前断电留下的，当成坏了，免得编号从头算。
  if (text.trim() === "" && !CRITICAL.has(basename(file))) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const moved = quarantine(file, text, error);
    if (CRITICAL.has(basename(file))) {
      throw new CorruptFileError(`${basename(file)} 坏了（不是合法的 JSON），chief 不会拿空的覆盖它（编号会从头算、内容会丢）。坏的那份另存在 ${moved}。把 ${file} 修好再试；确定不要了就把它删掉`);
    }
    return fallback;
  }
}

// 先写临时文件、落盘（fsync）再改名：写到一半被杀、断电都不会留下半个文件。SCHEMA 里的文件盖上格式版本。
export function writeJson(file: string, value: unknown): void {
  const version = SCHEMA[basename(file)];
  const out = version !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) ? { version, ...value } : value;
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(out, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
// ── 事件 ──

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
  // 每天汇总：每个时段上次发的是哪天（当地日期 YYYY-MM-DD），重启不重复发。
  digest?: Partial<Record<"morning" | "evening", string>>;
}

const MAX_SEEN = 5000;
const MAX_THREADS = 5000;
const MAX_SENT = 1000;

export function loadState(): EngineState {
  const s = readJson<Partial<EngineState>>(paths().state, {});
  return { nextId: s.nextId ?? 1, since: s.since ?? {}, seen: s.seen ?? [], threads: s.threads ?? [], sent: s.sent ?? [], digest: s.digest ?? {} };
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

// 命令行自己造一条事件交给主会话（撤回了判断、撤回了不做了）：拿着 state 的锁取号再追加，和引擎不会拿到同一个号。
export function addEvent(e: Omit<ChiefEvent, "id">): ChiefEvent {
  return withLock(paths().state, () => {
    const st = loadState();
    const ev: ChiefEvent = { id: st.nextId++, ...e };
    saveState(st);
    appendEvent(ev);
    return ev;
  });
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

export function loadDispatch(): Record<string, Dispatch> {
  return readJson<Record<string, Dispatch>>(paths().dispatch, {});
}

// ── 事情、回复 ──

export function loadThings(): ThingsFile {
  return readJson<ThingsFile>(paths().things, { nextThing: 1, nextAsk: 1, things: [], asks: [] });
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

// ── 规矩 ──

// Slack 编号：U / W 开头是人，C / G / D 开头是对话；大写字母和数字，至少带一个数字（免得把全大写的名字当成编号）。
const SLACK_ID = /^[UWCGD][A-Z0-9]{6,20}$/;

export function isSlackId(text: string): boolean {
  return SLACK_ID.test(text) && /\d/.test(text);
}

// 名单里的一项是不是这个人：写的是编号就只认编号；写的是名字就要和显示名完全一样（不分大小写、去掉前后空格），不认名字的一部分。
// 显示名谁都能改成别人的，编号改不了：名单里最好写编号。
function samePerson(entry: string, from: string | null | undefined, fromId: string | null | undefined): boolean {
  const k = entry.trim();
  if (!k) return false;
  if (isSlackId(k)) return fromId === k;
  return !!from && from.trim().toLowerCase() === k.toLowerCase();
}

// 这条消息在不在「一定问我」名单里：说话的人（编号或完整显示名），或者所在的对话（频道 / 私信编号）。
export function mustAsk(list: readonly string[], event: Pick<ChiefEvent, "from" | "fromId" | "reply" | "speakers">): boolean {
  return list.some((t) => samePerson(t, event.from, event.fromId) || (event.speakers ?? []).some((s) => samePerson(t, s, undefined)) || (isSlackId(t.trim()) && event.reply.channel === t.trim()));
}

// 这个人在不在白名单里。
export function isTrusted(trusted: readonly string[], from: string | null | undefined, fromId: string | null | undefined): boolean {
  return trusted.some((t) => samePerson(t, from, fromId));
}

// 每个场景默认怎么办在 shared/sources.ts 的来源名单里。
export function defaultPolicy(): Policy {
  const scenarios = Object.fromEntries(Object.entries(SCENARIO_META).map(([k, m]): [string, ScenarioRule] => [k, { handle: m.handle, reply: m.reply ?? "ask", ...(m.brief ? { brief: m.brief } : {}) }])) as Record<Scenario, ScenarioRule>;
  return {
    mode: "normal",
    scenarios,
    signature: DEFAULT_SIGNATURE,
    trusted: [],
    askAlways: [],
    bots: [],
    quick: [],
    style: [
      "像同事在 Slack 上聊天，不像写报告：不加粗小标题，不写「主要原因是」「整体估计」「具体看」这类报告腔。",
      "第一句就说结论（做完了没、行不行、要对方做什么），单独一行，链接紧跟在后面。",
      "要讲几点理由或几件事，就分成短行，每行一点，用「- 」开头；结论、理由、下一步之间空一行。不要把好几层意思挤成一大段。",
      "整条一般不超过 6 行，每行一两句。细节、数据、推理过程放进 PR、文档或链接里；只留对方最关心的一两个数字。",
      "对方问什么答什么，没问的不展开。",
      "称呼和语气跟着对方：对方随意就随意，对方正式就正式。",
    ],
    placement: { ...DEFAULT_PLACEMENT },
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
    mode: p.mode === "auto" || p.mode === "yolo" ? p.mode : "normal",
    scenarios: { ...base.scenarios, ...(p.scenarios ?? {}) }, notes: p.notes ?? base.notes, signature: p.signature ?? base.signature,
    style: p.style ?? base.style,
    trusted: p.trusted ?? base.trusted,
    askAlways: p.askAlways ?? base.askAlways,
    bots: p.bots ?? base.bots,
    quick: p.quick ?? base.quick,
    placement: { ...base.placement, ...(p.placement ?? {}) },
    custom: p.custom ?? base.custom, nextCustom: p.nextCustom ?? base.nextCustom,
    proposals: p.proposals ?? [], nextProposal: p.nextProposal ?? 1,
  };
}

// ── 判断记录 ──

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
