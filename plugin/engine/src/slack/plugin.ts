// 照搬 aide 的 channels/src/slack/plugin.ts（去掉加表情）。发消息只由引擎在你确认（或规矩允许、过了 5 秒撤回期）之后调用。
// Slack 插件：用 gabriel-slack 的会话 cookie 连 Slack 客户端协议。
// 不需要建 Slack 应用、不需要公网地址、不需要 OAuth。
// gabriel-slack 管连接、重连、令牌刷新、事件 hydration（人名频道名解析）。
// 这里只做：收事件 → 判断跟你有没有关系 → 交给 host。

import { readFileSync } from "node:fs";
import type { ChannelContext, ChannelPlugin, SecretCheck, SecretSpec } from "./types";
import { msg } from "../messages";
import { scrubTokens } from "./api";
import { classifyCreated, classifyDeleted, classifyUpdated, directOf, type Classified, type GabrielChannel, type GabrielDeleteEvent, type GabrielMessageEvent } from "./classify";

export const SLACK_COOKIE_D = "cookie_d";

const SECRETS: readonly SecretSpec[] = [
  {
    name: SLACK_COOKIE_D,
    label: "Slack 会话 Cookie",
    prefix: "xoxd-",
    hint: "运行 chief connect slack，在弹出的窗口里登录",
  },
];

// 补收私信时，历史里的一条。
export interface HistoryMessageLike {
  ts: string;
  sender: { id: string; displayName?: string; handle?: string; isBot?: boolean };
  markdown: string;
  thread: { rootTs: string } | null;
  attribution?: { text: string };
}

// 发消息时正文上方的 agent 署名行（gabriel-slack 的 attribution，一个 context block，Slack 里显示成一行灰色小字）。
// text 是 mrkdwn，{self} 换成发消息的人（你）；review 记进 block_id（confirmed：你确认过；unconfirmed：没经你确认）。
// false：不加。
export type SlackAttribution = false | { text: string; review?: "confirmed" | "unconfirmed" | "hidden" };

// 插件用到的 gabriel-slack 客户端的部分。测试注入假的。
// selfUserId / core / channels 可以没有（老的假客户端）：没有就不补收、不查频道类型。
export interface GabrielClientLike {
  readonly selfUserId?: string;
  readonly core?: { callWebApi(method: string, fields?: Record<string, unknown>, opts?: { reason?: string }): Promise<unknown> };
  readonly channels?: {
    resolve(id: string): Promise<{ id: string; name?: string; isIm?: boolean; isMpim?: boolean; isPrivate?: boolean; imUserId?: string } | null>;
    getHistory(opts: { channel: string; oldest?: string; limit?: number }): Promise<{ messages: HistoryMessageLike[] }>;
  };
  on(event: string, handler: (...args: never[]) => void): void;
  onError(handler: (err: Error, evt?: unknown) => void): void;
  start(): Promise<void>;
  stop(options?: { drainMs?: number }): Promise<void>;
  chat: { send(opts: { channel: string; markdown: string; threadTs?: string; attribution?: SlackAttribution }): Promise<{ channel: string; ts: string }> };
  // 按编号查人（查 @ 了谁的名字、发消息的账号是不是机器人账号用）；老的假客户端没有。
  readonly users?: { resolve(ids: string[]): Promise<Array<{ id: string; name?: string; displayName?: string; handle?: string; isBot?: boolean } | null>> };
  reactions: { add(opts: { channel: string; ts: string; emoji: string }): Promise<void> };
  // 传图（回复附图用）：传完分享到 channel（有 threadTs 就进那个 thread）。老的假客户端没有。
  readonly files?: { upload(opts: { filename: string; content: Uint8Array; mimeType?: string; channel?: string; threadTs?: string }): Promise<unknown> };
}

// 发出去落在哪：附的图跟着正文发到同一个对话、同一个 thread。
export interface SentTo {
  ref: string;
  channel: string;
  // 正文这条消息自己的 ts。
  ts: string;
  // 正文发在哪个 thread 里；正文是对话里的顶层消息就没有。
  threadTs?: string;
  // 私信、群聊（不是频道）：正文直接回在对话里时，图紧跟在下面就和正文在一起，不用进 thread。
  direct?: boolean;
}

