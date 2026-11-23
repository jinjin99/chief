import { describe, expect, it } from "vitest";
import { JiraSource, acliCli, twgCli, type CliRunner } from "../src/sources/jira";

// One Jira world, served by a fake acli and a fake twg in each CLI's own output shape.
const ME = "Me Myself";
const SINCE = new Date("2026-11-19T08:50:00Z");
const AFTER = "2026-11-19T17:55:12.000+0800";
const person = (displayName: string) => ({ displayName, accountType: "atlassian" });
const fields = {
  summary: "Fix login", status: { name: "In Progress" }, assignee: person(ME), reporter: person("QA"),
  duedate: "2026-11-30", updated: AFTER, priority: { name: "High" }, parent: { key: "PROJ-9", fields: { summary: "Auth epic" } },
  comment: { comments: [{ author: person("QA"), created: AFTER, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `ping ${ME}` }] }] } }] },
};

function fakeAcli(calls: string[][] = []): CliRunner {
  return async (args) => {
    calls.push([...args]);
    if (args[1] === "auth") return "✓ Authenticated\n  Site: acme.atlassian.net\n  Email: me@acme.com\n";
    if (args[2] === "search") return JSON.stringify([{ key: "PROJ-1", fields: { summary: fields.summary, status: fields.status } }]);
    if (args[2] === "view") return JSON.stringify({ key: "PROJ-1", fields });
    if (args[2] === "comment") return JSON.stringify({ results: [{ status: "SUCCESS" }], totalCount: 1, successCount: 1 });
    throw new Error(`unexpected acli ${args.join(" ")}`);
  };
}

function fakeTwg(calls: string[][] = [], comment: unknown = { ok: true, data: { id: "1" } }): CliRunner {
  return async (args) => {
    calls.push([...args]);
    const wrap = (data: unknown) => JSON.stringify({ apiVersion: "v2", data });
    if (args[0] === "doctor") return wrap({ auth: { resolved: { site: "acme.atlassian.net", user: "me@acme.com" } }, connectivity: { ok: true } });
    if (args[2] === "query") return wrap({ issues: [{ key: "PROJ-1", summary: fields.summary, status: fields.status, url: "x" }] });
    if (args[2] === "get") return wrap([{ key: "PROJ-1", ...fields, url: "x" }]);
    if (args[2] === "comment") return JSON.stringify(comment);
    throw new Error(`unexpected twg ${args.join(" ")}`);
  };
}

const signal = () => new AbortController().signal;

describe("Jira via acli or twg", () => {
  it("twg polls the same items as acli", async () => {
    const viaAcli = await new JiraSource(acliCli(fakeAcli())).poll(SINCE, signal());
    const viaTwg = await new JiraSource(twgCli(fakeTwg())).poll(SINCE, signal());
    expect(viaTwg).toEqual(viaAcli);
    expect(viaTwg).toHaveLength(1);
    expect(viaTwg[0]).toMatchObject({
      url: "https://acme.atlassian.net/browse/PROJ-1", mine: true, asks: ["assigned", "mention"],
      payload: { key: "PROJ-1", status: "In Progress", parent: "PROJ-9" },
    });
  });

  it("twg check reads site and email from twg doctor", async () => {
    expect(await new JiraSource(twgCli(fakeTwg())).check(signal())).toEqual([{ label: "twg 已登录 Jira", pass: true, detail: "acme.atlassian.net，me@acme.com" }]);
  });

  it("twg comment sends a plain-text body and surfaces { ok: false }", async () => {
    const calls: string[][] = [];
    const res = await new JiraSource(twgCli(fakeTwg(calls))).comment("PROJ-1", "--done", signal());
    expect(res.url).toBe("https://acme.atlassian.net/browse/PROJ-1");
    expect(calls.at(-1)).toEqual(["jira", "workitem", "comment", "create", "--issue-id=PROJ-1", "--body=--done", "--body-format", "plain", "-o", "json"]);
    const bad = new JiraSource(twgCli(fakeTwg([], { ok: false, error: { message: "no permission" } })));
    await expect(bad.comment("PROJ-1", "hi", signal())).rejects.toThrow("no permission");
  });
});
