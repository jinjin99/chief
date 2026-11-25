// 主会话用掉多少额度：读会话记录、按份额分、拟合折算比例。
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, SLOT_MS, daysOf, fitWeights, localDay, slotOf, spansOf, type Slot, type Tokens } from "../src/shared/usage";
import { scan, takeLine } from "../src/usage";

const T0 = new Date(2026, 10, 24, 10, 0, 0).getTime();
const call = (at: number, id: string, u: Partial<Record<string, number>>) =>
  JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { id, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u }, content: [{ type: "text", text: "好的，收到" }] } });
const monitor = (command: string) => JSON.stringify({ type: "assistant", timestamp: new Date(T0).toISOString(), message: { id: "m0", content: [{ type: "tool_use", name: "Monitor", input: { command } }] } });

describe("读会话记录", () => {
  it("同一次回答拆成几行只算一次；挂了 chief events --follow 的 Monitor 认作主会话", () => {
    const slots: Record<string, Slot> = {};
    const st = { offset: 0, hub: false };
    takeLine(call(T0, "a", { output_tokens: 10 }), st, false, slots, 0);
    takeLine(call(T0, "a", { output_tokens: 10 }), st, false, slots, 0);
    expect(slots[String(slotOf(T0))]).toEqual({ all: [0, 10, 0, 0], hub: [0, 0, 0, 0] });
    takeLine(monitor("~/chief/data/bin/chief events --after 3 --follow"), st, false, slots, 0);
    expect(st.hub).toBe(true);
    takeLine(call(T0 + 1000, "b", { cache_read_input_tokens: 500 }), st, false, slots, 0);
    expect(slots[String(slotOf(T0))]).toEqual({ all: [0, 10, 0, 500], hub: [0, 0, 0, 500] });
    // 两周前的不算；别的 Monitor 不算主会话。
    const st2 = { offset: 0, hub: false };
    takeLine(monitor("tail -f log"), st2, false, slots, 0);
    takeLine(call(T0 - 1000, "c", { input_tokens: 7 }), st2, false, slots, T0);
    expect(st2.hub).toBe(false);
    expect(Object.keys(slots)).toHaveLength(1);
  });

  it("只读新写的；半行留到下次；子代理算在它的会话头上；汉字跨块也不乱", async () => {
    const root = mkdtempSync(join(tmpdir(), "chief-usage-"));
    const hubFile = join(root, "proj", "hub1.jsonl");
    const sub = join(root, "proj", "hub1", "subagents", "agent-x.jsonl");
    const other = join(root, "proj", "work.jsonl");
    mkdirSync(join(root, "proj", "hub1", "subagents"), { recursive: true });
    writeFileSync(hubFile, `${monitor("chief events --follow")}\n${call(T0, "h1", { input_tokens: 100 })}\n`);
    writeFileSync(sub, `${call(T0, "s1", { input_tokens: 5 })}\n`);
    // 一行很长、全是汉字：跨好几块。
    writeFileSync(other, `${JSON.stringify({ type: "user", text: "汉".repeat(3_000_000) })}\n${call(T0, "w1", { input_tokens: 50 })}\n`);
    const now = T0 + 60_000;
    let st = await scan({ files: {}, slots: {} }, root, now);
    const key = String(slotOf(T0));
    expect(st.slots[key]).toEqual({ all: [155, 0, 0, 0], hub: [105, 0, 0, 0] });
    // 写了一行半：先只算整行。
    appendFileSync(other, `${call(T0, "w2", { input_tokens: 1 })}\n${call(T0, "w3", { input_tokens: 2 }).slice(0, 30)}`);
    st = await scan(st, root, now);
    expect(st.slots[key]!.all[0]).toBe(156);
    appendFileSync(other, `${call(T0, "w3", { input_tokens: 2 }).slice(30)}\n`);
    st = await scan(st, root, now);
    expect(st.slots[key]!.all[0]).toBe(158);
    // 再读一遍没新东西：不重复算。
    st = await scan(st, root, now);
    expect(st.slots[key]).toEqual({ all: [158, 0, 0, 0], hub: [105, 0, 0, 0] });
  });
});

describe("按份额分", () => {
  const slot = (all: Tokens, hub: Tokens): Slot => ({ all, hub });

  it("每段账号涨的点数按主会话在这段里的份额分；窗口重置了只算重置后的；本机没用量的段不算给主会话", () => {
    const slots = {
      [String(slotOf(T0))]: slot([0, 100, 0, 0], [0, 25, 0, 0]),
      [String(slotOf(T0 + SLOT_MS))]: slot([0, 100, 0, 0], [0, 50, 0, 0]),
    };
    const readings = [
      { at: T0, five: 10, week: 30 },
      { at: T0 + SLOT_MS, five: 14, week: 31 },
      { at: T0 + 2 * SLOT_MS, five: 2, week: 32 },
      { at: T0 + 3 * SLOT_MS, five: 5, week: 33 },
    ];
    const spans = spansOf(readings, slots);
    expect(spans.map((s) => [s.five, s.week, s.reset])).toEqual([[4, 1, false], [2, 1, true], [3, 1, false]]);
    const d = daysOf(spans, DEFAULT_WEIGHTS)[localDay(T0)]!;
    expect(d.accountFive).toBe(9);
    // 4 × 25% + 2 × 50% + 3 × 0（那段本机没用量）
    expect(d.five).toBeCloseTo(2);
    expect(d.week).toBeCloseTo(0.75);
    expect(d.share).toBeCloseTo(75 / 200);
  });

  it("拟合折算比例：数据够就拟合出账号自己的比例；不够用默认", () => {
    const truth = { input: 2, output: 5, cacheWrite: 0, cacheRead: 0.01 };
    const slots: Record<string, Slot> = {};
    const readings = [{ at: T0, five: 0, week: 0 }];
    let five = 0;
    for (let i = 0; i < 40; i++) {
      const t: Tokens = [1000 * (1 + (i % 3)), 400 * (1 + (i % 5)), 0, 200_000 * (1 + (i % 7))];
      slots[String(T0 + i * SLOT_MS)] = slot(t, [0, 0, 0, 0]);
      five += (t[0] * truth.input + t[1] * truth.output + t[3] * truth.cacheRead) / 1000;
      readings.push({ at: T0 + (i + 1) * SLOT_MS, five, week: 0 });
    }
    const w = fitWeights(spansOf(readings, slots))!;
    expect(w.output).toBe(5);
    expect(w.input).toBeCloseTo(2, 3);
    expect(w.cacheRead).toBeCloseTo(0.01, 5);
    expect(fitWeights(spansOf(readings.slice(0, 10), slots))).toBeNull();
  });
});
