// 分诊：只用记一笔的事件先扣住给插件看，插件放行了、或者插件不在才交给主会话。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { released, shouldHold, type TriageFile } from "../src/triage";
import type { ChiefEvent, Thing } from "../src/store";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs");
const CLI = join(ROOT, "src", "cli.ts");

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

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const thread = (over: Partial<ChiefEvent> = {}): ChiefEvent => ({
  id: 1, at: iso(now), source: "slack", kind: "message.received", title: "#dev", url: null, from: "Carol",
  text: "好的，谢谢", why: ["thread"], keys: ["slack:C1:10.0"], reply: { channel: "C1", ts: "11.0", thread_ts: "10.0" }, ...over,
});

const update = (over: Partial<ChiefEvent> = {}): ChiefEvent => ({
  id: 2, at: iso(now), source: "session", kind: "session.update", title: "导出报表", url: null, from: "会话「导出报表」",
  text: "单测都过了，正在补 PR 描述。", why: ["update"], keys: ["local_abc"], reply: {}, ...over,
});

const thing = (over: Partial<Thing> = {}): Thing => ({ id: 1, title: "导出报表", status: "doing", progress: "", events: [], updatedAt: iso(now), log: [], ...over }) as Thing;

describe("扣不扣", () => {
  let before: string | undefined;
  let h: string;
  beforeEach(() => {
    before = process.env.CHIEF_HOME;
    h = mkdtempSync(join(tmpdir(), "chief-triage-"));
    process.env.CHIEF_HOME = h;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.CHIEF_HOME;
    else process.env.CHIEF_HOME = before;
  });
  const none = { things: [] as Thing[], routes: {}, events: [] as ChiefEvent[] };

  it("规矩是只记下、接不上正在做的事的 thread 后续：扣", () => {
    expect(shouldHold(thread(), none)).toBe(true);
  });

  it("要派活的、带 PR 链接或工单号的、测试和演练：不扣", () => {
    expect(shouldHold(thread({ why: ["dm"] }), none)).toBe(false);
    expect(shouldHold(thread({ keys: ["slack:C1:10.0", "github.com/acme/shop/pull/12"] }), none)).toBe(false);
    expect(shouldHold(thread({ keys: ["slack:C1:10.0", "PROJ-479"] }), none)).toBe(false);
    expect(shouldHold(thread({ test: true }), none)).toBe(false);
    expect(shouldHold(thread({ dryrun: true }), none)).toBe(false);
    expect(shouldHold(thread({ kind: "chief.missed", why: ["missed"] }), none)).toBe(false);
  });

  it("接得上正在做的事：不扣，主会话决定转不转", () => {
    expect(shouldHold(thread(), { ...none, routes: { "slack:C1:10.0": { session: "local_abc", title: "x", at: iso(now) } } })).toBe(false);
    expect(shouldHold(thread(), { ...none, things: [thing({ keys: ["slack:C1:10.0"] })] })).toBe(false);
    const earlier = thread({ id: 7 });
    expect(shouldHold(thread(), { ...none, things: [thing({ events: [7] })], events: [earlier] })).toBe(false);
    // 办完的事不算。
    expect(shouldHold(thread(), { ...none, things: [thing({ events: [7], status: "done" })], events: [earlier] })).toBe(true);
  });

  it("工作会话的普通进展：会话挂着没办完的事才扣；在问你的不扣", () => {
    const doing = { ...none, things: [thing({ session: "local_abc" })] };
    expect(shouldHold(update(), doing)).toBe(true);
    expect(shouldHold(update(), none)).toBe(false);
    expect(shouldHold(update({ why: ["asking"] }), doing)).toBe(false);
    expect(shouldHold(update({ kind: "thing.woke" }), doing)).toBe(false);
  });

  it("关掉分诊就都不扣", () => {
    writeFileSync(join(h, "config.json"), JSON.stringify({ triage: false }));
    expect(shouldHold(thread(), none)).toBe(false);
  });
});

