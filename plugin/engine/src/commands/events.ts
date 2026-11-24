// 事件：chief events / show / watch / cursor / hub / route / mark。主会话靠它们收消息、记判断、记对应的会话。
import { watch as fsWatch } from "node:fs";
import { archivedEvent } from "../archive";
import { SESSION, fail, flag, num, oneLine, stdinText, title } from "../args";
import { KEY } from "../keys";
import { LineTail } from "../tail";
import { appendDecision, loadCursor, loadDecisions, loadDispatch, loadRoutes, loadThings, paths, readEvents, readJson, scenarioOf, updateJson, withLock, writeJson, type ChiefEvent, type Decision, type Dispatch, type Routes } from "../store";
import { loadTriage, released, wakeReason } from "../triage";
import { recordMark, recordSkip } from "../undo";
import { updateThings } from "./things";

// 一条事件在 Monitor 通知里最多带这么多字，全文用 chief show 看。
export const MAX_TEXT_IN_STREAM = 1500;
// related 里每个问题最多带这么多字。
const RELATED_QUESTION = 150;
const SAME_RELATED_MS = 6 * 3600_000;

export function eventById(id: number): ChiefEvent {
  return readEvents().find((e) => e.id === id) ?? archivedEvent(id) ?? fail(`没有事件 #${id}`);
}

// 主会话这次挂上 Monitor 以后，每个对话上一次带的 related：一样的就不再带一遍。
// 对话：私信按频道，频道里按 thread（和 relatedOf 认「附近」的办法一样）；别的来源按第一个键。
function conversationOf(e: ChiefEvent): string {
  if (e.source !== "slack") return e.keys[0] ?? "";
  return e.why.includes("dm") ? `${e.reply.channel}` : `${e.reply.channel}:${e.reply.thread_ts ?? e.reply.ts}`;
}

export type SeenRelated = Map<string, { id: number; rel: string; at: number }>;

export function streamLine(e: ChiefEvent, seen?: SeenRelated): string {
  const { hold, heldAt: _heldAt, ...rest } = e;
  const text = e.text.length > MAX_TEXT_IN_STREAM ? `${e.text.slice(0, MAX_TEXT_IN_STREAM)}…（全文：chief show ${e.id}）` : e.text;
  let related: unknown = relatedOf(e);
  if (related && seen) {
    const key = conversationOf(e);
    const rel = JSON.stringify(related);
    const at = Date.parse(e.at);
    const prev = seen.get(key);
    // 同一个 thread 6 小时内和上一条一样：主会话刚看过，只说「同 #N」。
    if (prev && prev.rel === rel && !(at - prev.at >= SAME_RELATED_MS)) related = { sameAs: prev.id };
    else seen.set(key, { id: e.id, rel, at });
  }
  // 插件用 Haiku 看过、觉得要你处理的：带上它的理由。
  const triage = hold ? wakeReason(e.id) : null;
  return JSON.stringify({ ...rest, text, ...(related ? { related } : {}), ...(triage ? { triage } : {}) });
}

// 同一个人、同一个 Slack 对话（私信，或同一个 thread）里还没了结的事情和问题。
// 一起交给主会话：对方的新消息常常是在接着说那件事（「好的」「那我跟他说吧」），要连起来看，
// 问题已经被这条消息答掉或过时了，主会话自己关掉，不要留给用户去面板上标。
export function relatedOf(e: ChiefEvent, all: ChiefEvent[] = readEvents()): { things: unknown[]; asks: unknown[] } | null {
  if (e.source !== "slack") return null;
  const thread = (x: ChiefEvent) => x.reply.thread_ts ?? x.reply.ts;
  const same = (x: ChiefEvent) =>
    x.id !== e.id && x.source === "slack" &&
    ((e.fromId !== undefined && x.fromId === e.fromId) ||
      (x.reply.channel === e.reply.channel && (e.why.includes("dm") || thread(x) === thread(e))));
  const near = new Set(all.filter(same).map((x) => x.id));
  if (near.size === 0) return null;
  const t = loadThings();
  // 以前判断时归到的事情（决定记录里一定有；事情自己的事件表可能没记全）。
  const decided = new Set(loadDecisions().flatMap((d) => (near.has(d.event) && d.thing !== undefined && !d.dry ? [d.thing] : [])));
  const things = t.things.filter((x) => x.status !== "done" && x.status !== "dropped" && (decided.has(x.id) || x.events.some((id) => near.has(id))));
  if (things.length === 0) return null;
  const ids = new Set(things.map((x) => x.id));
  return {
    // 只带认得出是哪件、哪个问题的：同一个 thread 来十条就附十次，都留在主会话的上下文里。进展、建议要看再 chief thing list / chief ask show。
    things: things.map((x) => ({ id: x.id, title: x.title, status: x.status, session: x.session ?? null })),
    asks: t.asks.filter((a) => a.status === "open" && ids.has(a.thing)).map((a) => ({ id: a.id, thing: a.thing, question: oneLine(a.question, RELATED_QUESTION) })),
  };
}

