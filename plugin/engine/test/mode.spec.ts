import { describe, expect, it } from "vitest";
import { autoReason } from "../src/gate";
import type { Mode } from "../src/shared/types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy, loadPolicy, paths, type ChiefEvent } from "../src/store";
import { eventOfItem } from "../src/engine";

const ev = (source: "slack" | "github", why?: string) => ({
  id: 1, at: "t", source, kind: "message.received", title: "x", url: null, from: "Bob Lee", fromId: "U0BOB1234", text: "x https://github.com/o/r/pull/4",
  why: [why ?? (source === "slack" ? "dm" : "review")], keys: ["github.com/o/r/pull/4"],
  reply: source === "slack" ? { channel: "D0BOB1234", ts: "1.1" } : { ref: "o/r#4" },
});
const reply = (source: "slack" | "github" | "jira", target: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  id: 1, event: 1, source, target, context: { who: null, where: "", said: "", url: null }, body: "下午给你", status: "pending" as const, at: "t", ...extra,
});
const pol = (mode: Mode, askAlways: string[] = []) => ({ ...defaultPolicy(), mode, askAlways });

describe("做事方式 normal / auto / yolo 对发送的影响", () => {
  const slack = ev("slack");
  const gh = ev("github"); // PR 请我 review：别人的 PR
  const mine = ev("github", "comment"); // 别人评论了我的 PR
  const slackReply = reply("slack", { channel: "D0BOB1234", ts: "1.1" });
  const ghReply = reply("github", { ref: "o/r#4" });
  const approve = reply("github", { ref: "o/r#4" }, { kind: "approve", body: "" });
  const message = reply("slack", { to: "C0NEWCHAN1" }, { kind: "message" });

  it("缺 mode 的旧规矩等于 normal：和以前一样，回复都要确认", () => {
    expect(defaultPolicy().mode).toBe("normal");
    expect(autoReason(slackReply as never, pol("normal"), slack as never)).toBeNull();
    expect(autoReason(ghReply as never, pol("normal"), gh as never)).toBeNull();
    expect(autoReason(message as never, pol("normal"), null)).toBeNull();
  });

  it("auto：approve 别人的 PR、回我自己 PR 上的话直接发；回别人的话、新消息仍按规矩", () => {
    expect(autoReason(approve as never, pol("auto"), gh as never)).toBe("模式 auto（别人的 PR）");
    expect(autoReason(ghReply as never, pol("auto"), mine as never)).toBe("模式 auto（我自己的 PR）");
    // 回别人的话：GitHub 上（PR 请我 review、@我）、Slack 上都还要点。
    expect(autoReason(ghReply as never, pol("auto"), gh as never)).toBeNull();
    expect(autoReason(ghReply as never, pol("auto"), ev("github", "mention") as never)).toBeNull();
    // 我的 PR 被 approve、被要求修改：是我自己的 PR，回复放。
    expect(autoReason(ghReply as never, pol("auto"), ev("github", "approved") as never)).toBe("模式 auto（我自己的 PR）");
    // approve 只放「PR 请我 review」的；别的事件里提到的 PR 不放。
    expect(autoReason(approve as never, pol("auto"), mine as never)).toBeNull();
    expect(autoReason(approve as never, pol("auto"), ev("github", "mention") as never)).toBeNull();
    expect(autoReason(slackReply as never, pol("auto"), slack as never)).toBeNull();
    expect(autoReason(message as never, pol("auto"), null)).toBeNull();
  });

  it("yolo：回复、approve 直接发；主动发的新消息仍问", () => {
    expect(autoReason(slackReply as never, pol("yolo"), slack as never)).toBe("模式 yolo");
    expect(autoReason(ghReply as never, pol("yolo"), gh as never)).toBe("模式 yolo");
    expect(autoReason(approve as never, pol("yolo"), gh as never)).toBe("模式 yolo");
    expect(autoReason(message as never, pol("yolo"), null)).toBeNull();
  });

  it("「一定问我」名单任何模式都拦（人、对话、新消息的去处）", () => {
    for (const mode of ["auto", "yolo"] as const) {
      for (const entry of ["U0BOB1234", "bob lee", "D0BOB1234"]) {
        expect(autoReason(slackReply as never, pol(mode, [entry]), slack as never)).toBeNull();
        // 对话编号只管 Slack 的对话；GitHub 的事件按人拦。
        if (entry !== "D0BOB1234") expect(autoReason(ghReply as never, pol(mode, [entry]), gh as never)).toBeNull();
      }
    }
    // 新消息（频道、人、私信、邮箱）任何模式都问。
    expect(autoReason(message as never, pol("yolo", ["C0NEWCHAN1"]), null)).toBeNull();
    const toUser = reply("slack", { to: "U0NEWUSER1" }, { kind: "message" });
    expect(autoReason(toUser as never, pol("yolo"), null)).toBeNull();
    expect(autoReason(toUser as never, pol("yolo", ["U0OTHERUSER"]), null)).toBeNull();
    expect(autoReason(reply("slack", { to: "D0NEWDM001" }, { kind: "message" }) as never, pol("yolo"), null)).toBeNull();
    expect(autoReason(reply("slack", { to: "bob@example.com" }, { kind: "message" }) as never, pol("yolo"), null)).toBeNull();
    expect(autoReason(reply("slack", { to: "general" }, { kind: "message" }) as never, pol("yolo"), null)).toBeNull();
  });

  it("模式不放宽去处：回复发到别的地方、approve 别的 PR，都不放", () => {
    expect(autoReason(reply("slack", { channel: "C0OTHER", ts: "9.9" }) as never, pol("yolo"), slack as never)).toBeNull();
    expect(autoReason(reply("github", { ref: "o/r#99" }, { kind: "approve", body: "" }) as never, pol("yolo"), gh as never)).toBeNull();
    expect(autoReason({ ...slackReply, event: 2 } as never, pol("yolo"), slack as never)).toBeNull();
  });
});

