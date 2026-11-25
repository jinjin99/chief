// 引擎弹给你看的话（系统通知、面板上显示的「最近做的」、数据文件坏了的说明）：zh（默认）和 en 两本，按 config.json 的 locale 选。
// en 照 zh 的类型写：少一项 tsc 就报错。交给主会话的事件文字不在这里，hub skill 认的是中文。
import { liveConfig } from "./config";
import type { Locale } from "./shared/i18n";

const zh = {
  sep: "；",
  colon: "：",
  heldTitle: (n: number) => `chief · 免打扰时攒下 ${n} 条提醒`,
  corruptTitle: (name: string) => `chief · ${name} 坏了`,
  corruptCritical: (name: string, moved: string) => `${name} 不是合法的 JSON，chief 没覆盖它，用到它的功能会停下。坏的那份另存在 ${moved}，修好原文件或删掉它。`,
  corruptMoved: (name: string, moved: string) => `${name} 不是合法的 JSON，已挪到 ${moved}，先用默认的接着跑。`,
  corruptHealth: (file: string, critical: boolean, moved: string) => `${file} 坏了${critical ? "（没覆盖，修好或删掉它）" : "（已挪走，用的默认）"}：另存在 ${moved}`,
  hubDownTitle: "chief · 主会话没在听",
  hubDown: (n: number) => `有 ${n} 条消息等着处理。到「chief 消息中心」会话里发 /chief:hub 接着听。`,
  sessionWaitingTitle: "chief · 会话在等你回答",
  newAskTitle: "chief · 有事要你定",
  slackDeadTitle: "chief · Slack 登录失效了",
  slackDead: "收不到 Slack 消息、也发不出回复了。打开 /chief 面板的「设置」页，点 Slack 那行的「重新登录」。",
  replyBlockedTitle: "chief · 有条回复没发",
  replyFailedTitle: "chief · 回复没发出去",
  replyMaybeSent: (raw: string) => `网络超时，Slack 可能已经收到。请先到 Slack 确认；确实没有再点重发。（原文：${raw}）`,
  imageFailedTitle: "chief · 回复的图没发上",
  wokeTitle: "chief · 稍后再说的事到点了",
  keyTitle: "chief · 「以你的名义发」的钥匙换了",
  keyReset: "钥匙被清掉了。不是你在终端里清的，就是有人（可能是主会话）动了它。",
  keySet: "配了一把新钥匙。不是你刚重新加载插件，就是有人（可能是主会话）换了它。",
  // 「最近做的」里的一行（undo.json 的 label）。
  undoIgnored: "忽略",
  undoNoted: "只记下",
  undoMark: (verb: string, where: string, n: number) => `${verb}：${where}${n > 1 ? ` 等 ${n} 条` : ""}`,
  undoFrom: (title: string, from: string) => `${title}（${from}）`,
  undoSkip: (n: number) => `跳过积下的 ${n} 条旧消息`,
  undoDrop: (title: string) => `不做了：${title}`,
  // 事情办完、不做了时，它还开着的问题自动撤掉，面板上灰字写这句。
  askThingDone: "这件事办完了",
  askThingDropped: "这件事不做了",
  // 问题挂着的回复你发了 / 不发了 / 让它重写了：问题跟着关掉。
  askReplySent: "回复发了",
  askReplyDropped: "回复不发了",
  askReplyRedo: "回复让它重写了",
  approveDone: (ref: string) => `approve 了 ${ref}`,
};

export type Messages = typeof zh;

const en: Messages = {
  sep: "; ",
  colon: ": ",
  heldTitle: (n: number) => `chief · ${n} notifications held during quiet hours`,
  corruptTitle: (name: string) => `chief · ${name} is broken`,
  corruptCritical: (name: string, moved: string) => `${name} is not valid JSON. chief did not overwrite it, and features that need it are paused. A copy of the broken file is at ${moved}; fix or delete the original.`,
  corruptMoved: (name: string, moved: string) => `${name} is not valid JSON; moved it to ${moved} and carrying on with defaults.`,
  corruptHealth: (file: string, critical: boolean, moved: string) => `${file} is broken${critical ? " (not overwritten; fix or delete it)" : " (moved away, using defaults)"}: copy at ${moved}`,
  hubDownTitle: "chief · The hub is not listening",
  hubDown: (n: number) => `${n} messages are waiting. Send /chief:hub in the "chief 消息中心" session to resume.`,
  sessionWaitingTitle: "chief · A session is waiting for your answer",
  newAskTitle: "chief · Something needs your decision",
  slackDeadTitle: "chief · Slack login expired",
  slackDead: "Slack messages are not coming in and replies cannot go out. Open the Setup tab in the /chief panel and click \"Log in again\" on the Slack row.",
  replyBlockedTitle: "chief · A reply was not sent",
  replyFailedTitle: "chief · A reply failed to send",
  replyMaybeSent: (raw: string) => `Network timeout: Slack may have received it. Check in Slack first; resend only if it is not there. (Original: ${raw})`,
  imageFailedTitle: "chief · A reply's images were not sent",
  wokeTitle: "chief · A snoozed thing is back",
  keyTitle: "chief · The \"send as you\" key changed",
  keyReset: "The key was cleared. If you did not clear it in a terminal, someone (maybe the hub) touched it.",
  keySet: "A new key was set. If you did not just reload the plugin, someone (maybe the hub) changed it.",
  undoIgnored: "Ignored",
  undoNoted: "Noted",
  undoMark: (verb: string, where: string, n: number) => `${verb}: ${where}${n > 1 ? ` and ${n - 1} more` : ""}`,
  undoFrom: (title: string, from: string) => `${title} (${from})`,
  undoSkip: (n: number) => `Skipped ${n} backlog messages`,
  undoDrop: (title: string) => `Dropped: ${title}`,
  askThingDone: "This is done",
  askThingDropped: "This was dropped",
  askReplySent: "Reply sent",
  askReplyDropped: "Reply dropped",
  askReplyRedo: "Reply sent back for a rewrite",
  approveDone: (ref: string) => `Approved ${ref}`,
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { zh, en };

// 现在的语言（每次现读 config.json：改了马上生效，不用重启引擎）。读不了按中文。
export function msg(): Messages {
  try {
    return MESSAGES[liveConfig().locale];
  } catch {
    return zh;
  }
}
