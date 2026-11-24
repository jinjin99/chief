// chief triage：面板插件分诊用（见 triage.ts、hooks/triage.ts）。
//   list           这一轮要看的（扣着、没人领的），加上判断要用的规矩；顺带记下插件在。
//   claim <号>     领一条（领到了退出码 0；别人领了、已经放了、已经处理了是 1）。
//   wake <号>      这条要主会话处理，标准输入是理由（交给主会话时带上）。
// 只记下的不在这里：插件照主会话的办法 chief thing update / chief mark … noted，记录、撤回都一样。
import { fail, num, oneLine, stdinText } from "../args";
import { loadPolicy, loadReplies, loadThings, scenarioOf, SCENARIOS } from "../store";
import { claim, heartbeat, pending, wake } from "../triage";

// 一条最多带这么多字给 Haiku。
const MAX_TEXT = 3000;

export async function triage(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "list") {
    heartbeat();
    const policy = loadPolicy();
    const t = loadThings();
    const replies = loadReplies().items;
    const items = pending().map((e) => {
      const base = { id: e.id, title: e.title, from: e.from, text: e.text.slice(0, MAX_TEXT), scenario: SCENARIOS[scenarioOf(e)] };
      if (e.kind !== "session.update") return { kind: "message" as const, ...base };
      const x = t.things.find((y) => y.session === e.keys[0] && y.status !== "done" && y.status !== "dropped");
      const asks = x ? t.asks.filter((a) => a.thing === x.id && a.status === "open").map((a) => a.question) : [];
      const waiting = x ? replies.filter((r) => r.thing === x.id && (r.status === "pending" || r.status === "failed")).map((r) => `给 ${r.context?.who ?? "对方"}：${oneLine(r.body, 80)}`) : [];
      return {
        kind: "session" as const, ...base,
        thing: x ? { id: x.id, title: x.title, status: x.status, progress: x.progress, next: x.next ?? "", blocker: x.blocker ?? "", asks, replies: waiting } : null,
      };
    });
    const rules = { notes: policy.notes, custom: policy.custom.map((c) => ({ when: c.when, handle: c.handle, brief: c.brief ?? "" })) };
    process.stdout.write(`${JSON.stringify({ rules, items })}\n`);
    return;
  }
  if (sub === "claim") {
    const id = num(args[0] ?? fail("chief triage claim <事件号>"), "事件号");
    if (!claim(id)) fail(`事件 #${id} 不用领了（别人领了、已经交给主会话、或已经处理过）`);
    return;
  }
  if (sub === "wake") {
    const id = num(args[0] ?? fail("chief triage wake <事件号>"), "事件号");
    wake(id, oneLine(await stdinText(), 300));
    return;
  }
  fail("chief triage list|claim|wake");
}
