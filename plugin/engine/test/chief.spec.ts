import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { eventOfItem, eventOfSlack, hubDown, missedEvents } from "../src/engine";
import { keysOf } from "../src/keys";
import { parsePermalink } from "../src/slack/people";
import { describeSendError } from "../src/slack/plugin";
import type { InboundMessage } from "../src/slack/types";
import { paths, workspaceDir } from "../src/store";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "chief-test-"));
}

function chief(h: string, ...args: string[]): string {
  return execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8" });
}

// 「以你的名义发」要钥匙：测试里配一把，面板点发送就是带着它 confirm。
const KEY = "ab".repeat(32);
function withStdin(h: string, input: string, ...args: string[]): string {
  return execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function sendByYou(h: string, id: string): string {
  try {
    withStdin(h, KEY, "key", "set");
  } catch {
    // 已经配过
  }
  return withStdin(h, JSON.stringify({ key: KEY, how: "panel" }), "reply", "confirm", id);
}

// 你在面板上改规矩：带钥匙（chief rules --yours），放宽发送的也直接生效。
function yours(h: string, input: string, ...args: string[]): string {
  try {
    withStdin(h, KEY, "key", "set");
  } catch {
    // 已经配过
  }
  return withStdin(h, JSON.stringify({ key: KEY, text: input }), "rules", "--yours", ...args);
}

// 在终端里跑 chief key reset，敲进 typed：用 Python 的 pty 给它一个假终端。
function resetInTerminal(h: string, typed: string): string {
  return execFileSync("python3", ["-c", "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)", process.execPath, "--import", TSX, CLI, "key", "reset"], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input: `${typed}\n`, stdio: ["pipe", "pipe", "pipe"] });
}

function sendByYouFails(h: string, id: string): string {
  try {
    sendByYou(h, id);
  } catch (error) {
    return String((error as { stderr?: string }).stderr);
  }
  throw new Error("没失败");
}

function chiefFails(h: string, ...args: string[]): string {
  try {
    chief(h, ...args);
  } catch (error) {
    return String((error as { stderr?: string }).stderr);
  }
  throw new Error("没失败");
}

const slackMsg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "slack", deliveryId: "C1:1.0:created", kind: "message.received", role: "message", relevance: "mention",
  conversation: { key: "slack:C1", threadKey: "slack:C1:1.0", label: "#dev", audience: "channel" },
  sender: { id: "U1", name: "Carol", bot: false },
  text: "看下 https://github.com/acme/shop/pull/12 和 PROJ-479，UTF-8 不算",
  occurredAt: "2026-11-19T00:00:00.000Z", replyTarget: { channel: "C1", ts: "1.0" }, ...over,
});

describe("keys", () => {
  it("认出 PR、工单号、Notion 页面，跳过 UTF-8 这种", () => {
    expect(keysOf("https://github.com/acme/shop/pull/12 PROJ-479 UTF-8 https://www.notion.so/x-0123456789abcdef0123456789abcdef"))
      .toEqual(["github.com/acme/shop/pull/12", "PROJ-479", "notion:0123456789abcdef0123456789abcdef"]);
  });
});

describe("events", () => {
  it("Slack：@ 你的交出去，键里有 thread、PR、工单", () => {
    const e = eventOfSlack(slackMsg());
    expect(e?.keys).toEqual(["slack:C1:1.0", "github.com/acme/shop/pull/12", "PROJ-479"]);
    expect(e?.reply).toEqual({ channel: "C1", ts: "1.0", audience: "channel" });
  });
  it("Slack：你自己说的、机器人、改动不交", () => {
    expect(eventOfSlack(slackMsg({ role: "self", relevance: null }))).toBeNull();
    expect(eventOfSlack(slackMsg({ sender: { id: "B", name: "bot", bot: true } }))).toBeNull();
    expect(eventOfSlack(slackMsg({ kind: "message.edited" }))).toBeNull();
  });
  it("外部来源：只交有人找你的", () => {
    const item = { externalId: "x", kind: "github.pr", title: "acme/shop#12 加字段 PROJ-479", url: "https://github.com/acme/shop/pull/12", summary: "s", at: "t", payload: { repo: "acme/shop", number: 12 }, mine: true };
    expect(eventOfItem("github", { ...item, asks: [] })).toBeNull();
    const e = eventOfItem("github", { ...item, asks: ["review"] });
    expect(e?.keys).toEqual(["github.com/acme/shop/pull/12", "PROJ-479"]);
    expect(e?.reply).toEqual({ ref: "acme/shop#12" });
    expect(eventOfItem("jira", { ...item, kind: "jira.issue", payload: { key: "PROJ-479" }, asks: ["assigned"] })?.keys[0]).toBe("PROJ-479");
  });
});

describe("cli", () => {
  const event = (id: number) => JSON.stringify({ id, at: "t", source: "github", kind: "github.pr", title: "x", url: null, from: null, text: "第一行\n第二行", why: ["mention"], keys: ["PROJ-1"], reply: { ref: "o/r#1" } });

  it("events --after 只打新的，一条一行", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${event(1)}\n${event(2)}\n`);
    const out = chief(h, "events", "--after", "1").trim().split("\n");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).id).toBe(2);
  });

  it("events --follow 等到新追加的", async () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${event(1)}\n`);
    const child = spawn(process.execPath, ["--import", TSX, CLI, "events", "--after", "1", "--follow"], { env: { ...process.env, CHIEF_HOME: h } });
    const got = new Promise<string>((done) => child.stdout.on("data", (d: Buffer) => done(d.toString())));
    setTimeout(() => writeFileSync(join(h, "events.jsonl"), `${event(1)}\n${event(2)}\n`), 500);
    const line = await got;
    child.kill();
    expect(JSON.parse(line.trim()).id).toBe(2);
  }, 10_000);

  it("对应表和进度", () => {
    const h = home();
    chief(h, "route", "set", "--session", "local_abc-1", "--title", "PROJ-1 接口", "PROJ-1", "slack:C1:1.0");
    expect(JSON.parse(chief(h, "route", "get", "PROJ-1", "PROJ-2"))).toMatchObject({ "PROJ-1": { session: "local_abc-1" } });
    expect(chiefFails(h, "route", "set", "--session", "a b", "PROJ-1")).toContain("会话编号");
    chief(h, "cursor", "7");
    expect(chief(h, "cursor").trim()).toBe("7");
  });

  it("回复只认 drafts 里的文件；发送要排队，5 秒内能撤回；改过的留着原稿", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${JSON.stringify({ ...JSON.parse(event(1)), source: "slack", from: "Carol", title: "#dev", why: ["dm"], reply: { channel: "D1", ts: "1.0" } })}\n`);
    const outside = join(h, "x.md");
    writeFileSync(outside, "hi");
    expect(chiefFails(h, "reply", "add", "--event", "1", "--file", outside)).toContain("drafts");
    expect(chiefFails(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "..", "x.md"))).toContain("drafts");
    writeFileSync(join(h, "drafts", "1.md"), "好的，我来看");
    expect(JSON.parse(chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "1.md")))).toMatchObject({ id: 1, source: "slack", scenario: "slack_dm", policy: "ask" });
    execFileSync(process.execPath, ["--import", TSX, CLI, "reply", "edit", "1"], { env: { ...process.env, CHIEF_HOME: h }, input: "好的，下午看" });
    sendByYou(h, "1");
    let r = JSON.parse(chief(h, "reply", "list"))[0];
    expect(r).toMatchObject({ status: "queued", by: "you", body: "好的，下午看", original: "好的，我来看", context: { who: "Carol", where: "#dev" } });
    chief(h, "reply", "undo", "1");
    r = JSON.parse(chief(h, "reply", "list"))[0];
    expect(r.status).toBe("pending");
    chief(h, "reply", "drop", "1");
    expect(sendByYouFails(h, "1")).toContain("dropped");
  });
});

describe("事情和要你定的", () => {
  function chiefIn(h: string, input: string, ...args: string[]): string {
    return execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input });
  }

  it("同一段私信里还开着的问题，跟着对方的下一条消息一起交给主会话", () => {
    const h = home();
    chief(h, "cursor");
    const dm = (id: number, text: string) => JSON.stringify({ id, at: "t", source: "slack", kind: "slack.message", title: "私信", url: null, from: "Dave", fromId: "U9", text, why: ["dm"], keys: [`slack:D1:${id}.0`], reply: { channel: "D1", ts: `${id}.0` } });
    writeFileSync(join(h, "events.jsonl"), `${dm(1, "现在方便 huddle 吗")}\n`);
    chiefIn(h, "", "thing", "add", "--title", "报表迁移", "--status", "waiting_you");
    chiefIn(h, "Dave 要 huddle，只有你能答", "mark", "1", "asked", "--thing", "1");
    chiefIn(h, JSON.stringify({ question: "Dave 问方不方便 huddle", suggest: "约个时间" }), "ask", "add", "--thing", "1");
    // mark --thing 把消息记到事情上。
    expect(JSON.parse(chief(h, "thing", "list"))[0].events).toEqual([1]);
    writeFileSync(join(h, "events.jsonl"), `${dm(1, "现在方便 huddle 吗")}\n${dm(2, "是的，那我跟他说吧")}\n`);
    const line = JSON.parse(chief(h, "events", "--after", "1").trim());
    expect(line.related.things).toMatchObject([{ id: 1, title: "报表迁移" }]);
    expect(line.related.asks).toMatchObject([{ id: 1, question: "Dave 问方不方便 huddle" }]);
  });

  it("记事情、问你、你答了回到进行中；文字只从标准输入进", () => {
    const h = home();
    const id = chiefIn(h, "开了会话在看代码", "thing", "add", "--title", "PROJ-479 接口加字段", "--session", "local_x").trim();
    expect(id).toBe("1");
    expect(chiefIn(h, JSON.stringify({ question: "Joe 问能不能本周上线", suggest: "回复：下周二" }), "ask", "add", "--thing", "1").trim()).toBe("1");
    let b = JSON.parse(chief(h, "board"));
    expect(b).toMatchObject({ asks: 1, live: 1 });
    expect(JSON.parse(chief(h, "ask", "list"))[0]).toMatchObject({ question: "Joe 问能不能本周上线" });
    expect(JSON.parse(chiefIn(h, "我来回，说下周三", "ask", "answer", "1"))).toMatchObject({ thing: 1, session: "local_x" });
    chiefIn(h, "改完了，PR 草稿已开", "thing", "update", "1", "--status", "done");
    b = JSON.parse(chief(h, "board"));
    expect(b).toMatchObject({ asks: 0, live: 0 });
    expect(JSON.parse(chief(h, "thing", "list", "--all"))[0]).toMatchObject({ id: 1, status: "done", progress: "改完了，PR 草稿已开" });
    expect(chiefFails(h, "thing", "update", "1", "--status", "bogus")).toContain("--status");
  });

  it("要你定一问一件；不用问了、撤掉、撤回回答；事情办完开着的问题自动撤掉", () => {
    const h = home();
    chiefIn(h, "", "thing", "add", "--title", "运费卡片", "--session", "local_x");
    const failsIn = (input: string, ...args: string[]) => {
      try {
        chiefIn(h, input, ...args);
      } catch (e) {
        return String((e as { stderr?: string }).stderr);
      }
      throw new Error("该失败没失败");
    };
    // 一个问题里列了几问：挡回去，要分开问。「1.0 还是 2.0」不算列了几问。
    expect(failsIn(JSON.stringify({ question: "三件事要你定：1. SDK 谁来写？2. 1.0 要不要一起改？", suggest: "" }), "ask", "add", "--thing", "1")).toMatch(/一个问题只问一件事/);
    expect(chiefIn(h, JSON.stringify({ question: "先改 1.0 还是 2.0？", suggest: "先改 2.0" }), "ask", "add", "--thing", "1").trim()).toBe("1");
    chiefIn(h, JSON.stringify({ question: "SDK 谁来写？", suggest: "我们写" }), "ask", "add", "--thing", "1");
    chiefIn(h, JSON.stringify({ question: "要不要问设计稿？", suggest: "顺口问一句" }), "ask", "add", "--thing", "1");
    expect(JSON.parse(chief(h, "ask", "list", "--thing", "1"))).toHaveLength(3);
    // 你说不用问了；主会话撤掉一个不成立的（要写为什么）。
    expect(JSON.parse(chief(h, "ask", "dismiss", "2"))).toMatchObject({ ask: 2, thing: 1 });
    expect(failsIn("", "ask", "withdraw", "3")).toMatch(/为什么撤掉/);
    chiefIn(h, "对方已经回了", "ask", "withdraw", "3");
    expect(failsIn("", "ask", "dismiss", "3")).toMatch(/已经关了/);
    let asks = JSON.parse(readFileSync(join(h, "things.json"), "utf8")).asks;
    expect(asks[1]).toMatchObject({ status: "dismissed" });
    expect(asks[2]).toMatchObject({ status: "withdrawn", reason: "对方已经回了" });
    expect(asks[2].closedAt).toBeTruthy();
    // 答了最后一个开着的：事情回到在做；撤回回答：又回到等你定。
    chiefIn(h, "照建议办", "ask", "answer", "1");
    expect(JSON.parse(chief(h, "thing", "list"))[0].status).toBe("doing");
    expect(JSON.parse(chief(h, "ask", "reopen", "1"))).toMatchObject({ ask: 1, was: "照建议办" });
    expect(JSON.parse(chief(h, "thing", "list"))[0].status).toBe("waiting_you");
    expect(failsIn("", "ask", "reopen", "3")).toMatch(/不是你答过的/);
    // 事情办完：还开着的问题撤掉，写上原因。
    chiefIn(h, "做完了", "thing", "update", "1", "--status", "done");
    asks = JSON.parse(readFileSync(join(h, "things.json"), "utf8")).asks;
    expect(asks[0]).toMatchObject({ status: "withdrawn", reason: "这件事办完了" });
    expect(failsIn("", "ask", "reopen", "2")).toMatch(/办完了/);
  });

  it("问题挂着的回复发了 / 不发了 / 让它重写：问题跟着关；撤回发送问题回来；approve 发了只为它记的事情就办完", () => {
    const h = home();
    chief(h, "cursor");
    const dm = (id: number, text: string) => JSON.stringify({ id, at: "t", source: "slack", kind: "slack.message", title: "私信", url: null, from: "Alex", fromId: "U9", text, why: ["dm"], keys: [`slack:D1:${id}.0`], reply: { channel: "D1", ts: `${id}.0` } });
    writeFileSync(join(h, "events.jsonl"), `${dm(1, "能赶上 12/2 吗")}\n${dm(2, "那 1.0 呢")}\n${JSON.stringify({ ...JSON.parse(dm(3, "帮忙看下 https://github.com/o/r/pull/44")), keys: ["slack:D1:3.0", "github.com/o/r/pull/44"] })}\n`);
    chiefIn(h, "", "thing", "add", "--title", "运费卡片", "--session", "local_x");
    for (const n of [1, 2]) {
      writeFileSync(join(h, "drafts", `${n}.md`), n === 1 ? "能赶上" : "一起改");
      chief(h, "reply", "add", "--event", String(n), "--thing", "1", "--file", join(h, "drafts", `${n}.md`));
      chiefIn(h, JSON.stringify({ question: n === 1 ? "这样回 Alex 吗？" : "这样回 1.0 的问题吗？", suggest: "发" }), "ask", "add", "--thing", "1", "--reply", String(n));
    }
    const asks = () => JSON.parse(readFileSync(join(h, "things.json"), "utf8")).asks as { status: string; answer?: string; reason?: string }[];
    // 你在面板上点了发送：问题记成答了；撤回发送：问题回来。
    sendByYou(h, "1");
    expect(asks()[0]).toMatchObject({ status: "answered", answer: "回复发了" });
    chief(h, "reply", "undo", "1");
    expect(asks()[0]).toMatchObject({ status: "open" });
    expect(JSON.parse(chief(h, "thing", "list"))[0].status).toBe("waiting_you");
    // 不发了 / 让它重写：问题撤掉，写上为什么。
    chief(h, "reply", "drop", "1");
    expect(asks()[0]).toMatchObject({ status: "withdrawn", reason: "回复不发了" });
    chiefIn(h, "太硬了", "reply", "redo", "2");
    expect(asks()[1]).toMatchObject({ status: "withdrawn", reason: "回复让它重写了" });
    expect(JSON.parse(chief(h, "thing", "list"))[0].status).toBe("doing");
    // approve：只为它记的事情（没有会话、没有开着的问题），approve 一发就办完。
    chiefIn(h, "", "thing", "add", "--title", "o/r#44 (Alex 让看的 PR)");
    const a = JSON.parse(chief(h, "reply", "approve", "--event", "3", "--ref", "o/r#44", "--custom", "1", "--thing", "2"));
    chief(h, "reply", "queue", String(a.id), "--policy");
    const t2 = JSON.parse(chief(h, "thing", "list", "--all")).find((x: { id: number }) => x.id === 2);
    expect(t2).toMatchObject({ status: "done", results: ["approve 了 o/r#44"] });
  });

  it("规矩：场景表加自由规矩，能改", () => {
    const h = home();
    expect(chief(h, "rules")).toContain("Slack 私信（slack_dm）：派人去办；回复先给我确认");
    yours(h, "", "set", "slack_dm", "reply=auto");
    expect(chief(h, "rules")).toContain("Slack 私信（slack_dm）：派人去办；回复直接发");
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "add"], { env: { ...process.env, CHIEF_HOME: h }, input: "Bob Chen 问进度可以直接回" });
    expect(chief(h, "rules")).toContain("Bob Chen 问进度可以直接回");
    expect(chiefFails(h, "rules", "set", "slack_dm", "reply=maybe")).toContain("看不懂");
    expect(chiefFails(h, "rules", "set", "slack_dm", "handle=command")).toContain("只能用在你给自己发的私信");
    chief(h, "rules", "set", "slack_self", "handle=command");
  });

  it("判断记一行，带理由；跳过旧的不记判断", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${JSON.stringify({ id: 1, at: "t", source: "slack", kind: "k", title: "#dev", url: null, from: "Carol", text: "嗯", why: ["dm"], keys: [], reply: {} })}\n${JSON.stringify({ id: 2, at: "t", source: "slack", kind: "k", title: "#dev", url: null, from: "Carol", text: "好", why: ["thread"], keys: [], reply: {} })}\n`);
    execFileSync(process.execPath, ["--import", TSX, CLI, "mark", "1", "noted"], { env: { ...process.env, CHIEF_HOME: h }, input: "只是应了一声" });
    chief(h, "mark", "--upto", "2", "ignored");
    const lines = readFileSync(join(h, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 1, scenario: "slack_dm", verdict: "noted", reason: "只是应了一声" });
    expect(JSON.parse(chief(h, "board")).unhandled).toBe(0);
  });
});