// 附的图发进哪个 thread（没有就是对话里的顶层）：
//   - 正文在 thread 里（回别人的 thread、回到 thread、发到帖子的 thread）：图进同一个 thread。
//   - 正文是频道里的顶层消息（发到频道的新消息、直接回在频道里）：图进正文自己的 thread。
//     不然图成了频道里单独的几条，和正文之间可能插进别人的话，thread 视图里也看不到。
//   - 私信、群聊里直接回在对话里的：图紧跟在正文下面，照旧顶层。
export function imageThreadOf(to: SentTo): string | undefined {
  return to.threadTs ?? (to.direct ? undefined : to.ts);
}

// 正文落在哪个 thread，写法和收消息时 classify 算的 threadKey 一样。chief 替你发出去以后登记成「你在的 thread」，
// 别人在下面回复才会当成「我在的 thread 有后续」交给消息中心（chief 自己发的那条回显被当成自己发的挡掉了，走不到登记那一步）。
export function sentThreadKey(to: SentTo): string {
  if (to.direct) return to.threadTs ? `slack:${to.channel}:${to.threadTs}` : `slack:${to.channel}:dm`;
  return `slack:${to.channel}:${to.threadTs ?? to.ts}`;
}

export interface CheckCookieResult {
  valid: boolean;
  detail: string;
}

export interface SlackPluginOptions {
  createClient?: (cookieD: string) => Promise<GabrielClientLike>;
  checkCookie?: (cookieD: string) => Promise<CheckCookieResult>;
  // gabriel-slack 记「每个对话收到哪了」的目录（state.json，只有时间戳，不含密钥）。
  // 给了的话，引擎重启后会把停着那段时间漏掉的消息补回来；不给就只在内存里记。
  stateDir?: string;
  // 连上以后补收最近多久的私信、群聊（毫秒），默认 DM_CATCH_UP_MS；config.json 的 slackCatchUpHours。
  catchUpMs?: number;
}

// 连上以后补收最近这么久的私信、群聊（收过的按编号自动跳过）。默认值，可以用 catchUpMs 改。
export const DM_CATCH_UP_MS = 48 * 60 * 60 * 1000;
const DM_CATCH_UP_MAX_CONVERSATIONS = 40;

const defaultCreateClient = (stateDir: string | undefined) => async (cookieD: string): Promise<GabrielClientLike> => {
  const { GabrielClient, FileStateStore } = await import("gabriel-slack");
  // 发一条的截止时间：库默认 30 秒，装不下一次请求超时（15 秒）后的重试，慢网络上正常的发送也会被判超时。
  return GabrielClient.fromCookie({ cookieD, chat: { itemDeadlineMs: 90_000 }, ...(stateDir ? { stateStore: new FileStateStore({ dir: stateDir }) } : {}) }) as unknown as GabrielClientLike;
};

// 发出去没成功时写给你看的话。这三种错是 gabriel-slack 自己认为「Slack 可能已经收下了、只是回应没等到」的：
// 别让人以为没发出去就直接重发，先到 Slack 看一眼。其它错照旧给原文。
const MAYBE_SENT_CODES = new Set(["NETWORK_TIMEOUT", "SERVER_ERROR", "CANCELLED"]);
export const describeSendError = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (typeof code === "string" && MAYBE_SENT_CODES.has(code)) return msg().replyMaybeSent(raw.slice(0, 120));
  return raw.slice(0, 200);
};