// 按字节读新追加的部分（见 tail.ts）：每秒看一眼，只读后来追加的那段；归档重写了文件就从头读，按编号跳过交过的。
export function events(args: string[]): void {
  let after = num(flag(args, "--after") ?? "0", "--after ");
  const follow = args.includes("--follow");
  const tail = new LineTail(paths().events);
  // 还扣着给插件看的（见 triage.ts）：插件放行了、或者插件不在了再交；插件自己记下了就不交。
  const held = new Map<number, ChiefEvent>();
  const seen: SeenRelated = new Map();
  const drain = () => {
    const lines = tail.read();
    if (lines.length === 0 && held.size === 0) return;
    const handled = loadDispatch();
    const triage = loadTriage();
    const now = Date.now();
    const out: ChiefEvent[] = [];
    for (const l of lines) {
      let e: ChiefEvent;
      try {
        e = JSON.parse(l) as ChiefEvent;
      } catch {
        continue;
      }
      if (e.id > after) {
        after = e.id;
        // 已经判断过的不再交给主会话（重新挂 Monitor 时会从进度重读一遍）。
        if (!handled[e.id]) held.set(e.id, e);
      }
    }
    for (const [id, e] of held) {
      if (handled[id]) held.delete(id);
      else if (released(e, triage, now)) {
        held.delete(id);
        out.push(e);
      }
    }
    for (const e of out.sort((a, b) => a.id - b.id)) process.stdout.write(`${streamLine(e, seen)}\n`);
  };
  // 主会话只能有一个：谁挂着 chief events --follow，谁就是主会话。已经有一个在听，第二个直接退出（除非 --take-over 接手）。
  if (follow) {
    const takeOver = args.includes("--take-over");
    const held = withLock(paths().alive, () => {
      const cur = readJson<{ at?: string; pid?: number; stopped?: boolean }>(paths().alive, {});
      const fresh = cur.at !== undefined && Date.now() - Date.parse(cur.at) < ALIVE_MS * 3;
      if (fresh && !cur.stopped && cur.pid !== undefined && cur.pid !== process.pid && pidAlive(cur.pid)) {
        if (!takeOver) return cur.pid;
      }
      // 新的主会话开始听：写下自己（之前「停下」的标记一并清掉）。
      writeJson(paths().alive, { at: new Date().toISOString(), pid: process.pid });
      return null;
    });
    if (held !== null) fail(`已经有一个主会话在听（进程 ${held}）。要让这个会话接手，用 chief events --after N --follow --take-over`);
  }
  // 被别的会话接手了（alive.json 里换成了别人的进程）：说一声就退出，一条消息都不再交，免得两个会话一起处理。
  const stillMine = () => {
    if (!follow) return true;
    const cur = readJson<{ pid?: number; stopped?: boolean }>(paths().alive, {});
    if (cur.stopped) {
      process.stdout.write(`${JSON.stringify({ chief: "stopped", note: "你让主会话停下了，这里不再处理消息" })}\n`);
      process.exit(0);
    }
    if (cur.pid === undefined || cur.pid === process.pid) return true;
    process.stdout.write(`${JSON.stringify({ chief: "handed_over", note: "另一个会话接手了主会话，这里不再处理消息" })}\n`);
    process.exit(0);
  };
  drain();
  if (!follow) return;
  setInterval(() => {
    if (stillMine()) drain();
  }, 1000);
  // 主会话的 Monitor 挂着这个命令：它在跑，就说明主会话在听。面板看 alive.json 判断。
  setInterval(() => {
    if (stillMine()) writeJson(paths().alive, { at: new Date().toISOString(), pid: process.pid });
  }, ALIVE_MS);
}

