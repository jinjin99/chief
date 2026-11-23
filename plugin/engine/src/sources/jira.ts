// 照搬 aide 的 engine/src/sources/jira.ts（只留拉动态和评论）。
// Jira: uses a CLI already logged in on this machine — acli (Atlassian's official CLI, `acli jira auth login --web`)
// or twg (Teamwork Graph CLI, `twg login`). With both installed, acli wins. chief stores no Jira token.
// 拉指派给你、你报的、你关注的工单在 since 之后的变化：状态、截止时间、新评论。拉动态、给 agent 看的工具都只读（search、view、auth status）。
// 写（建单、评论、改状态、指派）只在你点了「发出」之后由 Outbox 调用（见 outbox.ts），agent 自己调不到。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProgram } from "../program";
import type { SecretCheck } from "../slack/types";
import { SourceError, plain, type Ask, type Source, type SourceItem } from "./types";

const ACLI_PATHS = ["/opt/homebrew/bin/acli", "/usr/local/bin/acli"];
// twg's official installer puts it in ~/.local/bin.
const TWG_PATHS = [join(homedir(), ".local/bin/twg"), "/opt/homebrew/bin/twg", "/usr/local/bin/twg"];
const KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const MAX_ITEMS = 50;
// parent：父单（史诗或上一级的单），同一个父单下的单多半是同一件事，拿来提议「合进去」。
const VIEW_FIELDS = "summary,status,assignee,reporter,duedate,updated,priority,comment,parent";

export type CliRunner = (args: readonly string[], signal: AbortSignal) => Promise<string>;

// The Jira operations chief needs. Each CLI adapts its own output to the acli shape ({ key, fields }).
export interface JiraCli {
  readonly name: "acli" | "twg";
  // What to run in a terminal when not logged in.
  readonly login: string;
  status(signal: AbortSignal): Promise<{ site: string | null; email: string }>;
  search(jql: string, fields: string, limit: number, signal: AbortSignal): Promise<Issue[]>;
  view(key: string, fields: string, signal: AbortSignal): Promise<Issue>;
  comment(key: string, body: string, signal: AbortSignal): Promise<void>;
}

export function findJiraCli(): JiraCli | null {
  const acli = ACLI_PATHS.find((p) => existsSync(p));
  if (acli) return acliCli(cliRunner(acli, "acli", ACLI_LOGIN, acliWhy));
  const twg = TWG_PATHS.find((p) => existsSync(p));
  return twg ? twgCli(cliRunner(twg, "twg", TWG_LOGIN, twgWhy)) : null;
}

interface Failure { reason: string; auth: boolean }

function cliRunner(bin: string, name: JiraCli["name"], login: string, why: (stdout: string, stderr: string) => Failure): CliRunner {
  return async (args, signal) => {
    const out = await runProgram(bin, args, { cwd: homedir(), timeoutMs: 30_000, network: true, signal, maxOutput: 16 * 1024 * 1024 });
    if (out.aborted) throw new SourceError("取消了");
    if (out.timedOut) throw new SourceError(`${name} 30 秒没回应`);
    if (out.code !== 0) {
      const { reason, auth } = why(out.stdout, out.stderr);
      throw new SourceError(auth ? `${name} 没登录 Jira，到终端里跑 ${login}` : `${name} 出错了：${reason.slice(0, 200)}`);
    }
    return out.stdout;
  };
}

// —— acli ——

const ACLI_LOGIN = "acli jira auth login --web";

function acliWhy(stdout: string, stderr: string): Failure {
  const reason = `${stdout}\n${stderr}`.trim().split("\n").at(-1) ?? "";
  return { reason, auth: /unauthorized|auth login/i.test(reason) };
}

