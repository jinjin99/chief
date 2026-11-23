// chief 的后台引擎：收 Slack（推送）、每 5 分钟拉一次 GitHub / Jira / Notion，
// 跟你有关、要你处理的写进 events.jsonl，消息中心（Claude App 里的会话）用 Monitor 盯着这个文件。
// 引擎不碰 Claude。往外发的只有一种：你点了发送（或规矩允许）、过了 5 秒撤回期的回复（replies.json 里 queued 的）。
// 日志不写密钥和消息原文。
import { execFile } from "node:child_process";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { sessionsRoot, syncActivity, type SessionUpdate } from "./activity";
import { archiveOld } from "./archive";
import { KeychainStore, type SecretStore } from "./secrets";
import { keysOf } from "./keys";
import { SlackPlugin, SLACK_COOKIE_D, type SlackAttribution } from "./slack/plugin";
import type { InboundMessage } from "./slack/types";
import { GitHubSource, findGh, ghRunner } from "./sources/github";
import { JiraSource, findJiraCli } from "./sources/jira";
import { NotionSource } from "./sources/notion";
import type { Source, SourceItem } from "./sources/types";
import { appendEvent, ensureHome, loadDispatch, loadEnabled, readEvents, readJson, loadPolicy, loadState, placementOf, paths, saveState, updateReplies, withLock, writeJson, type Enabled, type EngineState, type EventSource, type ChiefEvent, type Reply } from "./store";

const POLL_MS = 5 * 60_000;
// 第一次连上：往回看一天。
const FIRST_LOOKBACK_MS = 24 * 3600_000;

export const SECRET = { slack: `slack.${SLACK_COOKIE_D}`, notion: "notion.token" } as const;

// 弹一条 macOS 通知（只用在回复没发出去时；新消息不弹，要不要打扰你由主会话判断）。
// 文字当参数交给 osascript（不拼进脚本），对方写了什么都不会被当成脚本执行。
const NOTIFY = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';

function say(title: string, body: string): void {
  execFile("/usr/bin/osascript", ["-e", NOTIFY, title.slice(0, 80), body.replace(/\s+/g, " ").slice(0, 160)], { timeout: 10_000 }, () => {});
}

const SEND_CHECK_MS = 1_000;
const SESSION_EVENT_MS = 30 * 60_000;
// 交给主会话超过这么久还没判断（没有 chief mark）的消息，算漏掉了：再交一次。
const MISSED_MS = 10 * 60_000;
// 主会话超过这么久没在听、又有消息等着：弹通知叫你；之后最多每 30 分钟提醒一次。
const HUB_DOWN_MS = 5 * 60_000;
const HUB_NAG_MS = 30 * 60_000;
const HEALTH_MS = 60_000;
const ARCHIVE_MS = 24 * 3600_000;

// 漏掉的消息：交出去（firstSeen 记着引擎第一次看到它没判断的时间）过了 MISSED_MS 还没判断。演练消息和提醒本身不算。
export function missedEvents(events: readonly ChiefEvent[], handled: Record<string, unknown>, firstSeen: Map<number, number>, now: number): ChiefEvent[] {
  const open = events.filter((e) => !handled[e.id] && !e.dryrun && e.kind !== "chief.missed");
  const ids = new Set(open.map((e) => e.id));
  for (const id of [...firstSeen.keys()]) if (!ids.has(id)) firstSeen.delete(id);
  for (const e of open) if (!firstSeen.has(e.id)) firstSeen.set(e.id, now);
  return open.filter((e) => now - firstSeen.get(e.id)! >= MISSED_MS);
}