// 验一个 Cookie。domain：它登的工作区（子域名）；换得到 token 就有，SSO 没走完也有，登录窗口靠它跳到工作区地址。
export const checkSlackCookie = async (cookieD: string): Promise<CheckCookieResult & { domain?: string }> => {
  let domain: string | undefined;
  try {
    const { GabrielCore, silentLogger } = await import("gabriel-slack");
    const core = new GabrielCore({ auth: { cookieD }, logger: silentLogger });
    const session = await core.initialize();
    domain = (session as { domain?: string }).domain || undefined;
    // 换得到 token 不等于能用：工作区要公司 SSO、SSO 又没走完时，换出来的 token 一调接口就 403，实时连接也连不上。
    // 真调一个接口：HTTP 401 / 403 就是没走完；接口自己回的错（比如这个工作区不让看用户组）说明登录是好的。
    try {
      await core.callWebApi("usergroups.list", {});
    } catch (error) {
      if (/HTTP 40[13]\b/.test(error instanceof Error ? error.message : String(error))) {
        void core.disconnect();
        return { valid: false, detail: "登上了 Slack，但工作区的 SSO 还没走完：从工作区地址登录（chief connect slack --workspace <你的工作区>），走完公司 SSO 再试", ...(domain ? { domain } : {}) };
      }
    }
    void core.disconnect();
    return { valid: true, detail: `${session.teamName ?? session.teamId}，用户 ${session.userId}`, ...(domain ? { domain } : {}) };
  } catch {
    return { valid: false, detail: "Cookie 已失效或被撤销，请重新登录" };
  }
};

export class SlackPlugin implements ChannelPlugin {
  readonly id = "slack";
  readonly label = "Slack";
  readonly secrets = SECRETS;

  private context: ChannelContext | null = null;
  private client: GabrielClientLike | null = null;
  private stopped = true;

  constructor(private readonly options: SlackPluginOptions = {}) {}

  setupManifest(): string {
    return "Slack 会话 Cookie（xoxd-…）：Chrome 登录 app.slack.com → DevTools → Application → Cookies → 名为 d 的那一项。";
  }

  async test(secrets: Readonly<Record<string, string>>): Promise<SecretCheck[]> {
    const cookieD = (secrets[SLACK_COOKIE_D] ?? "").trim();
    const scrub = (s: string) => scrubTokens(s, [cookieD]).slice(0, 300);
    const checks: SecretCheck[] = [];

    const formatOk = cookieD.startsWith("xoxd-");
    checks.push({
      label: "Cookie 的格式",
      pass: formatOk,
      detail: scrub(formatOk ? "以 xoxd- 开头" : "应该以 xoxd- 开头（运行 chief connect slack 重新登录）"),
    });

    if (formatOk) {
      const result = await (this.options.checkCookie ?? checkSlackCookie)(cookieD);
      checks.push({ label: "Cookie 有效", pass: result.valid, detail: scrub(result.detail) });
    }
    return checks;
  }

  async start(context: ChannelContext): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.context = context;

    const cookieD = context.secrets[SLACK_COOKIE_D] ?? "";
    context.status({ state: "connecting" });

