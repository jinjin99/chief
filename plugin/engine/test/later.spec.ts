// 稍后再说、撤回、找以前的事。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUntil } from "../src/snooze";
import { snippetOf } from "../src/commands/search";
import { recordSkip } from "../src/undo";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "chief-later-"));
}

function chief(h: string, input: string | null, ...args: string[]): string {
  return execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", ...(input === null ? {} : { input }), stdio: ["pipe", "pipe", "pipe"] });
}

function chiefFails(h: string, ...args: string[]): string {
  try {
    chief(h, null, ...args);
  } catch (error) {
    return String((error as { stderr?: string }).stderr);
  }
  throw new Error("没失败");
}

const json = (h: string, f: string) => JSON.parse(readFileSync(join(h, f), "utf8"));
const lines = (h: string, f: string) => readFileSync(join(h, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const ev = (id: number, over: Record<string, unknown> = {}) => ({ id, at: new Date().toISOString(), source: "slack", kind: "message.received", title: `#dev`, url: null, from: "Carol", text: `消息 ${id}`, why: ["mention"], keys: [`slack:C1:${id}.0`], reply: {}, ...over });

function withEvents(h: string, n: number): void {
  writeFileSync(join(h, "events.jsonl"), `${Array.from({ length: n }, (_, i) => JSON.stringify(ev(i + 1))).join("\n")}\n`);
  writeFileSync(join(h, "state.json"), JSON.stringify({ nextId: n + 1 }));
}

describe("稍后再说：时间的写法", () => {
  // 2026-11-23 是周一，下午两点（本机时区）。
  const now = new Date(2026, 10, 23, 14, 0, 0);
  const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

  it("相对时间、明天、下周几、日期都认；过去的、看不懂的不认", () => {
    expect(parseUntil("2h", now)!.getTime()).toBe(now.getTime() + 2 * 3600_000);
    expect(parseUntil("30m", now)!.getTime()).toBe(now.getTime() + 30 * 60_000);
    expect(parseUntil("1d", now)!.getTime()).toBe(now.getTime() + 86_400_000);
    expect(parseUntil("2小时", now)!.getTime()).toBe(now.getTime() + 2 * 3600_000);
    expect(parseUntil("tomorrow 09:00", now)!.getTime()).toBe(at(2026, 11, 24));
    expect(parseUntil("tomorrow", now)!.getTime()).toBe(at(2026, 11, 24));
    expect(parseUntil("明天9点", now)!.getTime()).toBe(at(2026, 11, 24));
    expect(parseUntil("明天下午3点半", now)!.getTime()).toBe(at(2026, 11, 24, 15, 30));
    expect(parseUntil("今天 18:00", now)!.getTime()).toBe(at(2026, 11, 23, 18));
    expect(parseUntil("后天", now)!.getTime()).toBe(at(2026, 11, 25));
    // 今天是周一：「下周一」是下个礼拜的周一，「周五」是这周五，「周一」已经过了 9 点，算下周一。
    expect(parseUntil("下周一", now)!.getTime()).toBe(at(2026, 11, 30));
    expect(parseUntil("下周三下午2点", now)!.getTime()).toBe(at(2026, 12, 2, 14));
    expect(parseUntil("周五", now)!.getTime()).toBe(at(2026, 11, 27));
    expect(parseUntil("周一", now)!.getTime()).toBe(at(2026, 11, 30));
    expect(parseUntil("next monday 09:00", now)!.getTime()).toBe(at(2026, 11, 30));
    expect(parseUntil("friday 3pm", now)!.getTime()).toBe(at(2026, 11, 27, 15));
    // 周日说「下周一」是明天。
    expect(parseUntil("下周一", new Date(2026, 10, 29, 10))!.getTime()).toBe(at(2026, 11, 30));
    expect(parseUntil("2026-11-30", now)!.getTime()).toBe(at(2026, 11, 30));
    expect(parseUntil("2026-11-30 15:00", now)!.getTime()).toBe(at(2026, 11, 30, 15));
    expect(parseUntil("2026-11-30T15:00:00Z", now)!.toISOString()).toBe("2026-11-30T15:00:00.000Z");
    expect(parseUntil("今天 9:00", now)).toBeNull();
    expect(parseUntil("2026-01-01", now)).toBeNull();
    expect(parseUntil("等他回了再说", now)).toBeNull();
    expect(parseUntil("明天 25:00", now)).toBeNull();
    expect(parseUntil("0h", now)).toBeNull();
  });
});

describe("稍后再说", () => {
  it("收起、提前拿出来；办完的不收；来了新问题自己拿出来", () => {
    const h = home();
    chief(h, "在压测", "thing", "add", "--title", "PROJ-123 压测", "--session", "local_abc", "--key", "PROJ-123");
    const out = JSON.parse(chief(h, null, "thing", "snooze", "1", "--until", "2h"));
    expect(out.id).toBe(1);
    const t = json(h, "things.json").things[0];
    expect(Date.parse(t.snooze.until) - Date.now()).toBeGreaterThan(3600_000);
    // 状态不变，只是收起来。
    expect(t.status).toBe("doing");
    expect(t.log.at(-1).text).toMatch(/^稍后再说：/);
    expect(chiefFails(h, "thing", "snooze", "1", "--until", "昨天")).toMatch(/--until 看不懂，或者不在以后/);
    expect(chiefFails(h, "thing", "snooze", "1")).toMatch(/要 --until/);
    chief(h, null, "thing", "wake", "1");
    expect(json(h, "things.json").things[0].snooze).toBeUndefined();
    expect(chiefFails(h, "thing", "wake", "1")).toMatch(/没有在稍后再说/);

    chief(h, null, "thing", "snooze", "1", "--until", "1d");
    chief(h, JSON.stringify({ question: "要不要加机器？", suggest: "加两台" }), "ask", "add", "--thing", "1");
    expect(json(h, "things.json").things[0]).toMatchObject({ status: "waiting_you" });
    expect(json(h, "things.json").things[0].snooze).toBeUndefined();

    chief(h, null, "thing", "snooze", "1", "--until", "1d");
    chief(h, "做完了", "thing", "update", "1", "--status", "done");
    expect(json(h, "things.json").things[0].snooze).toBeUndefined();
    expect(chiefFails(h, "thing", "snooze", "1", "--until", "1d")).toMatch(/已经办完了/);
  });

  it("引擎到点叫醒：去掉 snooze、弹通知、交给主会话一条 thing.woke；没到点的不动、不写文件", async () => {
    const h = home();
    chief(h, "在压测", "thing", "add", "--title", "PROJ-123 压测", "--session", "local_abc", "--key", "PROJ-123");
    chief(h, "等人", "thing", "add", "--title", "o/r#3 review");
    chief(h, null, "thing", "snooze", "1", "--until", "1h");
    chief(h, null, "thing", "snooze", "2", "--until", "3d");
    const before = process.env.CHIEF_HOME;
    process.env.CHIEF_HOME = h;
    try {
      const { Engine } = await import("../src/engine");
      const notes: string[] = [];
      const e = new Engine({ notify: (title, body) => void notes.push(`${title}｜${body}`) });
      const mtime = readFileSync(join(h, "things.json"), "utf8");
      e.wakeSnoozed(Date.now());
      expect(notes).toEqual([]);
      expect(readFileSync(join(h, "things.json"), "utf8")).toBe(mtime);
      e.wakeSnoozed(Date.now() + 2 * 3600_000);
      expect(notes).toEqual(["chief · 稍后再说的事到点了｜PROJ-123 压测"]);
      const things = json(h, "things.json").things;
      expect(things[0].snooze).toBeUndefined();
      expect(things[0].status).toBe("doing");
      expect(things[1].snooze).toBeTruthy();
      const woke = lines(h, "events.jsonl").at(-1);
      expect(woke).toMatchObject({ kind: "thing.woke", source: "session", keys: ["PROJ-123", "local_abc"] });
      expect(woke.text).toContain("mark noted --thing 1");
      // 主会话照常收到这条。
      expect(chief(h, null, "events", "--after", "0")).toContain("thing.woke");
      // 叫醒过的不再叫第二次。
      e.wakeSnoozed(Date.now() + 2 * 3600_000);
      expect(notes).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.CHIEF_HOME;
      else process.env.CHIEF_HOME = before;
    }
  });
});

describe("撤回", () => {
  it("撤回不做了：一起撤掉的问题回来接着等你定，之前就关了的不动", () => {
    const h = home();
    chief(h, "", "thing", "add", "--title", "运费卡片");
    chief(h, JSON.stringify({ question: "SDK 谁来写？", suggest: "我们写" }), "ask", "add", "--thing", "1");
    chief(h, JSON.stringify({ question: "要不要问设计稿？", suggest: "问" }), "ask", "add", "--thing", "1");
    chief(h, "对方回了", "ask", "withdraw", "2");
    chief(h, "", "thing", "update", "1", "--status", "dropped");
    expect(json(h, "things.json").asks.map((a: { status: string }) => a.status)).toEqual(["withdrawn", "withdrawn"]);
    chief(h, null, "undo");
    const t = json(h, "things.json");
    expect(t.things[0].status).toBe("waiting_you");
    expect(t.asks[0]).toMatchObject({ status: "open" });
    expect(t.asks[0].reason).toBeUndefined();
    expect(t.asks[1]).toMatchObject({ status: "withdrawn", reason: "对方回了" });
  });

  it("不做了：撤回回到原来的状态，告诉主会话让会话接着做；撤过的不能再撤；后来又动过的撤不回", () => {
    const h = home();
    chief(h, "在压测", "thing", "add", "--title", "PROJ-123 压测", "--session", "local_abc", "--status", "waiting_others");
    chief(h, "用户说不做了", "thing", "update", "1", "--status", "dropped");
    const list = JSON.parse(chief(h, null, "undo", "--list"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "drop", label: "不做了：PROJ-123 压测", thing: { id: 1, status: "waiting_others" } });
    expect(chief(h, null, "undo")).toContain("接着做了");
    expect(json(h, "things.json").things[0].status).toBe("waiting_others");
    const told = lines(h, "events.jsonl").at(-1);
    expect(told).toMatchObject({ kind: "chief.undo", why: ["undo"] });
    expect(told.text).toContain("local_abc");
    expect(chiefFails(h, "undo", "1")).toMatch(/已经撤回过了/);
    expect(chiefFails(h, "undo")).toMatch(/没有能撤回的/);

    chief(h, "又不做了", "thing", "update", "1", "--status", "dropped");
    chief(h, "其实做完了", "thing", "update", "1", "--status", "done");
    expect(chiefFails(h, "undo")).toMatch(/现在不是「不做了」/);
    expect(chiefFails(h, "undo", "99")).toMatch(/没有这一笔/);
  });

  it("只记下 / 忽略：撤回后消息重新算没判断、判断记录拿掉、记到事情上的拿掉，重新交给主会话；派出去的不记", () => {
    const h = home();
    withEvents(h, 3);
    chief(h, "x", "thing", "add", "--title", "PROJ-123 压测");
    chief(h, "只是闲聊", "mark", "1", "2", "ignored", "--thing", "1");
    chief(h, "送进了压测会话", "mark", "3", "forwarded", "--session", "local_abc");
    const list = JSON.parse(chief(h, null, "undo", "--list"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "mark", label: "忽略：#dev（Carol） 等 2 条" });
    expect(json(h, "things.json").things[0].events).toEqual([1, 2]);

    chief(h, null, "undo", String(list[0].id));
    const d = json(h, "dispatch.json");
    expect(d[1]).toBeUndefined();
    expect(d[2]).toBeUndefined();
    expect(d[3]).toMatchObject({ status: "forwarded" });
    expect(lines(h, "decisions.jsonl").map((x) => x.event)).toEqual([3]);
    expect(json(h, "things.json").things[0].events).toEqual([]);
    const told = lines(h, "events.jsonl").at(-1);
    expect(told).toMatchObject({ id: 4, kind: "chief.undo", source: "slack" });
    expect(told.text).toContain("#1、#2");
    // 主会话重新收到：撤回的两条和这条提醒（events 只打没判断的）。
    expect(chief(h, null, "events", "--after", "0").trim().split("\n").map((l) => JSON.parse(l).id)).toEqual([1, 2, 4]);
    // 重新判断了，再标一次照常能标。
    chief(h, "其实要记下", "mark", "1", "2", "noted");
    expect(json(h, "dispatch.json")[1]).toMatchObject({ status: "noted" });
  });

  it("--force 改过的判断：撤回改回原来的判断，不重新交", () => {
    const h = home();
    withEvents(h, 1);
    chief(h, "派出去了", "mark", "1", "forwarded", "--session", "local_abc");
    chief(h, "其实不用管", "mark", "1", "ignored", "--force");
    chief(h, null, "undo");
    expect(json(h, "dispatch.json")[1]).toMatchObject({ status: "forwarded", session: "local_abc" });
    expect(lines(h, "events.jsonl")).toHaveLength(1);
    expect(lines(h, "decisions.jsonl").map((x) => x.verdict)).toEqual(["forwarded"]);
  });

  it("跳过积下的：撤回后全部重新算没判断，交给主会话一条提醒，告诉它从哪开始看；后来判断过的不动", () => {
    const h = home();
    withEvents(h, 5);
    chief(h, "送进了会话", "mark", "2", "forwarded", "--session", "local_abc");
    chief(h, null, "mark", "--upto", "5", "ignored");
    const list = JSON.parse(chief(h, null, "undo", "--list"));
    expect(list[0]).toMatchObject({ kind: "skip", label: "跳过积下的 4 条旧消息" });
    // 跳过以后主会话又改判了一条：撤回时它不动。
    chief(h, "其实要记下", "mark", "5", "noted", "--force");
    expect(chief(h, null, "undo", String(list[0].id))).toContain("3 条旧消息重新交给主会话了");
    const d = json(h, "dispatch.json");
    expect(Object.keys(d).sort()).toEqual(["2", "5"]);
    const told = lines(h, "events.jsonl").at(-1);
    expect(told.text).toContain("chief events --after 0");
    expect(told.text).toContain("#1 到 #4");
    expect(chief(h, null, "events", "--after", "0").trim().split("\n").map((l) => JSON.parse(l).id)).toEqual([1, 3, 4, 6]);
  });

  it("只留最近 50 笔；undo.json 带格式版本", () => {
    const h = home();
    const before = process.env.CHIEF_HOME;
    process.env.CHIEF_HOME = h;
    try {
      for (let i = 1; i <= 55; i++) recordSkip(new Date().toISOString(), [i]);
    } finally {
      process.env.CHIEF_HOME = before;
    }
    const u = json(h, "undo.json");
    expect(u.version).toBe(1);
    expect(u.items).toHaveLength(50);
    expect(u.items[0].id).toBe(6);
    expect(u.nextId).toBe(56);
  });
});

describe("找以前的事", () => {
  it("按字面找，不分大小写：事情、问题、回复、消息、判断，现在的和归档的都找；按种类、条数筛", () => {
    const h = home();
    const old = "2026-10-01T00:00:00.000Z";
    writeFileSync(join(h, "events.jsonl"), `${[
      JSON.stringify(ev(1, { text: "Payment 回调超时了，能看下吗", url: "https://acme.slack.com/archives/C1/p1" })),
      JSON.stringify(ev(2, { kind: "chief.missed", text: "漏掉了 payment" })),
      JSON.stringify(ev(3, { text: "payment 演练", dryrun: true })),
    ].join("\n")}\n`);
    writeFileSync(join(h, "state.json"), JSON.stringify({ nextId: 4 }));
    chief(h, "在查 payment 回调", "thing", "add", "--title", "PROJ-123 支付回调", "--session", "local_abc");
    chief(h, JSON.stringify({ result: "[PR](https://github.com/acme/shop/pull/12)" }), "thing", "update", "1");
    chief(h, JSON.stringify({ question: "Payment 回调要不要重试？", suggest: "重试三次" }), "ask", "add", "--thing", "1");
    chief(h, "Carol 问 payment 回调，送进了会话", "mark", "1", "forwarded", "--session", "local_abc", "--thing", "1");
    mkdirSync(join(h, "archive"));
    writeFileSync(join(h, "archive", "things-2026-10.jsonl"), `${JSON.stringify({ id: 9, title: "旧的 PAYMENT 迁移", status: "done", progress: "迁完了", events: [], updatedAt: old, log: [] })}\n`);
    writeFileSync(join(h, "archive", "replies-2026-10.jsonl"), `${JSON.stringify({ id: 4, event: 7, source: "slack", target: {}, context: { who: "Bob", where: "私信", said: "迁移好了吗", url: null }, body: "payment 迁移做完了", status: "sent", sentAt: old, at: old })}\n`);

    const hits = chief(h, null, "search", "payment").trim().split("\n").map((l) => JSON.parse(l));
    const kinds = hits.map((x) => `${x.kind}:${x.id}`);
    expect(kinds).toEqual(expect.arrayContaining(["thing:1", "ask:1", "event:1", "decision:1", "thing:9", "reply:4"]));
    // chief 自己的提醒、演练消息不算。
    expect(kinds).not.toContain("event:2");
    expect(kinds).not.toContain("event:3");
    // 新的在前，归档的在后、标着 archived。
    expect(hits.at(-1)).toMatchObject({ archived: true });
    const thing = hits.find((x) => x.kind === "thing" && x.id === 1);
    expect(thing).toMatchObject({ title: "PROJ-123 支付回调", session: "local_abc", url: "https://github.com/acme/shop/pull/12" });
    expect(hits.find((x) => x.kind === "event")).toMatchObject({ url: "https://acme.slack.com/archives/C1/p1", snippet: "Payment 回调超时了，能看下吗" });
    expect(hits.find((x) => x.kind === "reply")).toMatchObject({ title: "回 Bob", snippet: "payment 迁移做完了" });

    const only = chief(h, null, "search", "PAYMENT", "--kind", "thing").trim().split("\n").map((l) => JSON.parse(l));
    expect(only.map((x) => x.id)).toEqual([1, 9]);
    expect(chief(h, null, "search", "payment", "--limit", "2").trim().split("\n")).toHaveLength(2);
    expect(chief(h, null, "search", "没有这个字")).toBe("");
    expect(chiefFails(h, "search", "x", "--kind", "file")).toMatch(/--kind 是/);
    expect(chiefFails(h, "search")).toMatch(/要找的字/);
  });

  it("摘一段：前后留一点，太长的加省略号", () => {
    expect(snippetOf("短的 payment", "payment")).toBe("短的 payment");
    const long = `${"前".repeat(50)}payment${"后".repeat(200)}`;
    const s = snippetOf(long, "payment")!;
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("payment");
    expect(snippetOf("没有", "payment")).toBeNull();
  });
});

describe("新的「要你定」弹通知", () => {
  it("首轮已有的不弹；后来新增的弹一次；回答后不再弹", async () => {
    const h = home();
    chief(h, "在压测", "thing", "add", "--title", "PROJ-123 压测");
    const ask = (q: string) => chief(h, JSON.stringify({ question: q, suggest: "好" }), "ask", "add", "--thing", "1").trim();
    ask("旧问题？");
    const before = process.env.CHIEF_HOME;
    process.env.CHIEF_HOME = h;
    try {
      const { Engine } = await import("../src/engine");
      const notes: string[] = [];
      const e = new Engine({ notify: (title, body) => void notes.push(`${title}｜${body}`) });
      e.notifyNewAsks();
      expect(notes).toEqual([]);
      const id = ask("先上 2.0 吗？");
      e.notifyNewAsks();
      e.notifyNewAsks();
      expect(notes).toEqual(["chief · 有事要你定｜先上 2.0 吗？"]);
      chief(h, "上", "ask", "answer", id);
      e.notifyNewAsks();
      expect(notes).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.CHIEF_HOME;
      else process.env.CHIEF_HOME = before;
    }
  });
});