export function acliCli(run: CliRunner): JiraCli {
  return {
    name: "acli",
    login: ACLI_LOGIN,
    async status(signal) {
      const out = await run(["jira", "auth", "status"], signal);
      return { site: /Site:\s*([a-z0-9-]+\.atlassian\.net)/i.exec(out)?.[1]?.toLowerCase() ?? null, email: /Email:\s*(\S+)/.exec(out)?.[1] ?? "?" };
    },
    search: async (jql, fields, limit, signal) =>
      JSON.parse(await run(["jira", "workitem", "search", "--jql", jql, "--fields", fields, "--limit", String(limit), "--json"], signal)) as Issue[],
    view: async (key, fields, signal) => JSON.parse(await run(["jira", "workitem", "view", key, "--fields", fields, "--json"], signal)) as Issue,
    comment: async (key, body, signal) => acliWritten(await run(["jira", "workitem", "comment", "create", `--key=${key}`, `--body=${body}`, "--json"], signal), "评论"),
  };
}

// 写操作（--json）的结果：每张单一条，FAILURE 带原因。acli 失败时退出码也是 0，只能看这个。
interface WriteResult { results?: { status?: string; message?: string; id?: string }[]; totalCount?: number; successCount?: number }

function acliWritten(out: string, what: string): void {
  let res: WriteResult;
  try {
    res = JSON.parse(out) as WriteResult;
  } catch {
    if (/✗|failure|error/i.test(out)) throw new SourceError(`${what}没成功：${out.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`);
    return;
  }
  const bad = (res.results ?? []).find((r) => r.status !== "SUCCESS");
  if (bad || (res.totalCount !== undefined && res.successCount !== res.totalCount)) {
    throw new SourceError(`${what}没成功：${(bad?.message ?? "Jira 没说为什么").slice(0, 200)}`);
  }
}

// —— twg ——

const TWG_LOGIN = "twg login";

interface TwgError { code?: string; statusCode?: number; message?: string }

// twg -o json failures: non-zero exit, `{ ok: false, error }` on stdout, a human "Error: ..." line on stderr.
function twgWhy(stdout: string, stderr: string): Failure {
  let error: TwgError | undefined;
  try {
    error = (JSON.parse(stdout) as { error?: TwgError }).error;
  } catch {
    // Not JSON: fall back to stderr.
  }
  const reason = error?.message ?? stderr.trim().split("\n")[0] ?? "";
  return { reason, auth: error?.code === "AUTH_REQUIRED" || error?.statusCode === 401 || /not signed in|twg login/i.test(reason) };
}

function twgData(out: string): unknown {
  const res = JSON.parse(out) as { ok?: boolean; data?: unknown; error?: TwgError };
  if (res.ok === false) throw new SourceError(`twg 出错了：${(res.error?.message ?? "没说为什么").slice(0, 200)}`);
  return res.data;
}

// twg flattens Jira fields onto the issue; fold them back under `fields` like acli.
export function twgIssue(raw: unknown): Issue {
  const { key, fields, ...rest } = (raw ?? {}) as { key?: string; fields?: Issue["fields"] } & Record<string, unknown>;
  return { key: key ?? "", fields: fields ?? (rest as Issue["fields"]) };
}

export function twgCli(run: CliRunner): JiraCli {
  return {
    name: "twg",
    login: TWG_LOGIN,
    async status(signal) {
      const d = twgData(await run(["doctor", "-o", "json"], signal)) as { auth?: { resolved?: { site?: string | null; user?: string | null } } };
      const site = d.auth?.resolved?.site?.toLowerCase() ?? "";
      // twg accepts a bare site prefix ("acme") as well as a hostname.
      const host = /^[a-z0-9-]+$/.test(site) ? `${site}.atlassian.net` : site;
      return { site: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null, email: d.auth?.resolved?.user ?? "?" };
    },
    async search(jql, fields, limit, signal) {
      const d = twgData(await run(["jira", "workitem", "query", "--jql", jql, "--fields", fields, "--limit", String(limit), "-o", "json"], signal)) as { issues?: unknown[] };
      return (d.issues ?? []).map(twgIssue);
    },
    async view(key, fields, signal) {
      const d = twgData(await run(["jira", "workitem", "get", key, "--fields", fields, "-o", "json"], signal));
      return twgIssue(Array.isArray(d) ? d[0] : d);
    },
    async comment(key, body, signal) {
      twgData(await run(["jira", "workitem", "comment", "create", `--issue-id=${key}`, `--body=${body}`, "--body-format", "plain", "-o", "json"], signal));
    },
  };
}

