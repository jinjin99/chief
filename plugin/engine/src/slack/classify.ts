// 照搬 aide 的 channels/src/slack/classify.ts。
// 从 gabriel-slack 的事件里认出「跟你有关的消息」。
// gabriel-slack 已经做了：连接管理、令牌刷新、事件去重、人名频道名解析（hydration）。
// 这里只做：判断这条消息跟你有没有关系（私信、@了你、你在的 thread 里的后续）。

import type { InboundRole, Relevance } from "./types";

// Slack 原文里 @ 了谁（<@U123> 或 <@U123|名字>），按出现先后、不重复。（照搬 aide 的 channels/src/mentions.ts）
function mentionedIds(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

// ── gabriel-slack 事件里我们用到的字段 ──

// 注意：gabriel-slack 推来的消息事件里，频道只带 id 和名字，isIm / isMpim 不填
// （只有建私信那种生命周期事件才填）。所以私信、群聊要自己认：见 directOf。
export interface GabrielChannel {
  id: string;
  // 私信的对方（gabriel-slack 查频道时给）；和你自己的私信，这里就是你。
  imUserId?: string;
  name?: string;
  isIm?: boolean;
  isMpim?: boolean;
  isPrivate?: boolean;
}

// 私信：频道编号 D 开头；群聊：名字 mpdm- 开头。事件里带了标记的以标记为准。
export function directOf(ch: GabrielChannel): "im" | "mpim" | null {
  if (ch.isIm === true || (ch.isIm === undefined && ch.id.startsWith("D"))) return "im";
  if (ch.isMpim === true || (ch.isMpim === undefined && (ch.name ?? "").startsWith("mpdm-"))) return "mpim";
  return null;
}

export interface GabrielSender {
  id: string;
  displayName?: string;
  handle?: string;
  isBot: boolean;
}

export type GabrielOrigin = "this_client" | "self_other_client" | "other_user" | "bot";

// message.created / message.updated 共用。
export interface GabrielMessageEvent {
  ts: string;
  channel: GabrielChannel;
  sender: GabrielSender;
  origin: GabrielOrigin;
  text: string;
  markdown: string;
  thread: { rootTs: string; isReply: boolean; broadcast?: boolean } | null;
  isThreadReply: boolean;
  isMentioningMe: boolean;
  eventId: string;
  // 消息上方自称的 agent 署名行（gabriel-slack 从 blocks 里认出来、已经从 markdown 里去掉）。谁都能写，不能当证据。
  attribution?: { text: string };
}

// message.deleted。
export interface GabrielDeleteEvent {
  deletedTs: string;
  channel: GabrielChannel;
  sender?: GabrielSender;
  eventId: string;
}

// ── 分类结果 ──

export interface Classified {
  kind: "message.received" | "message.edited" | "message.deleted";
  deliveryId: string;
  amends?: string;
  role: InboundRole;
  relevance: Relevance | null;
  channel: string;
  ts: string;
  threadTs: string | null;
  threadKey: string;
  userId: string;
  senderName: string;
  bot: boolean;
  text: string;
  // 原文里 @ 了谁（编号），插件再查名字。
  mentionIds: string[];
  // 消息上方的 agent 署名行（有的话）。
  attribution?: string;
  conversation: { label: string; audience: "direct" | "group" | "channel" };
}

export type ClassifyResult =
  | { ok: true; message: Classified }
  | { ok: false; reason: "echo" | "unrelated" };

export function classifyCreated(evt: GabrielMessageEvent, threadSeen: (threadKey: string) => boolean, selfId: string | null = null): ClassifyResult {
  return classify("message.received", evt, threadSeen, selfId);
}

export function classifyUpdated(evt: GabrielMessageEvent, threadSeen: (threadKey: string) => boolean): ClassifyResult {
  const result = classify("message.edited", evt, threadSeen);
  if (!result.ok) return result;
  result.message.amends = `${evt.channel.id}:${evt.ts}:created`;
  return result;
}

export function classifyDeleted(evt: GabrielDeleteEvent, threadSeen: (threadKey: string) => boolean): ClassifyResult {
  const channel = evt.channel.id;
  const threadKey = threadKeyOf(evt.channel, evt.deletedTs, null, null);
  if (!threadSeen(threadKey)) return { ok: false, reason: "unrelated" };
  return {
    ok: true,
    message: {
      kind: "message.deleted",
      deliveryId: evt.eventId,
      amends: `${channel}:${evt.deletedTs}:created`,
      role: "message",
      relevance: "thread",
      channel,
      ts: evt.deletedTs,
      threadTs: null,
      threadKey,
      userId: evt.sender?.id ?? "",
      senderName: "",
      bot: evt.sender?.isBot ?? false,
      text: "",
      mentionIds: [],
      conversation: conversationOf(evt.channel),
    },
  };
}

// ── 内部 ──

function classify(
  kind: "message.received" | "message.edited",
  evt: GabrielMessageEvent,
  threadSeen: (threadKey: string) => boolean,
  selfId: string | null = null,
): ClassifyResult {
  if (evt.origin === "this_client") return { ok: false, reason: "echo" };
  const channel = evt.channel.id;
  const threadTs = evt.thread?.rootTs ?? null;
  const threadKey = threadKeyOf(evt.channel, evt.ts, evt.thread?.isReply === true ? threadTs : null, threadTs);

  let role: InboundRole = "message";
  let relevance: Relevance | null = null;

  // 你在和自己的私信里写的话：是写给助理的，当成一条找你的消息交出去（chief 自己发的回显上面已经挡掉了）。
  if (evt.origin === "self_other_client" && selfId !== null && directOf(evt.channel) === "im" && evt.channel.imUserId === selfId && kind === "message.received") {
    relevance = "self";
  } else if (evt.origin === "self_other_client") {
    role = "self";
  } else if (directOf(evt.channel) !== null) {
    relevance = "dm";
  } else if (evt.isMentioningMe) {
    relevance = "mention";
  } else if (evt.isThreadReply && threadSeen(threadKey)) {
    relevance = "thread";
  } else {
    return { ok: false, reason: "unrelated" };
  }

  return {
    ok: true,
    message: {
      kind,
      deliveryId: evt.eventId,
      role,
      relevance,
      channel,
      ts: evt.ts,
      threadTs,
      threadKey,
      userId: evt.sender.id,
      senderName: evt.sender.displayName ?? evt.sender.handle ?? evt.sender.id,
      bot: evt.sender.isBot,
      text: evt.markdown || evt.text,
      mentionIds: mentionedIds(evt.text ?? ""),
      ...(evt.attribution?.text ? { attribution: evt.attribution.text } : {}),
      conversation: conversationOf(evt.channel),
    },
  };
}

// 线程编号：频道里按 thread 根消息；私信、群聊里不在 thread 里的话是一整段对话（同一个人连发几句算一件，
// 你在私信里回了就算回了），私信里真开了 thread 的回复还按 thread 根。
function threadKeyOf(ch: GabrielChannel, ts: string, replyRoot: string | null, root: string | null): string {
  if (directOf(ch) !== null) return replyRoot ? `slack:${ch.id}:${replyRoot}` : `slack:${ch.id}:dm`;
  return `slack:${ch.id}:${root ?? ts}`;
}

function conversationOf(ch: GabrielChannel): { label: string; audience: "direct" | "group" | "channel" } {
  const direct = directOf(ch);
  // 私信的名字 gabriel-slack 给的是「@对方」。
  if (direct === "im") return { label: ch.name ? `${ch.name.replace(/^@/, "")} 的私信` : "私信", audience: "direct" };
  if (direct === "mpim") return { label: "群聊", audience: "group" };
  return { label: `#${ch.name ?? ch.id}`, audience: "channel" };
}