describe("什么时候交给主会话", () => {
  const held = thread({ hold: true, heldAt: iso(now) });
  const alive = (over: Partial<TriageFile> = {}): TriageFile => ({ alive: iso(now), since: iso(now - 60_000), items: {}, ...over });

  it("没扣的照常交；插件说要处理的交", () => {
    expect(released(thread(), alive(), now)).toBe(true);
    expect(released(held, alive({ items: { 1: { wake: iso(now), reason: "在问你" } } }), now)).toBe(true);
  });

  it("插件在、没看完：先不交", () => {
    expect(released(held, alive(), now)).toBe(false);
    expect(released(held, alive({ items: { 1: { claimed: iso(now - 60_000) } } }), now)).toBe(false);
  });

  it("插件不在、领了太久、扣了太久：交给主会话", () => {
    expect(released(held, { items: {} }, now)).toBe(true);
    expect(released(held, alive({ alive: iso(now - 4 * 60_000) }), now)).toBe(true);
    expect(released(held, alive({ items: { 1: { claimed: iso(now - 6 * 60_000) } } }), now)).toBe(true);
    const old = thread({ hold: true, heldAt: iso(now - 20 * 60_000) });
    expect(released(old, alive({ since: iso(now - 30 * 60_000) }), now)).toBe(true);
    // 插件刚回来：从它回来开始算，昨晚扣下的先给它看。
    expect(released(old, alive({ since: iso(now - 60_000) }), now)).toBe(false);
  });
});

describe("chief triage", () => {
  const setup = () => {
    const h = mkdtempSync(join(tmpdir(), "chief-triage-"));
    const evs = [thread({ hold: true, heldAt: iso(now) }), update({ hold: true, heldAt: iso(now) }), thread({ id: 3, why: ["dm"], text: "能帮我看下吗" })];
    writeFileSync(join(h, "events.jsonl"), `${evs.map((e) => JSON.stringify(e)).join("\n")}\n`);
    writeFileSync(join(h, "state.json"), JSON.stringify({ nextId: 4 }));
    chief(h, "", "thing", "add", "--title", "导出报表", "--session", "local_abc");
    return h;
  };
  const stream = (h: string) => chief(h, null, "events", "--after", "0").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("插件在：扣着的不交；放行了带着理由交；记下了就不交", () => {
    const h = setup();
    const listed = JSON.parse(chief(h, null, "triage", "list"));
    expect(listed.items.map((x: { id: number; kind: string }) => [x.id, x.kind])).toEqual([[1, "message"], [2, "session"]]);
    expect(listed.items[1].thing).toMatchObject({ title: "导出报表" });
    expect(listed.model).toBe("haiku");
    chief(h, null, "config", "set", "triageModel", "sonnet");
    expect(JSON.parse(chief(h, null, "triage", "list")).model).toBe("sonnet");
    expect(chiefFails(h, "config", "set", "triageModel", "gpt")).toMatch(/triageModel 只能是/);
    expect(stream(h).map((e) => e.id)).toEqual([3]);

    chief(h, null, "triage", "claim", "1");
    expect(chiefFails(h, "triage", "claim", "1")).toMatch(/不用领了/);
    chief(h, "她在问你周五能不能给", "triage", "wake", "1");
    const out = stream(h);
    expect(out.map((e) => e.id)).toEqual([1, 3]);
    expect(out[0]).toMatchObject({ triage: "她在问你周五能不能给" });
    expect(out[0]).not.toHaveProperty("hold");

    chief(h, null, "triage", "claim", "2");
    chief(h, "Haiku：普通进展，记到卡片上", "mark", "2", "noted", "--thing", "1");
    expect(stream(h).map((e) => e.id)).toEqual([1, 3]);
    expect(JSON.parse(chief(h, null, "triage", "list")).items).toEqual([]);
  });

  it("插件不在：照常交给主会话", () => {
    const h = setup();
    expect(stream(h).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("没扣的领不到", () => {
    const h = setup();
    chief(h, null, "triage", "list");
    expect(chiefFails(h, "triage", "claim", "3")).toMatch(/不用领了/);
    expect(readFileSync(join(h, "triage.json"), "utf8")).not.toContain('"3"');
  });
});
