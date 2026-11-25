import { describe, expect, it } from "vitest";
import { eventOfItem } from "../src/engine";
import { GitHubSource, type GhRunner } from "../src/sources/github";
import { defaultPolicy, scenarioOf } from "../src/store";

// 假的 gh：按 api 路径回话。PR 写成 o/r#号。
interface Pr { number: number; author: string; updated: string; comments?: number; state?: string }
interface World {
  prs: Pr[];
  requested?: number[];
  issueComments?: Record<number, unknown[]>;
  reviews?: Record<number, unknown[]>;
  lines?: Record<number, unknown[]>;
}

const ME = "jinjin99";
const SINCE = new Date("2026-11-19T08:50:00Z");
const AFTER = "2026-11-19T08:55:12Z";
const BEFORE = "2026-11-19T08:30:00Z";

function search(w: World, only?: number[]): string {
  const items = w.prs.filter((p) => !only || only.includes(p.number)).map((p) => ({
    html_url: `https://github.com/o/r/pull/${p.number}`, number: p.number, title: `PR ${p.number}`, state: p.state ?? "open",
    updated_at: p.updated, comments: p.comments ?? 0, repository_url: "https://api.github.com/repos/o/r",
    user: { login: p.author }, pull_request: { merged_at: null },
  }));
  return JSON.stringify({ items });
}

function fakeGh(w: World, calls: string[] = []): GhRunner {
  return async (args) => {
    if (args[1] === "user") return JSON.stringify({ login: ME });
    const path = args[3]!;
    calls.push(path);
    if (path === "search/issues") {
      const q = args.find((a) => a.startsWith("q=")) ?? "";
      return search(w, q.startsWith("q=review-requested") ? w.requested ?? [] : undefined);
    }
    const m = /^repos\/o\/r\/(issues|pulls)\/(\d+)\/(comments|reviews)$/.exec(path);
    if (!m) throw new Error(`没想到会调 ${path}`);
    const n = Number(m[2]);
    if (m[3] === "reviews") {
      const page = Number((args.find((a) => a.startsWith("page=")) ?? "page=1").slice(5));
      return JSON.stringify((w.reviews?.[n] ?? []).slice((page - 1) * 100, page * 100));
    }
    return JSON.stringify((m[1] === "issues" ? w.issueComments?.[n] : w.lines?.[n]) ?? []);
  };
}

const user = (login: string, type = "User") => ({ login, type });
const review = (id: number, login: string, state: string, body = "", at = AFTER, type = "User") => ({ id, user: user(login, type), state, body, submitted_at: at });
const line = (id: number, login: string, body: string, at = AFTER, extra: Record<string, unknown> = {}) => ({ id, user: user(login), body, path: "src/a.ts", line: 12, original_line: 12, created_at: at, ...extra });

async function pollOnce(w: World, src = new GitHubSource(fakeGh(w)), since = SINCE) {
  return src.poll(since, new AbortController().signal);
}

describe("GitHub：事件里记下是谁在找我（「一定问我」名单按它拦）", () => {
  it("请我 review：from 是 PR 作者", async () => {
    const items = await pollOnce({ prs: [{ number: 5, author: "alice", updated: AFTER }], requested: [5] });
    expect(eventOfItem("github", items[0]!)).toMatchObject({ why: ["review"], from: "alice" });
  });

  it("我的 PR 被 approve：from 是 approve 的人", async () => {
    const items = await pollOnce({ prs: [{ number: 87, author: ME, updated: AFTER }], reviews: { 87: [review(1, "dacongming0425", "APPROVED")] } });
    expect(eventOfItem("github", items[0]!)?.from).toBe("dacongming0425");
  });

  it("好几个人说话：speakers 记下所有说话的人加作者，from 只是最后一个", async () => {
    const items = await pollOnce({ prs: [{ number: 11, author: "carol", updated: AFTER, comments: 2 }], issueComments: { 11: [{ id: 1, user: user("alice"), body: `@${ME} 看下`, created_at: AFTER }, { id: 2, user: user("bob"), body: "+1", created_at: AFTER }] } });
    const e = eventOfItem("github", items[0]!)!;
    expect(e.from).toBe("bob");
    expect([...(e.speakers ?? [])].sort()).toEqual(["alice", "bob", "carol"]);
  });

  it("别人评论我的 PR：from 是最后说话的人", async () => {
    const items = await pollOnce({ prs: [{ number: 9, author: ME, updated: AFTER, comments: 2 }], issueComments: { 9: [{ id: 1, user: user("bob"), body: "a", created_at: AFTER }, { id: 2, user: user("carol"), body: "b", created_at: AFTER }] } });
    expect(eventOfItem("github", items[0]!)?.from).toBe("carol");
  });
});

