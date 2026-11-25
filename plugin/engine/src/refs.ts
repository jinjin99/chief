// 外面的东西变了就提醒：开着的「要你定」、待发出的回复、进行中的事情里提到的 GitHub PR，状态变了（合了、关了、
// 重新打开、有冲突、推了新提交）就交给主会话，免得问题和稿子悄悄过时。
// 为什么要这个：别人的 PR 合并时，GitHub 来源不算「有人找你」（合并的不是你、也没 @ 你），引擎交不出事件；
// 主会话就会在 PR 合了以后还登记「approve 吗」，稿子在待发出里放一天，期间 PR 全变了。
//
//   - RefWatch.tick：健康检查时调，每 refCheckMinutes 分钟一轮（默认 10），用本机的 gh 批量查（GraphQL，一次 25 个），
//     结果写进 refs.json（面板读）。每个提到 PR 的（问题、回复、事情）记着它上次看到的样子，变了交一条 ref.changed。
//     登记问题、写稿时 PR 已经合了、关了的也算（问题和回复第一次被看到时就不是开着的）。
//   - RefWatch.staleDrafts：待发出的回复放了 staleDraftHours 小时（默认 12）还没发，交一条 reply.stale，让写稿的会话按现状核一遍。每条只交一次。
//   - RefWatch.beforeSend：引擎发到 GitHub 之前现查一次那个 PR：approve 已经不开着的 PR 不发；往合了、关了的 PR 上评论，
//     退回待发出、写明 PR 已合并，你看过再点发送才发，规矩不能自动发。
//
// 只读：查 PR 只发 GraphQL 查询。仓库名、PR 号是从别人写的文字里认出来的，当变量交给 gh（-f / -F），不拼进查询。
// 只在 GitHub 来源开着时查（关了 GitHub 的不碰 gh）。
import { homedir } from "node:os";
import { settleReplyAsks } from "./commands/things";
import { config } from "./config";
import { githubKey } from "./keys";
import { runProgram } from "./program";
import { snoozeDue } from "./snooze";
import { findGh } from "./sources/github";
import { loadReplies, loadThings, paths, readJson, updateReplies, writeJson, type ChiefEvent, type PrState, type RefsFile, type Reply, type Thing, type ThingsFile } from "./store";

// 一轮最多查几个 PR、一次 GraphQL 查几个。
const MAX_PRS = 100;
const BATCH = 25;
// 查不到的（不是 PR、没权限、仓库没了）隔多久再查。
const MISSING_MS = 86_400_000;

// ── 从文字里认出 PR ──

// PR 链接（只认 pull，issue 不算）、owner/repo#号、只写仓库名的 repo#号（要在别处见过这个仓库的完整写法才认得出是谁的）。
const LINK = /github\.com\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull\/(\d{1,9})/gi;
const FULL = /(?<![\w./-])([A-Za-z0-9][\w.-]{0,99})\/([\w.-]{1,100})#(\d{1,9})(?!\d)/g;
const SHORT = /(?<![\w./#-])([A-Za-z][\w.-]{0,99})#(\d{1,9})(?!\d)/g;

const id = (owner: string, repo: string, n: string | number) => `${owner}/${repo}#${Number(n)}`.toLowerCase();

// 仓库名 → owner（文字里出现过完整写法的）。同名仓库有两个 owner 的记 null，认不出。
export function ownersOf(texts: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const add = (owner: string, repo: string) => {
    const r = repo.toLowerCase();
    const o = owner.toLowerCase();
    if (!out.has(r)) out.set(r, o);
    else if (out.get(r) !== o) out.set(r, null);
  };
  for (const t of texts) {
    for (const m of t.matchAll(LINK)) add(m[1]!, m[2]!);
    for (const m of t.matchAll(FULL)) add(m[1]!, m[2]!);
  }
  return out;
}

// 一段文字里提到的 PR：owner/repo#号，小写，去重。
export function prsIn(text: string, owners: ReadonlyMap<string, string | null> = new Map()): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(LINK)) out.add(id(m[1]!, m[2]!, m[3]!));
  for (const m of text.matchAll(FULL)) out.add(id(m[1]!, m[2]!, m[3]!));
  for (const m of text.matchAll(SHORT)) {
    const owner = owners.get(m[1]!.toLowerCase());
    if (owner) out.add(id(owner, m[1]!, m[2]!));
  }
  return [...out];
}