// 主会话是不是掉线了：alive.json 太久没更新。你让它停下的（stopped）不算掉线。
export function hubDown(alive: { at?: string; stopped?: boolean }, now: number): boolean {
  if (alive.stopped) return false;
  return alive.at === undefined || now - Date.parse(alive.at) >= HUB_DOWN_MS;
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

// 这条 Slack 消息是不是 chief（或别的 agent）替你发的，不是新消息：
// - 记下的发出编号（存在 state.json，重启后补推的也认得）；
// - 你自己账号发的、正文上方带 agent 署名行的（现在的发法；署名行谁都能写，所以只认你自己账号发的，别人的照常收）；
// - 正文开头是署名的（以前的发法；Slack 回传时会把 _ 换成 *，比的时候去掉这些符号）。
export function isOwnAgentMessage(m: InboundMessage, sent: readonly string[], signature: string, selfId: string | null): boolean {
  if (sent.includes(`${m.replyTarget.channel}:${m.replyTarget.ts}`)) return true;
  if (m.attribution !== undefined && selfId !== null && m.sender.id === selfId) return true;
  return startsWithSignature(m.text, signature);
}

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

// 按开关和钥匙串搭出要拉的外部来源。
export async function buildSources(enabled: Enabled, secrets: SecretStore): Promise<Source[]> {
  const out: Source[] = [];
  if (enabled.github) {
    const gh = findGh();
    if (gh) out.push(new GitHubSource(ghRunner(gh), () => loadPolicy().bots));
    else log("[github] 没找到 gh，跳过");
  }
  if (enabled.jira) {
    const cli = findJiraCli();
    if (cli) out.push(new JiraSource(cli));
    else log("[jira] 没找到 acli 或 twg，跳过");
  }
  if (enabled.notion) {
    const token = await secrets.get(SECRET.notion);
    if (token) out.push(new NotionSource(token));
    else log("[notion] 钥匙串里没有令牌，跳过");
  }
  return out;
}

// 外部来源的一条动态 → 事件。只有「有人找你」的（请你 review、指派给你、@ 你、评论了你的）才交给消息中心。
export function eventOfItem(source: EventSource, item: SourceItem): Omit<ChiefEvent, "id"> | null {
  if (!item.asks || item.asks.length === 0) return null;
  const own = source === "jira" ? String(item.payload.key ?? "")
    : source === "notion" ? `notion:${String(item.payload.pageId ?? "")}`
    : keysOf(item.url)[0] ?? item.url;
  const reply: Record<string, string> = source === "github" ? { ref: `${String(item.payload.repo)}#${String(item.payload.number)}` }
    : source === "jira" ? { key: String(item.payload.key ?? "") }
    : { page: String(item.payload.pageId ?? "") };
  return {
    at: item.at, source, kind: item.kind, title: item.title, url: item.url, from: null,
    text: item.summary, why: item.asks, keys: [...new Set([own, ...keysOf(`${item.title} ${item.summary}`)])], reply,
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

export interface SourceHealth {
  ok: boolean;
  at: string;
  // 连着失败了几次（成功一次就清零）。
  fails: number;
  error?: string;
}

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
  // 每个来源最近一次收 / 拉的结果，跟心跳一起写进 engine.json，面板拿它把连不上的来源标红。
  private readonly health: Record<string, SourceHealth> = {};
  private readonly startedAt = Date.now();
  private readonly firstSeen = new Map<number, number>();
  private lastHubNag = 0;
  private sessionWatcher: FSWatcher | null = null;

  async start(): Promise<void> {
    ensureHome();
    this.sources = await buildSources(this.enabled, this.secrets);
    log(`开始：外部来源 ${this.sources.map((s) => s.id).join("、") || "没有"}；事件写在 ${paths().events}`);
    // 上次停下时正在发的：不知道发出去没有，标成没发出去，让你去看一眼，不自动重发。
    try {
      updateReplies((all) => {
        for (const r of all.items) if (r.status === "sending") Object.assign(r, { status: "failed", error: "引擎重启时这条正在发，不确定对方收到没有，请去看一眼再决定重发" });
      });
    } catch (error) {
      log(`检查上次没发完的回复没成：${error instanceof Error ? error.message : String(error)}`);
    }
    await this.startSlack();
    this.sendTimer = setInterval(() => void this.sendDue(), SEND_CHECK_MS);
    // 面板看这个知道引擎在跑。
    const beat = () => writeJson(paths().engineAlive, { at: new Date().toISOString(), pid: process.pid, health: this.health });
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
    this.timer = setInterval(() => void this.pollAll(), POLL_MS);
    this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_MS);
    // 办完的旧东西每天搬一次（起来时先搬一次）。
    this.archive();
    this.archiveTimer = setInterval(() => this.archive(), ARCHIVE_MS);
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

  // 每分钟对一次账：交出去的消息主会话有没有判断、主会话还在不在听。消息交出去不等于被处理了，这里兜底。
  private checkHealth(): void {
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
            text: `事件 #${e.id} 交给你超过 10 分钟了还没判断（没有 chief mark）。用 chief show ${e.id} 看全文，照平常的办法处理，办完 mark ${e.id}；这条提醒也一起 mark。`,
            why: ["missed"], keys: e.keys, reply: {},
          }, `missed:${e.id}`);
        }
      }
      // 主会话掉线了、又有消息等着：叫你。引擎刚起来的头几分钟不算（主会话可能还没挂上）。
      const waiting = events.filter((e) => !handled[e.id] && !e.dryrun).length;
      if (down && waiting > 0 && now - this.startedAt >= HUB_DOWN_MS && now - this.lastHubNag >= HUB_NAG_MS) {
        this.lastHubNag = now;
        log(`主会话没在听，有 ${waiting} 条消息等着`);
        say("chief · 主会话没在听", `有 ${waiting} 条消息等着处理。到「chief 消息中心」会话里发 /chief:hub 接着听。`);
      }
    } catch (error) {
      log(`对账没成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.sendTimer) clearInterval(this.sendTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
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
    if (u.waiting) say(`chief · 会话在等你回答`, `${u.title}：${u.waiting}`);
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
    this.health[id] = { ok: error === undefined, at: new Date().toISOString(), fails, ...(error === undefined ? {} : { error: error.replace(/\s+/g, " ").slice(0, 160) }) };
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
    const cookie = await this.secrets.get(SECRET.slack);
    if (!cookie) {
      log("[slack] 钥匙串里没有 Cookie，跳过");
      return;
    }
    this.slack = new SlackPlugin({ stateDir: paths().slackState });
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
      threadSeen: (key) => this.state.threads.includes(key),
      status: (s) => {
        log(`[slack] ${s.state === "error" ? `出错：${s.error}` : s.state}`);
        if (s.state === "error") this.sourceResult("slack", String(s.error));
        else if (s.state === "connected") this.sourceResult("slack");
      },
      log: (line) => log(`[slack] ${line}`),
    });
  }

  // 过了撤回期的回复：先标成 sending（拿着锁，不会发两次），再发，再记结果。
  // 发出去了但结果没记上（文件被占着）：记在 unrecorded 里下一轮再记，绝不因为记不上就当成没发出去。
  private readonly unrecorded = new Map<number, { url: string | null }>();

  private async sendDue(): Promise<void> {
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
      for (const r of due) {
        let out: { url: string | null; warning?: string };
        try {
          out = await this.sendOne(r);
        } catch (error) {
          const why = error instanceof Error ? error.message.slice(0, 200) : String(error);
          if (!this.record(r.id, { status: "failed", error: why })) log(`回复 ${r.id} 没发出去，结果也没记上（下次引擎启动会标成要你看一眼）`);
          log(`回复 ${r.id} 没发出去：${why}`);
          say("chief · 回复没发出去", `${r.context.who ?? r.context.where}：${why}`);
          continue;
        }
        log(`回复 ${r.id} 发出去了（${r.source}）${out.warning ? `；${out.warning}` : ""}`);
        if (out.warning) say("chief · 回复的图没发上", `${r.context.who ?? r.context.where}：${out.warning}`);
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

  private async sendOne(r: Reply): Promise<{ url: string | null; warning?: string }> {
    const signal = AbortSignal.timeout(60_000);
    if (r.kind === "approve") {
      const gh = findGh();
      if (!gh) throw new Error("没找到 gh");
      return { url: (await new GitHubSource(ghRunner(gh)).approve(r.target.ref ?? "", r.body, signal)).url };
    }
    if (r.source === "slack") {
      if (!this.slack) throw new Error("Slack 没连上（chief connect slack）");
      // 署名不进正文：放在正文上方的一行灰色小字里（Slack 的 context block），对方一眼看出是 agent 代回的。
      const attribution = signatureAttribution(loadPolicy().signature, r.by);
      const sent = r.kind === "message"
        ? await this.slack.sendNew(r.target.to ?? "", r.body, r.target.thread_ts, attribution)
        : await this.slack.send(r.target, r.body, placementOf(r.target, loadPolicy().placement) === "thread", attribution);
      this.state.sent.push(sent.ref);
      this.persist();
      // 附的图发到同一个地方。正文已经发出去了：图没发上也不能算整条失败（重发会把正文再发一遍），记在 error 里给你看。
      const failed = r.images?.length ? await this.slack.sendImages(sent, r.images) : [];
      return { url: null, ...(failed.length > 0 ? { warning: `正文发出去了，图没发上：${failed.join("；")}` } : {}) };
    }
    if (r.source === "github") {
      const gh = findGh();
      if (!gh) throw new Error("没找到 gh");
      return { url: (await new GitHubSource(ghRunner(gh)).comment(r.target.ref ?? "", r.body, signal)).url };
    }
    if (r.source === "jira") {
      const cli = findJiraCli();
      if (!cli) throw new Error("没找到 acli 或 twg");
      return { url: (await new JiraSource(cli).comment(r.target.key ?? "", r.body, signal)).url };
    }
    throw new Error("Notion 集成只读，请你到页面上自己回");
  }

  private async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const source of this.sources) {
        const started = new Date();
        const since = new Date(this.state.since[source.id] ?? Date.now() - FIRST_LOOKBACK_MS);
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