describe("磁盘上的 mode", () => {
  it("缺 mode 或写了不认识的值：回落 normal；只认 auto、yolo", () => {
    const h = mkdtempSync(join(tmpdir(), "chief-mode-"));
    const before = process.env.CHIEF_HOME;
    process.env.CHIEF_HOME = h;
    try {
      for (const body of [{}, { mode: "wild" }, { mode: 1 }, { mode: "YOLO" }, { mode: null }]) {
        writeFileSync(paths().policy, JSON.stringify(body));
        expect(loadPolicy().mode).toBe("normal");
      }
      for (const mode of ["auto", "yolo"]) {
        writeFileSync(paths().policy, JSON.stringify({ mode }));
        expect(loadPolicy().mode).toBe(mode);
      }
    } finally {
      if (before === undefined) delete process.env.CHIEF_HOME;
      else process.env.CHIEF_HOME = before;
    }
  });
});

// 真实的 GitHub / Jira 事件由 eventOfItem 造：from 取自来源里的人。名单拦得住，才算数。
describe("「一定问我」名单拦真实的 GitHub、Jira 事件", () => {
  const real = (source: "github" | "jira", from: string | null, asks: string[], speakers?: string[]): ChiefEvent => ({
    id: 1,
    ...eventOfItem(source, {
      externalId: "x", kind: source === "github" ? "github.pr" : "jira.issue", title: "o/r#4 t", url: "https://github.com/o/r/pull/4", summary: "o/r#4 https://github.com/o/r/pull/4", at: "t",
      payload: { key: "PROJ-1", repo: "o/r", number: 4 }, mine: true, asks: asks as never, from, ...(speakers ? { speakers } : {}),
    })!,
  } as ChiefEvent);
  const approve = reply("github", { ref: "o/r#4" }, { kind: "approve", body: "" });

  it("auto 下 approve 别人的 PR：作者在名单里就问，不在就放", () => {
    const e = real("github", "alice", ["review"]);
    expect(e.from).toBe("alice");
    expect(autoReason(approve as never, pol("auto", ["alice"]), e)).toBeNull();
    expect(autoReason(approve as never, pol("auto", ["ALICE "]), e)).toBeNull();
    expect(autoReason(approve as never, pol("auto", ["bob"]), e)).toBe("模式 auto（别人的 PR）");
  });

  it("yolo 下回复和 approve：GitHub、Jira 的人在名单里都问", () => {
    const gh = real("github", "alice", ["review"]);
    const jira = real("jira", "Alice Wu", ["comment"]);
    for (const [r, e, who] of [[approve, gh, "alice"], [reply("github", { ref: "o/r#4" }), gh, "alice"], [reply("jira", { key: "PROJ-1" }), jira, "Alice Wu"]] as const) {
      expect(autoReason(r as never, pol("yolo", [who]), e)).toBeNull();
      expect(autoReason(r as never, pol("yolo"), e)).toBe("模式 yolo");
    }
  });

  it("好几个人说话：名单里是其中任何一个（不只是最后说话的）都问", () => {
    // alice @ 我，bob 后面跟一句 +1：from 是 bob，名单写 alice 也要拦；作者 carol 也要拦。
    const e = real("github", "bob", ["mention"], ["carol", "alice", "bob"]);
    for (const who of ["alice", "bob", "carol"]) {
      expect(autoReason(reply("github", { ref: "o/r#4" }) as never, pol("yolo", [who]), e)).toBeNull();
    }
    expect(autoReason(reply("github", { ref: "o/r#4" }) as never, pol("yolo", ["dave"]), e)).toBe("模式 yolo");
    const j = real("jira", "Bob Ng", ["comment"], ["Carol Li", "Alice Wu", "Bob Ng"]);
    expect(autoReason(reply("jira", { key: "PROJ-1" }) as never, pol("yolo", ["Alice Wu"]), j)).toBeNull();
  });

  it("白名单只管 Slack：GitHub、Jira 事件的人和白名单同名，normal 下仍要问", () => {
    const trust = { ...pol("normal"), trusted: ["alice", "Alice Wu"], scenarios: { ...pol("normal").scenarios } };
    expect(autoReason(reply("github", { ref: "o/r#4" }) as never, trust, real("github", "alice", ["mention"]))).toBeNull();
    expect(autoReason(reply("jira", { key: "PROJ-1" }) as never, trust, real("jira", "Alice Wu", ["comment"]))).toBeNull();
    // Slack 上的白名单照旧。
    const s = { ...ev("slack"), from: "alice", fromId: undefined };
    expect(autoReason(reply("slack", { channel: "D0BOB1234", ts: "1.1" }) as never, trust, s as never)).toBe("白名单");
  });
});
