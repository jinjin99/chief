// 分诊：多半只用记一笔的事件先扣住，主会话所在的会话里的面板插件用 Haiku 看一眼（hooks/triage.ts），
// 只记下的它自己 chief mark，要处理的放给主会话。主会话每醒一次都要把整段对话重读一遍，很贵；Haiku 看一条很便宜。
//
// 扣哪些：
//   - 工作会话的普通进展（session.update，不是在问你的），而且这个会话挂着一件没办完的事；
//   - 外部来的、你的规矩是「只记下」的消息（比如我在的 thread 有后续），而且没带 PR 链接、工单号这类键，
//     也接不上正在做的事（键在对应表里、或这件事挂着同一个 thread 的消息）：接得上的要主会话决定转不转。
// 测试、演练消息、chief 自己的提醒不扣。
//
// 什么时候放给主会话（chief events 照常交）：
//   - 插件看过，说要主会话处理（wake）；
//   - 插件不在：3 分钟没来看过（主会话不在、插件没装新版）；
//   - 插件领了 5 分钟还没看完，或者插件在、扣了 15 分钟还没人领（插件出错了）。
// 插件看完说只记下的，它自己 chief mark，事件就算处理过了，主会话不会收到。
import { liveConfig } from "./config";
import { loadDispatch, loadPolicy, loadRoutes, loadThings, paths, readEvents, readJson, scenarioOf, updateJson, type ChiefEvent, type Thing } from "./store";

export const ALIVE_MS = 3 * 60_000;
export const CLAIM_MS = 5 * 60_000;
export const MAX_HOLD_MS = 15 * 60_000;
// 看过的记录留一天就清掉。
const KEEP_MS = 24 * 3600_000;

export interface TriageItem {
  // 插件领走的时间。
  claimed?: string;
  // 插件说要主会话处理的时间，和它的理由（交给主会话时带上）。
  wake?: string;
  reason?: string;
}

export interface TriageFile {
  // 插件最近一次来看（chief triage list）的时间。
  alive?: string;
  // 插件这一轮是从什么时候开始一直在的：扣着的事件从这之后才开始算 15 分钟。
  since?: string;
  items: Record<string, TriageItem>;
}

export function loadTriage(): TriageFile {
  return readJson<TriageFile>(paths().triage, { items: {} });
}

const active = (x: Thing) => x.status !== "done" && x.status !== "dropped";

// 这条要不要先扣住给插件看。
export function shouldHold(e: Omit<ChiefEvent, "id">, ctx = { things: loadThings().things, routes: loadRoutes(), events: readEvents() }): boolean {
  if (!liveConfig().triage || e.test || e.dryrun) return false;
  if (e.kind === "session.update") {
    if (!e.why.includes("update")) return false;
    const session = e.keys[0];
    return session !== undefined && ctx.things.some((x) => active(x) && x.session === session);
  }
  if (e.source === "session" || e.source === "chief" || e.kind.startsWith("chief.")) return false;
  const scenario = scenarioOf(e);
  if (scenario === "other" || loadPolicy().scenarios[scenario]?.handle !== "note") return false;
  // 带着 PR 链接、工单号的：可能是让你 approve（你加的情况），也可能在接着一件事。交给主会话。
  if (e.keys.some((k) => !k.startsWith("slack:"))) return false;
  if (e.keys.some((k) => ctx.routes[k] !== undefined)) return false;
  const doing = ctx.things.filter(active);
  const keys = new Set(doing.flatMap((x) => x.keys ?? []));
  if (e.keys.some((k) => keys.has(k))) return false;
  // 正在做的事挂着同一个 thread 的消息（第一个键一样）。
  const ids = new Set(doing.flatMap((x) => x.events));
  const thread = e.keys[0];
  if (thread !== undefined && ctx.events.some((x) => ids.has(x.id) && x.keys[0] === thread)) return false;
  return true;
}

// 扣着的事件现在能不能交给主会话。
export function released(e: ChiefEvent, t: TriageFile, now: number): boolean {
  if (!e.hold) return true;
  const it = t.items[e.id];
  if (it?.wake) return true;
  if (t.alive === undefined || now - Date.parse(t.alive) > ALIVE_MS) return true;
  if (it?.claimed) return now - Date.parse(it.claimed) > CLAIM_MS;
  const from = Math.max(Date.parse(e.heldAt ?? e.at), Date.parse(t.since ?? t.alive));
  return now - from > MAX_HOLD_MS;
}

// 还扣着、没人领、没处理的：插件这一轮要看的。
export function pending(now = Date.now()): ChiefEvent[] {
  const t = loadTriage();
  const handled = loadDispatch();
  return readEvents().filter((e) => e.hold && !handled[e.id] && !released(e, t, now) && !t.items[e.id]?.claimed);
}

// 插件来看了：记下它在，顺手清掉一天前的记录。
export function heartbeat(now = Date.now()): void {
  updateJson<TriageFile, void>(paths().triage, { items: {} }, (t) => {
    if (t.alive === undefined || now - Date.parse(t.alive) > ALIVE_MS) t.since = new Date(now).toISOString();
    t.alive = new Date(now).toISOString();
    for (const [id, it] of Object.entries(t.items)) {
      const at = Date.parse(it.wake ?? it.claimed ?? "");
      if (!(now - at < KEEP_MS)) delete t.items[id];
    }
  });
}

// 领一条：别人领过、已经放了、已经处理过的领不到。
export function claim(id: number, now = Date.now()): boolean {
  const e = readEvents().find((x) => x.id === id);
  if (!e?.hold || loadDispatch()[id]) return false;
  return updateJson<TriageFile, boolean>(paths().triage, { items: {} }, (t) => {
    if (released(e, t, now) || t.items[id]?.claimed) return false;
    t.items[id] = { claimed: new Date(now).toISOString() };
    return true;
  });
}

export function wake(id: number, reason: string, now = Date.now()): void {
  updateJson<TriageFile, void>(paths().triage, { items: {} }, (t) => {
    t.items[id] = { ...t.items[id], wake: new Date(now).toISOString(), reason };
  });
}

// 交给主会话时带上的一句：插件为什么觉得要你处理。
export function wakeReason(id: number): string | null {
  return loadTriage().items[id]?.reason ?? null;
}
