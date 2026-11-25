// 提到的 PR 变了就提醒、稿子放久了提醒、发到 GitHub 之前再查一次（见 src/refs.ts）。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { replyHash } from "../src/gate";
import { changesOf, fingerprint, ownersOf, prsIn, queryPrs, RefWatch, watchersOf, type Gql } from "../src/refs";
import type { ChiefEvent, Reply, ThingsFile } from "../src/store";

let saved: string | undefined;
let h: string;

beforeEach(() => {
  saved = process.env.CHIEF_HOME;
  h = mkdtempSync(join(tmpdir(), "chief-refs-"));
  process.env.CHIEF_HOME = h;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CHIEF_HOME;
  else process.env.CHIEF_HOME = saved;
});

const MIN = 60_000;
const HOUR = 3600_000;
const T0 = Date.parse("2026-11-25T03:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const write = (f: string, v: unknown) => writeFileSync(join(h, f), JSON.stringify(v));
const read = (f: string) => JSON.parse(readFileSync(join(h, f), "utf8"));
const events = (): ChiefEvent[] => {
  try {
    return readFileSync(join(h, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChiefEvent);
  } catch {
    return [];
  }
};

// 假的 GitHub：按 owner/repo#号 给状态；查了哪些记在 calls 里（看变量，确认仓库名、PR 号没拼进查询）。
type Pr = { state: "OPEN" | "MERGED" | "CLOSED"; mergeable?: string; head?: string; mergedAt?: string | null };
function fakeGitHub(prs: Record<string, Pr>) {
  const calls: { query: string; vars: Record<string, string | number> }[] = [];
  const gql: Gql = async (query, vars) => {
    calls.push({ query, vars });
    const data: Record<string, unknown> = {};
    for (let n = 0; `o${n}` in vars; n++) {
      const key = `${vars[`o${n}`]}/${vars[`r${n}`]}#${vars[`n${n}`]}`.toLowerCase();
      const p = prs[key];
      data[`p${n}`] = { pullRequest: p ? { title: `PR ${key}`, url: `https://github.com/${key.replace("#", "/pull/")}`, state: p.state, mergedAt: p.mergedAt ?? null, closedAt: p.state === "OPEN" ? null : p.mergedAt ?? null, mergeable: p.mergeable ?? "MERGEABLE", headRefOid: p.head ?? "aaa" } : null };
    }
    return { data };
  };
  return { gql, calls, prs };
}

const thing = (id: number, extra: Record<string, unknown> = {}) => ({ id, title: `事情 ${id}`, status: "doing", progress: "", events: [], updatedAt: iso(T0), log: [], ...extra });
const ask = (id: number, thingId: number, question: string, extra: Record<string, unknown> = {}) => ({ id, thing: thingId, question, suggest: "", status: "open", at: iso(T0), ...extra });
const ghReply = (id: number, ref: string, extra: Record<string, unknown> = {}): Reply => ({
  id, event: 1, source: "github", target: { ref }, context: { who: null, where: `${ref} 修 bug`, said: "", url: null }, body: "改好了", status: "pending", at: iso(T0), ...extra,
} as Reply);

describe("从文字里认出 PR", () => {
  it("PR 链接、owner/repo#号；只写仓库名的要别处见过完整写法；issue、网址片段、PR#12 不算", () => {
    expect(prsIn("看下 https://github.com/Acme/Shop/pull/12#issuecomment-1 和 acme/api#3（接口）")).toEqual(["acme/shop#12", "acme/api#3"]);
    expect(prsIn("github.com/acme/shop/issues/5、https://x.com/a/b#12、PR#12、#7、颜色 #fafafa")).toEqual([]);
    const owners = ownersOf(["github.com/acme/shop/pull/1", "bob/tools#2", "carol/tools#3"]);
    expect(prsIn("shop#535（删掉 mini）、tools#4", owners)).toEqual(["acme/shop#535"]);
    expect(prsIn("acme/shop#1 / #2")).toEqual(["acme/shop#1"]);
  });

  it("谁提到了哪些 PR：问题带上它那件事的键；稍后再说的事情、测试消息的回复、发出去的回复不算", () => {
    const t = {
      nextThing: 4, nextAsk: 4,
      things: [
        thing(1, { keys: ["github.com/acme/shop/pull/12"], title: "shop#12（删掉 mini）review" }),
        thing(2, { keys: ["github.com/acme/api/pull/7"], snooze: { until: iso(T0 + HOUR), at: iso(T0) } }),
        thing(3, { status: "done", keys: ["github.com/acme/api/pull/8"] }),
      ],
      asks: [ask(1, 1, "带着评论 approve 吗？"), ask(2, 2, "acme/api#7（接口）要拆吗？"), ask(3, 1, "答过了", { status: "answered" })],
    } as unknown as ThingsFile;
    const replies = [
      ghReply(1, "acme/shop#12"),
      ghReply(2, "acme/shop#13", { status: "sent" }),
      { ...ghReply(3, "acme/shop#14"), source: "slack", target: {}, context: { who: "Bob", where: "私信", said: "acme/shop#14 合了吗", url: null } } as Reply,
    ];
    const w = watchersOf(t, replies, T0);
    expect(w.map((x) => [x.key, x.prs, x.direct])).toEqual([
      ["a1", ["acme/shop#12"], []],
      ["r1", ["acme/shop#12"], ["acme/shop#12"]],
      ["t1", ["acme/shop#12"], ["acme/shop#12"]],
    ]);
    // 稍后再说到点了就算。
    expect(watchersOf(t, replies, T0 + 2 * HOUR).map((x) => x.key)).toEqual(["a1", "a2", "r1", "t1", "t2"]);
  });
});

describe("变了没有", () => {
  const open = { state: "open" as const, conflict: false, head: "aaa" };
  const ask = { kind: "ask" as const, direct: true };
  const thingW = { kind: "thing" as const, direct: true };

  it("第一次看到：问题、回复登记时 PR 已经合了、关了算变了；事情只记下", () => {
    expect(changesOf(undefined, open, ask)).toEqual([]);
    expect(changesOf(undefined, { ...open, state: "merged" }, ask)).toEqual(["merged"]);
    expect(changesOf(undefined, { ...open, state: "closed" }, { kind: "reply", direct: true })).toEqual(["closed"]);
    expect(changesOf(undefined, { ...open, state: "merged" }, thingW)).toEqual([]);
  });

  it("合了、关了、重新打开、有冲突谁都算；冲突解决了不报；新提交只算问题、回复自己写着的", () => {
    const was = fingerprint(open);
    expect(changesOf(was, { ...open, state: "merged", head: "bbb" }, thingW)).toEqual(["merged"]);
    expect(changesOf(fingerprint({ ...open, state: "closed" }), open, thingW)).toEqual(["reopened"]);
    expect(changesOf(was, { ...open, conflict: true }, thingW)).toEqual(["conflict"]);
    expect(changesOf(fingerprint({ ...open, conflict: true }), open, ask)).toEqual([]);
    expect(changesOf(was, { ...open, head: "bbb" }, ask)).toEqual(["commits"]);
    expect(changesOf(was, { ...open, head: "bbb" }, { kind: "ask", direct: false })).toEqual([]);
    expect(changesOf(was, { ...open, head: "bbb" }, thingW)).toEqual([]);
    expect(changesOf(was, open, ask)).toEqual([]);
  });
});

describe("查 GitHub", () => {
  it("一批 25 个；仓库名、PR 号走变量，不拼进查询；查不到的是 null", async () => {
    const gh = fakeGitHub({ "acme/shop#1": { state: "MERGED", mergedAt: iso(T0) }, "acme/shop#2": { state: "OPEN", mergeable: "CONFLICTING", head: "bbb" } });
    const prs = ["acme/shop#1", "acme/shop#2", "acme/gone#3", ...Array.from({ length: 30 }, (_, i) => `acme/many#${i + 10}`)];
    const got = await queryPrs(gh.gql, prs, new AbortController().signal);
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[0]!.query).not.toMatch(/acme|shop/);
    expect(gh.calls[0]!.vars).toMatchObject({ o0: "acme", r0: "shop", n0: 1 });
    expect(got.get("acme/shop#1")).toMatchObject({ state: "merged", mergedAt: iso(T0) });
    expect(got.get("acme/shop#2")).toMatchObject({ state: "open", mergeable: "CONFLICTING", head: "bbb" });
    expect(got.get("acme/gone#3")).toBeNull();
  });
});

// 在临时数据目录里跑引擎：GitHub 开着，查 PR 用假的，通知收起来。
async function engine(gql: Gql) {
  write("sources.json", { github: true });
  const { Engine } = await import("../src/engine");
  const notes: string[] = [];
  const sent: number[] = [];
  const e = new Engine({ gql, notify: (title, body) => void notes.push(`${title}｜${body}`), send: async (r) => { sent.push(r.id); return { url: null }; } });
  return { e, notes, sent };
}

describe("引擎：提到的 PR 变了交给主会话", () => {
  it("开着时只记下；合了交一条 ref.changed，带上受影响的问题、回复、事情；每 10 分钟才查一次；交过的不再交", async () => {
    write("things.json", { nextThing: 2, nextAsk: 2, things: [thing(1, { keys: ["github.com/acme/shop/pull/12"], session: "local_s1" })], asks: [ask(1, 1, "带着评论 approve 吗？")] });
    write("replies.json", { nextId: 2, items: [ghReply(1, "acme/shop#12", { thing: 1 })] });
    const gh = fakeGitHub({ "acme/shop#12": { state: "OPEN" } });
    const { e } = await engine(gh.gql);
    await e.refTick(T0);
    expect(events()).toEqual([]);
    expect(read("refs.json")).toMatchObject({ prs: { "acme/shop#12": { state: "open", conflict: false } }, links: { a1: ["acme/shop#12"], r1: ["acme/shop#12"], t1: ["acme/shop#12"] } });
    // 没到 10 分钟：不查。
    gh.prs["acme/shop#12"] = { state: "MERGED", mergedAt: iso(T0 + MIN) };
    await e.refTick(T0 + 5 * MIN);
    expect(gh.calls).toHaveLength(1);
    expect(events()).toEqual([]);
    await e.refTick(T0 + 11 * MIN);
    const [ev] = events();
    expect(ev).toMatchObject({ source: "chief", kind: "ref.changed", why: ["merged"], keys: ["github.com/acme/shop/pull/12"], affected: { asks: [1], replies: [1], things: [1] } });
    expect(ev!.title).toContain("已合并");
    expect(ev!.text).toContain("开着的问题 #1");
    expect(ev!.text).toContain("待发出的回复 #1");
    expect(ev!.text).toContain("mark noted --thing 1");
    expect(read("refs.json").prs["acme/shop#12"].state).toBe("merged");
    // 再查一轮：没再变，不交。
    await e.refTick(T0 + 22 * MIN);
    expect(events()).toHaveLength(1);
  });

  it("PR 合了以后才登记的问题：第一次看到就交（问的多半是合之前的事）；事情不交", async () => {
    write("things.json", { nextThing: 2, nextAsk: 1, things: [thing(1, { keys: ["github.com/acme/shop/pull/12"] })], asks: [] });
    write("replies.json", { nextId: 1, items: [] });
    const gh = fakeGitHub({ "acme/shop#12": { state: "MERGED", mergedAt: iso(T0 - 3 * MIN) } });
    const { e } = await engine(gh.gql);
    await e.refTick(T0);
    expect(events()).toEqual([]);
    write("things.json", { nextThing: 2, nextAsk: 2, things: [thing(1, { keys: ["github.com/acme/shop/pull/12"] })], asks: [ask(1, 1, "带着评论 approve 吗？", { at: iso(T0 + MIN) })] });
    await e.refTick(T0 + 11 * MIN);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ kind: "ref.changed", affected: { asks: [1], replies: [], things: [1] } });
  });

  it("有冲突了、推了新提交：问题自己写着的 PR 推了新提交才算；查不到的 PR 一天内不再查", async () => {
    write("things.json", { nextThing: 2, nextAsk: 2, things: [thing(1)], asks: [ask(1, 1, "acme/shop#12（删 mini）要改完再 approve 吗？ acme/gone#1（旧的）")] });
    write("replies.json", { nextId: 1, items: [] });
    const gh = fakeGitHub({ "acme/shop#12": { state: "OPEN", head: "aaa" } });
    const { e } = await engine(gh.gql);
    await e.refTick(T0);
    expect(read("refs.json").missing["acme/gone#1"]).toBeTruthy();
    gh.prs["acme/shop#12"] = { state: "OPEN", head: "bbb", mergeable: "CONFLICTING" };
    await e.refTick(T0 + 11 * MIN);
    expect(events()[0]).toMatchObject({ why: ["conflict", "commits"] });
    // 查不到的那个没再查。
    expect(gh.calls[1]!.vars).not.toHaveProperty("r1");
  });

  it("GitHub 没开：不查", async () => {
    write("things.json", { nextThing: 2, nextAsk: 2, things: [thing(1)], asks: [ask(1, 1, "acme/shop#12（x）")] });
    const gh = fakeGitHub({});
    write("sources.json", { github: false });
    const { Engine } = await import("../src/engine");
    await new Engine({ gql: gh.gql }).refTick(T0);
    expect(gh.calls).toHaveLength(0);
  });
});