// chief watch：~/chief/data 里有文件变了就打一行（面板挂着它，有变化马上刷新，不用一直去读）。
export function watchHome(): void {
  let pending: NodeJS.Timeout | null = null;
  const fire = () => process.stdout.write(`changed ${new Date().toISOString()}\n`);
  fsWatch(paths().home, (_type, name) => {
    if (!name || String(name).endsWith(".tmp") || String(name).endsWith(".lock")) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(fire, 200);
  });
  fire();
}

export function route(args: string[]): void {
  const sub = args.shift();
  const routes = loadRoutes();
  if (sub === "list") {
    process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`);
    return;
  }
  if (sub === "get") {
    const hits: Record<string, unknown> = {};
    for (const k of args) if (KEY.test(k) && routes[k]) hits[k] = routes[k];
    process.stdout.write(`${JSON.stringify(hits)}\n`);
    return;
  }
  if (sub === "set") {
    const session = flag(args, "--session") ?? fail("要 --session <会话编号>");
    const t = title(flag(args, "--title")) ?? "";
    if (!SESSION.test(session)) fail("会话编号只能是字母、数字、_ 和 -");
    if (args.length === 0) fail("至少给一个键");
    for (const k of args) if (!KEY.test(k)) fail(`键里有不支持的字符：${oneLine(k, 80)}`);
    const at = new Date().toISOString();
    updateJson<Routes, void>(paths().routes, {}, (all) => {
      for (const k of args) all[k] = { session, title: t, at };
    });
    process.stdout.write(`记下了 ${args.length} 个键 → ${session}\n`);
    return;
  }
  if (sub === "drop") {
    updateJson<Routes, void>(paths().routes, {}, (all) => {
      for (const k of args) delete all[k];
    });
    return;
  }
  fail("chief route get|set|list|drop");
}

export const STATUSES = ["forwarded", "opened", "ignored", "noted", "asked"] as const;

// 主会话判断完一条（或一批）消息就 mark：记进 dispatch.json（面板按它算还剩多少没处理），
// 再往 decisions.jsonl 记一行判断（为什么这么办，从标准输入给），测评和纠正都看它。
export async function mark(args: string[]): Promise<void> {
  const session = flag(args, "--session");
  const titleText = title(flag(args, "--title"));
  const upto = flag(args, "--upto");
  const thingFlag = flag(args, "--thing");
  const thingId = thingFlag === null ? null : num(thingFlag, "--thing ");
  const force = args.includes("--force");
  if (force) args.splice(args.indexOf("--force"), 1);
  // --dry：演练消息的判断（只说会怎么办，没真的办）。
  const dry = args.includes("--dry");
  if (dry) args.splice(args.indexOf("--dry"), 1);
  const status = args.pop() as Dispatch["status"] | Decision["verdict"] | undefined;
  if (!status || !STATUSES.includes(status as (typeof STATUSES)[number])) fail(`chief mark <事件号...> ${STATUSES.join("|")}`);
  if (session !== null && !SESSION.test(session)) fail("会话编号只能是字母、数字、_ 和 -");
  const evts = readEvents();
  const byId = new Map(evts.map((e) => [e.id, e]));
  const listed = upto === null ? args.map((a) => num(a, "事件号")) : [];
  for (const id of listed) if (!byId.has(id)) fail(`没有事件 #${id}`);
  const reason = upto !== null ? "你让跳过之前积下的旧消息" : await stdinText();
  const at = new Date().toISOString();
  // 判断过的不再判断第二次（Monitor 重新挂上时可能又收到一遍）：除非 --force。
  // before：改之前每条是怎么处理的（撤回用，见 undo.ts）。
  const before: Record<string, Dispatch> = {};
  const marked = updateJson<Record<string, Dispatch>, number[] | string>(paths().dispatch, {}, (dispatch) => {
    const ids = upto !== null ? evts.filter((e) => e.id <= num(upto, "--upto ") && !dispatch[e.id]).map((e) => e.id) : listed;
    if (ids.length === 0) return "没有要标的事件";
    const done = ids.filter((id) => dispatch[id]);
    if (done.length > 0 && !force) return `这些已经判断过了：${done.map((id) => `#${id}`).join(" ")}（不用再办；真要改判断加 --force）`;
    for (const id of done) before[id] = dispatch[id]!;
    for (const id of ids) dispatch[id] = { status: status === "asked" ? "noted" : status, at, ...(session ? { session } : {}), ...(titleText ? { title: titleText } : {}) };
    return ids;
  });
  if (typeof marked === "string") fail(marked);
  // 归到哪件事，就把消息记到那件事上（后来的消息靠它连回这件事和它挂着的问题）。
  if (thingId !== null && !dry) {
    updateThings((t) => {
      const x = t.things.find((y) => y.id === thingId);
      if (x) for (const id of marked) if (!byId.get(id)?.dryrun && !x.events.includes(id)) x.events.push(id);
    });
  }
  if (upto === null) {
    for (const id of marked) {
      const e = byId.get(id)!;
      appendDecision({
        at, event: id, scenario: scenarioOf(e), verdict: status as Decision["verdict"], reason: oneLine(reason, 300),
        what: { source: e.source, title: e.title, from: e.from, text: oneLine(e.text, 200) },
        ...(thingId !== null ? { thing: thingId } : {}), ...(session ? { session } : {}),
        ...(dry || e.dryrun ? { dry: true } : {}),
      });
    }
  }
  // 记一笔能撤回的：跳过积下的、只记下 / 忽略（chief undo）。
  if (upto !== null) recordSkip(at, marked);
  else if (!dry) recordMark(status as Decision["verdict"], at, marked.map((id) => byId.get(id)!), before, thingId);
  process.stdout.write(`标好了 ${marked.length} 条\n`);
}

// 主会话在不在听：Monitor 挂着的 chief events --follow 每 20 秒写一次 alive.json。
export const ALIVE_MS = 20_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function hubAlive(): { listening: boolean; lastAt: string | null } {
  const a = readJson<{ at?: string; stopped?: boolean }>(paths().alive, {});
  return { listening: !a.stopped && a.at !== undefined && Date.now() - Date.parse(a.at) < ALIVE_MS * 3, lastAt: a.at ?? null };
}

// chief show <事件号>：一条事件的全文，加上同一个人、同一个对话里还没了结的事情和问题。
export function show(args: string[]): void {
  const e = eventById(num(args[0], "事件号"));
  const related = relatedOf(e);
  process.stdout.write(`${JSON.stringify({ ...e, ...(related ? { related } : {}) }, null, 2)}\n`);
}

// chief cursor [N]：主会话处理到第几条。
export function cursor(args: string[]): void {
  if (args[0] === undefined) {
    process.stdout.write(`${loadCursor()}\n`);
    return;
  }
  const to = num(args[0], "事件号");
  updateJson<{ cursor?: number }, void>(paths().hub, {}, (h) => {
    // 进度只往前走：两边同时记时，不会被旧的盖回去。
    h.cursor = Math.max(h.cursor ?? 0, to);
  });
}

// chief hub [stop]：主会话在不在听。stop 让主会话停下（它的监听看到就退出，标题改回普通会话）。下次在哪个会话发 /chief:hub，哪个就是主会话。
export function hub(args: string[]): void {
  if (args[0] === "stop") {
    updateJson<Record<string, unknown>, void>(paths().alive, {}, (a) => {
      a.stopped = true;
      a.at = new Date().toISOString();
    });
    process.stdout.write("主会话会在 1 秒内停下\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(hubAlive())}\n`);
}