describe("Slack 原文", () => {
  it("内部写法换成人话", async () => {
    const { slackText } = await import("../src/engine");
    expect(slackText("<@U0ME> 你看下 <@U22> <!channel> <#C1|dev> <https://a.b/c|链接> <https://x.y>", [{ id: "U22", name: "Alice" }], "U0ME"))
      .toBe("@你 你看下 @Alice @channel #dev [链接](https://a.b/c) https://x.y");
  });
});

describe("纠正和提议", () => {
  const run = (h: string, input: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input });

  it("判断记下是什么消息；你标对错；提议的规矩采纳后进你的规矩", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${JSON.stringify({ id: 1, at: "t", source: "slack", kind: "k", title: "#dev", url: null, from: "Alice", text: "看板 ready 了", why: ["thread"], keys: [], reply: {} })}\n`);
    run(h, "只是同步", "mark", "1", "noted");
    const d = JSON.parse(readFileSync(join(h, "decisions.jsonl"), "utf8").trim());
    expect(d.what).toMatchObject({ source: "slack", title: "#dev", from: "Alice", text: "看板 ready 了" });
    run(h, "这个其实要我回", "review", "1", "wrong");
    expect(JSON.parse(readFileSync(join(h, "reviews.json"), "utf8"))["1"]).toMatchObject({ ok: false, note: "这个其实要我回" });
    const pid = run(h, JSON.stringify({ text: "Alice 在项目频道里问进度，派活", basis: "你标错了 #1" }), "rules", "propose").trim();
    expect(JSON.parse(chief(h, "rules", "json")).proposals[0]).toMatchObject({ id: Number(pid), basis: "你标错了 #1" });
    chief(h, "rules", "accept", pid);
    const p = JSON.parse(chief(h, "rules", "json"));
    expect(p.proposals).toHaveLength(0);
    expect(p.notes.at(-1)).toBe("Alice 在项目频道里问进度，派活");
    expect(chiefFails(h, "review", "9", "ok")).toContain("没有事件");
  });
});

describe("审查找到的问题", () => {
  const run = (h: string, input: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input });
  const ev = (id: number) => JSON.stringify({ id, at: "t", source: "slack", kind: "k", title: "#dev", url: null, from: "Carol", text: "x", why: ["dm"], keys: [`slack:C1:${id}`], reply: { channel: "D1", ts: "1.0" } });

  it("连点两次发送：第二次报错，但锁放掉了，还能撤回", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${ev(1)}\n`);
    writeFileSync(join(h, "drafts", "1.md"), "好的");
    chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "1.md"));
    sendByYou(h, "1");
    expect(sendByYouFails(h, "1")).toContain("不能发");
    chief(h, "reply", "undo", "1");
    expect(JSON.parse(chief(h, "reply", "list"))[0].status).toBe("pending");
  });

  it("判断过的不再判断第二次；重读事件时跳过判断过的", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${ev(1)}\n${ev(2)}\n`);
    run(h, "派了", "mark", "1", "forwarded");
    expect(chiefFails(h, "mark", "1", "noted")).toContain("已经判断过了");
    run(h, "改判", "mark", "1", "noted", "--force");
    const out = chief(h, "events", "--after", "0").trim().split("\n");
    expect(out.map((l) => JSON.parse(l).id)).toEqual([2]);
  });

  it("标题里带命令符号的拒收；规矩按原文删；进度只往前走", () => {
    const h = home();
    expect(chiefFails(h, "thing", "add", "--title", "$(rm -rf ~)")).toContain("标题只能用");
    run(h, "a", "rules", "add");
    run(h, "b", "rules", "add");
    run(h, "a", "rules", "remove");
    expect(JSON.parse(chief(h, "rules", "json")).notes.slice(-1)).toEqual(["b"]);
    expect(() => run(h, "a", "rules", "remove")).toThrow();
    chief(h, "cursor", "9");
    chief(h, "cursor", "3");
    expect(chief(h, "cursor").trim()).toBe("9");
  });
});

describe("停下和交代", () => {
  it("chief hub stop 让在听的主会话自己退出；每类活能写交代", async () => {
    const h = home();
    const { spawn: sp } = await import("node:child_process");
    const child = sp(process.execPath, ["--import", TSX, CLI, "events", "--follow"], { env: { ...process.env, CHIEF_HOME: h } });
    const said = new Promise<string>((done) => child.stdout.on("data", (d: Buffer) => done(d.toString())));
    await new Promise((r) => setTimeout(r, 1500));
    expect(JSON.parse(chief(h, "hub")).listening).toBe(true);
    chief(h, "hub", "stop");
    expect(JSON.parse((await said).trim())).toMatchObject({ chief: "stopped" });
    expect(JSON.parse(chief(h, "hub")).listening).toBe(false);
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "brief", "github_review"], { env: { ...process.env, CHIEF_HOME: h }, input: "先看有没有测试" });
    expect(chief(h, "rules")).toContain("交代：先看有没有测试");
  });
});

describe("后来加的场景", () => {
  it("老的 rules.json 没有 PR 被 approve / 要求修改：chief rules 补上，原来改过的不动", () => {
    const h = home();
    chief(h, "rules", "set", "github_comment", "handle=note");
    const file = join(h, "rules.json");
    const old = JSON.parse(readFileSync(file, "utf8")) as { scenarios: Record<string, unknown> };
    delete old.scenarios.github_approved;
    delete old.scenarios.github_changes;
    writeFileSync(file, JSON.stringify(old));
    const p = JSON.parse(chief(h, "rules", "json")) as { scenarios: Record<string, { handle: string; brief?: string }> };
    expect(p.scenarios.github_approved).toMatchObject({ handle: "dispatch" });
    expect(p.scenarios.github_comment?.handle).toBe("note");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { scenarios: Record<string, { handle: string }> };
    expect(onDisk.scenarios.github_changes).toMatchObject({ handle: "dispatch" });
    expect(onDisk.scenarios.github_comment?.handle).toBe("note");
    expect(chief(h, "rules")).toContain("我的 PR 被 approve 了（github_approved）：派人去办");
  });
});

describe("导入", () => {
  it("导入的事情带键，按键能找到；办完的找不到", () => {
    const h = home();
    const run = (input: string, ...args: string[]) =>
      execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input });
    const id = run("压测脚本写完了", "thing", "add", "--import", "--title", "PROJ-123 大促压测", "--session", "local_x", "--key", "PROJ-123").trim();
    expect(JSON.parse(chief(h, "thing", "find", "PROJ-123", "PROJ-1"))[0]).toMatchObject({ id: Number(id), origin: "import", session: "local_x", keys: ["PROJ-123"] });
    run("", "thing", "update", id, "--status", "done");
    expect(JSON.parse(chief(h, "thing", "find", "PROJ-123"))).toHaveLength(0);
  });
});

describe("测试消息", () => {
  it("造一条测试消息，编号接着往下；它的回复不会真的发出去", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "state.json"), JSON.stringify({ nextId: 5, since: {}, seen: [], threads: [] }));
    const out = execFileSync(process.execPath, ["--import", TSX, CLI, "test", "--from", "Carol"], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input: "PROJ-479 能加个字段吗" });
    expect(out).toContain("#5");
    const e = JSON.parse(chief(h, "show", "5"));
    expect(e).toMatchObject({ test: true, from: "Carol", title: "[测试] 测试私信", why: ["dm"] });
    expect(e.keys).toContain("PROJ-479");
    writeFileSync(join(h, "drafts", "5.md"), "可以");
    chief(h, "reply", "add", "--event", "5", "--file", join(h, "drafts", "5.md"));
    expect(sendByYouFails(h, "1")).toContain("不会真的发出去");
  });
});

describe("策略能自己加、approve、进度表", () => {
  const run = (h: string, input: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input });

  it("自己加情况、改它、删它；默认带 approve PR 的情况", () => {
    const h = home();
    expect(chief(h, "rules")).toContain("custom:1 当「Slack 里有人发 PR 链接");
    const out = run(h, "Jira 上 QA 提的 bug 指给我", "rules", "custom", "add");
    expect(out).toContain("custom:2");
    yours(h, "", "set", "custom:2", "handle=dispatch", "reply=auto");
    run(h, "先复现再修", "rules", "brief", "custom:2");
    expect(chief(h, "rules")).toContain("当「Jira 上 QA 提的 bug 指给我」：派人去办；回复直接发（发前 5 秒可撤回）；交代：先复现再修");
    chief(h, "rules", "custom", "remove", "2");
    expect(chief(h, "rules")).not.toContain("QA 提的 bug");
    expect(chiefFails(h, "rules", "set", "custom:9", "handle=note")).toContain("没有你加的情况");
  });

  it("approve 进待发出，按规矩返回 policy；测试消息的 approve 不会真的发", () => {
    const h = home();
    chief(h, "cursor");
    run(h, "帮忙看下 https://github.com/o/r/pull/44", "test", "--from", "Alice", "--why", "mention");
    const a = JSON.parse(chief(h, "reply", "approve", "--event", "1", "--ref", "o/r#44", "--custom", "1"));
    expect(a).toMatchObject({ kind: "approve", ref: "o/r#44", policy: "auto" });
    expect(sendByYouFails(h, String(a.id))).toContain("测试消息");
    expect(chiefFails(h, "reply", "approve", "--event", "1", "--ref", "$(x)")).toContain("--ref");
  });

  it("进度：下一步、阻碍、结果、截止", () => {
    const h = home();
    const id = run(h, JSON.stringify({ progress: "脚本写完", next: "跑一轮", blocker: "等测试环境" }), "thing", "add", "--title", "PROJ-123 压测", "--due", "2026-11-20").trim();
    let t = JSON.parse(chief(h, "thing", "list"))[0];
    expect(t).toMatchObject({ progress: "脚本写完", next: "跑一轮", blocker: "等测试环境", due: "2026-11-20" });
    run(h, JSON.stringify({ progress: "跑完了", blocker: "", result: "[报告](https://x)" }), "thing", "update", id, "--due", "none");
    t = JSON.parse(chief(h, "thing", "list"))[0];
    expect(t.blocker).toBeUndefined();
    expect(t.due).toBeUndefined();
    expect(t.results).toEqual(["[报告](https://x)"]);
    expect(chiefFails(h, "thing", "update", id, "--due", "明天")).toContain("YYYY-MM-DD");
  });
});

describe("Slack 给自己发的话", () => {
  it("和自己的私信里你写的话，当成找你的消息交出去", async () => {
    const { classifyCreated } = await import("../src/slack/classify");
    const evt = { ts: "1.0", channel: { id: "D1", isIm: true, isMpim: false, imUserId: "UME1" }, sender: { id: "UME1", isBot: false }, origin: "self_other_client" as const, text: "帮我看看进度", markdown: "帮我看看进度", thread: null, isThreadReply: false, isMentioningMe: false, eventId: "D1:1.0:created" };
    const r = classifyCreated(evt, () => false, "UME1");
    expect(r.ok && r.message.relevance).toBe("self");
    // 和别人的私信里你说的话：还是你自己说的，不交。
    const other = classifyCreated({ ...evt, channel: { ...evt.channel, imUserId: "UOTHER" } }, () => false, "UME1");
    expect(other.ok && other.message.role).toBe("self");
    const { eventOfSlack } = await import("../src/engine");
    const e = eventOfSlack({ channel: "slack", deliveryId: "x", kind: "message.received", role: "message", relevance: "self", conversation: { key: "slack:D1", threadKey: "slack:D1:dm", label: "x", audience: "direct" }, sender: { id: "UME1", name: "Rikki", bot: false }, text: "帮我看看进度", occurredAt: "t", replyTarget: { channel: "D1", ts: "1.0" } });
    expect(e).toMatchObject({ from: "你", why: ["self"], title: "你在 Slack 上给助理的话" });
  });
});

describe("Slack 署名", () => {
  it("默认加 agent 署名，能改、能清掉", () => {
    const h = home();
    expect(chief(h, "rules")).toContain("正文上方会自动加一行灰色小字署名：🤖 agent reply · confirmed by @我");
    yours(h, "— Rikki 的助手代回", "sign");
    expect(JSON.parse(chief(h, "rules", "json")).signature).toBe("— Rikki 的助手代回");
    yours(h, "", "sign");
    expect(chief(h, "rules")).toContain("（不加）");
  });
});

describe("会话进展", () => {
  it("会话进展的场景是「我的会话有新进展」", async () => {
    const { scenarioOf } = await import("../src/store");
    expect(scenarioOf({ source: "session", why: ["asking"] })).toBe("session_update");
    expect(chief(home(), "rules")).toContain("我的会话有新进展（session_update）：只记下");
  });
});

describe("主动发消息", () => {
  it("chief reply new：给人发新私信，进待发出，能排队", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "drafts", "n.md"), "jk 你好，testing 环境能让出来吗？");
    const r = JSON.parse(chief(h, "reply", "new", "--to", "U0ABC123", "--name", "bob.lee", "--file", join(h, "drafts", "n.md")));
    expect(r).toMatchObject({ kind: "message", to: "U0ABC123" });
    const x = JSON.parse(chief(h, "reply", "list"))[0];
    expect(x).toMatchObject({ kind: "message", event: 0, target: { to: "U0ABC123" }, context: { who: "bob.lee", where: "新私信" } });
    sendByYou(h, String(r.id));
    expect(JSON.parse(chief(h, "reply", "list"))[0].status).toBe("queued");
    expect(chiefFails(h, "reply", "new", "--to", "$(x)", "--file", join(h, "drafts", "n.md"))).toContain("--to");
  });
});

describe("回到别人帖子的 thread", () => {
  it("消息链接 → 频道和 thread 开头", () => {
    expect(parsePermalink("https://x.slack.com/archives/C0ABC/p1795079290188699")).toEqual({ channel: "C0ABC", thread_ts: "1795079290.188699" });
    expect(parsePermalink("https://x.slack.com/archives/C0ABC/p1795079290188699?thread_ts=1795079000.000100&cid=C0ABC")).toEqual({ channel: "C0ABC", thread_ts: "1795079000.000100" });
    expect(parsePermalink("https://evil.com/archives/C0ABC/p1795079290188699")).toBeNull();
  });

  it("chief reply new --to <链接>：进待发出，记着 thread", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "drafts", "t.md"), "压测报告改好了 <@U0DAVE>");
    const r = JSON.parse(chief(h, "reply", "new", "--to", "https://x.slack.com/archives/C0ABC/p1795079290188699", "--name", "#ops", "--file", join(h, "drafts", "t.md")));
    expect(r).toMatchObject({ to: "C0ABC", thread_ts: "1795079290.188699" });
    expect(JSON.parse(chief(h, "reply", "list"))[0]).toMatchObject({ target: { to: "C0ABC", thread_ts: "1795079290.188699" }, context: { where: "回到帖子的 thread" } });
    expect(chiefFails(h, "reply", "new", "--to", "https://x.slack.com/nope", "--file", join(h, "drafts", "t.md"))).toContain("链接");
    expect(chiefFails(h, "reply", "new", "--to", "U0ABC", "--thread", "1795079290.188699", "--file", join(h, "drafts", "t.md"))).toContain("--thread");
  });
});

describe("Slack 署名放在正文上方的小字里", () => {
  it("你点的发送写 confirmed by，规矩直接发的写 not reviewed，空的不加", async () => {
    const { signatureAttribution } = await import("../src/engine");
    expect(signatureAttribution("🤖 agent reply", "you")).toEqual({ text: "🤖 agent reply · confirmed by {self}", review: "confirmed" });
    expect(signatureAttribution("🤖 agent reply", "policy")).toEqual({ text: "🤖 agent reply · sent for {self} · not reviewed", review: "unconfirmed" });
    expect(signatureAttribution("🤖 agent reply", undefined)).toMatchObject({ review: "unconfirmed" });
    expect(signatureAttribution("  ", "you")).toBe(false);
    // 署名里写了 <!here>、<@U…>：转义掉，不会真的去提醒人。
    expect(signatureAttribution("<!here> <@U0X> & 我", "you")).toEqual({ text: "&lt;!here&gt; &lt;@U0X&gt; &amp; 我 · confirmed by {self}", review: "confirmed" });
  });

  it("gabriel-slack 把它画成正文上方的 context block", async () => {
    const { signatureAttribution } = await import("../src/engine");
    const { renderAttribution } = await import("gabriel-slack");
    const a = signatureAttribution("🤖 agent 加入光荣的进化吧", "you");
    if (a === false) throw new Error("应该有署名");
    expect(renderAttribution(a, { selfUserId: "U0ME", channel: "C0DEV" })).toEqual({
      text: "🤖 agent 加入光荣的进化吧 · confirmed by <@U0ME>",
      block: { type: "context", block_id: "gabriel.attribution.custom", elements: [{ type: "mrkdwn", text: "🤖 agent 加入光荣的进化吧 · confirmed by <@U0ME>" }] },
    });
  });

  it("发的时候正文原样、署名单独给 gabriel-slack", async () => {
    const { SlackPlugin } = await import("../src/slack/plugin");
    const calls: unknown[] = [];
    const fake = {
      selfUserId: "U0ME",
      core: { callWebApi: async (method: string) => (method === "conversations.open" ? { channel: { id: "D0NEW" } } : {}) },
      on: () => {}, onError: () => {}, start: async () => {}, stop: async () => {},
      chat: { send: async (opts: { channel: string }) => { calls.push(opts); return { channel: opts.channel, ts: "9.0" }; } },
      reactions: { add: async () => {} },
    };
    const plugin = new SlackPlugin({ createClient: async () => fake });
    await plugin.start({ secrets: { cookie_d: "xoxd-x" }, deliver: async () => {}, threadSeen: () => false, status: () => {}, log: () => {} });
    const attribution = { text: "🤖 agent reply · confirmed by {self}", review: "confirmed" as const };
    expect(await plugin.send({ channel: "C1", ts: "1.0" }, "好的，今天合", true, attribution)).toEqual({ ref: "C1:9.0", channel: "C1", ts: "9.0", threadTs: "1.0" });
    await plugin.sendNew("U0ABC", "jk 你好", undefined, attribution);
    await plugin.send({ channel: "C1", ts: "1.0" }, "不加署名", false);
    expect(calls).toEqual([
      { channel: "C1", markdown: "好的，今天合", threadTs: "1.0", attribution },
      { channel: "D0NEW", markdown: "jk 你好", attribution },
      { channel: "C1", markdown: "不加署名", attribution: false },
    ]);
    await plugin.stop();
  });
});

describe("认出 chief 自己发的", () => {
  it("带署名的：只认你自己账号发的；记下的编号也认；别人开头写署名的照常收", async () => {
    const { isOwnAgentMessage } = await import("../src/engine");
    const { classifyCreated } = await import("../src/slack/classify");
    // gabriel-slack 收到时把署名行从正文里拿出来，放在 attribution 上。
    const evt = { ts: "2.0", channel: { id: "D1", isIm: true, isMpim: false, imUserId: "UME1" }, sender: { id: "UME1", isBot: false }, origin: "self_other_client" as const, text: "出来了", markdown: "出来了", thread: null, isThreadReply: false, isMentioningMe: false, eventId: "D1:2.0:created", attribution: { text: "🤖 agent reply · confirmed by @Rikki" } };
    const r = classifyCreated(evt, () => false, "UME1");
    if (!r.ok) throw new Error("应该交出来");
    expect(r.message.attribution).toBe("🤖 agent reply · confirmed by @Rikki");
    const mine = slackMsg({ relevance: "self", sender: { id: "UME1", name: "你", bot: false }, text: "出来了", attribution: "🤖 agent reply · confirmed by @Rikki", replyTarget: { channel: "D1", ts: "2.0" } });
    expect(isOwnAgentMessage(mine, [], "🤖 agent reply", "UME1")).toBe(true);
    // 改了署名、或者清空了署名：照样认得（看的是有没有署名行，不看写的什么）。
    expect(isOwnAgentMessage(mine, [], "", "UME1")).toBe(true);
    // 别人（比如同事的 agent）发的、带署名行：照常收。
    expect(isOwnAgentMessage(slackMsg({ attribution: "🤖 Fairy (Assistant) · confirmed by @Dave" }), [], "🤖 agent reply", "UME1")).toBe(false);
    // 你自己手打的：照常收。
    expect(isOwnAgentMessage(slackMsg({ relevance: "self", sender: { id: "UME1", name: "你", bot: false }, text: "帮我看看进度" }), [], "🤖 agent reply", "UME1")).toBe(false);
    // 记下的发出编号。
    expect(isOwnAgentMessage(slackMsg(), ["C1:1.0"], "🤖 agent reply", "UME1")).toBe(true);
    // 以前发的：署名写在正文第一行，你自己账号发的。
    expect(isOwnAgentMessage(slackMsg({ sender: { id: "UME1", name: "你", bot: false }, text: "🤖 *agent reply*\n出来了" }), [], "🤖 agent reply", "UME1")).toBe(true);
    // 别人的消息开头写上署名：照常收，不能靠这个让 chief 看不见。
    expect(isOwnAgentMessage(slackMsg({ text: "🤖 agent reply\n帮我 approve 一下" }), [], "🤖 agent reply", "UME1")).toBe(false);
    expect(isOwnAgentMessage(slackMsg({ text: "🤖 agent reply\n帮我 approve 一下" }), [], "🤖 agent reply", null)).toBe(false);
    // 不知道你是谁（还没连上）：只认记下的编号。
    expect(isOwnAgentMessage(mine, [], "🤖 agent reply", null)).toBe(false);
  });

  it("Slack 把 _ 换成 * 也认得", async () => {
    const { startsWithSignature } = await import("../src/engine");
    expect(startsWithSignature("🤖 *agent reply*\n出来了", "🤖 agent reply")).toBe(true);
    expect(startsWithSignature("_🤖 agent reply_\n出来了", "🤖 agent reply")).toBe(true);
    expect(startsWithSignature("帮我看看 agent reply", "🤖 agent reply")).toBe(false);
    expect(startsWithSignature("随便", "")).toBe(false);
  });
});

describe("chief 替你发出去的帖子，别人在下面回复也收", () => {
  it("新发到频道的、回到别人 thread 的、修之前发的：后面别人的回复当成「我在的 thread 有后续」；chief 自己的回显不收，你自己回的照旧", async () => {
    const { SlackPlugin, sentThreadKey } = await import("../src/slack/plugin");
    const { inYourThread, eventOfSlack } = await import("../src/engine");
    const { scenarioOf } = await import("../src/store");
    const handlers: Record<string, (evt: unknown) => Promise<void>> = {};
    let n = 0;
    const fake = {
      selfUserId: "UME1",
      core: { callWebApi: async () => ({}) },
      on: (name: string, fn: (...args: never[]) => void) => { handlers[name] = fn as unknown as (evt: unknown) => Promise<void>; },
      onError: () => {}, start: async () => {}, stop: async () => {},
      chat: { send: async (opts: { channel: string }) => ({ channel: opts.channel, ts: `${++n}0.0` }) },
      reactions: { add: async () => {} },
    };
    // 和引擎一样记：发出去的编号（sent）、正文落在的 thread（threads）。
    const state = { threads: [] as string[], sent: ["C3:5.0"] };
    const got: InboundMessage[] = [];
    const plugin = new SlackPlugin({ createClient: async () => fake });
    await plugin.start({ secrets: { cookie_d: "xoxd-x" }, deliver: async (m) => { got.push(m); }, threadSeen: (k) => inYourThread(k, state.threads, state.sent), status: () => {}, log: () => {} });
    const sendAndRecord = (sent: Parameters<typeof sentThreadKey>[0]) => {
      state.sent.push(sent.ref);
      state.threads.push(sentThreadKey(sent));
    };
    const channel = { id: "C2", name: "proj", isIm: false, isMpim: false };
    const msg = (over: Record<string, unknown>) => ({ channel, sender: { id: "USAM", displayName: "Sam", isBot: false }, origin: "other_user", isThreadReply: true, isMentioningMe: false, ...over });
    const reply = (ts: string, root: string, over: Record<string, unknown> = {}) =>
      handlers["message.created"]!(msg({ ts, text: "收到", markdown: "收到", thread: { rootTs: root, isReply: true }, eventId: `C2:${ts}:created`, ...over }));

    // chief reply new --to <频道>：正文是频道里的新消息（ts 10.0）。
    sendAndRecord(await plugin.sendNew("C2", "<@URYAN> 这个需求怎么定？"));
    expect(state.threads).toEqual(["slack:C2:10.0"]);
    // 它的回显（gabriel-slack 认得是自己这边发的）：不收。
    await handlers["message.created"]!(msg({ ts: "10.0", origin: "this_client", sender: { id: "UME1", isBot: false }, text: "x", markdown: "x", thread: null, isThreadReply: false, eventId: "C2:10.0:created" }));
    expect(got).toEqual([]);
    // Sam 在它的 thread 里回：收，算「我在的 thread 有后续」。
    await reply("11.0", "10.0");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ relevance: "thread", role: "message", sender: { name: "Sam" }, replyTarget: { channel: "C2", ts: "11.0", thread_ts: "10.0" } });
    expect(scenarioOf(eventOfSlack(got[0]!, "UME1")!)).toBe("slack_thread");
    // 你自己在下面回的：照旧是你自己说的（self），不当成找你的。
    await reply("12.0", "10.0", { origin: "self_other_client", sender: { id: "UME1", isBot: false } });
    expect(got[1]).toMatchObject({ role: "self", relevance: null });
    // 回到别人帖子的 thread（帖子 1.0）：那个 thread 也算。
    sendAndRecord(await plugin.send({ channel: "C2", ts: "1.0", audience: "channel" }, "好的", true));
    await reply("21.0", "1.0");
    expect(got[2]).toMatchObject({ relevance: "thread", replyTarget: { ts: "21.0", thread_ts: "1.0" } });
    // 修之前发的（只在 sent 里记着发出编号 C3:5.0）：下面的回复也收。
    await reply("6.0", "5.0", { channel: { id: "C3", name: "old", isIm: false, isMpim: false }, eventId: "C3:6.0:created" });
    expect(got[3]).toMatchObject({ relevance: "thread", replyTarget: { channel: "C3", thread_ts: "5.0" } });
    // 和你无关的 thread：照旧不收。
    await reply("31.0", "30.0");
    expect(got).toHaveLength(4);
    await plugin.stop();
  });

  it("登记的 thread 写法和收消息时算的一样：频道按正文或它所在的 thread，私信里直接回的是整段对话", async () => {
    const { sentThreadKey } = await import("../src/slack/plugin");
    expect(sentThreadKey({ ref: "C2:10.0", channel: "C2", ts: "10.0" })).toBe("slack:C2:10.0");
    expect(sentThreadKey({ ref: "C2:11.0", channel: "C2", ts: "11.0", threadTs: "1.0" })).toBe("slack:C2:1.0");
    expect(sentThreadKey({ ref: "D1:3.0", channel: "D1", ts: "3.0", direct: true })).toBe("slack:D1:dm");
    expect(sentThreadKey({ ref: "D1:4.0", channel: "D1", ts: "4.0", threadTs: "2.0", direct: true })).toBe("slack:D1:2.0");
  });
});

describe("别的 app 借真人账号发的消息也收", () => {
  // 同事让自己的助理、Slack 上的 Claude、发版脚本拿他的用户令牌发消息：Slack 上显示是他本人（带个 APP 标记），
  // 实时推来的消息却带着 bot_id，gabriel-slack 记成 origin bot、isBot。以前引擎把它当机器人，不交、也不留痕迹。
  const start = async (accounts: Record<string, { isBot: boolean; displayName?: string } | "error">) => {
    const { SlackPlugin } = await import("../src/slack/plugin");
    const handlers: Record<string, (evt: unknown) => Promise<void>> = {};
    const got: InboundMessage[] = [];
    const logs: string[] = [];
    const looked: string[] = [];
    const fake = {
      selfUserId: "UME1",
      core: { callWebApi: async () => ({}) },
      on: (name: string, fn: (...args: never[]) => void) => { handlers[name] = fn as unknown as (evt: unknown) => Promise<void>; },
      onError: () => {}, start: async () => {}, stop: async () => {},
      chat: { send: async (opts: { channel: string }) => ({ channel: opts.channel, ts: "9.0" }) },
      reactions: { add: async () => {} },
      users: {
        resolve: async (ids: string[]) => ids.map((id) => {
          looked.push(id);
          const a = accounts[id];
          if (a === "error") throw new Error("users/info 超时");
          return a ? { id, ...a } : null;
        }),
      },
    };
    const plugin = new SlackPlugin({ createClient: async () => fake });
    await plugin.start({ secrets: { cookie_d: "xoxd-x" }, deliver: async (m) => { got.push(m); }, threadSeen: () => false, status: () => {}, log: (l) => logs.push(l) });
    const dm = { id: "D1", name: "@Dave", isIm: true, isMpim: false, imUserId: "UDAVE" };
    const created = (ts: string, sender: Record<string, unknown>, origin = "bot") => handlers["message.created"]!({
      ts, channel: dm, sender, origin, text: "@acme/shop-sdk 1.2.3-beta.1 已发布", markdown: "@acme/shop-sdk 1.2.3-beta.1 已发布",
      thread: null, isThreadReply: false, isMentioningMe: false, eventId: `D1:${ts}:created`,
    });
    return { plugin, got, logs, looked, created };
  };

  it("私信里同事经 app 发的：账号是真人就当他本人说的话，名字用他的，交给消息中心", async () => {
    const { eventOfSlack } = await import("../src/engine");
    const { plugin, got, created } = await start({ UDAVE: { isBot: false, displayName: "Dave" } });
    // 漏收的那种：同事的账号、app 的名字、带 bot_id。
    await created("1.0", { id: "UDAVE", displayName: "Release Helper", isBot: true });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ relevance: "dm", role: "message", sender: { id: "UDAVE", name: "Dave", bot: false } });
    expect(eventOfSlack(got[0]!, "UME1")).toMatchObject({ from: "Dave", fromId: "UDAVE", why: ["dm"], keys: ["slack:D1:dm"] });
    await plugin.stop();
  });

  it("真机器人账号、只有 bot_id 的、你自己账号经 app 发的：照旧当机器人；查不到账号也照旧，但记一行日志", async () => {
    const { eventOfSlack } = await import("../src/engine");
    const { plugin, got, logs, looked, created } = await start({ UCIBOT: { isBot: true, displayName: "CI" }, UGONE: "error", UME1: { isBot: false, displayName: "你" } });
    await created("2.0", { id: "UCIBOT", displayName: "CI", isBot: true });
    await created("3.0", { id: "B0LEGACY", displayName: "Old Hook", isBot: true });
    await created("4.0", { id: "UGONE", isBot: true });
    await created("5.0", { id: "UME1", isBot: true });
    expect(got.map((m) => m.sender.bot)).toEqual([true, true, true, true]);
    for (const m of got) expect(eventOfSlack(m, "UME1")).toBeNull();
    // 只有 bot_id 的、你自己的不查；查不到的写清是哪条，不带原文。
    expect(looked).toEqual(["UCIBOT", "UGONE"]);
    expect(logs.filter((l) => l.includes("UGONE"))).toEqual([expect.stringContaining("D1:4.0")]);
    expect(logs.join("\n")).not.toContain("已发布");
    // 本来就是人发的（没有 bot_id）：不多查一次。
    await created("6.0", { id: "UDAVE", displayName: "Dave", isBot: false }, "other_user");
    expect(looked).toEqual(["UCIBOT", "UGONE"]);
    expect(got[4]).toMatchObject({ relevance: "dm", sender: { name: "Dave", bot: false } });
    await plugin.stop();
  });

  it("本来会交、因为是机器人才没交的：引擎记一行日志（只写位置，不写原文）", async () => {
    const { skippedBotNote } = await import("../src/engine");
    const dm = slackMsg({ relevance: "dm", sender: { id: "UCIBOT", name: "机器人", bot: true }, replyTarget: { channel: "D1", ts: "2.0" } });
    expect(skippedBotNote(dm)).toBe("机器人账号 UCIBOT 发的（dm），没交给消息中心：D1:2.0");
    expect(skippedBotNote(dm)).not.toContain("github");
    // 本来就不交的（和你无关、改和删、你自己说的）、人发的：不记。
    expect(skippedBotNote(slackMsg({ relevance: null, sender: { id: "UCIBOT", name: "机器人", bot: true } }))).toBeNull();
    expect(skippedBotNote(slackMsg({ kind: "message.edited", sender: { id: "UCIBOT", name: "机器人", bot: true } }))).toBeNull();
    expect(skippedBotNote(slackMsg())).toBeNull();
  });
});

describe("Slack 回复放哪", () => {
  it("私信直接回、频道回 thread、对方在 thread 里就回 thread、稿子能指定", async () => {
    const { placementOf, defaultPolicy } = await import("../src/store");
    const p = defaultPolicy().placement;
    expect(placementOf({ channel: "D1", ts: "1", audience: "direct" }, p)).toBe("inline");
    expect(placementOf({ channel: "C1", ts: "1", audience: "channel" }, p)).toBe("thread");
    expect(placementOf({ channel: "D1", ts: "1", thread_ts: "0.5", audience: "direct" }, p)).toBe("thread");
    expect(placementOf({ channel: "D1", ts: "1", audience: "self" }, p)).toBe("thread");
    expect(placementOf({ channel: "D1", ts: "1", audience: "direct", in: "thread" }, p)).toBe("thread");
    expect(placementOf({ channel: "D9", ts: "1" }, p)).toBe("inline");
    const h = home();
    chief(h, "rules", "place", "direct=thread");
    expect(chief(h, "rules")).toContain("一对一私信 回到 thread");
  });
});

describe("回复写法", () => {
  it("默认几条写法，能加能删", () => {
    const h = home();
    expect(chief(h, "rules")).toContain("像同事在 Slack 上聊天");
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "style", "add"], { env: { ...process.env, CHIEF_HOME: h }, input: "不用「您」" });
    expect(JSON.parse(chief(h, "rules", "json")).style).toContain("不用「您」");
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "style", "remove"], { env: { ...process.env, CHIEF_HOME: h }, input: "不用「您」" });
    expect(JSON.parse(chief(h, "rules", "json")).style).not.toContain("不用「您」");
  });
});

describe("演练", () => {
  const run = (h: string, input: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input });

  it("加例子、跑一遍（造演练消息）、主会话 --dry 判断、对结果；演练判断标着 dry", () => {
    const h = home();
    chief(h, "cursor");
    run(h, JSON.stringify({ from: "Bob", where: "私信", why: "dm", text: "压测那个你处理了吗", expect: "dispatch" }), "eval", "add");
    run(h, JSON.stringify({ from: "Alice", where: "#proj", why: "thread", text: "看板 ready 了", expect: "note" }), "eval", "add");
    expect(chief(h, "eval", "run")).toContain("交了 2 个例子");
    const evs = chief(h, "events", "--after", "0").trim().split("\n").map((l) => JSON.parse(l));
    expect(evs.map((e) => e.dryrun)).toEqual([true, true]);
    run(h, "会送进压测会话", "mark", String(evs[0].id), "forwarded", "--dry");
    run(h, "会送进看板会话", "mark", String(evs[1].id), "forwarded", "--dry");
    const rep = JSON.parse(chief(h, "eval", "report"));
    expect(rep).toMatchObject({ total: 2, judged: 2, correct: 1 });
    expect(rep.results[1]).toMatchObject({ expect: "note", got: "dispatch", ok: false, reason: "会送进看板会话" });
    const d = readFileSync(join(h, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(d.every((x) => x.dry === true)).toBe(true);
    // 真实判断存成例子
    writeFileSync(join(h, "events.jsonl"), readFileSync(join(h, "events.jsonl"), "utf8") + `${JSON.stringify({ id: 99, at: "t", source: "slack", kind: "k", title: "#dev", url: null, from: "Carol", text: "PROJ-479 能加字段吗", why: ["mention"], keys: [], reply: {} })}\n`);
    run(h, "派了", "mark", "99", "forwarded");
    expect(chief(h, "eval", "from-event", "99")).toContain("应该：派人去办");
  });
});

describe("白名单", () => {
  it("名单里的人：回复的 policy 是 auto；不在名单里按场景", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), [
      { id: 1, at: "t", source: "slack", kind: "k", title: "私信", url: null, from: "Bob Lee", fromId: "U0BOB1234", text: "压测好了吗", why: ["dm"], keys: [], reply: { channel: "D1", ts: "1" } },
      { id: 2, at: "t", source: "slack", kind: "k", title: "私信", url: null, from: "Joe", fromId: "U0JOE1234", text: "能上线吗", why: ["dm"], keys: [], reply: { channel: "D2", ts: "1" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    yours(h, "bob lee", "trust", "add");
    writeFileSync(join(h, "drafts", "a.md"), "好了");
    expect(JSON.parse(chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "a.md")))).toMatchObject({ policy: "auto", trusted: true });
    expect(JSON.parse(chief(h, "reply", "add", "--event", "2", "--file", join(h, "drafts", "a.md")))).toMatchObject({ policy: "ask" });
    expect(chief(h, "rules")).toContain("- bob lee");
  });

  it("只认编号或完整的显示名：名字的一部分、改成像别人的名字都不算", async () => {
    const { isTrusted } = await import("../src/store");
    expect(isTrusted(["U0BOB1234"], "Mallory", "U0BOB1234")).toBe(true);
    expect(isTrusted(["U0BOB1234"], "U0BOB1234", "U0EVE9999")).toBe(false);
    expect(isTrusted([" Bob Lee "], "bob lee", "U0EVE9999")).toBe(true);
    expect(isTrusted(["bob"], "Bob Lee", "U0BOB1234")).toBe(false);
    expect(isTrusted(["bob lee"], "Bob Lee (ENG - QA)", "U0BOB1234")).toBe(false);
    expect(isTrusted(["bob lee"], "not bob lee", "U0EVE9999")).toBe(false);
    expect(isTrusted([""], "", "")).toBe(false);
    // 全大写、不带数字的名字不当成编号。
    expect(isTrusted(["WES"], "wes", "U0WES1234")).toBe(true);
  });
});

describe("放宽发送的规矩要你点头", () => {
  const rulesJson = (h: string) => JSON.parse(chief(h, "rules", "json")) as { scenarios: Record<string, { handle: string; reply: string }>; custom: { id: number; handle: string; reply: string }[]; trusted: string[]; quick: string[]; signature: string; notes: string[]; proposals: { id: number; text: string; change?: unknown }[] };

  it("不带钥匙：放宽的都变成提议，不生效；收紧的直接改", () => {
    const h = home();
    expect(chief(h, "rules", "set", "slack_dm", "reply=auto")).toContain("它提议的规矩");
    chief(h, "rules", "set", "custom:1", "handle=approve");
    withStdin(h, JSON.stringify({ when: "有人让我 approve", handle: "approve", reply: "ask" }), "rules", "custom", "add");
    withStdin(h, JSON.stringify({ when: "QA 的 bug", handle: "dispatch", reply: "auto" }), "rules", "custom", "add");
    withStdin(h, "U0EVE9999", "rules", "trust", "add");
    withStdin(h, "好的", "rules", "quick", "add");
    withStdin(h, "", "rules", "sign");
    let p = rulesJson(h);
    expect(p.scenarios.slack_dm!.reply).toBe("ask");
    expect(p.custom.map((c) => c.id)).toEqual([1]);
    expect(p.trusted).toEqual([]);
    expect(p.quick).toEqual([]);
    expect(p.signature).toBe("🤖 agent reply");
    // custom:1 本来就是直接 approve，没变：不算放宽，不提议。
    expect(p.proposals.map((x) => x.text)).toEqual([
      "「Slack 私信」改成：派人去办；回复直接发（发前 5 秒可撤回）",
      "加一种情况「有人让我 approve」：直接 approve PR；approve 前先问我",
      "加一种情况「QA 的 bug」：派人去办；回复直接发（发前 5 秒可撤回）",
      "白名单加上 U0EVE9999：回 ta 的话不用你确认直接发",
      "固定回复加上「好的」：回复正好是这句就不问你直接发",
      "Slack 回复不再加署名（对方看不出是 agent 代发的）",
    ]);
    // 收紧的不用钥匙。
    chief(h, "rules", "set", "custom:1", "reply=ask");
    chief(h, "rules", "set", "slack_self", "handle=note");
    p = rulesJson(h);
    expect(p.custom[0]).toMatchObject({ handle: "approve", reply: "ask" });
    expect(p.scenarios.slack_self!.handle).toBe("note");
    // 改回「当成我的指令」是放宽。
    chief(h, "rules", "set", "slack_self", "handle=command");
    expect(rulesJson(h).scenarios.slack_self!.handle).toBe("note");
  });

  it("主会话采纳不了放宽的提议；你在面板上点（带钥匙）才照原样生效；不要的不用钥匙", () => {
    const h = home();
    chief(h, "rules", "set", "slack_dm", "reply=auto");
    withStdin(h, "U0EVE9999", "rules", "trust", "add");
    withStdin(h, JSON.stringify({ when: "QA 的 bug", handle: "dispatch", reply: "auto" }), "rules", "custom", "add");
    const [a, b, c] = rulesJson(h).proposals.map((x) => String(x.id));
    expect(chiefFails(h, "rules", "accept", a!)).toContain("面板上点采纳");
    // 钥匙不对也不行。
    expect(() => withStdin(h, JSON.stringify({ key: "cd".repeat(32), text: "" }), "rules", "--yours", "accept", a!)).toThrow(/钥匙对不上/);
    yours(h, "", "accept", a!);
    yours(h, "", "accept", c!);
    chief(h, "rules", "reject", b!);
    const p = rulesJson(h);
    expect(p.scenarios.slack_dm!.reply).toBe("auto");
    expect(p.custom.find((x) => x.id === 2)).toMatchObject({ handle: "dispatch", reply: "auto" });
    expect(p.trusted).toEqual([]);
    expect(p.proposals).toEqual([]);
    // 采纳的是改动本身，不是一条文字规矩。
    expect(p.notes.some((n) => n.includes("Slack 私信"))).toBe(false);
  });

  it("主会话的文字提议照旧：采纳不用钥匙，进你写的规矩", () => {
    const h = home();
    const id = withStdin(h, JSON.stringify({ text: "Alice 问进度派活", basis: "你标错了" }), "rules", "propose").trim();
    chief(h, "rules", "accept", id);
    expect(rulesJson(h).notes).toContain("Alice 问进度派活");
  });
});

describe("一定问我", () => {
  it("名单里的人、对话：白名单、固定回复、直接发、直接 approve 都不放行", async () => {
    const { autoReason } = await import("../src/gate");
    const { defaultPolicy } = await import("../src/store");
    const base = { ...defaultPolicy(), trusted: ["U0BOB1234"], quick: ["好的"] };
    base.scenarios.slack_dm = { handle: "dispatch", reply: "auto" };
    const ev = { id: 1, at: "t", source: "slack" as const, kind: "message.received", title: "私信", url: null, from: "Bob Lee", fromId: "U0BOB1234", text: "x https://github.com/o/r/pull/4", why: ["dm"], keys: ["github.com/o/r/pull/4"], reply: { channel: "D0BOB1234", ts: "1.0" } };
    const r = { id: 1, event: 1, source: "slack" as const, target: { ...ev.reply }, context: { who: null, where: "", said: "", url: null }, body: "好的", status: "pending" as const, at: "t" };
    const approve = { ...r, kind: "approve" as const, source: "github" as const, target: { ref: "o/r#4" }, body: "", custom: 1 };
    expect(autoReason(r, base, ev)).toBe("固定回复");
    expect(autoReason({ ...r, body: "下午给你" }, base, ev)).toBe("白名单");
    expect(autoReason(approve, base, ev)).toBe("你加的情况 custom:1");
    for (const entry of ["U0BOB1234", "bob lee", "D0BOB1234"]) {
      const pol = { ...base, askAlways: [entry] };
      expect(autoReason(r, pol, ev)).toBeNull();
      expect(autoReason({ ...r, body: "下午给你" }, pol, ev)).toBeNull();
      expect(autoReason(approve, pol, ev)).toBeNull();
    }
    // 名字的一部分不算。
    expect(autoReason(r, { ...base, askAlways: ["bob"] }, ev)).toBe("固定回复");
  });

  it("chief rules always：加直接生效；删要你点头", () => {
    const h = home();
    writeFileSync(join(h, "events.jsonl"), `${JSON.stringify({ id: 1, at: "t", source: "slack", kind: "message.received", title: "私信", url: null, from: "Bob Lee", fromId: "U0BOB1234", text: "x", why: ["dm"], keys: [], reply: { channel: "D0BOB1234", ts: "1.0" } })}\n`);
    yours(h, "U0BOB1234", "trust", "add");
    withStdin(h, "U0BOB1234", "rules", "always", "add");
    expect(chief(h, "rules")).toContain("## 一定问我");
    writeFileSync(join(h, "drafts", "a.md"), "下午给你");
    expect(JSON.parse(chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "a.md")))).toMatchObject({ policy: "ask" });
    expect(chiefFails(h, "reply", "queue", "1", "--policy")).toContain("要你确认");
    expect(withStdin(h, "U0BOB1234", "rules", "always", "remove")).toContain("它提议的规矩");
    expect((JSON.parse(chief(h, "rules", "json")) as { askAlways: string[] }).askAlways).toEqual(["U0BOB1234"]);
    yours(h, "U0BOB1234", "always", "remove");
    expect((JSON.parse(chief(h, "rules", "json")) as { askAlways: string[] }).askAlways).toEqual([]);
    expect(chief(h, "reply", "queue", "1", "--policy")).toContain("白名单");
  });
});

describe("对账", () => {
  const ev = (id: number, extra: Record<string, unknown> = {}) => ({ id, at: "2026-11-19T00:00:00Z", source: "github", kind: "github.pr", title: `PR ${id}`, url: null, from: null, text: "", why: ["review"], keys: [], reply: {}, ...extra }) as never;
  it("交出去 10 分钟还没判断的算漏掉；判断过的、演练的、提醒本身不算", () => {
    const seen = new Map<number, number>();
    const events = [ev(1), ev(2), ev(3, { dryrun: true }), ev(4, { kind: "chief.missed" })];
    expect(missedEvents(events, { 2: {} }, seen, 0)).toEqual([]);
    expect(missedEvents(events, { 2: {} }, seen, 9 * 60_000)).toEqual([]);
    expect(missedEvents(events, { 2: {} }, seen, 10 * 60_000).map((e) => e.id)).toEqual([1]);
    expect(missedEvents(events, { 1: {}, 2: {} }, seen, 11 * 60_000)).toEqual([]);
    expect(seen.has(1)).toBe(false);
  });
  it("主会话 5 分钟没写 alive 算掉线；你让它停的不算", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(hubDown({ at: "2026-11-19T09:58:00Z" }, now)).toBe(false);
    expect(hubDown({ at: "2026-11-19T09:54:00Z" }, now)).toBe(true);
    expect(hubDown({}, now)).toBe(true);
    expect(hubDown({ at: "2026-11-19T09:00:00Z", stopped: true }, now)).toBe(false);
  });
});

describe("归档", () => {
  it("办完超过 7 天的搬走，没判断的、还在办的、没发出去的留着；chief show 还能看老事件", () => {
    const h = home();
    const old = "2026-10-01T00:00:00.000Z";
    const fresh = new Date().toISOString();
    const ev = (id: number) => JSON.stringify({ id, at: old, source: "slack", kind: "message.received", title: `t${id}`, url: null, from: "a", text: `消息 ${id}`, why: ["dm"], keys: [], reply: {} });
    writeFileSync(join(h, "events.jsonl"), `${[1, 2, 3].map(ev).join("\n")}\n`);
    writeFileSync(join(h, "state.json"), JSON.stringify({ nextId: 4 }));
    writeFileSync(join(h, "dispatch.json"), JSON.stringify({ 1: { status: "noted", at: old }, 2: { status: "noted", at: fresh } }));
    writeFileSync(join(h, "decisions.jsonl"), `${JSON.stringify({ at: old, event: 1, verdict: "noted" })}\n${JSON.stringify({ at: fresh, event: 2, verdict: "noted" })}\n`);
    writeFileSync(join(h, "things.json"), JSON.stringify({ nextThing: 3, nextAsk: 3, things: [
      { id: 1, title: "旧的", status: "done", progress: "", events: [], updatedAt: old, log: [] },
      { id: 2, title: "在做", status: "doing", progress: "", events: [], updatedAt: old, log: [] },
    ], asks: [{ id: 1, thing: 1, question: "q", suggest: "", status: "answered", at: old }, { id: 2, thing: 2, question: "q2", suggest: "", status: "open", at: old }] }));
    writeFileSync(join(h, "replies.json"), JSON.stringify({ nextId: 3, items: [
      { id: 1, event: 1, source: "slack", target: {}, context: {}, body: "b", status: "sent", sentAt: old, at: old },
      { id: 2, event: 1, source: "slack", target: {}, context: {}, body: "b", status: "failed", at: old },
    ] }));
    expect(chief(h, "archive")).toContain("事件 1、判断 1、事情 1、问题 1、回复 1");
    expect(readFileSync(join(h, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id)).toEqual([2, 3]);
    const things = JSON.parse(readFileSync(join(h, "things.json"), "utf8"));
    expect(things.things.map((t: { id: number }) => t.id)).toEqual([2]);
    expect(things.asks.map((a: { id: number }) => a.id)).toEqual([2]);
    expect(JSON.parse(readFileSync(join(h, "replies.json"), "utf8")).items.map((r: { id: number }) => r.id)).toEqual([2]);
    expect(readFileSync(join(h, "archive", "events-2026-10.jsonl"), "utf8")).toContain("消息 1");
    expect(chief(h, "show", "1")).toContain("消息 1");
    expect(chief(h, "archive")).toContain("事件 0、判断 0、事情 0、问题 0、回复 0");
  });
});

describe("放在哪", () => {
  it("默认都在工作目录：数据在 data/，规矩在最上层的 rules.json；数据指到别处时规矩跟着数据", () => {
    const ws = workspaceDir();
    expect(paths(join(ws, "data")).events).toBe(join(ws, "data", "events.jsonl"));
    expect(paths(join(ws, "data")).policy).toBe(join(ws, "rules.json"));
    expect(paths("/tmp/x").policy).toBe("/tmp/x/rules.json");
  });
});

describe("插电时不让电脑睡", () => {
  it("默认开；chief awake off / on 切换，doctor 用的设置跟着变", () => {
    const h = home();
    expect(chief(h, "awake")).toContain("开");
    expect(chief(h, "awake", "off")).toContain("关");
    expect(JSON.parse(readFileSync(join(h, "settings.json"), "utf8"))).toEqual({ version: 1, awake: false });
    expect(chief(h, "awake", "on")).toContain("开");
    expect(chiefFails(h, "awake", "maybe")).toContain("chief awake");
  });
});

describe("Slack 登录窗口", () => {
  it("从工作区地址登：几种写法都认，乱写的拒收", async () => {
    const { workspaceUrl } = await import("../src/slack/login");
    expect(workspaceUrl("acme")).toBe("https://acme.slack.com/");
    expect(workspaceUrl("Acme.slack.com")).toBe("https://acme.slack.com/");
    expect(workspaceUrl("https://acme-eng.slack.com/")).toBe("https://acme-eng.slack.com/");
    expect(() => workspaceUrl("evil.com/?x=")).toThrow();
    expect(() => workspaceUrl("a b")).toThrow();
  });
  it("chief connect slack --workspace 写得不对：不开窗口，直接说怎么写", () => {
    expect(chiefFails(home(), "connect", "slack", "--workspace", "evil.com/?x=")).toContain("工作区写成 acme");
  });
});

describe("GitHub 上不报的机器人", () => {
  const run = (h: string, input: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
  it("chief rules bot add / remove：名单记在规矩里，登录名不对拒收", () => {
    const h = home();
    expect(run(h, "Acme-Review", "rules", "bot", "add")).toContain("acme-review");
    expect((JSON.parse(chief(h, "rules", "json")) as { bots: string[] }).bots).toEqual(["acme-review"]);
    expect(chief(h, "rules")).toContain("- acme-review");
    expect(() => run(h, "not a login; rm -rf", "rules", "bot", "add")).toThrow();
    run(h, "acme-review", "rules", "bot", "remove");
    expect((JSON.parse(chief(h, "rules", "json")) as { bots: string[] }).bots).toEqual([]);
  });
});

describe("回复附图", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const run = (h: string, input: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, CHIEF_HOME: h }, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

  it("只认真的图片：看文件开头，不看扩展名；软链接、太大的不收；收下复制一份", async () => {
    const { sniffImage, takeImage } = await import("../src/images");
    expect(sniffImage(PNG)?.mime).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a..."))?.mime).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))?.mime).toBe("image/webp");
    const d = home();
    writeFileSync(join(d, "arch.png"), PNG);
    writeFileSync(join(d, "secret.png"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    symlinkSync(join(d, "arch.png"), join(d, "link.png"));
    writeFileSync(join(d, "huge.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    const got = takeImage(join(d, "arch.png"), join(d, "out"), "r1-1");
    expect(got).toMatchObject({ name: "arch.png", mime: "image/png", bytes: PNG.length });
    expect(readFileSync(got.file)).toEqual(PNG);
    // 原文件后来被改了，发的还是收下时那份。
    writeFileSync(join(d, "arch.png"), "changed");
    expect(readFileSync(got.file)).toEqual(PNG);
    expect(() => takeImage(join(d, "secret.png"), join(d, "out"), "x")).toThrow("不是图片");
    expect(() => takeImage(join(d, "link.png"), join(d, "out"), "x")).toThrow("链接");
    expect(() => takeImage(join(d, "huge.png"), join(d, "out"), "x")).toThrow("10MB");
  });

  it("chief reply add --image：Slack 的回复带上图；GitHub 的拒收", () => {
    const h = home();
    run(h, "帮我看下架构", "test", "--from", "Alice");
    writeFileSync(join(h, "arch.png"), PNG);
    mkdirSync(join(h, "drafts"), { recursive: true });
    writeFileSync(join(h, "drafts", "1-a.md"), "架构图在下面");
    run(h, "", "reply", "add", "--event", "1", "--file", join(h, "drafts", "1-a.md"), "--image", join(h, "arch.png"));
    const r = (JSON.parse(chief(h, "reply", "list")) as { images?: { file: string; name: string }[] }[])[0]!;
    expect(r.images?.map((i) => i.name)).toEqual(["arch.png"]);
    expect(r.images?.[0]?.file.startsWith(join(h, "drafts", "images"))).toBe(true);
    // GitHub 的评论只发文字：带图直接拒收，什么都不存。
    const gh = { id: 9, at: "t", source: "github", kind: "github.pr", title: "o/r#44", url: null, from: "bob", text: "看下", why: ["mention"], keys: [], reply: { ref: "o/r#44" } };
    writeFileSync(join(h, "events.jsonl"), `${readFileSync(join(h, "events.jsonl"), "utf8")}${JSON.stringify(gh)}\n`);
    expect(() => run(h, "", "reply", "add", "--event", "9", "--file", join(h, "drafts", "1-a.md"), "--image", join(h, "arch.png"))).toThrow(/只有 Slack 的回复能附图/);
    expect((JSON.parse(chief(h, "reply", "list")) as unknown[]).length).toBe(1);
  });

  it("发：正文发完，图发到同一个 thread；没发上的说出名字", async () => {
    const { SlackPlugin } = await import("../src/slack/plugin");
    const uploads: unknown[] = [];
    let fail = false;
    const fake = {
      selfUserId: "U0ME",
      core: { callWebApi: async () => ({}) },
      on: () => {}, onError: () => {}, start: async () => {}, stop: async () => {},
      chat: { send: async (opts: { channel: string }) => ({ channel: opts.channel, ts: "9.0" }) },
      reactions: { add: async () => {} },
      files: { upload: async (opts: { filename: string; channel?: string; threadTs?: string; mimeType?: string }) => { if (fail) throw new Error("file_uploads_disabled"); uploads.push({ filename: opts.filename, channel: opts.channel, threadTs: opts.threadTs, mimeType: opts.mimeType }); } },
    };
    const plugin = new SlackPlugin({ createClient: async () => fake });
    await plugin.start({ secrets: { cookie_d: "xoxd-x" }, deliver: async () => {}, threadSeen: () => false, status: () => {}, log: () => {} });
    const d = home();
    writeFileSync(join(d, "a.png"), PNG);
    const sent = await plugin.send({ channel: "C1", ts: "1.0" }, "架构图在下面", true);
    expect(await plugin.sendImages(sent, [{ file: join(d, "a.png"), name: "arch.png", mime: "image/png" }])).toEqual([]);
    expect(uploads).toEqual([{ filename: "arch.png", channel: "C1", threadTs: "1.0", mimeType: "image/png" }]);
    fail = true;
    expect(await plugin.sendImages(sent, [{ file: join(d, "a.png"), name: "arch.png", mime: "image/png" }])).toEqual(["arch.png：file_uploads_disabled"]);
    await plugin.stop();
  });

  it("图和正文在一起：发到频道的新消息、直接回在频道里的，图进正文自己的 thread；回 thread 的进同一个 thread；私信里直接回的图紧跟在下面", async () => {
    const { SlackPlugin, imageThreadOf } = await import("../src/slack/plugin");
    const uploads: { filename: string; channel: string | undefined; threadTs: string | undefined }[] = [];
    let n = 0;
    const fake = {
      selfUserId: "U0ME",
      core: { callWebApi: async (method: string) => (method === "conversations.open" ? { channel: { id: "D7" } } : {}) },
      on: () => {}, onError: () => {}, start: async () => {}, stop: async () => {},
      chat: { send: async (opts: { channel: string }) => ({ channel: opts.channel, ts: `${++n}0.0` }) },
      reactions: { add: async () => {} },
      files: { upload: async (opts: { filename: string; channel?: string; threadTs?: string }) => { uploads.push({ filename: opts.filename, channel: opts.channel, threadTs: opts.threadTs }); } },
    };
    const plugin = new SlackPlugin({ createClient: async () => fake });
    await plugin.start({ secrets: { cookie_d: "xoxd-x" }, deliver: async () => {}, threadSeen: () => false, status: () => {}, log: () => {} });
    const d = home();
    writeFileSync(join(d, "a.png"), PNG);
    const two = [{ file: join(d, "a.png"), name: "a.png", mime: "image/png" }, { file: join(d, "a.png"), name: "b.png", mime: "image/png" }];
    const imagesOf = async (sent: Parameters<typeof imageThreadOf>[0]) => {
      uploads.length = 0;
      expect(await plugin.sendImages(sent, two)).toEqual([]);
      return uploads.map((u) => `${u.filename}@${u.channel}/${u.threadTs ?? "顶层"}`);
    };
    // chief reply new --to <频道>：正文是频道里的新消息（ts 10.0），两张图都进它的 thread。
    expect(await imagesOf(await plugin.sendNew("C2", "问下 PM"))).toEqual(["a.png@C2/10.0", "b.png@C2/10.0"]);
    // 直接回在频道里（规矩把频道设成 inline）：图进这条回复自己的 thread。
    expect(await imagesOf(await plugin.send({ channel: "C1", ts: "1.0", audience: "channel" }, "看图", false))).toEqual(["a.png@C1/20.0", "b.png@C1/20.0"]);
    // 回到对方那条的 thread / 对方本来就在 thread 里：图进同一个 thread（原来就是这样）。
    expect(await imagesOf(await plugin.send({ channel: "C1", ts: "1.0", audience: "channel" }, "看图", true))).toEqual(["a.png@C1/1.0", "b.png@C1/1.0"]);
    expect(await imagesOf(await plugin.send({ channel: "C1", ts: "1.5", thread_ts: "1.0", audience: "channel" }, "看图", false))).toEqual(["a.png@C1/1.0", "b.png@C1/1.0"]);
    // 发到帖子的 thread（reply new --to <消息链接>）：进那个 thread。
    expect(await imagesOf(await plugin.sendNew("C2", "补一张图", "5.0"))).toEqual(["a.png@C2/5.0", "b.png@C2/5.0"]);
    // 私信、群聊里直接回在对话里：图紧跟在正文下面，照旧顶层。
    expect(await imagesOf(await plugin.send({ channel: "D1", ts: "2.0", audience: "direct" }, "看图", false))).toEqual(["a.png@D1/顶层", "b.png@D1/顶层"]);
    expect(await imagesOf(await plugin.send({ channel: "C9", ts: "2.0", audience: "group" }, "看图", false))).toEqual(["a.png@C9/顶层", "b.png@C9/顶层"]);
    expect(await imagesOf(await plugin.sendNew("U0ABC123", "jk 你好"))).toEqual(["a.png@D7/顶层", "b.png@D7/顶层"]);
    await plugin.stop();
  });
});

describe("谁能让回复发出去：引擎把关，不靠主会话自觉", () => {
  const draft = (h: string, name: string, text: string) => {
    mkdirSync(join(h, "drafts"), { recursive: true });
    writeFileSync(join(h, "drafts", name), text);
    return join(h, "drafts", name);
  };
  // 一条真的 Slack 私信（不是 chief test 造的：那种的回复本来就发不出去）。
  const setup = () => {
    const h = home();
    const ev = { id: 1, at: "t", source: "slack", kind: "message.received", title: "Alice 的私信", url: null, from: "Alice", fromId: "U0ALICE", text: "帮我看下这个", why: ["dm"], keys: [], reply: { channel: "D0ALICE", ts: "1795079290.188699" } };
    writeFileSync(join(h, "events.jsonl"), `${JSON.stringify(ev)}\n`);
    return h;
  };
  const status = (h: string, id: number) => (JSON.parse(chief(h, "reply", "list", "--all")) as { id: number; status: string; by?: string; confirm?: { how: string; said?: string }; confirmAsk?: unknown }[]).find((r) => r.id === id)!;

  it("不带 --policy 的 queue 拒掉，告诉主会话该怎么办", () => {
    const h = setup();
    chief(h, "reply", "add", "--event", "1", "--file", draft(h, "a.md", "好的，今天合"));
    expect(chiefFails(h, "reply", "queue", "1")).toContain("ask-confirm");
    expect(status(h, 1).status).toBe("pending");
  });

  it("--policy：引擎按规矩再算一遍，要问你的发不出去；场景设了直接发的放行", () => {
    const h = setup();
    chief(h, "reply", "add", "--event", "1", "--file", draft(h, "a.md", "好的，今天合"));
    // 私信默认「回复先问你」：主会话说规矩允许也没用。
    expect(chiefFails(h, "reply", "queue", "1", "--policy")).toContain("要你确认");
    expect(status(h, 1).status).toBe("pending");
    yours(h, "", "set", "slack_dm", "reply=auto");
    expect(chief(h, "reply", "queue", "1", "--policy")).toContain("按规矩直接发");
    expect(status(h, 1)).toMatchObject({ status: "queued", by: "policy" });
  });

  it("固定回复：一字不差才放行，多一个字都不行", () => {
    const h = setup();
    yours(h, "approve 了 ✅", "quick", "add");
    chief(h, "reply", "add", "--event", "1", "--file", draft(h, "a.md", "approve 了 ✅，明天上线"));
    expect(chiefFails(h, "reply", "queue", "1", "--policy")).toContain("要你确认");
    chief(h, "reply", "add", "--event", "1", "--file", draft(h, "b.md", "approve 了 ✅"));
    expect(chief(h, "reply", "queue", "2", "--policy")).toContain("固定回复");
  });

  it("固定回复只用来回收到的那条消息、回到它自己的地方：主动发的新消息、改了去处的都要你确认", async () => {
    const { autoReason } = await import("../src/gate");
    const { defaultPolicy } = await import("../src/store");
    const pol = { ...defaultPolicy(), quick: ["收到 👍"] };
    const ev = { id: 1, at: "t", source: "slack" as const, kind: "message.received", title: "私信", url: null, from: "Alice", fromId: "U0ALICE", text: "x", why: ["dm"], keys: [], reply: { channel: "D0ALICE", ts: "1.0" } };
    const r = { id: 1, event: 1, source: "slack" as const, target: { ...ev.reply }, context: { who: null, where: "", said: "", url: null }, body: "收到 👍", status: "pending" as const, at: "t" };
    expect(autoReason(r, pol, ev)).toBe("固定回复");
    expect(autoReason({ ...r, target: { ...ev.reply, in: "thread" } }, pol, ev)).toBe("固定回复");
    // 换了去处：别的频道、别的帖子、多了别的字段。
    expect(autoReason({ ...r, target: { channel: "C0OTHER1", ts: "1.0" } }, pol, ev)).toBeNull();
    expect(autoReason({ ...r, target: { ...ev.reply, ts: "2.0" } }, pol, ev)).toBeNull();
    expect(autoReason({ ...r, target: { ...ev.reply, thread_ts: "9.0" } }, pol, ev)).toBeNull();
    // 主动发的新消息（reply new）、对不上事件的：一律问你。
    expect(autoReason({ ...r, kind: "message", event: 0, target: { to: "U0ALICE" } }, pol, null)).toBeNull();
    expect(autoReason({ ...r, event: 2 }, pol, ev)).toBeNull();
    // approve 的附言正好是固定回复：不算。
    expect(autoReason({ ...r, kind: "approve", source: "github", target: { ref: "o/r#1" } }, pol, { ...ev, source: "github", reply: { ref: "o/r#1" } })).toBeNull();
  });

  it("reply new 发的固定回复：queue --policy 拒掉", () => {
    const h = setup();
    yours(h, "收到 👍", "quick", "add");
    chief(h, "reply", "new", "--to", "U0EVE9999", "--file", draft(h, "n.md", "收到 👍"));
    expect(chiefFails(h, "reply", "queue", "1", "--policy")).toContain("要你确认");
    expect(status(h, 1).status).toBe("pending");
  });

  it("做事方式对排队的影响：normal 都问；auto 只放别人 PR 的 approve 和自己 PR 上的回复；yolo 连 Slack 回复、新消息也放，名单拦得住", () => {
    const h = setup();
    const gh = { id: 2, at: "t", source: "github", kind: "github.pr", title: "o/r#7", url: null, from: "Carol", fromId: null, text: "请你 review", why: ["review"], keys: ["github.com/o/r/pull/7"], reply: { ref: "o/r#7" } };
    const own = { ...gh, id: 3, title: "o/r#8", text: "别人评论了我的 PR", why: ["comment"], keys: ["github.com/o/r/pull/8"], reply: { ref: "o/r#8" } };
    writeFileSync(join(h, "events.jsonl"), `${readFileSync(join(h, "events.jsonl"), "utf8")}${JSON.stringify(gh)}\n${JSON.stringify(own)}\n`);
    let n = 0;
    const add = (event: number) => JSON.parse(chief(h, "reply", "add", "--event", String(event), "--file", draft(h, `m${n++}.md`, `下午给你 ${n}`))) as { id: number; policy: string };
    // normal：都问。
    expect(add(1).policy).toBe("ask");
    expect(add(2).policy).toBe("ask");
    // auto：approve 别人的 PR、回我自己 PR 上的话放；回别人的话（Slack、GitHub）还问。
    yours(h, "", "mode", "auto");
    expect(add(1).policy).toBe("ask");
    expect(add(2).policy).toBe("ask");
    const g = add(3);
    expect(g.policy).toBe("auto");
    expect(chief(h, "reply", "queue", String(g.id), "--policy")).toContain("模式 auto（我自己的 PR）");
    const ap = JSON.parse(chief(h, "reply", "approve", "--event", "2", "--ref", "o/r#7")) as { id: number; policy: string };
    expect(ap.policy).toBe("auto");
    expect(chief(h, "reply", "queue", String(ap.id), "--policy")).toContain("模式 auto（别人的 PR）");
    // yolo：Slack 回复也放；主动发的新消息仍问（频道、人都一样）。
    yours(h, "", "mode", "yolo");
    const s = add(1);
    expect(s.policy).toBe("auto");
    expect(chief(h, "reply", "queue", String(s.id), "--policy")).toContain("模式 yolo");
    const fresh = JSON.parse(chief(h, "reply", "new", "--to", "C0NEWCHAN1", "--file", draft(h, "n1.md", "新话题"))) as { id: number; policy: string };
    expect(fresh.policy).toBe("ask");
    expect(chiefFails(h, "reply", "queue", String(fresh.id), "--policy")).toContain("要你确认");
    const toUser = JSON.parse(chief(h, "reply", "new", "--to", "U0SOMEONE99", "--file", draft(h, "n3.md", "私下说一句"))) as { id: number; policy: string };
    expect(toUser.policy).toBe("ask");
    expect(chiefFails(h, "reply", "queue", String(toUser.id), "--policy")).toContain("要你确认");
    withStdin(h, "C0BLOCKED1", "rules", "always", "add");
    const blocked = JSON.parse(chief(h, "reply", "new", "--to", "C0BLOCKED1", "--file", draft(h, "n2.md", "新话题 2"))) as { id: number };
    expect(chiefFails(h, "reply", "queue", String(blocked.id), "--policy")).toContain("要你确认");
    // 降回 normal：又都问了。
    chief(h, "rules", "mode", "normal");
    expect(add(2).policy).toBe("ask");
  });

  it("approve 只能 approve 这条消息自己的 PR", () => {
    const h = home();
    writeFileSync(join(h, "events.jsonl"), [
      { id: 1, at: "t", source: "github", kind: "github.pr", title: "o/r#7", url: null, from: null, text: "请你 review，顺便看看 https://github.com/o/r/pull/8", why: ["review"], keys: ["github.com/o/r/pull/7", "github.com/o/r/pull/8"], reply: { ref: "o/r#7" } },
      { id: 2, at: "t", source: "slack", kind: "message.received", title: "#dev", url: null, from: "Alice", fromId: "U0ALICE", text: "帮忙 approve https://github.com/o/r/pull/44", why: ["mention"], keys: ["slack:C1:1.0", "github.com/o/r/pull/44"], reply: { channel: "C0DEV123", ts: "1.0" } },
      { id: 3, at: "t", source: "slack", kind: "message.received", title: "#dev", url: null, from: "Alice", fromId: "U0ALICE", text: "在吗", why: ["mention"], keys: ["slack:C1:2.0"], reply: { channel: "C0DEV123", ts: "2.0" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    // GitHub 的事件：只能是它自己的 PR，原文里提到的别的 PR 不行。
    expect(chiefFails(h, "reply", "approve", "--event", "1", "--ref", "o/r#8")).toContain("o/r#7");
    expect(JSON.parse(chief(h, "reply", "approve", "--event", "1", "--ref", "o/r#7"))).toMatchObject({ ref: "o/r#7", policy: "ask" });
    // Slack 里贴的 PR 链接：就是它；按默认的 custom:1 可以直接发，记下是按哪条情况。
    expect(chiefFails(h, "reply", "approve", "--event", "2", "--ref", "o/r#45", "--custom", "1")).toContain("o/r#44");
    expect(JSON.parse(chief(h, "reply", "approve", "--event", "2", "--ref", "o/r#44", "--custom", "1"))).toMatchObject({ ref: "o/r#44", policy: "auto" });
    expect(chief(h, "reply", "queue", "2", "--policy")).toContain("custom:1");
    const r = (JSON.parse(chief(h, "reply", "list", "--all")) as { id: number; custom?: number; status: string }[]).find((x) => x.id === 2);
    expect(r).toMatchObject({ custom: 1, status: "queued" });
    // 消息里没有 PR：不能 approve。
    expect(chiefFails(h, "reply", "approve", "--event", "3", "--ref", "o/r#44")).toContain("没有 PR");
  });

  it("以你的名义发要钥匙：不对的不行；配过的钥匙不能偷偷换，你 reset 了才能重配", () => {
    const h = setup();
    chief(h, "reply", "add", "--event", "1", "--file", draft(h, "a.md", "好的"));
    withStdin(h, KEY, "key", "set");
    const other = "cd".repeat(32);
    expect(() => withStdin(h, other, "key", "set")).toThrow(/已经配过/);
    expect(() => withStdin(h, JSON.stringify({ key: other, how: "panel" }), "reply", "confirm", "1")).toThrow(/钥匙对不上/);
    expect(() => withStdin(h, JSON.stringify({ key: KEY, how: "chat" }), "reply", "confirm", "1")).toThrow(/原话/);
    withStdin(h, JSON.stringify({ key: KEY, how: "chat", said: "发吧" }), "reply", "confirm", "1");
    expect(status(h, 1)).toMatchObject({ status: "queued", by: "you", confirm: { how: "chat", said: "发吧" } });
    // 主会话没有终端：清不掉。
    expect(chiefFails(h, "key", "reset")).toContain("终端");
    expect(withStdin(h, KEY, "key", "check")).toContain("对上了");
    // 你在终端里清（这里用 script 给它一个终端），插件重新加载时配新的。
    resetInTerminal(h, "reset");
    withStdin(h, other, "key", "set");
    expect(withStdin(h, other, "key", "check")).toContain("对上了");
  });

  it("清钥匙要在终端里敲 reset；清、换都记下来（面板据此一直挂着提醒）", () => {
    const h = setup();
    withStdin(h, KEY, "key", "set");
    // 插件每次加载都 set 同一把：不算换。
    withStdin(h, KEY, "key", "set");
    const log = () => readFileSync(join(h, "key-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { what: string; tty?: boolean });
    expect(log().map((x) => x.what)).toEqual(["first"]);
    // 没敲对：不清。
    expect(() => resetInTerminal(h, "yes")).toThrow();
    expect(withStdin(h, KEY, "key", "check")).toContain("对上了");
    resetInTerminal(h, "reset");
    expect(() => withStdin(h, KEY, "key", "check")).toThrow(/对不上/);
    withStdin(h, "cd".repeat(32), "key", "set");
    expect(log().map((x) => x.what)).toEqual(["first", "reset", "set"]);
    expect(log()[1]!.tty).toBe(true);
  });

  it("钥匙文件被直接删了再配一把：照样记成换了钥匙", () => {
    const h = setup();
    withStdin(h, KEY, "key", "set");
    unlinkSync(join(h, "confirm-key.sha256"));
    withStdin(h, "cd".repeat(32), "key", "set");
    expect(readFileSync(join(h, "key-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).what)).toEqual(["first", "set"]);
  });

  it("以前配的钥匙没有记录：插件下次加载时补一行，之后被删了再配也认得出", () => {
    const h = setup();
    withStdin(h, KEY, "key", "set");
    unlinkSync(join(h, "key-log.jsonl"));
    withStdin(h, KEY, "key", "set");
    expect(readFileSync(join(h, "key-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).what)).toEqual(["first"]);
  });

  it("ask-confirm 只记下请求，不发：等插件核对你真的说过", () => {
    const h = setup();
    chief(h, "reply", "add", "--event", "1", "--file", draft(h, "a.md", "好的"));
    chief(h, "reply", "ask-confirm", "1");
    expect(status(h, 1).status).toBe("pending");
    expect(status(h, 1).confirmAsk).toBeTruthy();
  });
});

describe("写给你看的话里不许有 chief 自己的编号", () => {
  function fails(h: string, input: string, ...args: string[]): string {
    try {
      withStdin(h, input, ...args);
    } catch (error) {
      return String((error as { stderr?: string }).stderr);
    }
    throw new Error("没失败");
  }
  const slackEvent = (id: number) => JSON.stringify({ id, at: "t", source: "slack", kind: "message.received", title: "私信", url: null, from: "Joe", fromId: "U9", text: "能本周上线吗", why: ["dm"], keys: [], reply: { channel: "D1", ts: `${id}.0` } });
  const githubEvent = (id: number) => JSON.stringify({ id, at: "t", source: "github", kind: "github.pr", title: "o/r#44", url: null, from: "bob", text: "看下", why: ["mention"], keys: [], reply: { ref: "o/r#44" } });

  it("问题和建议：带 #98、回复 107 的拒收，什么都不记；提待发出的那条用 --reply 挂上", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${slackEvent(1)}\n`);
    withStdin(h, "", "thing", "add", "--title", "Joe 问上线时间");
    writeFileSync(join(h, "drafts", "1.md"), "下周二上线");
    chief(h, "reply", "add", "--event", "1", "--thing", "1", "--file", join(h, "drafts", "1.md"));
    const err = fails(h, JSON.stringify({ question: "Joe 问能不能本周上线", suggest: "先发 #1，再回他" }), "ask", "add", "--thing", "1");
    expect(err).toContain("建议（suggest）里有看的人看不懂的编号：「#1」");
    expect(err).toContain("--reply");
    expect(fails(h, JSON.stringify({ question: "回复 1 要不要发？", suggest: "发" }), "ask", "add", "--thing", "1")).toContain("「回复 1」");
    expect(JSON.parse(chief(h, "ask", "list"))).toEqual([]);
    // 一句话说清是哪条，再用 --reply 挂上那条回复。
    withStdin(h, JSON.stringify({ question: "Joe 问能不能本周上线", suggest: "发给 Joe 的那条回复：下周二上线" }), "ask", "add", "--thing", "1", "--reply", "1");
    expect(JSON.parse(chief(h, "ask", "list"))[0]).toMatchObject({ reply: 1, suggest: "发给 Joe 的那条回复：下周二上线" });
    expect(fails(h, JSON.stringify({ question: "要发吗" }), "ask", "add", "--thing", "1", "--reply", "9")).toContain("没有回复 9");
    // PR、Jira 单照常写。
    expect(fails(h, JSON.stringify({ question: "o/r#44 能合吗？", suggest: "合" }), "ask", "add", "--thing", "1")).toContain("「o/r#44」");
    withStdin(h, JSON.stringify({ question: "o/r#44（接口加字段）能合吗？PROJ-35189（下单接口加字段）要一起上", suggest: "合，见 https://github.com/o/r/pull/44" }), "ask", "add", "--thing", "1");
    expect(JSON.parse(chief(h, "ask", "list"))).toHaveLength(2);
  });

  it("事情的标题、进展、下一步、卡在哪、结果：带 chief 编号的拒收", () => {
    const h = home();
    expect(fails(h, "", "thing", "add", "--title", "跟进 #63")).toContain("标题里有看的人看不懂的编号：「#63」");
    // 标题本身就在说这个 PR 是什么：带仓库名的编号不用括号；单写的、光秃秃的编号照样拦。
    expect(fails(h, "", "thing", "add", "--title", "o/r#12")).toContain("「o/r#12」");
    expect(withStdin(h, "", "thing", "add", "--title", "o/r#12 登录超时 review").trim()).toBe("1");
    expect(fails(h, "等事件 #552 的人回话", "thing", "update", "1")).toContain("进展里有");
    expect(fails(h, JSON.stringify({ progress: "改完了", next: "等问题 #3 拍板" }), "thing", "update", "1")).toContain("下一步里有");
    expect(fails(h, JSON.stringify({ blocker: "回复 12 没发出去" }), "thing", "update", "1")).toContain("卡在哪里有");
    expect(fails(h, JSON.stringify({ result: "PR #45 开好了" }), "thing", "update", "1")).toContain("结果里有");
    expect(JSON.parse(chief(h, "thing", "list"))[0]).toMatchObject({ progress: "", log: [] });
    withStdin(h, JSON.stringify({ progress: "改完了", result: "[PR #45](https://github.com/o/r/pull/45) 开好了，PROJ-35189（下单接口加字段）已提测" }), "thing", "update", "1");
    expect(JSON.parse(chief(h, "thing", "list"))[0]).toMatchObject({ progress: "改完了", results: ["[PR #45](https://github.com/o/r/pull/45) 开好了，PROJ-35189（下单接口加字段）已提测"] });
  });

  it("回复正文：Slack 的拒收 #12；回 GitHub 的放行 #12（GitHub 自己会链过去）；你在面板上自己改的稿子带钥匙照原样收", () => {
    const h = home();
    chief(h, "cursor");
    writeFileSync(join(h, "events.jsonl"), `${slackEvent(1)}\n${githubEvent(2)}\n`);
    writeFileSync(join(h, "drafts", "bad.md"), "已经在 #12 修了");
    expect(chiefFails(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "bad.md"))).toContain("回复正文里有看的人看不懂的编号：「#12」");
    expect(chiefFails(h, "reply", "new", "--to", "U0ABC123", "--file", join(h, "drafts", "bad.md"))).toContain("消息正文里有");
    expect(JSON.parse(chief(h, "reply", "list"))).toEqual([]);
    // GitHub 的评论里 #12 是同一个仓库的 PR。
    expect(JSON.parse(chief(h, "reply", "add", "--event", "2", "--file", join(h, "drafts", "bad.md")))).toMatchObject({ id: 1, source: "github" });
    writeFileSync(join(h, "drafts", "ok.md"), "已经在 acme/shop#12（登录超时那个 PR）修了：https://github.com/acme/shop/pull/12");
    expect(JSON.parse(chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "ok.md")))).toMatchObject({ id: 2, source: "slack" });
    // 主会话改稿一样拦。
    expect(fails(h, "按回复 1 的意思改", "reply", "edit", "2")).toContain("「回复 1」");
    expect(fails(h, "见 #12", "reply", "edit", "2")).toContain("「#12」");
    withStdin(h, "见 #13", "reply", "edit", "1");
    // 你在面板上自己改的：带钥匙照原样收；钥匙不对不收。
    withStdin(h, KEY, "key", "set");
    expect(fails(h, JSON.stringify({ key: "cd".repeat(32), text: "见 #12" }), "reply", "edit-yours", "2")).toContain("钥匙对不上");
    withStdin(h, JSON.stringify({ key: KEY, text: "见 #12，我自己写的" }), "reply", "edit-yours", "2");
    const items = JSON.parse(chief(h, "reply", "list")) as { id: number; body: string }[];
    expect(items.map((r) => r.body)).toEqual(["见 #13", "见 #12，我自己写的"]);
  });
});