describe("引擎：稿子放久了", () => {
  it("待发出的回复放了 12 小时还没发：交一条 reply.stale，带上事情和会话；每条只交一次；测试消息的回复不算", async () => {
    write("things.json", { nextThing: 2, nextAsk: 2, things: [thing(1, { keys: ["slack:C1:1.0"], session: "local_s1" })], asks: [ask(1, 1, "这么回 Joe 行吗？", { reply: 1 })] });
    write("replies.json", { nextId: 4, items: [
      { ...ghReply(1, "acme/shop#12", { thing: 1, at: iso(T0 - 13 * HOUR) }), source: "slack", target: { channel: "C1", ts: "1.0" }, context: { who: "Joe", where: "#dev", said: "PR 合了吗", url: null } },
      { ...ghReply(2, "acme/shop#13", { at: iso(T0 - HOUR) }) },
      { ...ghReply(3, "acme/shop#14", { at: iso(T0 - 13 * HOUR) }), target: {} },
    ] });
    const { e } = await engine(fakeGitHub({}).gql);
    e["refs"].staleDrafts(T0);
    const ev = events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "reply.stale", source: "chief", keys: ["slack:C1:1.0", "local_s1"], affected: { asks: [1], replies: [1], things: [1] } });
    expect(ev[0]!.text).toContain("放了 12 小时还没发");
    expect(ev[0]!.text).toContain("mark noted --thing 1");
    e["refs"].staleDrafts(T0 + HOUR);
    expect(events()).toHaveLength(1);
    expect(defaultConfig()).toMatchObject({ refCheckMinutes: 10, staleDraftHours: 12 });
  });
});