// ── 谁提到了哪些 PR ──

export interface Watcher {
  // a<问题号>、r<回复号>、t<事情号>：refs.json 里 links、seen 的键，面板按它找。
  key: string;
  kind: "ask" | "reply" | "thing";
  id: number;
  thing?: number;
  // 登记 / 写稿的时间（主会话拿它和合并时间比）。
  at: string;
  // 自己的文字里写着的 PR。
  direct: string[];
  // 加上问题从它那件事带来的（事情的键、标题）。
  prs: string[];
}

const live = (t: Thing, now: number) => (t.status === "doing" || t.status === "waiting_you" || t.status === "waiting_others") && (!t.snooze || snoozeDue(t, now));
const thingTexts = (t: Thing) => [...(t.keys ?? []), t.title, t.next ?? "", t.blocker ?? "", ...(t.results ?? [])];
const replyTexts = (r: Reply) => [r.source === "github" ? r.target.ref ?? "" : "", r.context.url ?? "", r.context.where, r.context.said, r.body];
// 测试消息的回复（没有去处）发不出去，不用盯。
const outbox = (r: Reply) => (r.status === "pending" || r.status === "failed") && Object.keys(r.target).length > 0;

// 开着的问题、待发出的回复、进行中的事情（稍后再说的不算，到点叫醒了再算）。问题和回复排在前面（超出上限时先查它们）。
export function watchersOf(t: ThingsFile, replies: readonly Reply[], now = Date.now()): Watcher[] {
  const things = new Map(t.things.map((x) => [x.id, x]));
  const asks = t.asks.filter((a) => a.status === "open" && (() => {
    const x = things.get(a.thing);
    return !x || live(x, now);
  })());
  const drafts = replies.filter(outbox);
  const liveThings = t.things.filter((x) => live(x, now)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const owners = ownersOf([
    ...asks.flatMap((a) => [a.question, a.suggest]),
    ...drafts.flatMap(replyTexts),
    ...liveThings.flatMap(thingTexts),
  ]);
  const out: Watcher[] = [];
  const push = (w: Omit<Watcher, "prs">, inherited: string[]) => {
    const prs = [...new Set([...w.direct, ...inherited])];
    if (prs.length > 0) out.push({ ...w, prs });
  };
  for (const a of asks) {
    const x = things.get(a.thing);
    push({ key: `a${a.id}`, kind: "ask", id: a.id, thing: a.thing, at: a.at, direct: prsIn(`${a.question}\n${a.suggest}`, owners) },
      x ? prsIn([...(x.keys ?? []), x.title].join("\n"), owners) : []);
  }
  for (const r of drafts) {
    push({ key: `r${r.id}`, kind: "reply", id: r.id, ...(r.thing !== undefined ? { thing: r.thing } : {}), at: r.at, direct: prsIn(replyTexts(r).join("\n"), owners) }, []);
  }
  for (const x of liveThings) {
    push({ key: `t${x.id}`, kind: "thing", id: x.id, thing: x.id, at: x.updatedAt, direct: prsIn(thingTexts(x).join("\n"), owners) }, []);
  }
  return out;
}

// ── 变了没有 ──

export type Change = "merged" | "closed" | "reopened" | "conflict" | "commits";

// 一个 PR 现在的样子，压成一行存着比：状态|有没有冲突|最新提交。
export function fingerprint(s: Pick<PrState, "state" | "conflict" | "head">): string {
  return `${s.state}|${s.conflict ? "conflict" : ""}|${s.head}`;
}

// 这个提到 PR 的，上次看到的是 before，现在是 now：交给主会话的是哪几种变化。
//   - 第一次看到：问题、回复登记时 PR 已经合了、关了，算变了（问的、写的多半是开着时的事）；事情不算（只记下现在的样子）。
//   - 合了、关了、重新打开：谁都算。
//   - 有冲突了：谁都算（冲突解决了是好事，不报，面板上的「有冲突」自己会消失）。
//   - 推了新提交：只算问题、回复自己写着这个 PR 的（问的、写的是旧代码）；事情、从事情带来的不算，会话自己推的提交不用告诉主会话。
export function changesOf(before: string | undefined, now: Pick<PrState, "state" | "conflict" | "head">, who: { kind: Watcher["kind"]; direct: boolean }): Change[] {
  if (before === undefined) return who.kind !== "thing" && now.state !== "open" ? [now.state] : [];
  const [state, conflict, head] = before.split("|");
  const out: Change[] = [];
  if (state !== now.state) out.push(now.state === "open" ? "reopened" : now.state);
  if (now.state === "open" && conflict === "" && now.conflict) out.push("conflict");
  if (now.state === "open" && state === "open" && head !== now.head && who.kind !== "thing" && who.direct) out.push("commits");
  return out;
}

// ── 查 GitHub ──

// 交给 gh 的 GraphQL 查询：query 是写死的，vars 是变量（仓库名、PR 号）。
export type Gql = (query: string, vars: Record<string, string | number>, signal: AbortSignal) => Promise<{ data?: Record<string, unknown> | null }>;

// 本机的 gh（launchd 下 PATH 很短，见 findGh）；没装就是 null。
export function ghGql(): Gql | null {
  const bin = findGh();
  if (!bin) return null;
  return async (query, vars, signal) => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    // -f 原样当字符串，-F 才转成数字（PR 号只有数字，-F 的 @文件 写法用不上）。
    for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    const out = await runProgram(bin, args, { cwd: homedir(), timeoutMs: 30_000, network: true, signal, maxOutput: 4 * 1024 * 1024 });
    if (out.aborted) throw new Error("取消了");
    if (out.timedOut) throw new Error("gh 30 秒没回应");
    // 有的查不到（不是 PR、没权限）时 gh 的退出码不是 0，查到的照样在 data 里。
    try {
      const j = JSON.parse(out.stdout) as { data?: Record<string, unknown> | null };
      if (j && typeof j === "object" && j.data) return j;
    } catch {
      // 不是 JSON：下面按出错报。
    }
    const why = out.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
    throw new Error(/auth|login|token/i.test(why) ? "gh 没登录，到终端里跑 gh auth login" : `gh 出错了：${why}`);
  };
}