describe("发送失败文案", () => {
  // 用库自己的错误类，顺便锁住 code 字段名和取值。
  const timeout = async (code: "NETWORK_TIMEOUT" | "SERVER_ERROR" | "CANCELLED" | "SLACK_API_ERROR", message: string) => {
    const { GabrielError } = await import("gabriel-slack");
    return new GabrielError(code, message);
  };

  it("库认为可能已发出的三种错：提示 Slack 可能已经收到，请先确认再重发，并带原文", async () => {
    for (const code of ["NETWORK_TIMEOUT", "SERVER_ERROR", "CANCELLED"] as const) {
      const text = describeSendError(await timeout(code, "chat.postMessage exceeded itemDeadlineMs"));
      expect(text).toContain("可能已经收到");
      expect(text).toContain("先到 Slack 确认");
      expect(text).toContain("chat.postMessage exceeded itemDeadlineMs");
    }
  });

  it("可能已发出的错，原文只留前 120 字", async () => {
    const text = describeSendError(await timeout("NETWORK_TIMEOUT", `${"a".repeat(120)}${"b".repeat(50)}`));
    expect(text).toContain("a".repeat(120));
    expect(text).not.toContain("b");
  });

  it("其它错保持原文：Slack 明确拒绝的、普通 Error、不是 Error 的值", async () => {
    const rejected = describeSendError(await timeout("SLACK_API_ERROR", "channel_not_found"));
    expect(rejected).toBe("channel_not_found");
    expect(describeSendError(new Error("对方的频道不见了"))).toBe("对方的频道不见了");
    expect(describeSendError("boom")).toBe("boom");
    expect(describeSendError(undefined)).toBe("undefined");
    expect(describeSendError(null)).toBe("null");
    expect(`${rejected}${describeSendError(new Error("x"))}`).not.toContain("可能已经收到");
  });

  it("其它错超长：原文保持只留前 200 字", () => {
    expect(describeSendError(new Error("c".repeat(300)))).toBe("c".repeat(200));
    expect(describeSendError("d".repeat(300))).toBe("d".repeat(200));
  });
});