    try {
      const client = await (this.options.createClient ?? defaultCreateClient(this.options.stateDir))(cookieD);

      client.on("message.created", ((evt: GabrielMessageEvent) => this.onCreated(evt)) as never);
      client.on("message.updated", ((evt: GabrielMessageEvent) => this.onUpdated(evt)) as never);
      client.on("message.deleted", ((evt: GabrielDeleteEvent) => this.onDeleted(evt)) as never);
      client.on("connection.ready", (() => {
        context.status({ state: "connected", account: "" });
        context.log("连上了（gabriel-slack）");
      }) as never);
      client.on("connection.reconnecting", (() => {
        if (this.stopped) return;
        context.status({ state: "connecting" });
        context.log("重连中");
      }) as never);
      client.on("auth.dead", (((e: { reason: string }) => {
        context.status({ state: "error", error: `Cookie 已失效：${scrubTokens(e.reason, [cookieD])}，请重新登录`, dead: true });
        context.log(`Cookie 失效：${scrubTokens(e.reason, [cookieD])}`);
      }) as never));
      client.onError((err) => {
        context.log(`错误：${scrubTokens(err.message, [cookieD])}`);
      });

      this.client = client;
      if (this.stopped) return;
      await client.start();
      void this.catchUpDirect(client, context);
    } catch (error) {
      if (this.stopped) return;
      const msg = error instanceof Error ? error.message : String(error);
      context.status({ state: "error", error: scrubTokens(msg, [cookieD]) });
      context.log(`连接失败：${scrubTokens(msg, [cookieD])}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    await client?.stop({ drainMs: 5_000 });
  }

  // 你在 Slack 上的编号（连上以后才有）：把原文里 @ 你的地方写成「@你」。
  selfId(): string | null {
    return this.client?.selfUserId ?? null;
  }

  // 主动发一条新消息：to 是用户编号（U…）、邮箱、或频道编号（C… / G… / D…）。发给人就先打开和他的私信。
  // threadTs：发到频道里某条帖子的 thread 里（别人的帖子也行）。attribution：正文上方的署名行（不给就不加）。
  async sendNew(to: string, text: string, threadTs?: string, attribution: SlackAttribution = false): Promise<SentTo> {
    const client = this.client;
    if (!client?.core) throw new Error("Slack 还没连上");
    let channel = to;
    if (to.includes("@")) {
      const found = (await client.core.callWebApi("users.lookupByEmail", { email: to }, { reason: "chief-send-new" })) as { user?: { id?: string } };
      if (!found.user?.id) throw new Error(`Slack 上没找到 ${to}`);
      channel = found.user.id;
    }
    if (/^[UW]/.test(channel)) {
      const opened = (await client.core.callWebApi("conversations.open", { users: channel }, { reason: "chief-send-new" })) as { channel?: { id?: string } };
      if (!opened.channel?.id) throw new Error("打不开和对方的私信");
      channel = opened.channel.id;
    }
    const res = await client.chat.send({ channel, markdown: text, ...(threadTs ? { threadTs } : {}), attribution });
    return { ref: `${res.channel}:${res.ts}`, channel: res.channel, ts: res.ts, ...(threadTs ? { threadTs } : {}), ...(channel.startsWith("D") ? { direct: true } : {}) };
  }

  // 在一条消息所在的线程里回一句，以你本人的身份。target 是那条消息交来时的 replyTarget；text 原样发。
  // inThread：回到对方那条消息的 thread 里；否则直接回在对话里（放哪由引擎按规矩定）。attribution：正文上方的署名行（不给就不加）。
  async send(target: Readonly<Record<string, string>>, text: string, inThreadOf = true, attribution: SlackAttribution = false): Promise<SentTo> {
    const client = this.client;
    if (!client) throw new Error("Slack 还没连上");
    const channel = target.channel!;
    const inThread = target.thread_ts ?? (inThreadOf ? target.ts : undefined);
    const res = await client.chat.send({ channel, markdown: text, ...(inThread ? { threadTs: inThread } : {}), attribution });
    const direct = target.audience ? target.audience !== "channel" : channel.startsWith("D");
    return { ref: `${res.channel}:${res.ts}`, channel: res.channel, ts: res.ts, ...(inThread ? { threadTs: inThread } : {}), ...(direct ? { direct: true } : {}) };
  }

  // 图要和正文在一起，发到哪由 imageThreadOf 定。返回没发上的（名字和原因）；全发上了是空的。
  // 一张一条：gabriel-slack 的 files.upload 一次只分享一个文件，几张合成一条要它支持了才行。
  async sendImages(to: SentTo, images: readonly { file: string; name: string; mime: string }[]): Promise<string[]> {
    const files = this.client?.files;
    if (!files) return images.map((i) => `${i.name}：这个 Slack 连接传不了文件`);
    const threadTs = imageThreadOf(to);
    const failed: string[] = [];
    for (const img of images) {
      try {
        await files.upload({ filename: img.name, content: readFileSync(img.file), mimeType: img.mime, channel: to.channel, ...(threadTs ? { threadTs } : {}) });
      } catch (error) {
        failed.push(`${img.name}：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      }
    }
    return failed;
  }

  // ── 收消息 ──

  private async onCreated(original: GabrielMessageEvent): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    const evt = await this.personOf(original);
    let channel = await this.channelOf(evt.channel);
    // 你在私信里说的话：问清楚这是不是和你自己的私信（那是写给助理的指令）。
    if (evt.origin === "self_other_client" && directOf(channel) === "im" && channel.imUserId === undefined) {
      const other = await this.imUserOf(channel.id);
      if (other) channel = { ...channel, imUserId: other };
    }
    const result = classifyCreated({ ...evt, channel }, ctx.threadSeen, this.selfId());
    if (result.ok) await this.deliver(result.message);
  }

  private async onUpdated(evt: GabrielMessageEvent): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    const result = classifyUpdated({ ...evt, channel: await this.channelOf(evt.channel) }, ctx.threadSeen);
    if (result.ok) await this.deliver(result.message);
  }

  // 别的 app 拿某个人的用户令牌替他发的（Slack 上的 Claude、同事自己的助理、发版脚本）：Slack 上显示是他本人，
  // 消息却带着 bot_id，gabriel-slack 收实时消息时只看 bot_id，记成机器人（origin bot、isBot），引擎就不交了。
  // 查一下发消息的账号：账号本身不是机器人，就当成他本人说的话，名字也换成他的（不用 app 的名字）。
  // 补收私信走的历史接口本来就按账号认（gabriel-slack 的 senderOf），这里让实时收的和它一致。
  // 照旧当机器人的：真机器人账号；只有 bot_id、没有用户的（编号不是 U / W 开头）；查不到的（记一行日志，只写位置）；
  // 你自己的账号经 app 发的（要不要当成你说的话、在和自己的私信里算不算给助理的指令，另说）。
  private async personOf(evt: GabrielMessageEvent): Promise<GabrielMessageEvent> {
    const users = this.client?.users;
    if (!evt.sender.isBot || !users || !/^[UW]/.test(evt.sender.id) || evt.sender.id === this.selfId()) return evt;
    try {
      const [account] = await users.resolve([evt.sender.id]);
      if (account?.isBot !== false) return evt;
      const name = account.displayName || account.name || account.handle;
      return { ...evt, origin: evt.origin === "bot" ? "other_user" : evt.origin, sender: { ...evt.sender, isBot: false, ...(name ? { displayName: name } : {}) } };
    } catch (error) {
      this.context?.log(`查不到 ${evt.sender.id} 是不是机器人账号，按机器人算（${evt.channel.id}:${evt.ts}）：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      return evt;
    }
  }

  // 私信的对方是谁：gabriel-slack 的频道信息里没有，问一次 conversations.info，记住（只记编号）。
  private readonly imUsers = new Map<string, string | null>();

  private async imUserOf(channelId: string): Promise<string | null> {
    if (this.imUsers.has(channelId)) return this.imUsers.get(channelId) ?? null;
    let user: string | null = null;
    try {
      const info = (await this.client?.core?.callWebApi("conversations.info", { channel: channelId }, { reason: "chief-im-user" })) as { channel?: { user?: unknown } } | undefined;
      user = typeof info?.channel?.user === "string" ? info.channel.user : null;
    } catch {
      // 查不到：当成不是和自己的私信。
    }
    this.imUsers.set(channelId, user);
    return user;
  }

  // 消息事件里的频道只有编号和名字：问 gabriel-slack 要私信、群聊的标记（它收消息时已经查过，有缓存）。
  // 查不到就照编号、名字认（directOf）。
  private async channelOf(ch: GabrielChannel): Promise<GabrielChannel> {
    if (ch.isIm !== undefined && ch.isMpim !== undefined && (ch.isIm !== true || ch.imUserId !== undefined)) return ch;
    try {
      const ref = await this.client?.channels?.resolve(ch.id);
      if (ref) return { ...ch, ...(ref.name && !ch.name ? { name: ref.name } : {}), ...(ref.isIm !== undefined ? { isIm: ref.isIm } : {}), ...(ref.isMpim !== undefined ? { isMpim: ref.isMpim } : {}), ...(ref.isPrivate !== undefined ? { isPrivate: ref.isPrivate } : {}), ...(ref.imUserId ? { imUserId: ref.imUserId } : {}) };
    } catch {
      // 查不到：照编号、名字认。
    }
    return ch;
  }

  // 连上以后：把最近 48 小时（catchUpMs）的私信、群聊从历史里补收一遍。引擎停着、断网时别人发的私信不会丢；
  // 收过的消息编号一样，记账时自动跳过。按时间先后交，好让后面的判断看到前因。
  private async catchUpDirect(client: GabrielClientLike, ctx: ChannelContext): Promise<void> {
    if (!client.core || !client.channels) return;
    const window = this.options.catchUpMs ?? DM_CATCH_UP_MS;
    if (window <= 0) return;
    const since = (Date.now() - window) / 1000;
    let counts: Record<string, unknown>;
    try {
      counts = (await client.core.callWebApi("client.counts", {}, { reason: "chief-dm-catch-up" })) as Record<string, unknown>;
    } catch (error) {
      ctx.log(`补收私信没成：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      return;
    }
    const recent = (group: string) => (Array.isArray(counts[group]) ? (counts[group] as Array<Record<string, unknown>>) : [])
      .filter((c) => typeof c.id === "string" && typeof c.latest === "string" && Number(c.latest) > since)
      .map((c) => ({ id: c.id as string, latest: Number(c.latest) }));
    const conversations = [...recent("ims"), ...recent("mpims")].sort((a, b) => b.latest - a.latest).slice(0, DM_CATCH_UP_MAX_CONVERSATIONS);
    const events: GabrielMessageEvent[] = [];
    let failed = 0;
    for (const c of conversations) {
      if (this.stopped) return;
      try {
        const channel = await this.channelOf({ id: c.id });
        if (directOf(channel) === null) continue;
        const page = await client.channels.getHistory({ channel: c.id, oldest: since.toFixed(6), limit: 50 });
        for (const m of page.messages) {
          if (typeof m.ts !== "string" || !m.sender) continue;
          const mine = client.selfUserId !== undefined && m.sender.id === client.selfUserId;
          events.push({
            ts: m.ts,
            channel,
            sender: { id: m.sender.id, ...(m.sender.displayName ? { displayName: m.sender.displayName } : {}), ...(m.sender.handle ? { handle: m.sender.handle } : {}), isBot: m.sender.isBot === true },
            origin: mine ? "self_other_client" : m.sender.isBot ? "bot" : "other_user",
            text: m.markdown,
            markdown: m.markdown,
            thread: m.thread ? { rootTs: m.thread.rootTs, isReply: false } : null,
            isThreadReply: false,
            isMentioningMe: false,
            eventId: `${c.id}:${m.ts}:created`,
            ...(m.attribution?.text ? { attribution: { text: m.attribution.text } } : {}),
          });
        }
      } catch {
        failed++;
      }
    }
    events.sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const e of events) {
      if (this.stopped) return;
      const result = classifyCreated(e, ctx.threadSeen);
      if (result.ok) await this.deliver(result.message);
    }
    ctx.log(`补收私信：查了最近 48 小时 ${conversations.length} 个私信 / 群聊，${events.length} 条消息（收过的自动跳过）${failed > 0 ? `，${failed} 个没读成` : ""}`);
  }

  private async onDeleted(evt: GabrielDeleteEvent): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    const result = classifyDeleted(evt, ctx.threadSeen);
    if (result.ok) await this.deliver(result.message);
  }

  private async deliver(m: Classified): Promise<void> {
    const ctx = this.context!;
    const mentions = await this.namesOf(m.mentionIds);
    await ctx.deliver({
      channel: this.id,
      deliveryId: m.deliveryId,
      kind: m.kind,
      ...(m.amends ? { amends: m.amends } : {}),
      role: m.role,
      relevance: m.relevance,
      conversation: {
        key: `slack:${m.channel}`,
        threadKey: m.threadKey,
        label: m.conversation.label,
        audience: m.conversation.audience,
      },
      sender: {
        id: m.userId,
        name: m.role === "self" ? "你" : m.bot ? "机器人" : m.senderName,
        bot: m.bot,
      },
      text: m.text,
      ...(m.attribution ? { attribution: m.attribution } : {}),
      occurredAt: new Date(Number(m.ts) * 1000).toISOString(),
      replyTarget: { channel: m.channel, ts: m.ts, ...(m.threadTs ? { thread_ts: m.threadTs } : {}) },
      ...(mentions.length > 0 ? { mentions } : {}),
    });
  }

  // 消息里 @ 的人：按编号查名字（gabriel-slack 有缓存）。查不到的不记。
  private async namesOf(ids: readonly string[]): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0 || !this.client?.users) return [];
    try {
      const refs = await this.client.users.resolve([...ids]);
      return refs.flatMap((r) => {
        const name = r?.displayName || r?.name || r?.handle;
        return r && name ? [{ id: r.id, name }] : [];
      });
    } catch {
      return [];
    }
  }
}