// Jira 的富文本（ADF）→ 纯文字。
export function adfText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") return n.attrs?.text ?? "@某人";
  const inner = (n.content ?? []).map(adfText).join("");
  return n.type === "paragraph" || n.type === "listItem" || n.type === "heading" ? `${inner}\n` : inner;
}

interface Person { displayName?: string; accountType?: string; accountId?: string }

export interface Issue {
  key: string;
  fields: {
    summary?: string; status?: { name?: string }; assignee?: Person | null; reporter?: Person | null;
    duedate?: string | null; updated?: string; priority?: { name?: string } | null;
    comment?: { comments?: { author?: Person; body?: unknown; created?: string }[] };
    description?: unknown;
    issuetype?: { name?: string }; labels?: string[];
    parent?: { key?: string; fields?: { summary?: string } } | null;
  };
}

export class JiraSource implements Source {
  readonly id = "jira" as const;
  readonly label = "Jira";
  private site: string | null = null;
  // 每个工单上次报过的状态：没变、也没有人的新评论的，不再报。
  private readonly seen = new Map<string, string>();
  // 上次看到的指派人（认出「新指派给你」）。
  private readonly assignees = new Map<string, string | null>();

  // 你在 Jira 上的显示名（从指派给你的工单里认出来，认一次就记住）。
  private me: string | null = null;

  constructor(private readonly cli: JiraCli) {}

  whoami(): string | null {
    return this.me;
  }