describe("引擎发之前再核一遍", () => {
  type Row = { id: number; status: string; by?: string; body: string; target: Record<string, string>; sendAt?: string; sentAt?: string; error?: string; confirm?: { hash?: string } };
  const ev = { id: 1, at: "t", source: "slack", kind: "message.received", title: "Alice 的私信", url: null, from: "Alice", fromId: "U0ALICE", text: "帮我看下", why: ["dm"], keys: [], reply: { channel: "D0ALICE", ts: "1795079290.188699" } };
  const setup = () => {
    const h = home();
    writeFileSync(join(h, "events.jsonl"), `${JSON.stringify(ev)}\n`);
    chief(h, "cursor");
    writeFileSync(join(h, "drafts", "a.md"), "好的，下午看");
    chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "a.md"));
    return h;
  };
  const rows = (h: string) => (JSON.parse(readFileSync(join(h, "replies.json"), "utf8")) as { items: Row[] }).items;
  // 改 replies.json（模拟到点了，或者排队以后被人改过）。
  const edit = (h: string, fn: (r: Row) => void) => {
    const file = JSON.parse(readFileSync(join(h, "replies.json"), "utf8")) as { items: Row[] };
    for (const r of file.items) fn(r);
    writeFileSync(join(h, "replies.json"), JSON.stringify(file));
  };
  const due = (r: Row) => {
    if (r.status === "queued") r.sendAt = new Date(Date.now() - 1000).toISOString();
  };
  // 在这个数据目录里跑引擎：真的发出去、弹通知都换成假的。
  async function engineIn(h: string, fn: (e: { sendDue: () => Promise<void> }, sent: Row[], notes: string[]) => Promise<void>, send?: (r: Row) => Promise<{ url: string | null }>): Promise<void> {
    const before = process.env.CHIEF_HOME;
    process.env.CHIEF_HOME = h;
    try {
      const { Engine } = await import("../src/engine");
      const sent: Row[] = [];
      const notes: string[] = [];
      const e = new Engine({
        send: async (r) => {
          sent.push(r as unknown as Row);
          return send ? send(r as unknown as Row) : { url: null };
        },
        notify: (title, body) => void notes.push(`${title}｜${body}`),
      });
      await fn(e, sent, notes);
    } finally {
      if (before === undefined) delete process.env.CHIEF_HOME;
      else process.env.CHIEF_HOME = before;
    }
  }

  it("你确认的：queued → sending → sent；发的时候文件里是 sending", async () => {
    const h = setup();
    sendByYou(h, "1");
    expect(rows(h)[0]!.confirm?.hash).toMatch(/^[0-9a-f]{64}$/);
    // 撤回期还没过：不发。
    await engineIn(h, async (e, sent) => {
      await e.sendDue();
      expect(sent).toHaveLength(0);
    });
    edit(h, due);
    const during: string[] = [];
    await engineIn(h, async (e, sent) => {
      await e.sendDue();
      expect(sent.map((r) => r.id)).toEqual([1]);
    }, async () => {
      during.push(rows(h)[0]!.status);
      return { url: "https://example.com/x" };
    });
    expect(during).toEqual(["sending"]);
    expect(rows(h)[0]).toMatchObject({ status: "sent", by: "you" });
    expect(rows(h)[0]!.sentAt).toBeTruthy();
  });

  it("排队后做事方式降回 normal：引擎发之前拦下，不发", async () => {
    const h = setup();
    yours(h, "", "mode", "yolo");
    chief(h, "reply", "queue", "1", "--policy");
    chief(h, "rules", "mode", "normal");
    edit(h, due);
    await engineIn(h, async (e, sent, notes) => {
      await e.sendDue();
      expect(sent).toHaveLength(0);
      expect(notes.join()).toContain("要你确认");
    });
    expect(rows(h)[0]).toMatchObject({ status: "failed" });
    expect(rows(h)[0]!.error).toContain("要你确认");
  });

  it("发的时候出错：failed，写明为什么，弹通知", async () => {
    const h = setup();
    sendByYou(h, "1");
    edit(h, due);
    await engineIn(h, async (e, _sent, notes) => {
      await e.sendDue();
      expect(notes.join()).toContain("对方的频道不见了");
    }, async () => {
      throw new Error("对方的频道不见了");
    });
    expect(rows(h)[0]).toMatchObject({ status: "failed", error: "对方的频道不见了" });
  });

  it("Slack 发送超时：failed，写明 Slack 可能已经收到，通知里也是这句", async () => {
    const h = setup();
    sendByYou(h, "1");
    edit(h, due);
    await engineIn(h, async (e, _sent, notes) => {
      await e.sendDue();
      expect(notes.join()).toContain("可能已经收到");
    }, async () => {
      const { GabrielError } = await import("gabriel-slack");
      throw new GabrielError("NETWORK_TIMEOUT", "chat.postMessage exceeded itemDeadlineMs");
    });
    expect(rows(h)[0]).toMatchObject({ status: "failed" });
    expect(rows(h)[0]!.error).toContain("可能已经收到");
    expect(rows(h)[0]!.error).toContain("chat.postMessage exceeded itemDeadlineMs");
  });

  it("你确认之后稿子或去处被改了、确认记录没了：不发，failed", async () => {
    const changes: ((r: Row) => void)[] = [
      (r) => { r.body = "好的，今天就合"; },
      (r) => { r.target = { channel: "C0OTHER12", ts: "1.0" }; },
      (r) => { delete r.confirm; },
    ];
    for (const change of changes) {
      const h = setup();
      sendByYou(h, "1");
      edit(h, (r) => {
        due(r);
        change(r);
      });
      await engineIn(h, async (e, sent, notes) => {
        await e.sendDue();
        expect(sent).toHaveLength(0);
        expect(notes).toHaveLength(1);
      });
      expect(rows(h)[0]!.status).toBe("failed");
      expect(rows(h)[0]!.error).toMatch(/被改过|没有你确认时的记录/);
    }
  });

  it("规矩直接发的：排队后规矩收紧了、或者不知道谁让发的，不发", async () => {
    const h = setup();
    yours(h, "", "set", "slack_dm", "reply=auto");
    chief(h, "reply", "queue", "1", "--policy");
    chief(h, "rules", "set", "slack_dm", "reply=ask");
    edit(h, due);
    await engineIn(h, async (e, sent) => {
      await e.sendDue();
      expect(sent).toHaveLength(0);
    });
    expect(rows(h)[0]).toMatchObject({ status: "failed", by: "policy" });
    expect(rows(h)[0]!.error).toContain("按现在的规矩");
    // 规矩还允许：照发。
    yours(h, "", "set", "slack_dm", "reply=auto");
    chief(h, "reply", "queue", "1", "--policy");
    edit(h, due);
    await engineIn(h, async (e, sent) => {
      await e.sendDue();
      expect(sent).toHaveLength(1);
    });
    expect(rows(h)[0]!.status).toBe("sent");
    // 没写谁让发的（直接改文件塞进队里的）：不发。
    writeFileSync(join(h, "drafts", "b.md"), "再来一条");
    chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "b.md"));
    edit(h, (r) => {
      if (r.id === 2) {
        r.status = "queued";
        due(r);
      }
    });
    await engineIn(h, async (e, sent) => {
      await e.sendDue();
      expect(sent).toHaveLength(0);
    });
    expect(rows(h)[1]!.status).toBe("failed");
    expect(rows(h)[1]!.error).toContain("不知道是谁让发的");
  });

  it("发出去了但结果记不上（文件被占着）：留着下一轮再记成 sent，不当成没发", async () => {
    const h = setup();
    sendByYou(h, "1");
    edit(h, due);
    const lock = join(h, "replies.json.lock");
    await engineIn(h, async (e, sent) => {
      await e.sendDue();
      expect(sent).toHaveLength(1);
      expect(rows(h)[0]!.status).toBe("sending");
      rmdirSync(lock);
      await e.sendDue();
      expect(sent).toHaveLength(1);
    }, async () => {
      mkdirSync(lock);
      return { url: null };
    });
    expect(rows(h)[0]!.status).toBe("sent");
  }, 20_000);

  it("引擎重启：上次正在发的标成 failed，不自动重发", async () => {
    const h = setup();
    sendByYou(h, "1");
    edit(h, (r) => {
      r.status = "sending";
    });
    await engineIn(h, async () => {
      const { recoverSending } = await import("../src/engine");
      recoverSending();
    });
    expect(rows(h)[0]!.status).toBe("failed");
    expect(rows(h)[0]!.error).toContain("引擎重启");
  });
});