type Found = Omit<PrState, "conflict" | "checkedAt"> & { mergeable: string };

interface RawPr { title?: string; url?: string; state?: string; mergedAt?: string | null; closedAt?: string | null; mergeable?: string; headRefOid?: string }

const PR_RE = /^([\w.-]{1,100})\/([\w.-]{1,100})#(\d{1,9})$/;

// 查一批 PR 现在的样子。查不到的是 null。整批出错（gh 没登录、网络断了）就抛出去，这一轮什么都不改。
export async function queryPrs(gql: Gql, prs: readonly string[], signal: AbortSignal): Promise<Map<string, Found | null>> {
  const out = new Map<string, Found | null>();
  const ok = prs.filter((p) => PR_RE.test(p));
  for (let i = 0; i < ok.length; i += BATCH) {
    const batch = ok.slice(i, i + BATCH);
    const vars: Record<string, string | number> = {};
    const decl: string[] = [];
    const body: string[] = [];
    batch.forEach((p, n) => {
      const [, owner, repo, num] = PR_RE.exec(p)!;
      vars[`o${n}`] = owner!;
      vars[`r${n}`] = repo!;
      vars[`n${n}`] = Number(num);
      decl.push(`$o${n}:String!,$r${n}:String!,$n${n}:Int!`);
      body.push(`p${n}:repository(owner:$o${n},name:$r${n}){pullRequest(number:$n${n}){title url state mergedAt closedAt mergeable headRefOid}}`);
    });
    const res = await gql(`query(${decl.join(",")}){${body.join(" ")}}`, vars, signal);
    if (!res.data) throw new Error("GitHub 没返回数据");
    batch.forEach((p, n) => {
      const pr = (res.data![`p${n}`] as { pullRequest?: RawPr | null } | null | undefined)?.pullRequest;
      const state = pr?.state === "MERGED" ? "merged" : pr?.state === "CLOSED" ? "closed" : pr?.state === "OPEN" ? "open" : null;
      out.set(p, pr && state ? {
        state, head: pr.headRefOid ?? "", title: (pr.title ?? "").replace(/\s+/g, " ").slice(0, 120), url: pr.url ?? `https://github.com/${p.replace("#", "/pull/")}`,
        mergedAt: pr.mergedAt ?? null, closedAt: pr.closedAt ?? null, mergeable: pr.mergeable ?? "UNKNOWN",
      } : null);
    });
  }
  return out;
}