describe("引擎：发到 GitHub 之前再查一次", () => {
  // 你在面板上点了发送、撤回期过了的样子。
  const confirmed = (r: Reply, at = iso(Date.now() - 1000)): Reply => ({ ...r, status: "queued", by: "you", sendAt: iso(Date.now() - 1000), confirm: { how: "panel", at, hash: replyHash(r) } });

  it("approve 已经合了的 PR：不发，标成没发出去，写明 PR 已合并", async () => {
    const r = { ...ghReply(1, "acme/shop#12"), kind: "approve" as const, body: "" };
    write("replies.json", { nextId: 2, items: [confirmed(r)] });
    const { e, notes, sent } = await engine(fakeGitHub({ "acme/shop#12": { state: "MERGED", mergedAt: iso(T0) } }).gql);
    await e.sendDue();
    expect(sent).toEqual([]);
    expect(read("replies.json").items[0]).toMatchObject({ status: "failed" });
    expect(read("replies.json").items[0].error).toMatch(/PR 已合并.*没 approve/);
    expect(notes.join()).toContain("PR 已合并");
  });

  it("往合了的 PR 上评论：退回待发出、注明 PR 已合并，挂着的问题重新打开；你看过再点发送就照发", async () => {
    write("things.json", { nextThing: 2, nextAsk: 2, things: [thing(1)], asks: [ask(1, 1, "这么回行吗？", { reply: 1, status: "answered", answer: "回复发了", closedAt: iso(T0) })] });
    write("replies.json", { nextId: 2, items: [confirmed(ghReply(1, "acme/shop#12", { thing: 1 }))] });
    const { e, sent } = await engine(fakeGitHub({ "acme/shop#12": { state: "MERGED", mergedAt: iso(T0) } }).gql);
    await e.sendDue();
    expect(sent).toEqual([]);
    const back = read("replies.json").items[0] as Reply;
    expect(back).toMatchObject({ status: "pending", prState: { ref: "acme/shop#12", state: "merged" } });
    expect(back.by).toBeUndefined();
    expect(back.confirm).toBeUndefined();
    expect(read("things.json").asks[0]).toMatchObject({ status: "open" });
    // 你看过「PR 已合并」又点了发送：照发。
    const later = iso(Date.parse(back.prState!.at) + 1000);
    write("replies.json", { nextId: 2, items: [{ ...confirmed(back, later), prState: back.prState }] });
    await e.sendDue();
    expect(sent).toEqual([1]);
    expect(read("replies.json").items[0]).toMatchObject({ status: "sent" });
  });

  it("做事方式 yolo：闸门放行的回复、approve，PR 合了照样拦下、退回", async () => {
    write("rules.json", { mode: "yolo" });
    const ev = { id: 1, at: iso(T0), source: "github", kind: "github.pr", title: "acme/shop#12 删 mini", url: "https://github.com/acme/shop/pull/12", from: null, text: "PR acme/shop#12 请你 review", why: ["review"], keys: ["github.com/acme/shop/pull/12"], reply: { ref: "acme/shop#12" } };
    writeFileSync(join(h, "events.jsonl"), `${JSON.stringify(ev)}\n`);
    write("state.json", { nextId: 2 });
    const due = { status: "queued", by: "policy", sendAt: iso(Date.now() - 1000) };
    write("replies.json", { nextId: 3, items: [
      { ...ghReply(1, "acme/shop#12"), ...due },
      { ...ghReply(2, "acme/shop#12"), kind: "approve", body: "", ...due },
    ] });
    const { e, sent } = await engine(fakeGitHub({ "acme/shop#12": { state: "MERGED", mergedAt: iso(T0) } }).gql);
    await e.sendDue();
    expect(sent).toEqual([]);
    const [reply, approve] = read("replies.json").items as Reply[];
    expect(reply).toMatchObject({ status: "pending", prState: { state: "merged" } });
    expect(approve).toMatchObject({ status: "failed" });
    expect(approve!.error).toMatch(/PR 已合并/);
  });

  it("规矩直接发的：PR 合了永远退回；PR 开着、不是 GitHub 的照发", async () => {
    const gh = fakeGitHub({ "acme/shop#12": { state: "MERGED", mergedAt: iso(T0) }, "acme/shop#13": { state: "OPEN" } });
    const w = new RefWatch({ gql: () => gh.gql, emit: () => true, log: () => {} });
    const bounced = { ...ghReply(1, "acme/shop#12"), by: "policy" as const, prState: { ref: "acme/shop#12", state: "merged" as const, at: iso(T0) }, confirm: { how: "panel" as const, at: iso(T0 + MIN) } };
    expect(await w.beforeSend(bounced, T0 + 2 * MIN)).toMatchObject({ kind: "bounce" });
    expect(await w.beforeSend({ ...ghReply(2, "acme/shop#13"), by: "policy" }, T0)).toBeNull();
    expect(await w.beforeSend({ ...ghReply(3, "acme/shop#12"), source: "slack", target: { channel: "C1", ts: "1.0" } }, T0)).toBeNull();
    // 查不成（gh 出错）：照发，真发的时候 gh 会自己报错。
    const broken = new RefWatch({ gql: () => async () => { throw new Error("gh 出错了"); }, emit: () => true, log: () => {} });
    expect(await broken.beforeSend(ghReply(4, "acme/shop#12"), T0)).toBeNull();
  });
});