describe("做事方式（chief rules mode）", () => {
  const mode = (h: string) => (JSON.parse(chief(h, "rules", "json")) as { mode: string }).mode;

  it("没配过是 normal；主会话（不带钥匙）升不了，只记成提议；你带钥匙升了生效；降回去不用钥匙", () => {
    const h = home();
    expect(mode(h)).toBe("normal");
    expect(chief(h, "rules", "mode")).toContain("normal");
    // 主会话改：不生效，记成提议。
    expect(chief(h, "rules", "mode", "yolo")).toContain("没改");
    expect(chief(h, "rules", "mode", "auto")).toContain("没改");
    expect(mode(h)).toBe("normal");
    expect((JSON.parse(chief(h, "rules", "json")) as { proposals: unknown[] }).proposals).toHaveLength(2);
    // 你在面板上改（带钥匙）：生效。
    yours(h, "", "mode", "yolo");
    expect(mode(h)).toBe("yolo");
    // 降级不用钥匙。
    chief(h, "rules", "mode", "auto");
    expect(mode(h)).toBe("auto");
    chief(h, "rules", "mode", "normal");
    expect(mode(h)).toBe("normal");
    expect(chiefFails(h, "rules", "mode", "wild")).toContain("normal|auto|yolo");
  });

  it("钥匙不对：升不了", () => {
    const h = home();
    yours(h, "", "mode", "auto");
    expect(() => withStdin(h, JSON.stringify({ key: "cd".repeat(32), text: "" }), "rules", "--yours", "mode", "yolo")).toThrow(/钥匙对不上/);
    expect(mode(h)).toBe("auto");
  });

  it("采纳提议才升（面板带钥匙采纳）", () => {
    const h = home();
    chief(h, "rules", "mode", "yolo");
    const id = String((JSON.parse(chief(h, "rules", "json")) as { proposals: { id: number }[] }).proposals[0]!.id);
    expect(chiefFails(h, "rules", "accept", id)).toContain("面板上点采纳");
    yours(h, "", "accept", id);
    expect(mode(h)).toBe("yolo");
  });
});
