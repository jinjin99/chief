// 照搬 aide 的 engine/src/sources/github.ts（只留拉动态和评论）。
// GitHub：用你本机已经登录的 gh（chief 不存任何 GitHub 令牌）。
// 拉跟你有关的 PR 和 issue（involves:@me，加上请你 review 的）在 since 之后的变化：状态、合并、新评论；
// PR 还要另外拉 review（approve / 要求修改 / review 总评）和代码行上的评论，这些不在 issue 评论里。拉动态只发 GET。
// 写（PR / issue 上评论）只在你对消息中心说了「发 N」之后由 `chief reply send` 调用。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { config } from "../config";
import { keysOf } from "../keys";
import { runProgram } from "../program";
import { SOURCE_META } from "../shared/sources";
import type { SecretCheck } from "../slack/types";
import { SourceError, escapeRe, plain, type Ask, type Source, type SourceDescriptor, type SourceItem } from "./types";

const GH_PATHS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
// 每次最多拉几条：config.json 的 items.github（默认 50）。
const maxItems = () => config().items.github;
const MAX_COMMENTS = 5;
// PR 的 review 按时间从旧到新给、不能按时间筛：一页 100 条，最多翻这么多页（每条代码行评论的回复也算一个 review）。
const MAX_REVIEW_PAGES = 5;
// 报过的 review、代码行评论记这么多条（引擎重启就清空，靠 since 兜底）。
const MAX_REPORTED = 5000;
// 算数的 review：PENDING 是没提交的草稿，DISMISSED 是作废了的。
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
// owner/repo#123 或 GitHub 上 PR / issue 的地址。
const REF = /^(?:https?:\/\/github\.com\/)?([\w.-]{1,100})\/([\w.-]{1,100})(?:\/(?:pull|issues)\/|#)(\d{1,9})\/?$/;

export type GhRunner = (args: readonly string[], signal: AbortSignal) => Promise<string>;

// owner/repo#123 或地址 → 三段；认不出是 null。
export function prRef(ref: string): { owner: string; repo: string; number: number } | null {
  const m = REF.exec(ref.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

// 找 gh：launchd 下 PATH 很短，先看常见的安装位置。
export function findGh(): string | null {
  for (const p of GH_PATHS) if (existsSync(p)) return p;
  return null;
}

export function ghRunner(bin: string): GhRunner {
  return async (args, signal) => {
    const out = await runProgram(bin, args, { cwd: homedir(), timeoutMs: 30_000, network: true, signal, maxOutput: 8 * 1024 * 1024 });
    if (out.aborted) throw new SourceError("取消了");
    if (out.timedOut) throw new SourceError("gh 30 秒没回应");
    if (out.code !== 0) {
      const why = out.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
      throw new SourceError(/auth|login|token/i.test(why) ? "gh 没登录，到终端里跑 gh auth login" : `gh 出错了：${why}`);
    }
    return out.stdout;
  };
}

interface SearchItem {
  html_url: string; number: number; title: string; state: string; updated_at: string; comments: number;
  repository_url: string; user?: { login?: string }; pull_request?: { merged_at?: string | null };
  assignees?: { login?: string }[];
}
interface Who { user?: { login?: string; type?: string } }
interface Comment extends Who { body?: string; created_at?: string }
interface Review extends Who { id?: number; body?: string; state?: string; submitted_at?: string }
interface LineComment extends Comment { id?: number; path?: string; line?: number | null; original_line?: number | null }

// 机器人（sonarqube、CI、dependabot、AI 代码评审……）的评论、review 不算动态。
// 注册成普通用户（type 是 User）的机器人账号（比如公司的 AI 代码评审）认不出来：写在你的规矩里（chief rules bot add），bots 是小写的登录名。
function isBot(c: Who, bots: ReadonlySet<string>): boolean {
  const login = c.user?.login ?? "";
  return c.user?.type === "Bot" || /\[bot\]$|-bot$|^bot-/i.test(login) || bots.has(login.toLowerCase());
}

// 一条拿不到（GitHub 偶尔回 422、没权限）不影响别的：拿不到就当没有。
async function orNone<T>(signal: AbortSignal, get: () => Promise<T[]>): Promise<T[]> {
  try {
    return await get();
  } catch (error) {
    if (signal.aborted) throw error;
    return [];
  }
}

// 一个 review 给人看的一句：谁 approve 了 / 要求修改 / 留了 review。
function reviewLine(r: Review): string {
  const who = r.user?.login ?? "某人";
  const body = plain(r.body ?? "", 200);
  if (r.state === "APPROVED") return `${who} approve 了${body ? `：${body}` : ""}`;
  if (r.state === "CHANGES_REQUESTED") return `${who} 要求修改${body ? `：${body}` : ""}`;
  return `${who} 留了 review：${body}`;
}

function lineCommentLine(c: LineComment): string {
  const line = c.line ?? c.original_line;
  return `${c.user?.login ?? "某人"} 在 ${plain(c.path ?? "?", 120)}${line ? `:${line}` : ""}：${plain(c.body ?? "", 200)}`;
}

export class GitHubSource implements Source {
  readonly id = "github" as const;
  readonly label = "GitHub";

  // 每个 PR / issue 上次报过的状态：没变、又只有机器人评论的，不再报。
  private readonly seen = new Map<string, string>();

  // 报过的 review、代码行评论（review:编号 / line:编号）：since 有重叠、PR 又有别的动静时，同一个不再报。
  private readonly reported = new Set<string>();

  // 你在 GitHub 上的账号（检查、第一次拉取时记下）。主会话用它认出哪些 PR 是你的。
  private login: string | null = null;

  // bots：每次拉的时候现问一遍你规矩里的机器人名单，改了不用重启。
  constructor(private readonly gh: GhRunner, private readonly bots: () => readonly string[] = () => []) {}

  whoami(): string | null {
    return this.login;
  }

  async check(signal: AbortSignal): Promise<SecretCheck[]> {
    try {
      const me = JSON.parse(await this.gh(["api", "user"], signal)) as { login?: string };
      this.login = me.login && /^[\w-]{1,39}$/.test(me.login) ? me.login : this.login;
      return [{ label: "gh 已登录", pass: true, detail: `账号 ${me.login ?? "?"}` }];
    } catch (error) {
      return [{ label: "gh 已登录", pass: false, detail: error instanceof Error ? error.message : "没成功" }];
    }
  }

  async poll(since: Date, signal: AbortSignal): Promise<SourceItem[]> {
    if (!this.login) await this.check(signal);
    const bots = new Set(this.bots().map((b) => b.toLowerCase()));
    const day = since.toISOString().replace(/\.\d{3}Z$/, "Z");
    const found = new Map<string, SearchItem>();
    // 两个搜索分开算：一个偶尔被 GitHub 拒（11/16 遇到过一次 422），另一个照样拉；都失败才算这次拉取出错。
    const failed: string[] = [];
    const queries = [`involves:@me updated:>=${day}`, `review-requested:@me is:open updated:>=${day}`];
    // 第二个搜索搜到的：在请你 review。
    const requested = new Set<string>();
    for (const q of queries) {
      try {
        const raw = await this.gh(["api", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "sort=updated", "-f", "order=desc", "-f", `per_page=${maxItems()}`], signal);
        for (const it of (JSON.parse(raw) as { items?: SearchItem[] }).items ?? []) {
          if (Date.parse(it.updated_at) > since.getTime()) found.set(it.html_url, it);
          if (q.startsWith("review-requested")) requested.add(it.html_url);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        failed.push(`「${q}」：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.length === queries.length) throw new SourceError(`GitHub 搜索都没成功：${failed.join("；").slice(0, 300)}`);
    const items: SourceItem[] = [];
    for (const it of [...found.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at))) {
      const repo = it.repository_url.split("/repos/")[1] ?? "?";
      const pr = it.pull_request !== undefined;
      // 一条拿不到评论不影响别的：这条先不带评论。
      const comments = it.comments > 0
        ? (await orNone(signal, async () => JSON.parse(await this.gh(["api", "-X", "GET", `repos/${repo}/issues/${it.number}/comments`, "-f", `since=${day}`, "-f", "per_page=30"], signal)) as Comment[]))
          .filter((c) => !isBot(c, bots)).slice(-MAX_COMMENTS)
        : [];
      const me = this.login;
      const byMe = (x: Who): boolean => me !== null && x.user?.login === me;
      const fresh = (t: string | undefined): boolean => t !== undefined && Date.parse(t) >= since.getTime();
      // PR 上 since 之后提交的 review、新写的代码行评论（不算机器人的）。
      const allReviews = pr
        ? (await orNone(signal, () => this.reviewsOf(repo, it.number, signal))).filter((r) => fresh(r.submitted_at) && REVIEW_STATES.has(r.state ?? "") && !isBot(r, bots))
        : [];
      const allLines = pr
        ? (await orNone(signal, async () => JSON.parse(await this.gh(["api", "-X", "GET", `repos/${repo}/pulls/${it.number}/comments`, "-f", `since=${day}`, "-f", "per_page=100"], signal)) as LineComment[]))
          .filter((c) => fresh(c.created_at) && !isBot(c, bots))
        : [];
      // 报的只是别人的、没报过的。只有代码行评论、没写总评的 review（COMMENTED 又没正文）不单算，它的评论在 lines 里。
      const reviews = allReviews.filter((r) => !byMe(r) && (r.state !== "COMMENTED" || (r.body ?? "").trim() !== "") && this.firstTime(`review:${r.id}`));
      const lines = allLines.filter((c) => !byMe(c) && this.firstTime(`line:${c.id}`));
      const state = pr ? (it.pull_request?.merged_at ? "已合并" : it.state === "open" ? "开着" : "已关闭（没合并）") : it.state === "open" ? "开着" : "已关闭";
      // 状态没变、也没有人（不是机器人）的新评论、新 review：只是 CI、机器人、推了新提交，不报。第一次见到的照报。
      const before = this.seen.get(it.html_url);
      this.seen.set(it.html_url, state);
      if (before === state && comments.length === 0 && reviews.length === 0 && lines.length === 0) continue;
      const said = comments.map((c) => `${c.user?.login ?? "某人"}：${plain(c.body ?? "", 200)}`).join("；");
      const reviewed = reviews.slice(-MAX_COMMENTS).map(reviewLine).join("；");
      const onLines = lines.slice(-MAX_COMMENTS).map(lineCommentLine).join("；");
      const atMe = me !== null ? new RegExp(`@${escapeRe(me)}\\b`, "i") : null;
      // 别人说的话：issue 评论、review、代码行评论。
      const others = me === null ? [] : [...comments.filter((c) => !byMe(c)), ...reviews, ...lines];
      const mine = me !== null && (it.user?.login === me
        || comments.some((c) => byMe(c) || atMe!.test(c.body ?? ""))
        || allReviews.some(byMe) || allLines.some(byMe) || others.some((c) => atMe!.test(c.body ?? "")));
      // 有人找你：请你 review（第一次见到时）、别人 @ 了你；你开的 PR 被要求修改、被 approve、有人评论。
      const asks: Ask[] = [];
      if (requested.has(it.html_url) && it.state === "open" && before === undefined) asks.push("review");
      const mention = others.some((c) => atMe?.test(c.body ?? ""));
      if (mention) asks.push("mention");
      if (me !== null && it.user?.login === me) {
        // 每个人看他这次最后的表态：先要求修改、后来 approve 了的，算 approve。
        const verdict = new Map<string, string>();
        for (const r of reviews) if (r.state !== "COMMENTED") verdict.set(r.user?.login ?? "?", r.state!);
        if ([...verdict.values()].includes("CHANGES_REQUESTED")) asks.push("changes");
        if ([...verdict.values()].includes("APPROVED")) asks.push("approved");
        const talked = comments.some((c) => !byMe(c)) || lines.length > 0 || reviews.some((r) => r.state === "COMMENTED");
        if (!mention && talked) asks.push("comment");
      }
      items.push({
        externalId: `${it.html_url}@${it.updated_at}`,
        kind: pr ? "github.pr" : "github.issue",
        title: `${repo}#${it.number} ${plain(it.title, 120)}`,
        url: it.html_url,
        summary: `${pr ? "PR" : "issue"} ${repo}#${it.number}「${plain(it.title, 120)}」${state}${it.user?.login ? `，作者 ${it.user.login}` : ""}${said ? `；新评论：${said}` : ""}${reviewed ? `；新 review：${reviewed}` : ""}${onLines ? `；代码行上的新评论：${onLines}` : ""}`,
        at: it.updated_at,
        payload: {
          repo, number: it.number, state: it.state, merged: Boolean(it.pull_request?.merged_at), mergedAt: it.pull_request?.merged_at ?? null, author: it.user?.login ?? null, comments: comments.length,
          ...(pr ? { reviews: reviews.length, lineComments: lines.length } : {}),
        },
        mine,
        asks,
        // 请你 review 的是 PR 作者；别的情况是最后说话的那个别人，没有别人说话就是作者。
        from: (asks.includes("review") ? it.user?.login : others.at(-1)?.user?.login ?? it.user?.login) ?? null,
        speakers: [...new Set([it.user?.login, ...others.map((c) => c.user?.login)].filter((x): x is string => !!x))],
      });
    }
    return items;
  }

  // 一个 PR 的全部 review（旧的在前）。
  private async reviewsOf(repo: string, n: number, signal: AbortSignal): Promise<Review[]> {
    const all: Review[] = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
      const got = JSON.parse(await this.gh(["api", "-X", "GET", `repos/${repo}/pulls/${n}/reviews`, "-f", "per_page=100", "-f", `page=${page}`], signal)) as Review[];
      all.push(...got);
      if (got.length < 100) break;
    }
    return all;
  }

  // 这个 review / 代码行评论第一次报：记下，太多了丢掉最早的。
  private firstTime(key: string): boolean {
    if (this.reported.has(key)) return false;
    this.reported.add(key);
    if (this.reported.size > MAX_REPORTED) this.reported.delete(this.reported.values().next().value!);
    return true;
  }

  // 导入用：你开着的 PR、等你 review 的 PR（查询写死）。
  async open(signal: AbortSignal): Promise<{ ref: string; title: string; url: string; mine: boolean; updated: string }[]> {
    const out: { ref: string; title: string; url: string; mine: boolean; updated: string }[] = [];
    // 只要最近 30 天动过的：很久没动的开着的 PR 多半不是「现在在做的事」。
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    for (const [q, mine] of [[`is:open is:pr author:@me updated:>=${since}`, true], [`is:open is:pr review-requested:@me updated:>=${since}`, false]] as const) {
      const raw = await this.gh(["api", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "sort=updated", "-f", "order=desc", "-f", "per_page=30"], signal);
      for (const it of (JSON.parse(raw) as { items?: SearchItem[] }).items ?? []) {
        const repo = it.repository_url.split("/repos/")[1] ?? "?";
        out.push({ ref: `${repo}#${it.number}`, title: plain(it.title, 120), url: it.html_url, mine, updated: it.updated_at });
      }
    }
    return out;
  }

  // —— 写：只在你确认了（或规矩允许、过了 5 秒撤回期）之后由引擎调用 ——

  // approve 一个 PR（以你本人的身份）。
  async approve(ref: string, body: string, signal: AbortSignal): Promise<{ url: string | null; ref: string }> {
    const r = prRef(ref);
    if (!r) throw new SourceError(`PR 写成 owner/repo#123：${ref}`);
    const out = JSON.parse(await this.gh(["api", "-X", "POST", `repos/${r.owner}/${r.repo}/pulls/${r.number}/reviews`, "-f", "event=APPROVE", ...(body.trim() ? ["-f", `body=${body.trim()}`] : [])], signal)) as { html_url?: string };
    return { url: out.html_url ?? null, ref: `${r.owner}/${r.repo}#${r.number}` };
  }

  // 在 PR / issue 下面评论。
  async comment(ref: string, body: string, signal: AbortSignal): Promise<{ url: string | null; ref: string }> {
    const r = prRef(ref);
    if (!r) throw new SourceError(`PR 写成 owner/repo#123：${ref}`);
    if (!body.trim()) throw new SourceError("评论是空的");
    const out = JSON.parse(await this.gh(["api", "-X", "POST", `repos/${r.owner}/${r.repo}/issues/${r.number}/comments`, "-f", `body=${body.trim()}`], signal)) as { html_url?: string };
    return { url: out.html_url ?? null, ref: `${r.owner}/${r.repo}#${r.number}` };
  }

}

function local(bots?: () => readonly string[]): GitHubSource | null {
  const gh = findGh();
  return gh ? new GitHubSource(ghRunner(gh), bots) : null;
}

function need(): GitHubSource {
  const s = local();
  if (!s) throw new Error("没找到 gh");
  return s;
}

export const github: SourceDescriptor = {
  id: "github",
  meta: SOURCE_META.github,
  local: () => local(),
  build: async ({ bots }) => local(bots) ?? "没找到 gh",
  event: (item) => ({ key: keysOf(item.url)[0] ?? item.url, reply: { ref: `${String(item.payload.repo)}#${String(item.payload.number)}` } }),
  comment: async (target, body, signal) => ({ url: (await need().comment(target.ref ?? "", body, signal)).url }),
  approve: async (ref, body, signal) => ({ url: (await need().approve(ref, body, signal)).url }),
  async connect({ signal }) {
    const s = local();
    if (!s) throw new Error("没找到 gh：brew install gh，再 gh auth login");
    return { checks: await s.check(signal) };
  },
  open: {
    rank: 2,
    list: async (signal) => (await need().open(signal)).map((it) => ({
      key: keysOf(it.url)[0] ?? it.url, title: `${it.ref} ${it.title}`, state: it.mine ? "我开的 PR" : "等我 review", url: it.url, updated: it.updated,
    })),
  },
};