describe("GitHub：PR 的 review", () => {
  it("别人 approve 了我开的 PR（没写总评）：报出来，why 是 approved", async () => {
    const items = await pollOnce({ prs: [{ number: 87, author: ME, updated: AFTER }], reviews: { 87: [review(1, "dacongming0425", "APPROVED")] } });
    expect(items).toHaveLength(1);
    expect(items[0]!.asks).toEqual(["approved"]);
    expect(items[0]!.summary).toContain("新 review：dacongming0425 approve 了");
    expect(items[0]!.payload).toMatchObject({ reviews: 1, lineComments: 0 });
    const e = eventOfItem("github", items[0]!);
    expect(e?.why).toEqual(["approved"]);
    expect(scenarioOf(e!)).toBe("github_approved");
  });

  it("别人要求修改：why 是 changes，总评写进摘要", async () => {
    const items = await pollOnce({ prs: [{ number: 5, author: ME, updated: AFTER }], reviews: { 5: [review(2, "bob", "CHANGES_REQUESTED", "请补测试")] } });
    expect(items[0]!.asks).toEqual(["changes"]);
    expect(items[0]!.summary).toContain("bob 要求修改：请补测试");
    expect(scenarioOf({ source: "github", why: items[0]!.asks! })).toBe("github_changes");
  });

  it("同一个人先要求修改、后来 approve 了：算 approve；另一个人要求修改的，changes 排前面", async () => {
    const one = await pollOnce({ prs: [{ number: 5, author: ME, updated: AFTER }], reviews: { 5: [review(2, "bob", "CHANGES_REQUESTED"), review(3, "bob", "APPROVED")] } });
    expect(one[0]!.asks).toEqual(["approved"]);
    const two = await pollOnce({ prs: [{ number: 5, author: ME, updated: AFTER }], reviews: { 5: [review(3, "bob", "APPROVED"), review(4, "amy", "CHANGES_REQUESTED")] } });
    expect(two[0]!.asks).toEqual(["changes", "approved"]);
  });

  it("代码行上的评论：报成 comment，写清哪个文件哪一行；@ 了我的算 mention", async () => {
    const items = await pollOnce({
      prs: [{ number: 6, author: ME, updated: AFTER }, { number: 7, author: "amy", updated: AFTER }],
      // 只有代码行评论、没写总评的 review 不单算。
      reviews: { 6: [review(10, "bob", "COMMENTED")] },
      lines: { 6: [line(20, "bob", "这里要判空", AFTER, { line: null, original_line: 192 })], 7: [line(21, "amy", `@${ME} 帮忙看下这行`)] },
    });
    const six = items.find((x) => x.payload.number === 6)!;
    expect(six.asks).toEqual(["comment"]);
    expect(six.summary).toContain("代码行上的新评论：bob 在 src/a.ts:192：这里要判空");
    expect(six.summary).not.toContain("新 review");
    const seven = items.find((x) => x.payload.number === 7)!;
    expect(seven.asks).toEqual(["mention"]);
    expect(seven.mine).toBe(true);
  });

  it("review 总评里 @ 了我：mention 排在 approve 前面", async () => {
    const items = await pollOnce({ prs: [{ number: 8, author: ME, updated: AFTER }], reviews: { 8: [review(30, "bob", "APPROVED", `@${ME} 合吧`)] } });
    expect(items[0]!.asks).toEqual(["mention", "approved"]);
  });

  it("机器人的 review 和代码行评论不报（Bot 类型、-bot、[bot]、规矩里写的机器人）", async () => {
    const w: World = {
      prs: [{ number: 9, author: ME, updated: AFTER }],
      reviews: { 9: [review(40, "sonar", "COMMENTED", "质量门禁没过", AFTER, "Bot"), review(41, "ci-bot", "CHANGES_REQUESTED", "x"), review(42, "acme-review", "COMMENTED", "已评审，发现问题")] },
      lines: { 9: [line(50, "dependabot[bot]", "bump"), line(51, "Acme-Review", "这里有风险")] },
    };
    // acme-review 是注册成普通用户的 AI 评审，名字里没有 bot：靠规矩里的机器人名单认出来（不分大小写）。
    const items = await pollOnce(w, new GitHubSource(fakeGh(w), () => ["acme-review"]));
    // 第一次见到这个 PR 照报，但不带机器人说的、也不算有人找你。
    expect(items[0]!.asks).toEqual([]);
    expect(items[0]!.summary).not.toMatch(/新 review|代码行/);
    expect(eventOfItem("github", items[0]!)).toBeNull();
  });

  it("同一个 review 不重复报：PR 又有别的动静（updated_at 变了）、since 有重叠也一样", async () => {
    const w: World = { prs: [{ number: 87, author: ME, updated: AFTER }], reviews: { 87: [review(1, "dacongming0425", "APPROVED")] }, lines: { 87: [line(60, "bob", "改下名字")] } };
    const src = new GitHubSource(fakeGh(w));
    expect((await pollOnce(w, src))[0]!.asks).toEqual(["approved", "comment"]);
    w.prs[0]!.updated = "2026-11-19T09:10:00Z";
    expect(await pollOnce(w, src)).toEqual([]);
    // 之后真有新的 review，只报新的那个。
    w.prs[0]!.updated = "2026-11-19T09:20:00Z";
    w.reviews![87]!.push(review(2, "amy", "CHANGES_REQUESTED", "再看看", "2026-11-19T09:19:00Z"));
    const again = await pollOnce(w, src);
    expect(again[0]!.asks).toEqual(["changes"]);
    expect(again[0]!.summary).toContain("amy 要求修改：再看看");
    expect(again[0]!.summary).not.toContain("dacongming0425");
  });

  it("since 之前的 review 不报", async () => {
    const items = await pollOnce({ prs: [{ number: 11, author: ME, updated: AFTER }], reviews: { 11: [review(70, "bob", "APPROVED", "", BEFORE)] } });
    expect(items[0]!.asks).toEqual([]);
  });

  it("我自己的 review、代码行评论不报", async () => {
    const w: World = {
      prs: [{ number: 12, author: ME, updated: AFTER }, { number: 13, author: "amy", updated: AFTER }],
      reviews: { 12: [review(80, ME, "COMMENTED", "回复一下")], 13: [review(81, ME, "APPROVED", "LGTM")] },
      lines: { 12: [line(90, ME, "已改")] },
    };
    const src = new GitHubSource(fakeGh(w));
    const first = await pollOnce(w, src);
    for (const x of first) {
      expect(x.asks).toEqual([]);
      expect(x.summary).not.toMatch(/新 review|代码行/);
    }
    // 我 review 过的别人的 PR：跟我直接有关。
    expect(first.find((x) => x.payload.number === 13)!.mine).toBe(true);
    // 状态没变、只有我自己的 review：之后不再报。
    w.prs.forEach((p) => (p.updated = "2026-11-19T09:10:00Z"));
    expect(await pollOnce(w, src)).toEqual([]);
  });

  it("别人的 PR 上别人 approve、要求修改：不算找我", async () => {
    const items = await pollOnce({ prs: [{ number: 14, author: "amy", updated: AFTER }], reviews: { 14: [review(100, "bob", "APPROVED"), review(101, "cat", "CHANGES_REQUESTED", "x")] } });
    expect(items[0]!.asks).toEqual([]);
    expect(items[0]!.summary).toContain("bob approve 了");
  });

  it("review 多过一页：翻到后面那页拿最新的", async () => {
    const old = Array.from({ length: 100 }, (_, i) => review(1000 + i, "bob", "COMMENTED", "旧的", BEFORE));
    const calls: string[] = [];
    const w: World = { prs: [{ number: 15, author: ME, updated: AFTER }], reviews: { 15: [...old, review(2000, "amy", "APPROVED")] } };
    const items = await pollOnce(w, new GitHubSource(fakeGh(w, calls)));
    expect(items[0]!.asks).toEqual(["approved"]);
    expect(calls.filter((c) => c.endsWith("/reviews"))).toHaveLength(2);
  });

  it("拿 review 出错不影响这条和别的 PR", async () => {
    const w: World = { prs: [{ number: 16, author: ME, updated: AFTER }], issueComments: { 16: [{ user: user("bob"), body: "看下", created_at: AFTER }] } };
    const gh = fakeGh({ ...w, prs: [{ ...w.prs[0]!, comments: 1 }] });
    const flaky: GhRunner = async (args, signal) => {
      if (String(args[3]).endsWith("/reviews")) throw new Error("422");
      return gh(args, signal);
    };
    const items = await new GitHubSource(flaky).poll(SINCE, new AbortController().signal);
    expect(items[0]!.asks).toEqual(["comment"]);
  });

  it("issue 不去拉 review", async () => {
    const calls: string[] = [];
    const w: World = { prs: [{ number: 17, author: ME, updated: AFTER }] };
    const gh = fakeGh(w, calls);
    const asIssue: GhRunner = async (args, signal) => {
      const out = await gh(args, signal);
      return args[3] === "search/issues" ? out.replace(/,"pull_request":\{"merged_at":null\}/g, "") : out;
    };
    const items = await new GitHubSource(asIssue).poll(SINCE, new AbortController().signal);
    expect(items[0]!.kind).toBe("github.issue");
    expect(calls.some((c) => c.startsWith("repos/"))).toBe(false);
  });
});

describe("GitHub review 的场景", () => {
  it("默认规矩里有，都是派人去办", () => {
    const p = defaultPolicy();
    expect(p.scenarios.github_approved.handle).toBe("dispatch");
    expect(p.scenarios.github_changes.handle).toBe("dispatch");
  });

  it("老场景不变", () => {
    expect(scenarioOf({ source: "github", why: ["comment"] })).toBe("github_comment");
    expect(scenarioOf({ source: "github", why: ["review"] })).toBe("github_review");
    expect(scenarioOf({ source: "jira", why: ["approved"] })).toBe("other");
    expect(scenarioOf({ source: "slack", why: ["thread"] })).toBe("slack_thread");
  });
});