// ── 交给主会话的话 ──

// 给人看的本地时间：11/24 09:00。
function localTime(iso: string | null | undefined): string {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "?";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

function changeText(c: Change, s: PrState): string {
  if (c === "merged") return `已合并（${localTime(s.mergedAt)} 合的）`;
  if (c === "closed") return `已关闭，没合并（${localTime(s.closedAt)} 关的）`;
  if (c === "reopened") return "重新打开了";
  if (c === "conflict") return "有冲突了，合不进去";
  return "推了新提交";
}

const SHORT_CHANGE: Record<Change, string> = { merged: "已合并", closed: "已关闭", reopened: "重新打开", conflict: "有冲突", commits: "有新提交" };

const whatOf = (r: Reply) => (r.kind === "approve" ? `approve ${r.target.ref ?? ""}` : `回 ${r.context.who ?? r.context.where}`);

export function refEvent(pr: string, s: PrState, hits: { w: Watcher; changes: Change[] }[], t: ThingsFile, replies: readonly Reply[], now: Date): Omit<ChiefEvent, "id"> {
  const changes = [...new Set(hits.flatMap((h) => h.changes))];
  const thingOf = (n: number | undefined) => (n === undefined ? undefined : t.things.find((x) => x.id === n));
  const lines = hits.map(({ w }) => {
    const x = thingOf(w.thing);
    const inThing = x ? `事情 #${x.id}「${clip(x.title, 40)}」` : "";
    if (w.kind === "ask") {
      const a = t.asks.find((y) => y.id === w.id);
      return `- 开着的问题 #${w.id}（${[inThing, `${localTime(w.at)} 登记`].filter(Boolean).join("，")}）：${clip(a?.question ?? "", 80)}`;
    }
    if (w.kind === "reply") {
      const r = replies.find((y) => y.id === w.id);
      return `- 待发出的回复 #${w.id}（${[r ? whatOf(r) : "", inThing, `${localTime(w.at)} 写的`].filter(Boolean).join("，")}）${r && r.kind !== "approve" ? `：${clip(r.body, 80)}` : ""}`;
    }
    return `- 进行中的事情 #${w.id}「${clip(x?.title ?? "", 40)}」${x?.session ? `（会话 ${x.session}）` : ""}`;
  });
  const of = (k: Watcher["kind"]) => [...new Set(hits.filter((h) => h.w.kind === k).map((h) => h.w.id))];
  const things = [...new Set([...of("thing"), ...hits.flatMap((h) => (h.w.thing !== undefined ? [h.w.thing] : []))])];
  const [, owner, repo, num] = PR_RE.exec(pr)!;
  const markThing = things.length === 1 ? ` --thing ${things[0]}` : "";
  return {
    at: now.toISOString(), source: "chief", kind: "ref.changed",
    title: `PR ${changes.map((c) => SHORT_CHANGE[c]).join("、")}：${pr} ${s.title}`.slice(0, 200), url: s.url, from: null,
    text: `PR ${pr}「${s.title}」${changes.map((c) => changeText(c, s)).join("；")}。还提到它的：\n${lines.join("\n")}\n`
      + `按现状过一遍（见 hub skill 的 ref.changed）：不成立的问题 chief ask withdraw；不对了的稿子 chief reply redo 让写稿的会话重写，不用发了 chief reply drop；事情的会话要知道的 send_message 告诉它。还成立的不动。这条 mark noted${markThing}。`,
    why: changes, keys: [githubKey(owner!, repo!, "pull", num!)], reply: {},
    affected: { asks: of("ask"), replies: of("reply"), things },
  };
}

export function staleEvent(r: Reply, t: ThingsFile, hours: number, now: Date): Omit<ChiefEvent, "id"> {
  const x = r.thing === undefined ? undefined : t.things.find((y) => y.id === r.thing);
  const asks = t.asks.filter((a) => a.status === "open" && a.reply === r.id).map((a) => a.id);
  const where = [whatOf(r), x ? `事情 #${x.id}「${clip(x.title, 40)}」` : "", x?.session ? `会话 ${x.session}` : "", `${localTime(r.at)} 写的`].filter(Boolean).join("，");
  return {
    at: now.toISOString(), source: "chief", kind: "reply.stale", title: `稿子放了 ${hours} 小时还没发：${whatOf(r)}`.slice(0, 200), url: r.context.url, from: null,
    text: `待发出的回复 #${r.id}（${where}）放了 ${hours} 小时还没发${r.kind === "approve" ? "" : `：${clip(r.body, 120)}`}。这段时间对方可能又说了话，PR、工单可能变了。`
      + `让写稿的会话按现状核一遍（见 hub skill 的 reply.stale）：还成立就不动，接着等用户；不成立就重写成新稿，或 chief reply drop ${r.id}。这条 mark noted${x ? ` --thing ${x.id}` : ""}。`,
    why: ["stale"], keys: [...(x?.keys ?? []), ...(x?.session ? [x.session] : [])], reply: {},
    affected: { asks, replies: [r.id], things: x ? [x.id] : [] },
  };
}

// ── 发之前再查一次 ──

export type SendStop =
  // approve 已经不开着的 PR：不发，标成没发出去。
  | { kind: "block"; why: string }
  // 往合了、关了的 PR 上评论：退回待发出，你看过再点发送才发。
  | { kind: "bounce"; why: string; prState: NonNullable<Reply["prState"]> };

// 把拦下的结果写进 replies.json。退回的：因为排上了发送才关掉的问题重新打开（和撤回发送一样）。文件被占着返回 false。
export function applyStop(replyId: number, stop: SendStop): boolean {
  try {
    updateReplies((all) => {
      const r = all.items.find((y) => y.id === replyId);
      if (!r) return;
      if (stop.kind === "block") Object.assign(r, { status: "failed", error: stop.why });
      else {
        r.status = "pending";
        r.prState = stop.prState;
        delete r.sendAt;
        delete r.by;
        delete r.confirm;
        delete r.error;
      }
    });
  } catch {
    return false;
  }
  if (stop.kind === "bounce") {
    try {
      settleReplyAsks(replyId, "undo");
    } catch {
      // 问题没重新打开不影响拦下：卡片上照样有这条回复。
    }
  }
  return true;
}

// ── 引擎用的 ──

export interface RefDeps {
  // 查 GitHub 用的（GitHub 来源没开、没装 gh 时是 null）。
  gql: () => Gql | null;
  emit: (e: Omit<ChiefEvent, "id">, dedupe: string) => boolean;
  log: (line: string) => void;
}

const EMPTY: RefsFile = { prs: {}, links: {}, seen: {}, missing: {} };

export class RefWatch {
  private lastAt = 0;
  private running = false;
  private noGh = false;

  constructor(private readonly deps: RefDeps) {}

  // 健康检查时调（每分钟）：到了间隔才查一轮。
  async tick(now = Date.now(), signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.running || now - this.lastAt < config().refCheckMinutes * 60_000) return;
    this.running = true;
    this.lastAt = now;
    try {
      await this.check(now, signal);
    } catch (error) {
      if (!signal.aborted) this.deps.log(`查 PR 状态没成：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  // 查一轮：交了几条 ref.changed。
  async check(now = Date.now(), signal: AbortSignal = new AbortController().signal): Promise<number> {
    const gql = this.deps.gql();
    if (!gql) {
      if (!this.noGh) this.deps.log("GitHub 没开或没找到 gh：不查 PR 状态");
      this.noGh = true;
      return 0;
    }
    this.noGh = false;
    const t = loadThings();
    const replies = loadReplies().items;
    const watchers = watchersOf(t, replies, now);
    const prev = { ...EMPTY, ...readJson<Partial<RefsFile>>(paths().refs, {}) };
    const missing = Object.fromEntries(Object.entries(prev.missing).filter(([, at]) => now - Date.parse(at) < MISSING_MS));
    const all = [...new Set(watchers.flatMap((w) => w.prs))];
    const want = all.filter((p) => !(p in missing));
    if (want.length > MAX_PRS) this.deps.log(`提到的 PR 有 ${want.length} 个，这一轮只查前 ${MAX_PRS} 个`);
    const found = await queryPrs(gql, want.slice(0, MAX_PRS), signal);
    const at = new Date(now).toISOString();
    const prs: Record<string, PrState> = {};
    for (const p of all) {
      const f = found.get(p);
      if (f === null) missing[p] = at;
      else if (f) {
        const { mergeable, ...rest } = f;
        // GitHub 还没算出能不能合（UNKNOWN）：按上一次的。
        const conflict = mergeable === "CONFLICTING" ? true : mergeable === "MERGEABLE" ? false : prev.prs[p]?.conflict ?? false;
        prs[p] = { ...rest, conflict, checkedAt: at };
      } else if (prev.prs[p]) prs[p] = prev.prs[p]!;
    }
    // 每个提到 PR 的，和它上次看到的比。这一轮没查到的（超出上限、查不到）留着上次的。
    const seen: Record<string, string> = {};
    const byPr = new Map<string, { w: Watcher; changes: Change[] }[]>();
    for (const w of watchers) {
      for (const p of w.prs) {
        const k = `${w.key} ${p}`;
        const s = found.get(p) ? prs[p] : undefined;
        if (!s) {
          if (prev.seen[k] !== undefined) seen[k] = prev.seen[k]!;
          continue;
        }
        seen[k] = fingerprint(s);
        const changes = changesOf(prev.seen[k], s, { kind: w.kind, direct: w.direct.includes(p) });
        if (changes.length > 0) byPr.set(p, [...(byPr.get(p) ?? []), { w, changes }]);
      }
    }
    // 先交事件、再写文件：写文件之前停了，下一轮会再交一次（引擎按 dedupe 认得出交过的）；反过来就丢了。
    let n = 0;
    for (const [p, hits] of byPr) {
      const e = refEvent(p, prs[p]!, hits, t, replies, new Date(now));
      if (this.deps.emit(e, `ref:${p}:${fingerprint(prs[p]!)}:${hits.map((h) => h.w.key).sort().join(",")}`)) n++;
    }
    writeJson(paths().refs, { checkedAt: at, prs, links: Object.fromEntries(watchers.map((w) => [w.key, w.prs])), seen, missing } satisfies RefsFile);
    if (n > 0) this.deps.log(`PR 状态变了，交给消息中心 ${n} 条`);
    return n;
  }

  // 待发出的回复放了 staleDraftHours 小时还没发：交一条 reply.stale（每条回复只交一次）。返回交了几条。
  staleDrafts(now = Date.now()): number {
    try {
      const hours = config().staleDraftHours;
      const old = loadReplies().items.filter((r) => outbox(r) && now - Date.parse(r.at) >= hours * 3600_000);
      if (old.length === 0) return 0;
      const t = loadThings();
      let n = 0;
      for (const r of old) if (this.deps.emit(staleEvent(r, t, hours, new Date(now)), `stale-draft:${r.id}`)) n++;
      if (n > 0) this.deps.log(`待发出的回复有 ${n} 条放了 ${hours} 小时以上，交给消息中心核一遍`);
      return n;
    } catch (error) {
      this.deps.log(`看待发出的稿子放了多久没成：${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  // 发到 GitHub 之前现查一次那个 PR。null 是照发。查不成（gh 出错、没开 GitHub）也照发：真发的时候 gh 会自己报错。
  async beforeSend(r: Reply, now = Date.now(), signal: AbortSignal = new AbortController().signal): Promise<SendStop | null> {
    if (r.source !== "github") return null;
    const pr = prsIn(r.target.ref ?? "")[0];
    const gql = pr ? this.deps.gql() : null;
    if (!pr || !gql) return null;
    let s: Found | null | undefined;
    try {
      s = (await queryPrs(gql, [pr], signal)).get(pr);
    } catch (error) {
      this.deps.log(`回复 ${r.id} 发之前查 PR 没成，照发：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!s || s.state === "open") return null;
    const done = s.state === "merged" ? `PR 已合并（${localTime(s.mergedAt)}）` : `PR 已关闭（${localTime(s.closedAt)}）`;
    if (r.kind === "approve") return { kind: "block", why: `${done}，没 approve` };
    // 退回以后你又点了发送：你看过「PR 已合并」还要发，照发。规矩直接发的永远退回。
    if (r.by === "you" && r.prState?.state === s.state && Date.parse(r.confirm?.at ?? "") > Date.parse(r.prState.at)) return null;
    return { kind: "bounce", why: `${done}，没发：退回待发出，看一眼还要不要发，要发再点发送`, prState: { ref: pr, state: s.state, at: new Date(now).toISOString() } };
  }
}
