// 谁能让回复发出去。命令行（chief reply queue --policy）放行前算一遍，引擎发之前再算一遍（见 engine.ts 的 sendDue）。
import { createHash } from "node:crypto";
import { isTrusted, mustAsk, scenarioOf, SCENARIOS, type ChiefEvent, type Policy, type Reply } from "./store";

// 一条事件自己的 PR（owner/repo#号，小写）：GitHub 的事件就是它回到的那个 PR；
// 别的（比如 Slack 里有人贴了 PR 链接）是引擎从原文里认出来的 PR 链接。
export function prsOf(event: Pick<ChiefEvent, "source" | "reply" | "keys">): string[] {
  if (event.source === "github") return event.reply.ref ? [event.reply.ref.toLowerCase()] : [];
  return event.keys.flatMap((k) => {
    const m = /^github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/i.exec(k);
    return m ? [`${m[1]}#${m[2]}`.toLowerCase()] : [];
  });
}

// 回复回到的地方是不是这条事件自己的：照抄事件的 reply，最多多一个 in（放 thread 还是直接回）。
function sameTarget(r: Reply, event: ChiefEvent): boolean {
  if (r.source !== event.source) return false;
  const want = Object.entries(event.reply);
  if (want.length === 0) return false;
  if (!want.every(([k, v]) => r.target[k] === v)) return false;
  return Object.keys(r.target).every((k) => k === "in" || k in event.reply);
}

// 规矩允许直接发（--policy）：引擎自己按规矩再算一遍，算出来要问你的发不出去，主会话怎么理解都没用。
// 返回放行的理由；null 是这条要你确认。只放行回答收到的消息、回到那条消息自己的地方；主动发的新消息（reply new）任何模式都问你。
// 模式放宽的是「哪些回复不用你点」。三道不放宽：「一定问我」名单、approve 只能是这条消息自己的 PR、回复只回到这条消息自己的地方。
// auto 只放开两种：approve 别人的 PR（GitHub 上「PR 请我 review」的事件，PR 不是我的）；回自己 PR 上的话（别人评论、approve、要求修改）。
// 回别人的话（Slack、GitHub、Jira、Notion 上的）、approve 原文里提到的 PR、主动发的新消息，仍按场景规矩和白名单。
// GitHub 上机器人的评论引擎本来就不报，没有要回的。yolo：回复和 approve 全部不问；主动发的新消息仍问你。
const OWN_PR = new Set<string>(["github_comment", "github_approved", "github_changes"]);
function byMode(pol: Policy, event: ChiefEvent): string | null {
  if (pol.mode === "yolo") return "模式 yolo";
  return pol.mode === "auto" && OWN_PR.has(scenarioOf(event)) ? "模式 auto（我自己的 PR）" : null;
}
function approveByMode(pol: Policy, event: ChiefEvent): string | null {
  if (pol.mode === "yolo") return "模式 yolo";
  return pol.mode === "auto" && event.source === "github" && event.why[0] === "review" ? "模式 auto（别人的 PR）" : null;
}

export function autoReason(r: Reply, pol: Policy, event: ChiefEvent | null): string | null {
  // 主动发的新消息（reply new）：是 agent 自己起的话头，不是回应，任何模式都问你。
  if (r.kind === "message") return null;
  if (event === null || r.event !== event.id) return null;
  // 「一定问我」名单里的人和对话：什么规矩都不放行（模式也不行）。
  if (mustAsk(pol.askAlways, event)) return null;
  if (r.kind === "approve") {
    // approve 的只能是这条消息自己的 PR，而且要按「直接 approve」的规矩。
    if (!prsOf(event).includes((r.target.ref ?? "").toLowerCase())) return null;
    const am = approveByMode(pol, event);
    if (am !== null) return am;
    if (r.custom !== undefined) {
      const c = pol.custom.find((x) => x.id === r.custom);
      return c?.handle === "approve" && c.reply === "auto" ? `你加的情况 custom:${c.id}` : null;
    }
    const s = pol.scenarios[scenarioOf(event)];
    return s.handle === "approve" && s.reply === "auto" ? `场景「${SCENARIOS[scenarioOf(event)]}」` : null;
  }
  if (!sameTarget(r, event)) return null;
  const m = byMode(pol, event);
  if (m !== null) return m;
  // 固定回复：一字不差才算，前后多一个字都不行。
  const body = r.body.trim();
  if (body !== "" && pol.quick.some((q) => q.trim() === body)) return "固定回复";
  // 白名单只管 Slack：GitHub 登录名、Jira 显示名和 Slack 名字撞了，不能当成同一个人。
  if (event.source === "slack" && isTrusted(pol.trusted, event.from, event.fromId)) return "白名单";
  if (r.custom !== undefined) {
    const c = pol.custom.find((x) => x.id === r.custom);
    return c?.reply === "auto" ? `你加的情况 custom:${c.id}` : null;
  }
  return pol.scenarios[scenarioOf(event)].reply === "auto" ? `场景「${SCENARIOS[scenarioOf(event)]}」` : null;
}

// 你点发送时这条是什么样（发什么、发到哪）：确认时记下指纹，引擎发之前再对一遍，确认之后被改过就不发。
export function replyHash(r: Pick<Reply, "kind" | "source" | "target" | "body" | "images">): string {
  const target = Object.entries(r.target).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([r.kind ?? "reply", r.source, target, r.body, (r.images ?? []).map((i) => i.file)])).digest("hex");
}

// 引擎发之前再核一遍（排队以后规矩、稿子都可能变了）：返回不发的理由，null 是可以发。
// 规矩直接发的：按现在的规矩还得放行；你确认的：内容和去处要和你点发送时一样。
// 主会话和你是同一个系统用户，能直接改 replies.json、算出同样的指纹：这一道拦的是走正常路子之外的改动和规矩变了，拦不住存心伪造。
export function sendCheck(r: Reply, pol: Policy, event: ChiefEvent | null): string | null {
  if (r.by === "policy") return autoReason(r, pol, event) === null ? "按现在的规矩这条要你确认（规矩或稿子在排队后变了），没发：要发请在面板上点发送" : null;
  if (r.by === "you") {
    if (!r.confirm?.hash) return "没有你确认时的记录，没发：要发请在面板上点发送";
    return r.confirm.hash === replyHash(r) ? null : "你确认之后这条的内容或去处被改过，没发：看一眼再点发送";
  }
  return "不知道是谁让发的，没发：要发请在面板上点发送";
}
