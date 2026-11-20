import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { eventOfItem, eventOfSlack, hubDown, missedEvents } from "../src/engine";
import { keysOf } from "../src/keys";
import { parsePermalink } from "../src/slack/people";
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
    chief(h, "reply", "queue", "1");
    let r = JSON.parse(chief(h, "reply", "list"))[0];
    expect(r).toMatchObject({ status: "queued", by: "you", body: "好的，下午看", original: "好的，我来看", context: { who: "Carol", where: "#dev" } });
    chief(h, "reply", "undo", "1");
    r = JSON.parse(chief(h, "reply", "list"))[0];
    expect(r.status).toBe("pending");
    chief(h, "reply", "drop", "1");
    expect(chiefFails(h, "reply", "queue", "1")).toContain("dropped");
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
    chiefIn(h, "", "thing", "add", "--title", "Warranty 迁移", "--status", "waiting_you");
    chiefIn(h, "Dave 要 huddle，只有你能答", "mark", "1", "asked", "--thing", "1");
    chiefIn(h, JSON.stringify({ question: "Dave 问方不方便 huddle", suggest: "约个时间" }), "ask", "add", "--thing", "1");
    // mark --thing 把消息记到事情上。
    expect(JSON.parse(chief(h, "thing", "list"))[0].events).toEqual([1]);
    writeFileSync(join(h, "events.jsonl"), `${dm(1, "现在方便 huddle 吗")}\n${dm(2, "是的，那我跟他说吧")}\n`);
    const line = JSON.parse(chief(h, "events", "--after", "1").trim());
    expect(line.related.things).toMatchObject([{ id: 1, title: "Warranty 迁移" }]);
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

  it("规矩：场景表加自由规矩，能改", () => {
    const h = home();
    expect(chief(h, "rules")).toContain("Slack 私信（slack_dm）：派人去办；回复先给我确认");
    chief(h, "rules", "set", "slack_dm", "reply=auto");
    expect(chief(h, "rules")).toContain("Slack 私信（slack_dm）：派人去办；回复直接发");
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "add"], { env: { ...process.env, CHIEF_HOME: h }, input: "Bob Chen 问进度可以直接回" });
    expect(chief(h, "rules")).toContain("Bob Chen 问进度可以直接回");
    expect(chiefFails(h, "rules", "set", "slack_dm", "reply=maybe")).toContain("看不懂");
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
    chief(h, "reply", "queue", "1");
    expect(chiefFails(h, "reply", "queue", "1")).toContain("不能发");
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
    const id = run("压测脚本写完了", "thing", "add", "--import", "--title", "OPS-35121 大促压测", "--session", "local_x", "--key", "OPS-35121").trim();
    expect(JSON.parse(chief(h, "thing", "find", "OPS-35121", "PROJ-1"))[0]).toMatchObject({ id: Number(id), origin: "import", session: "local_x", keys: ["OPS-35121"] });
    run("", "thing", "update", id, "--status", "done");
    expect(JSON.parse(chief(h, "thing", "find", "OPS-35121"))).toHaveLength(0);
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
    expect(chiefFails(h, "reply", "queue", "1")).toContain("不会真的发出去");
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
    chief(h, "rules", "set", "custom:2", "handle=dispatch", "reply=auto");
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
    expect(chiefFails(h, "reply", "queue", String(a.id))).toContain("测试消息");
    expect(chiefFails(h, "reply", "approve", "--event", "1", "--ref", "$(x)")).toContain("--ref");
  });

  it("进度：下一步、阻碍、结果、截止", () => {
    const h = home();
    const id = run(h, JSON.stringify({ progress: "脚本写完", next: "跑一轮", blocker: "等测试环境" }), "thing", "add", "--title", "OPS-35121 压测", "--due", "2026-11-20").trim();
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
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "sign"], { env: { ...process.env, CHIEF_HOME: h }, input: "— Rikki 的助手代回" });
    expect(JSON.parse(chief(h, "rules", "json")).signature).toBe("— Rikki 的助手代回");
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "sign"], { env: { ...process.env, CHIEF_HOME: h }, input: "" });
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
    const r = JSON.parse(chief(h, "reply", "new", "--to", "U0ABC123", "--name", "jk.yuan", "--file", join(h, "drafts", "n.md")));
    expect(r).toMatchObject({ kind: "message", to: "U0ABC123" });
    const x = JSON.parse(chief(h, "reply", "list"))[0];
    expect(x).toMatchObject({ kind: "message", event: 0, target: { to: "U0ABC123" }, context: { who: "jk.yuan", where: "新私信" } });
    chief(h, "reply", "queue", String(r.id));
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
    expect(await plugin.send({ channel: "C1", ts: "1.0" }, "好的，今天合", true, attribution)).toEqual({ ref: "C1:9.0" });
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
  it("带署名行的：只认你自己账号发的；记下的编号、以前写在正文开头的也认", async () => {
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
    // 以前发的：署名写在正文第一行。
    expect(isOwnAgentMessage(slackMsg({ text: "🤖 *agent reply*\n出来了" }), [], "🤖 agent reply", "UME1")).toBe(true);
  });

  it("Slack 把 _ 换成 * 也认得", async () => {
    const { startsWithSignature } = await import("../src/engine");
    expect(startsWithSignature("🤖 *agent reply*\n出来了", "🤖 agent reply")).toBe(true);
    expect(startsWithSignature("_🤖 agent reply_\n出来了", "🤖 agent reply")).toBe(true);
    expect(startsWithSignature("帮我看看 agent reply", "🤖 agent reply")).toBe(false);
    expect(startsWithSignature("随便", "")).toBe(false);
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
      { id: 1, at: "t", source: "slack", kind: "k", title: "私信", url: null, from: "Bob Lee (ENG - QA)", fromId: "UBOB1", text: "压测好了吗", why: ["dm"], keys: [], reply: { channel: "D1", ts: "1" } },
      { id: 2, at: "t", source: "slack", kind: "k", title: "私信", url: null, from: "Joe", fromId: "UJOE1", text: "能上线吗", why: ["dm"], keys: [], reply: { channel: "D2", ts: "1" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    execFileSync(process.execPath, ["--import", TSX, CLI, "rules", "trust", "add"], { env: { ...process.env, CHIEF_HOME: h }, input: "bob lee" });
    writeFileSync(join(h, "drafts", "a.md"), "好了");
    expect(JSON.parse(chief(h, "reply", "add", "--event", "1", "--file", join(h, "drafts", "a.md")))).toMatchObject({ policy: "auto", trusted: true });
    expect(JSON.parse(chief(h, "reply", "add", "--event", "2", "--file", join(h, "drafts", "a.md")))).toMatchObject({ policy: "ask" });
    expect(chief(h, "rules")).toContain("- bob lee");
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
    expect(JSON.parse(readFileSync(join(h, "settings.json"), "utf8"))).toEqual({ awake: false });
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