  // 查询是写死的（不带任何外来的字），只看指派给你的一张工单上的指派人。
  private async learnMe(signal: AbortSignal): Promise<void> {
    if (this.me) return;
    try {
      const found = await this.cli.search("assignee = currentUser() ORDER BY updated DESC", "key,summary,status", 1, signal);
      const key = found[0]?.key;
      if (!key || !KEY.test(key)) return;
      const name = (await this.view(key, "assignee", signal)).fields.assignee?.displayName;
      if (name && name.length <= 80) this.me = name;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }

  async check(signal: AbortSignal): Promise<SecretCheck[]> {
    try {
      const { site, email } = await this.cli.status(signal);
      this.site = site;
      return [{ label: `${this.cli.name} 已登录 Jira`, pass: site !== null, detail: site ? `${site}，${email}` : "没认出站点" }];
    } catch (error) {
      return [{ label: `${this.cli.name} 已登录 Jira`, pass: false, detail: error instanceof Error ? error.message : "没成功" }];
    }
  }

  // 导入用：指派给你、还没做完的单（查询写死，不带外来的字）。
  async open(signal: AbortSignal): Promise<{ key: string; title: string; status: string; url: string; updated: string; due: string | null }[]> {
    const site = await this.siteOf(signal);
    const jql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
    const found = await this.cli.search(jql, "key,summary,status", 30, signal);
    const items = found.filter((it) => KEY.test(it.key));
    // 搜索不给截止日期，一张张看（五张一起）。
    const due = new Map<string, string | null>();
    for (let i = 0; i < items.length; i += 5) {
      await Promise.all(items.slice(i, i + 5).map(async (it) => {
        try {
          due.set(it.key, (await this.view(it.key, "duedate", signal)).fields.duedate ?? null);
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }));
    }
    return items.map((it) => ({
      key: it.key, title: plain(it.fields.summary ?? "", 120), status: it.fields.status?.name ?? "?", url: `https://${site}/browse/${it.key}`, updated: "", due: due.get(it.key) ?? null,
    }));
  }

  private async view(key: string, fields: string, signal: AbortSignal): Promise<Issue> {
    return this.cli.view(key, fields, signal);
  }

  // —— 写：只在你说了「发 N」之后由 chief reply send 调用 ——

  async comment(key: string, body: string, signal: AbortSignal): Promise<{ url: string; ref: string }> {
    if (!KEY.test(key)) throw new SourceError(`工单号不对：${key}`);
    if (!body.trim()) throw new SourceError("评论是空的");
    const site = await this.siteOf(signal);
    await this.cli.comment(key, body, signal);
    return { url: `https://${site}/browse/${key}`, ref: key };
  }

  private async siteOf(signal: AbortSignal): Promise<string> {
    if (!this.site) await this.check(signal);
    if (!this.site) throw new SourceError(`${this.cli.name} 没登录 Jira，到终端里跑 ${this.cli.login}`);
    return this.site;
  }

  async poll(since: Date, signal: AbortSignal): Promise<SourceItem[]> {
    const site = await this.siteOf(signal);
    await this.learnMe(signal);
    const minutes = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 60_000) + 1);
    const jql = `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= "-${minutes}m" ORDER BY updated ASC`;
    const found = await this.cli.search(jql, "key,summary,status", MAX_ITEMS, signal);
    const items: SourceItem[] = [];
    for (const hit of found) {
      if (!KEY.test(hit.key)) continue;
      const it = await this.view(hit.key, VIEW_FIELDS, signal);
      const f = it.fields;
      const updated = f.updated ?? "";
      if (Date.parse(updated) <= since.getTime()) continue;
      const status = f.status?.name ?? "?";
      // 人写的新评论（集成、机器人的不算）。
      const fresh = (f.comment?.comments ?? []).filter((c) => Date.parse(c.created ?? "") > since.getTime() && c.author?.accountType !== "app").slice(-5);
      const before = this.seen.get(it.key);
      this.seen.set(it.key, status);
      if (before === status && fresh.length === 0) continue;
      const said = fresh.map((c) => `${c.author?.displayName ?? "某人"}：${plain(adfText(c.body), 200)}`).join("；");
      const me = this.me;
      const assignee = f.assignee?.displayName ?? null;
      const was = this.assignees.get(it.key);
      this.assignees.set(it.key, assignee);
      const mine = me !== null && (assignee === me
        || fresh.some((c) => c.author?.displayName === me || adfText(c.body).includes(me)));
      // 有人找你：新指派给你（之前不是你；第一次见到的也算，同一条只报一次由记录去重）、别人的评论里提到你、别人评论了指派给你 / 你报的单。
      const others = me === null ? [] : fresh.filter((c) => c.author?.displayName !== me);
      const asks: Ask[] = [];
      if (me !== null && assignee === me && was !== me) asks.push("assigned");
      if (others.some((c) => adfText(c.body).includes(me!))) asks.push("mention");
      else if (me !== null && others.length > 0 && (assignee === me || f.reporter?.displayName === me)) asks.push("comment");
      items.push({
        externalId: `${it.key}@${updated}`,
        kind: "jira.issue",
        title: `${it.key} ${plain(f.summary ?? "", 120)}`,
        url: `https://${site}/browse/${it.key}`,
        summary: `Jira ${it.key}「${plain(f.summary ?? "", 120)}」现在是 ${status}，指派给 ${f.assignee?.displayName ?? "没人"}`
          + `${f.priority?.name ? `，优先级 ${f.priority.name}` : ""}${f.duedate ? `，截止 ${f.duedate}` : ""}${said ? `；新评论：${said}` : ""}`,
        at: new Date(Date.parse(updated)).toISOString(),
        payload: {
          key: it.key, status, assignee, due: f.duedate ?? null, comments: fresh.length, ...(was !== undefined && was !== assignee ? { assigneeChanged: true } : {}),
          ...(f.parent?.key && KEY.test(f.parent.key) ? { parent: f.parent.key, parentTitle: plain(f.parent.fields?.summary ?? "", 120) || null } : {}),
        },
        mine,
        asks,
      });
    }
    return items;
  }

}
