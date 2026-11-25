// chief 的后台引擎：收 Slack（推送）、每 5 分钟拉一次 GitHub / Jira / Notion，
// 跟你有关、要你处理的写进 events.jsonl，消息中心（Claude App 里的会话）用 Monitor 盯着这个文件。
// 引擎不碰 Claude。往外发的只有一种：你点了发送（或规矩允许）、过了 5 秒撤回期的回复（replies.json 里 queued 的）。
// 日志不写密钥和消息原文。
import { execFile } from "node:child_process";
import { readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { sessionsRoot, syncActivity, type SessionUpdate } from "./activity";
import { archiveOld, archivedEvent } from "./archive";
import { config, liveConfig, loadConfig } from "./config";
import { sendCheck } from "./gate";
import { rotateLog } from "./logfile";
import { msg } from "./messages";
import { holdIfQuiet, takeHeld } from "./quiet";
import { scrubTokens } from "./scrub";
import { wakeDue } from "./snooze";
import { KeychainStore, type SecretStore } from "./secrets";
import { keysOf } from "./keys";
import { DATA_HEALTH } from "./shared/rules";
import { DIGEST_LABELS, dueDigests, type DigestTimes } from "./shared/schedule";
import { SOURCE_LABELS, type SourceId } from "./shared/sources";
import { SlackPlugin, SLACK_COOKIE_D, describeSendError, sentThreadKey, type SlackAttribution } from "./slack/plugin";
import type { ChannelStatus, InboundMessage } from "./slack/types";
import { DESCRIPTORS, SOURCES, descriptorOf } from "./sources/registry";
import type { Source, SourceItem } from "./sources/types";
import { appendEvent, ensureHome, loadCorrupt, loadDispatch, loadEnabled, readEvents, readJson, loadPolicy, loadState, loadThings, placementOf, paths, saveState, updateReplies, withLock, writeJson, type Enabled, type EngineState, type ChiefEvent, type Reply, type SourceHealth } from "./store";

// 拉外部来源的间隔、第一次连上往回看多久：config.json 的 pollMinutes（默认 5 分钟）、firstLookbackHours（默认一天）。
const pollMs = () => config().pollMinutes * 60_000;
const firstLookbackMs = () => config().firstLookbackHours * 3600_000;

// 弹一条 macOS 通知（只用在出了要你管的事时：回复没发出去、Slack 登录失效、数据文件坏了；新消息不弹，要不要打扰你由主会话判断）。
// 文字当参数交给 osascript（不拼进脚本），对方写了什么都不会被当成脚本执行。
const NOTIFY = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';

function osascript(title: string, body: string): void {
  execFile("/usr/bin/osascript", ["-e", NOTIFY, title.slice(0, 80), body.replace(/\s+/g, " ").slice(0, 160)], { timeout: 10_000 }, () => {});
}

// 免打扰时段里先不弹、记下来（见 quiet.ts），critical（数据文件坏了、钥匙被换了）照样弹。返回弹没弹。
export function say(title: string, body: string, critical = false, show: (title: string, body: string) => void = osascript): boolean {
  if (!critical && holdIfQuiet(title, body)) return false;
  show(title, body);
  return true;
}

// 免打扰一过：攒下的合成一条弹出来。
export function flushHeld(now = new Date(), show: (title: string, body: string) => void = osascript): number {
  const held = takeHeld(now);
  if (held.length > 0) show(msg().heldTitle(held.length), held.map((x) => x.title.replace(/^chief · /, "")).join(msg().sep));
  return held.length;
}

const SEND_CHECK_MS = 1_000;
const SESSION_EVENT_MS = 30 * 60_000;
// 交给主会话超过这么久还没判断（没有 chief mark）的消息，算漏掉了：再交一次。config.json 的 missedMinutes，默认 10 分钟。
const missedMs = () => config().missedMinutes * 60_000;
// 主会话超过这么久没在听、又有消息等着：弹通知叫你；之后最多每 30 分钟提醒一次（hubDownMinutes、nagMinutes）。
const hubDownMs = () => config().hubDownMinutes * 60_000;
const hubNagMs = () => config().nagMinutes * 60_000;
const HEALTH_MS = 60_000;
const ARCHIVE_MS = 24 * 3600_000;
// 稍后再说的事情多久看一次到点没有。
const WAKE_MS = 60_000;

// 漏掉的消息：交出去（firstSeen 记着引擎第一次看到它没判断的时间）过了 missedMs 还没判断。演练消息和提醒本身不算。
export function missedEvents(events: readonly ChiefEvent[], handled: Record<string, unknown>, firstSeen: Map<number, number>, now: number, after = missedMs()): ChiefEvent[] {
  const open = events.filter((e) => !handled[e.id] && !e.dryrun && e.kind !== "chief.missed");
  const ids = new Set(open.map((e) => e.id));
  for (const id of [...firstSeen.keys()]) if (!ids.has(id)) firstSeen.delete(id);
  for (const e of open) if (!firstSeen.has(e.id)) firstSeen.set(e.id, now);
  return open.filter((e) => now - firstSeen.get(e.id)! >= after);
}

// 主会话是不是掉线了：alive.json 太久没更新。你让它停下的（stopped）不算掉线。
export function hubDown(alive: { at?: string; stopped?: boolean }, now: number, after = hubDownMs()): boolean {
  if (alive.stopped) return false;
  return alive.at === undefined || now - Date.parse(alive.at) >= after;
}

// 消息开头是不是 chief 的标识（去掉 Markdown 的 _ * 再比）。
// 以前署名写在正文第一行，现在放在正文上方的署名行里；留着它认出以前发的（引擎重启后补收私信时会再看到）。
export function startsWithSignature(text: string, signature: string): boolean {
  const bare = (t: string) => t.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
  const sign = bare(signature);
  return sign !== "" && bare(text).startsWith(sign);
}

// 替你发到 Slack 的话正文上方那行灰色小字：「🤖 <署名> · confirmed by @你」。
// 你点了发送的写 confirmed by；规矩允许直接发的（没经你看）写 sent for … · not reviewed，不冒充你确认过。署名为空就不加。
// 署名是你自己设的，仍按 mrkdwn 转义 & < >，免得写成 @某人、@channel 之类真的去提醒人。
export function signatureAttribution(signature: string, by: Reply["by"]): SlackAttribution {
  const sign = signature.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (sign === "") return false;
  return by === "you"
    ? { text: `${sign} · confirmed by {self}`, review: "confirmed" }
    : { text: `${sign} · sent for {self} · not reviewed`, review: "unconfirmed" };
}

// 这个 thread 算不算「你在的」：你说过话、找过你的（threads），或者根消息是 chief 替你发出去的（sent 里记着，修之前发的也算）。
export function inYourThread(key: string, threads: readonly string[], sent: readonly string[]): boolean {
  return threads.includes(key) || (key.startsWith("slack:") && sent.includes(key.slice("slack:".length)));
}

// 这条 Slack 消息是不是 chief（或别的 agent）替你发的，不是新消息：
// - 记下的发出编号（存在 state.json，重启后补推的也认得）；
// - 你自己账号发的、正文上方带 agent 署名行的（现在的发法），或正文开头是署名的（以前的发法；Slack 回传时会把 _ 换成 *）。
// 只看正文像不像署名不算：别人的消息开头写上署名就能让 chief 看不见它。
export function isOwnAgentMessage(m: InboundMessage, sent: readonly string[], signature: string, selfId: string | null): boolean {
  if (sent.includes(`${m.replyTarget.channel}:${m.replyTarget.ts}`)) return true;
  if (selfId === null || m.sender.id !== selfId) return false;
  return m.attribution !== undefined || startsWithSignature(m.text, signature);
}

// 写进日志之前把像密钥的东西去掉（GitHub、Jira 命令出错时可能把令牌带出来）。
function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${scrubTokens(line)}\n`);
}

const engineLog = () => `${paths().logs}/engine.log`;

// Slack 登录失效（auth.dead）：从好的变成失效时弹一次通知，之后每次重连失败都不再弹，直到再连上。返回要不要弹。
export function slackDeadChanged(wasDead: boolean, s: ChannelStatus): { dead: boolean; notify: boolean } {
  if (s.state === "connected") return { dead: false, notify: false };
  if (s.state === "error" && s.dead) return { dead: true, notify: !wasDead };
  return { dead: wasDead, notify: false };
}

// 数据文件坏了（见 store.ts 的 readJson，记在 corrupt.json）：没通知过的弹一次通知（免打扰也弹）；还坏着的拼成一条 health 给面板标红。
// 要紧的文件修好了（或删了）就不再算；其余的（已经挪走、用了默认的）标一天。
export function notifyCorrupt(now = Date.now(), notify: (title: string, body: string) => void = (t, b) => void say(t, b, true)): SourceHealth | null {
  const all = loadCorrupt();
  let changed = false;
  for (const [name, r] of Object.entries(all)) {
    const fixed = r.critical ? (() => {
      try {
        JSON.parse(readFileSync(r.file, "utf8"));
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    })() : now - Date.parse(r.at) > 86_400_000;
    if (fixed) {
      delete all[name];
      changed = true;
      continue;
    }
    if (!r.notified) {
      notify(msg().corruptTitle(name), r.critical ? msg().corruptCritical(name, r.moved) : msg().corruptMoved(name, r.moved));
      r.notified = true;
      changed = true;
    }
  }
  if (changed) writeJson(paths().corrupt, all);
  const left = Object.values(all);
  if (left.length === 0) return null;
  const at = left.map((r) => r.at).sort().at(-1)!;
  return { ok: false, at, fails: 2, error: left.map((r) => msg().corruptHealth(r.file.split("/").at(-1) ?? r.file, r.critical, r.moved)).join(msg().sep).slice(0, 400) };
}

// 按开关和钥匙串搭出要拉的外部来源（来源注册表里有 build 的；Slack 是推送，见 startSlack）。
export async function buildSources(enabled: Enabled, secrets: SecretStore): Promise<Source[]> {
  const out: Source[] = [];
  for (const d of DESCRIPTORS) {
    if (!enabled[d.id] || !d.build) continue;
    const built = await d.build({ secrets, bots: () => loadPolicy().bots });
    if (typeof built === "string") log(`[${d.id}] ${built}，跳过`);
    else out.push(built);
  }
  return out;
}

// 外部来源的一条动态 → 事件。只有「有人找你」的（请你 review、指派给你、@ 你、评论了你的）才交给消息中心。
// 这件事自己的键、回复回到哪，由来源自己说（SourceDescriptor 的 event）。
export function eventOfItem(source: SourceId, item: SourceItem): Omit<ChiefEvent, "id"> | null {
  if (!item.asks || item.asks.length === 0) return null;
  const to = SOURCES[source].event?.(item);
  if (!to) return null;
  return {
    at: item.at, source, kind: item.kind, title: item.title, url: item.url, from: null,
    text: item.summary, why: item.asks, keys: [...new Set([to.key, ...keysOf(`${item.title} ${item.summary}`)])], reply: to.reply,
  };
}

// Slack 原文里的内部写法换成人看得懂的（仍是 Markdown，面板按 Markdown 画）：
// <@U123> → @名字（你自己是 @你），<!channel> → @channel，<#C1|dev> → #dev，<url|字> → [字](url)，<url> → url。
export function slackText(text: string, mentions: readonly { id: string; name: string }[] = [], selfId: string | null = null): string {
  const names = new Map(mentions.map((p) => [p.id, p.name]));
  return text
    .replace(/<@([UW][A-Z0-9]{2,20})(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `@${id === selfId ? "你" : names.get(id) ?? label ?? "某人"}`)
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^>]+)>/g, "$1");
}

// Slack 的一条消息 → 事件。你自己说的话、机器人、改和删都不交，只记下你在的 thread。
export function eventOfSlack(m: InboundMessage, selfId: string | null = null): Omit<ChiefEvent, "id"> | null {
  if (m.kind !== "message.received" || m.role !== "message" || m.relevance === null || m.sender.bot) return null;
  const text = slackText(m.text, m.mentions, selfId);
  const self = m.relevance === "self";
  return {
    at: m.occurredAt, source: "slack", kind: m.kind, title: self ? "你在 Slack 上给助理的话" : m.conversation.label, url: null, from: self ? "你" : m.sender.name, fromId: m.sender.id,
    text, why: [m.relevance], keys: [m.conversation.threadKey, ...keysOf(m.text)],
    // 记下是哪种对话：回复放 thread 还是直接回在对话里，按它定（见 placementOf）。
    reply: { ...m.replyTarget, audience: self ? "self" : m.conversation.audience },
  };
}

// 每天汇总的事件：不是外部来源（source 是 chief），主会话看到 kind 是 digest 就去 chief digest 拿材料。
export function digestEvent(slot: keyof DigestTimes, date: string, now: Date): Omit<ChiefEvent, "id"> {
  return {
    at: now.toISOString(), source: "chief", kind: "digest", title: `${DIGEST_LABELS[slot]}（${date}）`, url: null, from: null,
    text: `到点写${DIGEST_LABELS[slot]}了：chief digest --event <这条的编号> 拿材料，写一份汇总给用户。`, why: [slot], keys: [], reply: {},
  };
}

// 引擎重启：上次停下时正在发的，不知道发出去没有，标成没发出去，让你去看一眼，不自动重发。
export function recoverSending(): void {
  updateReplies((all) => {
    for (const r of all.items) {
      if (r.status === "sending") Object.assign(r, { status: "failed", error: "引擎重启时这条正在发，不确定对方收到没有，请去看一眼再决定重发" });
      // 旧版引擎排上的（你确认时没记下内容指纹）：放回待发出，你再点一次发送，不当成被改过。
      else if (r.status === "queued" && r.by === "you" && !r.confirm?.hash) {
        r.status = "pending";
        delete r.sendAt;
        delete r.by;
      }
    }
  });
}

type SendResult = { url: string | null; warning?: string };

// 测试换成假的：真的发出去、弹通知都换掉。
export interface EngineDeps {
  send?: (r: Reply) => Promise<SendResult>;
  notify?: (title: string, body: string) => void;
}

export type { SourceHealth };

export class Engine {
  private state: EngineState = loadState();
  private readonly enabled: Enabled = loadEnabled();
  private readonly secrets: SecretStore = new KeychainStore();
  private sources: Source[] = [];
  private slack: SlackPlugin | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly abort = new AbortController();
  private polling = false;
  private sending = false;
  private sendTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private archiveTimer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  // 每个来源最近一次收 / 拉的结果，跟心跳一起写进 engine.json，面板拿它把连不上的来源标红。
  private readonly health: Record<string, SourceHealth> = {};
  private readonly startedAt = Date.now();
  private readonly firstSeen = new Map<number, number>();
  private lastHubNag = 0;
  private slackDead = false;
  private sessionWatcher: FSWatcher | null = null;
  // 见过的「要你定」。null = 引擎刚起来、还没看过一遍：已有的只记下不弹。
  private knownAsks: Set<number> | null = null;

  constructor(private readonly deps: EngineDeps = {}) {}

  async start(): Promise<void> {
    ensureHome();
    // 每次起来换一个日志文件（上一次的留在 engine.log.1），之后每分钟看一眼，超过 logMaxMB 再换。
    this.rotateLog(0);
    for (const p of loadConfig().problems) log(`[config] ${p}`);
    this.sources = await buildSources(this.enabled, this.secrets);
    log(`开始：外部来源 ${this.sources.map((s) => s.id).join("、") || "没有"}；事件写在 ${paths().events}`);
    try {
      recoverSending();
    } catch (error) {
      log(`检查上次没发完的回复没成：${error instanceof Error ? error.message : String(error)}`);
    }
    await this.startSlack();
    this.sendTimer = setInterval(() => void this.sendDue(), SEND_CHECK_MS);
    // 面板看这个知道引擎在跑。
    const beat = () => {
      let data: SourceHealth | null = null;
      try {
        data = notifyCorrupt();
      } catch (error) {
        log(`看坏了的数据文件没成：${error instanceof Error ? error.message : String(error)}`);
      }
      writeJson(paths().engineAlive, { at: new Date().toISOString(), pid: process.pid, health: data ? { ...this.health, [DATA_HEALTH]: data } : this.health });
    };
    beat();
    this.beatTimer = setInterval(beat, 20_000);
    // 子会话里的动静：监听 Claude App 的会话记录（只读本机文件）。
    const watch = () => {
      try {
        for (const u of syncActivity()) this.sessionUpdate(u);
      } catch (error) {
        log(`看会话动静没成：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    watch();
    // 会话一有动静（App 改写它的记录文件），macOS 马上告诉我们：不用一直去看。保底每分钟再看一次（监听断了也不漏）。
    let pending: NodeJS.Timeout | null = null;
    try {
      this.sessionWatcher = fsWatch(sessionsRoot(), { recursive: true }, (_type, name) => {
        if (!name || !String(name).includes("local_")) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(watch, 500);
      });
    } catch (error) {
      log(`监听会话记录没成，改成每分钟看一次：${error instanceof Error ? error.message : String(error)}`);
    }
    this.activityTimer = setInterval(watch, 60_000);
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), pollMs());
    this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_MS);
    // 睡醒、重启时错过的汇总先补上（见 dueDigests）。
    this.digestTick();
    // 办完的旧东西每天搬一次（起来时先搬一次）。
    this.archive();
    this.archiveTimer = setInterval(() => this.archive(), ARCHIVE_MS);
    // 稍后再说的事情到点了就叫醒（起来时先看一次：关机时到点的也补上）。
    this.wakeSnoozed();
    this.wakeTimer = setInterval(() => this.wakeSnoozed(), WAKE_MS);
  }

  // 叫醒到点的事情：弹个通知，再交给主会话一条 thing.woke（它重新跟进、告诉你）。测试直接调。
  wakeSnoozed(now = Date.now()): void {
    try {
      for (const t of wakeDue(now)) {
        log(`事情 ${t.id} 稍后再说的时间到了`);
        (this.deps.notify ?? say)(msg().wokeTitle, t.title);
        this.emit({
          at: new Date(now).toISOString(), source: "session", kind: "thing.woke", title: `到点了：${t.title}`.slice(0, 200), url: null, from: null,
          text: `事情 #${t.id}「${t.title}」用户之前说稍后再说，现在到点了，已经拿回进行中。看一眼现状（chief thing list；有会话的可以问它进展），跟用户说一句这件事回来了、现在卡在哪、下一步是什么；要他拍板的 chief ask add。这条 mark noted --thing ${t.id}。`,
          why: ["woke"], keys: [...(t.keys ?? []), ...(t.session ? [t.session] : [])], reply: {},
        }, `woke:${t.id}:${now}`);
      }
    } catch (error) {
      log(`叫醒稍后再说的事情没成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private rotateLog(maxBytes: number): void {
    try {
      if (rotateLog(engineLog(), maxBytes)) log("换了一个日志文件（旧的在 engine.log.1）");
    } catch (error) {
      log(`换日志文件没成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private archive(): void {
    try {
      const n = archiveOld();
      const total = Object.values(n).reduce((a, b) => a + b, 0);
      if (total > 0) log(`归档：事件 ${n.events}、判断 ${n.decisions}、事情 ${n.things}、问题 ${n.asks}、回复 ${n.replies}`);
    } catch (error) {
      log(`归档没成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 工作会话自己 chief ask add 的「要你定」主会话不知道：新出现的弹个通知叫你看面板，每条只弹一次。测试直接调。
  notifyNewAsks(): void {
    const open = loadThings().asks.filter((a) => a.status === "open");
    if (this.knownAsks !== null) for (const a of open) if (!this.knownAsks.has(a.id)) (this.deps.notify ?? say)(msg().newAskTitle, a.question);
    this.knownAsks = new Set(open.map((a) => a.id));
  }

  // 每分钟对一次账：交出去的消息主会话有没有判断、主会话还在不在听。消息交出去不等于被处理了，这里兜底。
  private checkHealth(): void {
    this.rotateLog(config().logMaxMB * 1024 * 1024);
    this.digestTick();
    try {
      this.notifyNewAsks();
    } catch (error) {
      log(`查新的「要你定」没成：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const n = flushHeld();
      if (n > 0) log(`免打扰过了，攒下的 ${n} 条提醒合成一条弹了`);
    } catch (error) {
      log(`弹免打扰时攒下的提醒没成：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const now = Date.now();
      const handled = loadDispatch();
      const events = readEvents();
      const missed = missedEvents(events, handled, this.firstSeen, now);
      const down = hubDown(readJson<{ at?: string; stopped?: boolean }>(paths().alive, {}), now);
      // 主会话在听：漏掉的再交一次（每条只补交一次，引擎重启也不重复）。
      if (!down) {
        for (const e of missed) {
          this.emit({
            at: new Date(now).toISOString(), source: e.source, kind: "chief.missed", title: `漏掉了：#${e.id} ${e.title}`.slice(0, 200), url: e.url, from: e.from,
            text: `事件 #${e.id} 交给你超过 ${config().missedMinutes} 分钟了还没判断（没有 chief mark）。用 chief show ${e.id} 看全文，照平常的办法处理，办完 mark ${e.id}；这条提醒也一起 mark。`,
            why: ["missed"], keys: e.keys, reply: {},
          }, `missed:${e.id}`);
        }
      }
      // 主会话掉线了、又有消息等着：叫你。引擎刚起来的头几分钟不算（主会话可能还没挂上）。
      const waiting = events.filter((e) => !handled[e.id] && !e.dryrun).length;
      if (down && waiting > 0 && now - this.startedAt >= hubDownMs() && now - this.lastHubNag >= hubNagMs()) {
        this.lastHubNag = now;
        log(`主会话没在听，有 ${waiting} 条消息等着`);
        say(msg().hubDownTitle, msg().hubDown(waiting));
      }
    } catch (error) {
      log(`对账没成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 每天汇总：到点了交一条 digest 事件给主会话，它用 chief digest 拿材料写给你。每个时段每天一次（记在 state.json 的 digest，重启不重复）。
  digestTick(now = new Date()): void {
    try {
      const fired = this.state.digest ?? {};
      for (const d of dueDigests(liveConfig().digest, fired, now)) {
        this.state.digest = { ...this.state.digest, [d.slot]: d.date };
        this.emit(digestEvent(d.slot, d.date, now), `digest:${d.slot}:${d.date}`);
        this.persist();
      }
    } catch (error) {
      log(`看要不要发汇总没成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.sendTimer) clearInterval(this.sendTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.sessionWatcher?.close();
    this.abort.abort();
    await this.slack?.stop();
    this.persist();
    log("停了");
  }

  // 会话有了新进展：交给主会话判断（要不要你拍板、记进展）。像在问你的马上交；其余每个会话最多 30 分钟交一次。
  private readonly lastSessionEvent = new Map<string, number>();

  private sessionUpdate(u: SessionUpdate): void {
    // 会话停在问你的对话框上：先弹个通知（不等主会话），再交给主会话登记成「要你定」。
    if (u.waiting) say(msg().sessionWaitingTitle, `${u.title}${msg().colon}${u.waiting}`);
    const last = this.lastSessionEvent.get(u.session) ?? 0;
    if (!u.asking && Date.now() - last < SESSION_EVENT_MS) return;
    this.lastSessionEvent.set(u.session, Date.now());
    this.emit({
      at: u.at, source: "session", kind: "session.update", title: u.title, url: null, from: `会话「${u.title}」`,
      text: u.last, why: [u.asking ? "asking" : "update"], keys: [u.session], reply: {},
    }, `session:${u.session}:${u.at}`);
  }

  private sourceResult(id: string, error?: string): void {
    const fails = error === undefined ? 0 : (this.health[id]?.fails ?? 0) + 1;
    this.health[id] = { ok: error === undefined, at: new Date().toISOString(), fails, ...(error === undefined ? {} : { error: scrubTokens(error).replace(/\s+/g, " ").slice(0, 160) }) };
  }

  // 存引擎的状态：拿着锁，编号取两边大的（别的进程可能刚造过测试事件）。
  private persist(): void {
    withLock(paths().state, () => {
      this.state.nextId = Math.max(this.state.nextId, loadState().nextId);
      saveState(this.state);
    });
  }

  private emit(e: Omit<ChiefEvent, "id">, dedupe: string): boolean {
    if (this.state.seen.includes(dedupe)) return false;
    this.state.seen.push(dedupe);
    // 拿着锁取号、记下编号再写事件：chief test 也会造事件，两边不会拿到同一个号；中间断了只会空一个号。
    const event = withLock(paths().state, () => {
      this.state.nextId = Math.max(this.state.nextId, loadState().nextId);
      const ev: ChiefEvent = { id: this.state.nextId++, ...e };
      saveState(this.state);
      appendEvent(ev);
      return ev;
    });
    log(`事件 #${event.id}：${event.source} ${event.why.join("/")}`);
    return true;
  }

  private async startSlack(): Promise<void> {
    if (!this.enabled.slack) return;
    const cookie = await this.secrets.get(SOURCES.slack.secret!);
    if (!cookie) {
      log("[slack] 钥匙串里没有 Cookie，跳过");
      return;
    }
    this.slack = new SlackPlugin({ stateDir: paths().slackState, catchUpMs: config().slackCatchUpHours * 3600_000 });
    await this.slack.start({
      secrets: { [SLACK_COOKIE_D]: cookie },
      deliver: async (m) => {
        // chief 自己替你发出去的话又被 Slack 推回来了：不是新消息，跳过（不然在和自己的私信里会自己回自己）。怎么认见 isOwnAgentMessage。
        if (isOwnAgentMessage(m, this.state.sent, loadPolicy().signature, this.slack?.selfId() ?? null)) {
          if (!this.state.seen.includes(m.deliveryId)) this.state.seen.push(m.deliveryId);
          return;
        }
        // 你说过话的、找过你的 thread：后续也算跟你有关。
        if (m.role === "self" || m.relevance !== null) {
          if (!this.state.threads.includes(m.conversation.threadKey)) this.state.threads.push(m.conversation.threadKey);
        }
        const e = eventOfSlack(m, this.slack?.selfId() ?? null);
        if (e) this.emit(e, m.deliveryId);
        else if (!this.state.seen.includes(m.deliveryId)) {
          this.state.seen.push(m.deliveryId);
          this.persist();
        }
      },
      threadSeen: (key) => inYourThread(key, this.state.threads, this.state.sent),
      status: (s) => {
        log(`[slack] ${s.state === "error" ? `出错：${s.error}` : s.state}`);
        if (s.state === "error") this.sourceResult("slack", String(s.error));
        else if (s.state === "connected") this.sourceResult("slack");
        const dead = slackDeadChanged(this.slackDead, s);
        this.slackDead = dead.dead;
        if (dead.notify) say(msg().slackDeadTitle, msg().slackDead);
      },
      log: (line) => log(`[slack] ${line}`),
    });
  }

  // 过了撤回期的回复：先标成 sending（拿着锁，不会发两次），再发，再记结果。
  // 发出去了但结果没记上（文件被占着）：记在 unrecorded 里下一轮再记，绝不因为记不上就当成没发出去。
  private readonly unrecorded = new Map<number, SendResult>();

  // 每秒跑一次（测试直接调）。发之前每条再核一遍（sendCheck）：核不过的标成没发出去，写明为什么，绝不发。
  async sendDue(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (const [id, out] of [...this.unrecorded]) {
        if (this.record(id, { status: "sent", sentAt: new Date().toISOString(), ...(out.url ? { url: out.url } : {}) })) this.unrecorded.delete(id);
      }
      const now = Date.now();
      let due: Reply[];
      try {
        due = updateReplies((all) => {
          const ready = all.items.filter((r) => r.status === "queued" && Date.parse(r.sendAt ?? "") <= now);
          for (const r of ready) r.status = "sending";
          return ready.map((r) => ({ ...r }));
        });
      } catch (error) {
        log(`这一轮没拿到待发的回复：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const notify = this.deps.notify ?? ((t: string, b: string) => void say(t, b));
      const pol = due.length > 0 ? loadPolicy() : null;
      const events = due.length > 0 ? readEvents() : [];
      for (const r of due) {
        const event = r.kind === "message" ? null : events.find((e) => e.id === r.event) ?? archivedEvent(r.event) ?? null;
        const bad = sendCheck(r, pol!, event);
        if (bad !== null) {
          if (!this.record(r.id, { status: "failed", error: bad })) log(`回复 ${r.id} 没核过，结果也没记上（下次引擎启动会标成要你看一眼）`);
          log(`回复 ${r.id} 发之前没核过，没发：${bad}`);
          notify(msg().replyBlockedTitle, `${r.context.who ?? r.context.where}${msg().colon}${bad}`);
          continue;
        }
        let out: SendResult;
        try {
          out = await (this.deps.send ?? ((x: Reply) => this.sendOne(x)))(r);
        } catch (error) {
          const why = r.source === "slack" ? describeSendError(error) : error instanceof Error ? error.message.slice(0, 200) : String(error);
          if (!this.record(r.id, { status: "failed", error: why })) log(`回复 ${r.id} 没发出去，结果也没记上（下次引擎启动会标成要你看一眼）`);
          log(`回复 ${r.id} 没发出去：${why}`);
          notify(msg().replyFailedTitle, `${r.context.who ?? r.context.where}${msg().colon}${why}`);
          continue;
        }
        log(`回复 ${r.id} 发出去了（${r.source}）${out.warning ? `；${out.warning}` : ""}`);
        if (out.warning) notify(msg().imageFailedTitle, `${r.context.who ?? r.context.where}${msg().colon}${out.warning}`);
        if (!this.record(r.id, { status: "sent", sentAt: new Date().toISOString(), ...(out.url ? { url: out.url } : {}), ...(out.warning ? { error: out.warning } : {}) })) this.unrecorded.set(r.id, out);
      }
    } catch (error) {
      log(`发回复出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sending = false;
    }
  }

  // 把一条回复的结果写进 replies.json；文件被占着就返回 false。
  private record(id: number, patch: Partial<Reply>): boolean {
    try {
      updateReplies((all) => {
        const x = all.items.find((y) => y.id === id);
        if (x) Object.assign(x, patch);
      });
      return true;
    } catch {
      return false;
    }
  }

  private async sendOne(r: Reply): Promise<SendResult> {
    const signal = AbortSignal.timeout(60_000);
    const d = descriptorOf(r.source);
    if (r.kind === "approve") {
      if (!d?.approve) throw new Error(`${SOURCE_LABELS[r.source]} 上不能 approve`);
      return { url: (await d.approve(r.target.ref ?? "", r.body, signal)).url };
    }
    // Slack 是推送的，发要用引擎连着的那个 SlackPlugin，不走注册表。
    if (r.source === "slack") {
      if (!this.slack) throw new Error("Slack 没连上（chief connect slack）");
      // 署名不进正文：放在正文上方的一行灰色小字里（Slack 的 context block），对方一眼看出是 agent 代回的。
      const attribution = signatureAttribution(loadPolicy().signature, r.by);
      const sent = r.kind === "message"
        ? await this.slack.sendNew(r.target.to ?? "", r.body, r.target.thread_ts, attribution)
        : await this.slack.send(r.target, r.body, placementOf(r.target, loadPolicy().placement) === "thread", attribution);
      this.state.sent.push(sent.ref);
      // 正文落在的 thread 记成「你在的」：别人在下面回复，和你自己发的帖子一样交给消息中心。
      const key = sentThreadKey(sent);
      if (!this.state.threads.includes(key)) this.state.threads.push(key);
      this.persist();
      // 附的图跟着正文（发进哪个 thread 见 imageThreadOf）。正文已经发出去了：图没发上也不能算整条失败（重发会把正文再发一遍），记在 error 里给你看。
      const failed = r.images?.length ? await this.slack.sendImages(sent, r.images) : [];
      return { url: null, ...(failed.length > 0 ? { warning: `正文发出去了，图没发上：${failed.join("；")}` } : {}) };
    }
    if (d?.comment) return { url: (await d.comment(r.target, r.body, signal)).url };
    throw new Error(`${d?.meta.readOnly ?? `${SOURCE_LABELS[r.source]} 只读`}，请你到页面上自己回`);
  }

  private async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const source of this.sources) {
        const started = new Date();
        const since = new Date(this.state.since[source.id] ?? Date.now() - firstLookbackMs());
        try {
          const items = await source.poll(since, this.abort.signal);
          let n = 0;
          for (const item of items) {
            const e = eventOfItem(source.id, item);
            if (e && this.emit(e, `${source.id}:${item.externalId}`)) n++;
          }
          this.state.since[source.id] = started.toISOString();
          this.persist();
          log(`[${source.id}] 拉了 ${items.length} 条动态，${n} 条交给消息中心`);
          this.sourceResult(source.id);
        } catch (error) {
          if (this.abort.signal.aborted) return;
          log(`[${source.id}] 没拉成：${error instanceof Error ? error.message : String(error)}`);
          this.sourceResult(source.id, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
