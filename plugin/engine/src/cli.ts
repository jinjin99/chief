// chief 命令行。你在终端里用它连来源、装引擎；消息中心（Claude App 里的主会话）和 chief 面板用它记判断、记事情、管回复。
//   chief run                          前台跑引擎（launchd 里跑的也是它）
//   chief install | uninstall          装进 / 卸掉 launchd，并装好 chief 命令（消息中心 skill 和面板在 chief 插件里）
//   chief status | logs                看引擎、来源、进度；看最近的日志
//   chief connect <来源> | disconnect <来源>   slack 默认开浏览器窗口让你登录（要公司 SSO 的会自己跳到工作区地址；--workspace acme 直接从那登；--stdin 改从标准输入读 Cookie）；notion 从标准输入读令牌；
//                                      github / jira 用本机登录的 gh、acli（或 twg）
//   chief doctor                       设置页用：引擎、各来源、主会话的状态（JSON）
//   chief events [--after N] [--follow [--take-over]]  打出编号大于 N 的事件，一行一条；--follow 一直等新的（主会话的 Monitor 用，顺便报「在听」；
//                                      同时只能有一个，--take-over 让这个会话接手）
//   chief show <事件号>                 一条事件的全文
//   chief watch                        ~/chief/data 里有文件变了就打一行（面板用它即时刷新）
//   chief cursor [N]                   主会话处理到第几条
//   chief hub [stop]                   主会话在不在听；stop 让它停下
//   chief engine stop|start|restart    停下 / 开起 / 重启引擎
//   chief route get|set|list|drop      对应表：事件的键 → 会话
//   chief mark <事件号...> ignored|noted|forwarded|opened|asked [--session S --title T --thing T]（标准输入给理由）；--upto N ignored 跳过旧的
//   chief board                        一份汇总（JSON）
//   chief thing add|update|list|find   事情清单：标准输入给一句进展，或 JSON {progress, next, blocker, result}；--due YYYY-MM-DD 截止日；
//                                      --key 记这件事的键，--import 标成导入的；find 按键找事情
//   chief test [--from 名字] [--where 位置] [--why dm|mention|thread]  造一条测试消息（标准输入给内容），回复不会真的发出去
//   chief eval add|from-event|list|remove|run|report  演练：拿例子测主会话会怎么办（不真的办），对结果
//   chief import                       导入用：Jira 指派给你没做完的、GitHub 你开着的 / 等你 review 的 PR
//   chief ask add|list|answer          要你定的
//   chief rules [show|json|set|brief|add|remove|propose|accept|reject]  你的规矩（含每类活的交代），和主会话提议的规矩
//   chief review <事件号> ok|wrong     你给主会话的一次判断标对错（错的时候标准输入给应该怎样）
//   chief reply add|approve|new|list|edit|queue|undo|drop|redo   回复 / approve / 主动发新消息：加进待发出、改、排队发（5 秒可撤回）、撤回、不发、让它重写
//                                      new --to 可以是一条 Slack 消息的链接：回到那条帖子的 thread 里
//   chief slack who <名字>             找 Slack 上的人，拿到 <@U…>（写进稿子才会真的提醒到人）
//   chief archive                      把办完超过 7 天的事件、判断、事情、回复搬进 ~/chief/data/archive（引擎每天自己搬一次）
// 从标准输入给的文字（理由、进展、问题、稿子）不经过命令行参数：里面会引用别人的原文，不能让 shell 当成命令。
import { watch as fsWatch, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveOld, archivedEvent } from "./archive";
import { Engine, SECRET } from "./engine";
import { MAX_IMAGES, takeImage, type ReplyImage } from "./images";
import { KEY, keysOf } from "./keys";
import { type ChildProcess, spawn } from "node:child_process";
import { LABEL, bootout, bootstrap, kickstart, plistPath, renderPlist, serviceState } from "./launchd";
import { KeychainStore, isStorableSecret } from "./secrets";
import { findPeople, parsePermalink } from "./slack/people";
import { SlackPlugin, SLACK_COOKIE_D } from "./slack/plugin";
import type { SecretCheck } from "./slack/types";
import { GitHubSource, findGh, ghRunner } from "./sources/github";
import { browserLogin, findChrome, workspaceUrl } from "./slack/login";
import { JiraSource, findJiraCli } from "./sources/jira";
import { NotionSource } from "./sources/notion";
import {
  AUDIENCE_LABELS, HANDLE_LABELS, SCENARIOS, appendDecision, readEvents, expectOf, isTrusted, loadDecisions, appendEvent, ensureHome, loadCursor, loadDispatch, loadEnabled, loadPolicy, loadReplies, loadReviews, loadRoutes, loadThings,
  loadSettings, loadState, paths, workspaceDir, readJson, saveState, scenarioOf, updateJson, updateReplies, withLock, writeJson,
  type Ask, type Settings, type Decision, type Dispatch, type Enabled, type EventSource, type Handle, type Policy, type ChiefEvent, type RepliesFile,
  type Audience, type CustomScenario, type EvalCase, type EvalRun, type EvalsFile, type Expect, type Placement, type Reply, type ReplyMode, type Reviews, type ScenarioRule, type Routes, type Scenario, type Thing, type ThingsFile,
} from "./store";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES: readonly EventSource[] = ["slack", "github", "jira", "notion"];
const SESSION = /^[\w-]{1,100}$/;
const MAX_REPLY = 20_000;
// 一条事件在 Monitor 通知里最多带这么多字，全文用 chief show 看。
const MAX_TEXT_IN_STREAM = 1500;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// 能写好几次的参数（--image a.png --image b.png）：按顺序全拿出来。
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let v = flag(args, name); v !== null; v = flag(args, name)) out.push(v);
  return out;
}

// --image：检查、复制进 drafts/images，返回记录；不是图片、太大、太多都直接拒收。
function imagesOf(files: string[]): ReplyImage[] {
  if (files.length > MAX_IMAGES) fail(`一条回复最多 ${MAX_IMAGES} 张图`);
  const prefix = `${Date.now()}-${process.pid}`;
  return files.map((p, i) => {
    try {
      return takeImage(resolve(p), join(paths().drafts, "images"), `${prefix}-${i + 1}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${name} 后面要跟一个值`);
  args.splice(i, 2);
  return v;
}

function num(text: string | undefined, what: string): number {
  if (!text || !/^\d{1,9}$/.test(text)) fail(`${what}要是数字`);
  return Number(text);
}

// 标题由主会话自己写（一句话说清这件事），只许这些字符：主会话按规矩用单引号包起来传参，
// 这里再挡一道，免得别人的原文被抄进命令行参数里。
const TITLE_OK = /^[\p{L}\p{N} #._:/()（）·、，,+-]{1,120}$/u;

function title(text: string | null): string | null {
  if (text === null) return null;
  const t = text.trim();
  if (!TITLE_OK.test(t)) fail("标题只能用字、数字、空格和 # . _ : / ( ) · 、， , + -，由你自己概括，不要抄对方原文");
  return t;
}

function oneLine(text: string, max = 200): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

// ── 事件 ──

function eventById(id: number): ChiefEvent {
  return readEvents().find((e) => e.id === id) ?? archivedEvent(id) ?? fail(`没有事件 #${id}`);
}

function streamLine(e: ChiefEvent): string {
  const text = e.text.length > MAX_TEXT_IN_STREAM ? `${e.text.slice(0, MAX_TEXT_IN_STREAM)}…（全文：chief show ${e.id}）` : e.text;
  const related = relatedOf(e);
  return JSON.stringify({ ...e, text, ...(related ? { related } : {}) });
}

// 同一个人、同一个 Slack 对话（私信，或同一个 thread）里还没了结的事情和问题。
// 一起交给主会话：对方的新消息常常是在接着说那件事（「好的」「那我跟他说吧」），要连起来看，
// 问题已经被这条消息答掉或过时了，主会话自己关掉，不要留给用户去面板上标。
export function relatedOf(e: ChiefEvent, all: ChiefEvent[] = readEvents()): { things: unknown[]; asks: unknown[] } | null {
  if (e.source !== "slack") return null;
  const thread = (x: ChiefEvent) => x.reply.thread_ts ?? x.reply.ts;
  const same = (x: ChiefEvent) =>
    x.id !== e.id && x.source === "slack" &&
    ((e.fromId !== undefined && x.fromId === e.fromId) ||
      (x.reply.channel === e.reply.channel && (e.why.includes("dm") || thread(x) === thread(e))));
  const near = new Set(all.filter(same).map((x) => x.id));
  if (near.size === 0) return null;
  const t = loadThings();
  // 以前判断时归到的事情（决定记录里一定有；事情自己的事件表可能没记全）。
  const decided = new Set(loadDecisions().flatMap((d) => (near.has(d.event) && d.thing !== undefined && !d.dry ? [d.thing] : [])));
  const things = t.things.filter((x) => x.status !== "done" && x.status !== "dropped" && (decided.has(x.id) || x.events.some((id) => near.has(id))));
  if (things.length === 0) return null;
  const ids = new Set(things.map((x) => x.id));
  return {
    things: things.map((x) => ({ id: x.id, title: x.title, status: x.status, session: x.session ?? null, progress: x.progress })),
    asks: t.asks.filter((a) => a.status === "open" && ids.has(a.thing)).map((a) => ({ id: a.id, thing: a.thing, question: a.question, suggest: a.suggest })),
  };
}

// 按字节读新追加的部分：文件只追加，记住读到哪就行。每秒看一眼文件大小（本机文件，不访问网络）。
function events(args: string[]): void {
  let after = num(flag(args, "--after") ?? "0", "--after ");
  const follow = args.includes("--follow");
  const file = paths().events;
  let offset = 0;
  let rest = "";
  const drain = () => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (rest + buf.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) {
      let e: ChiefEvent;
      try {
        e = JSON.parse(l) as ChiefEvent;
      } catch {
        continue;
      }
      if (e.id > after) {
        after = e.id;
        // 已经判断过的不再交给主会话（重新挂 Monitor 时会从进度重读一遍）。
        if (!loadDispatch()[e.id]) process.stdout.write(`${streamLine(e)}\n`);
      }
    }
  };
  // 主会话只能有一个：谁挂着 chief events --follow，谁就是主会话。已经有一个在听，第二个直接退出（除非 --take-over 接手）。
  if (follow) {
    const takeOver = args.includes("--take-over");
    const held = withLock(paths().alive, () => {
      const cur = readJson<{ at?: string; pid?: number; stopped?: boolean }>(paths().alive, {});
      const fresh = cur.at !== undefined && Date.now() - Date.parse(cur.at) < ALIVE_MS * 3;
      if (fresh && !cur.stopped && cur.pid !== undefined && cur.pid !== process.pid && pidAlive(cur.pid)) {
        if (!takeOver) return cur.pid;
      }
      // 新的主会话开始听：写下自己（之前「停下」的标记一并清掉）。
      writeJson(paths().alive, { at: new Date().toISOString(), pid: process.pid });
      return null;
    });
    if (held !== null) fail(`已经有一个主会话在听（进程 ${held}）。要让这个会话接手，用 chief events --after N --follow --take-over`);
  }
  // 被别的会话接手了（alive.json 里换成了别人的进程）：说一声就退出，一条消息都不再交，免得两个会话一起处理。
  const stillMine = () => {
    if (!follow) return true;
    const cur = readJson<{ pid?: number; stopped?: boolean }>(paths().alive, {});
    if (cur.stopped) {
      process.stdout.write(`${JSON.stringify({ chief: "stopped", note: "你让主会话停下了，这里不再处理消息" })}\n`);
      process.exit(0);
    }
    if (cur.pid === undefined || cur.pid === process.pid) return true;
    process.stdout.write(`${JSON.stringify({ chief: "handed_over", note: "另一个会话接手了主会话，这里不再处理消息" })}\n`);
    process.exit(0);
  };
  drain();
  if (!follow) return;
  setInterval(() => {
    if (stillMine()) drain();
  }, 1000);
  // 主会话的 Monitor 挂着这个命令：它在跑，就说明主会话在听。面板看 alive.json 判断。
  setInterval(() => {
    if (stillMine()) writeJson(paths().alive, { at: new Date().toISOString(), pid: process.pid });
  }, ALIVE_MS);
}

// chief watch：~/chief/data 里有文件变了就打一行（面板挂着它，有变化马上刷新，不用一直去读）。
function watchHome(): void {
  let pending: NodeJS.Timeout | null = null;
  const fire = () => process.stdout.write(`changed ${new Date().toISOString()}\n`);
  fsWatch(paths().home, (_type, name) => {
    if (!name || String(name).endsWith(".tmp") || String(name).endsWith(".lock")) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(fire, 200);
  });
  fire();
}

// ── 对应表 ──

function route(args: string[]): void {
  const sub = args.shift();
  const routes = loadRoutes();
  if (sub === "list") {
    process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`);
    return;
  }
  if (sub === "get") {
    const hits: Record<string, unknown> = {};
    for (const k of args) if (KEY.test(k) && routes[k]) hits[k] = routes[k];
    process.stdout.write(`${JSON.stringify(hits)}\n`);
    return;
  }
  if (sub === "set") {
    const session = flag(args, "--session") ?? fail("要 --session <会话编号>");
    const t = title(flag(args, "--title")) ?? "";
    if (!SESSION.test(session)) fail("会话编号只能是字母、数字、_ 和 -");
    if (args.length === 0) fail("至少给一个键");
    for (const k of args) if (!KEY.test(k)) fail(`键里有不支持的字符：${oneLine(k, 80)}`);
    const at = new Date().toISOString();
    updateJson<Routes, void>(paths().routes, {}, (all) => {
      for (const k of args) all[k] = { session, title: t, at };
    });
    process.stdout.write(`记下了 ${args.length} 个键 → ${session}\n`);
    return;
  }
  if (sub === "drop") {
    updateJson<Routes, void>(paths().routes, {}, (all) => {
      for (const k of args) delete all[k];
    });
    return;
  }
  fail("chief route get|set|list|drop");
}

// ── 每条事件怎么处理的 ──

const STATUSES = ["forwarded", "opened", "ignored", "noted", "asked"] as const;

// 主会话判断完一条（或一批）消息就 mark：记进 dispatch.json（面板按它算还剩多少没处理），
// 再往 decisions.jsonl 记一行判断（为什么这么办，从标准输入给），测评和纠正都看它。
async function mark(args: string[]): Promise<void> {
  const session = flag(args, "--session");
  const titleText = title(flag(args, "--title"));
  const upto = flag(args, "--upto");
  const thingFlag = flag(args, "--thing");
  const thingId = thingFlag === null ? null : num(thingFlag, "--thing ");
  const force = args.includes("--force");
  if (force) args.splice(args.indexOf("--force"), 1);
  // --dry：演练消息的判断（只说会怎么办，没真的办）。
  const dry = args.includes("--dry");
  if (dry) args.splice(args.indexOf("--dry"), 1);
  const status = args.pop() as Dispatch["status"] | Decision["verdict"] | undefined;
  if (!status || !STATUSES.includes(status as (typeof STATUSES)[number])) fail(`chief mark <事件号...> ${STATUSES.join("|")}`);
  if (session !== null && !SESSION.test(session)) fail("会话编号只能是字母、数字、_ 和 -");
  const evts = readEvents();
  const byId = new Map(evts.map((e) => [e.id, e]));
  const listed = upto === null ? args.map((a) => num(a, "事件号")) : [];
  for (const id of listed) if (!byId.has(id)) fail(`没有事件 #${id}`);
  const reason = upto !== null ? "你让跳过之前积下的旧消息" : await stdinText();
  const at = new Date().toISOString();
  // 判断过的不再判断第二次（Monitor 重新挂上时可能又收到一遍）：除非 --force。
  const marked = updateJson<Record<string, Dispatch>, number[] | string>(paths().dispatch, {}, (dispatch) => {
    const ids = upto !== null ? evts.filter((e) => e.id <= num(upto, "--upto ") && !dispatch[e.id]).map((e) => e.id) : listed;
    if (ids.length === 0) return "没有要标的事件";
    const done = ids.filter((id) => dispatch[id]);
    if (done.length > 0 && !force) return `这些已经判断过了：${done.map((id) => `#${id}`).join(" ")}（不用再办；真要改判断加 --force）`;
    for (const id of ids) dispatch[id] = { status: status === "asked" ? "noted" : status, at, ...(session ? { session } : {}), ...(titleText ? { title: titleText } : {}) };
    return ids;
  });
  if (typeof marked === "string") fail(marked);
  // 归到哪件事，就把消息记到那件事上（后来的消息靠它连回这件事和它挂着的问题）。
  if (thingId !== null && !dry) {
    updateThings((t) => {
      const x = t.things.find((y) => y.id === thingId);
      if (x) for (const id of marked) if (!byId.get(id)?.dryrun && !x.events.includes(id)) x.events.push(id);
    });
  }
  if (upto === null) {
    for (const id of marked) {
      const e = byId.get(id)!;
      appendDecision({
        at, event: id, scenario: scenarioOf(e), verdict: status as Decision["verdict"], reason: oneLine(reason, 300),
        what: { source: e.source, title: e.title, from: e.from, text: oneLine(e.text, 200) },
        ...(thingId !== null ? { thing: thingId } : {}), ...(session ? { session } : {}),
        ...(dry || e.dryrun ? { dry: true } : {}),
      });
    }
  }
  process.stdout.write(`标好了 ${marked.length} 条\n`);
}

// 面板也直接读文件；这个给消息中心和终端看一眼用。
async function board(): Promise<void> {
  const svc = await serviceState();
  const dispatch = loadDispatch();
  const evts = readEvents();
  const t = loadThings();
  const unhandled = evts.filter((e) => !dispatch[e.id]);
  process.stdout.write(`${JSON.stringify({
    engine: svc.running ? "running" : svc.loaded ? "stopped" : "missing",
    hub: hubAlive(),
    unhandled: unhandled.length,
    unhandledMaxId: unhandled.reduce((m, e) => Math.max(m, e.id), 0),
    asks: t.asks.filter((a) => a.status === "open").length,
    live: t.things.filter((x) => x.status === "doing" || x.status === "waiting_you" || x.status === "waiting_others").length,
    replies: loadReplies().items.filter((r) => r.status === "pending" || r.status === "failed").length,
  })}\n`);
}

// 主会话在不在听：Monitor 挂着的 chief events --follow 每 20 秒写一次 alive.json。
const ALIVE_MS = 20_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hubAlive(): { listening: boolean; lastAt: string | null } {
  const a = readJson<{ at?: string; stopped?: boolean }>(paths().alive, {});
  return { listening: !a.stopped && a.at !== undefined && Date.now() - Date.parse(a.at) < ALIVE_MS * 3, lastAt: a.at ?? null };
}

// ── 事情、要你定的 ──

const THING_STATUSES = ["doing", "waiting_you", "waiting_others", "done", "dropped"] as const;
const MAX_TEXT = 2000;
const MAX_LOG = 30;

// 主会话写的话（进展、问题、回答）从标准输入读：里面会引用别人的原文，不放进命令行参数，免得被 shell 当成命令。
async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT);
}

function thingStatus(text: string | null): Thing["status"] | null {
  if (text === null) return null;
  if (!THING_STATUSES.includes(text as Thing["status"])) fail(`--status 是 ${THING_STATUSES.join("|")} 之一`);
  return text as Thing["status"];
}

const EMPTY_THINGS: ThingsFile = { nextThing: 1, nextAsk: 1, things: [], asks: [] };

// 锁着改 things.json；fn 里出错 throw，出来再报。
function updateThings<T>(fn: (t: ThingsFile) => T): T {
  return updateJson<ThingsFile, T>(paths().things, { ...EMPTY_THINGS, things: [], asks: [] }, fn);
}

function oops(message: string): never {
  throw new Error(message);
}

async function thing(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "list") {
    const all = args.includes("--all");
    process.stdout.write(`${JSON.stringify(loadThings().things.filter((x) => all || (x.status !== "done" && x.status !== "dropped")), null, 2)}\n`);
    return;
  }
  // chief thing find <键...>：还没做完的事情里，键对得上的（新消息归到哪件事用）。
  if (sub === "find") {
    const want = new Set(args);
    const hits = loadThings().things.filter((x) => x.status !== "done" && x.status !== "dropped" && (x.keys ?? []).some((k) => want.has(k)));
    process.stdout.write(`${JSON.stringify(hits)}\n`);
    return;
  }
  const session = flag(args, "--session");
  if (session !== null && !SESSION.test(session)) fail("会话编号只能是字母、数字、_ 和 -");
  const status = thingStatus(flag(args, "--status"));
  const eventFlag = flag(args, "--event");
  const event = eventFlag === null ? null : eventById(num(eventFlag, "--event ")).id;
  const titleText = title(flag(args, "--title"));
  const origin = args.includes("--import") ? "import" as const : "chief" as const;
  if (args.includes("--import")) args.splice(args.indexOf("--import"), 1);
  const keys: string[] = [];
  for (let k = flag(args, "--key"); k !== null; k = flag(args, "--key")) {
    if (!KEY.test(k)) fail(`键里有不支持的字符：${oneLine(k, 80)}`);
    keys.push(k);
  }
  const dueFlag = flag(args, "--due");
  if (dueFlag !== null && dueFlag !== "none" && !/^\d{4}-\d{2}-\d{2}$/.test(dueFlag)) fail("--due 写成 YYYY-MM-DD，清掉写 none");
  const id = sub === "update" ? num(args.shift(), "事情号") : null;
  // 先读完标准输入，再拿锁：锁只在读改写那一下。
  // 标准输入可以是一句进展，也可以是 JSON：{"progress": 做到哪了, "next": 下一步, "blocker": 卡在哪（空字符串 = 不卡了）, "result": 一条结果}。
  const raw = await stdinText();
  let report: { progress?: string; next?: string; blocker?: string; result?: string } = {};
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      for (const k of ["progress", "next", "blocker", "result"] as const) if (typeof j[k] === "string") report[k] = (j[k] as string).trim().slice(0, MAX_TEXT);
    } catch {
      fail("标准输入的 JSON 看不懂：{\"progress\", \"next\", \"blocker\", \"result\"}");
    }
  } else if (raw) report = { progress: raw };
  const text = report.progress ?? "";
  const at = new Date().toISOString();
  if (sub === "add") {
    if (!titleText) fail("要 --title");
    const newId = updateThings((t) => {
      const x: Thing = {
        id: t.nextThing++, title: titleText, status: status ?? "doing", progress: text,
        events: event !== null ? [event] : [], updatedAt: at, log: text ? [{ at, text }] : [], origin,
        ...(report.next ? { next: report.next } : {}), ...(report.blocker ? { blocker: report.blocker } : {}),
        ...(report.result ? { results: [report.result] } : {}), ...(dueFlag && dueFlag !== "none" ? { due: dueFlag } : {}),
        ...(keys.length > 0 ? { keys } : {}), ...(session ? { session } : {}),
      };
      t.things.push(x);
      return x.id;
    });
    process.stdout.write(`${newId}\n`);
    return;
  }
  if (sub === "update" && id !== null) {
    updateThings((t) => {
      const x = t.things.find((y) => y.id === id) ?? oops(`没有事情 ${id}`);
      if (status) x.status = status;
      if (session) x.session = session;
      if (titleText) x.title = titleText;
      if (event !== null && !x.events.includes(event)) x.events.push(event);
      if (keys.length > 0) x.keys = [...new Set([...(x.keys ?? []), ...keys])];
      if (text) {
        x.progress = text;
        x.log = [...x.log, { at, text }].slice(-MAX_LOG);
      }
      if (report.next) x.next = report.next;
      else if (report.next === "") delete x.next;
      if (report.blocker !== undefined) {
        if (report.blocker) {
          x.blocker = report.blocker;
          x.log = [...x.log, { at, text: `卡住：${report.blocker}` }].slice(-MAX_LOG);
        } else delete x.blocker;
      }
      if (report.result) {
        x.results = [...(x.results ?? []), report.result].slice(-20);
        x.log = [...x.log, { at, text: `结果：${report.result}` }].slice(-MAX_LOG);
      }
      if (dueFlag === "none") delete x.due;
      else if (dueFlag) x.due = dueFlag;
      x.updatedAt = at;
    });
    return;
  }
  fail("chief thing add|update|list|find");
}

async function ask(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "list") {
    process.stdout.write(`${JSON.stringify(loadThings().asks.filter((a) => a.status === "open"), null, 2)}\n`);
    return;
  }
  if (sub === "add") {
    const thingId = num(flag(args, "--thing") ?? undefined, "--thing ");
    const replyFlag = flag(args, "--reply");
    const replyId = replyFlag === null ? null : num(replyFlag, "--reply ");
    let body: { question?: unknown; suggest?: unknown };
    try {
      body = JSON.parse(await stdinText()) as typeof body;
    } catch {
      fail("标准输入要是 JSON：{\"question\": \"…\", \"suggest\": \"…\"}");
    }
    if (typeof body.question !== "string" || !body.question.trim()) fail("question 不能空");
    const question = body.question.trim().slice(0, MAX_TEXT);
    const suggest = typeof body.suggest === "string" ? body.suggest.trim().slice(0, MAX_TEXT) : "";
    const newId = updateThings((t) => {
      const x = t.things.find((y) => y.id === thingId) ?? oops(`没有事情 ${thingId}`);
      const a: Ask = { id: t.nextAsk++, thing: x.id, question, suggest, status: "open", at: new Date().toISOString(), ...(replyId !== null ? { reply: replyId } : {}) };
      t.asks.push(a);
      x.status = "waiting_you";
      x.updatedAt = a.at;
      return a.id;
    });
    process.stdout.write(`${newId}\n`);
    return;
  }
  if (sub === "answer") {
    const id = num(args.shift(), "问题号");
    const answer = await stdinText();
    if (!answer) fail("回答是空的");
    const out = updateThings((t) => {
      const a = t.asks.find((y) => y.id === id) ?? oops(`没有问题 ${id}`);
      if (a.status !== "open") oops(`问题 ${id} 已经答过了`);
      a.status = "answered";
      a.answer = answer;
      const x = t.things.find((y) => y.id === a.thing);
      if (x && x.status === "waiting_you" && !t.asks.some((y) => y.thing === x.id && y.status === "open")) x.status = "doing";
      return { ask: a.id, thing: a.thing, session: x?.session ?? null, reply: a.reply ?? null };
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  fail("chief ask add|list|answer");
}

// ── Slack ──

// chief slack who <名字>：找人，拿到用户编号。稿子里写 <@U…> 对方才会收到提醒；查过的人记下来，面板显示成 @名字。
async function slackCmd(args: string[]): Promise<void> {
  if (args[0] !== "who") fail("chief slack who <名字>");
  const query = args.slice(1).join(" ").trim();
  if (!query || query.length > 60 || /[\n<>]/.test(query)) fail("给一个名字（60 字以内），比如 chief slack who Dave");
  const cookie = await new KeychainStore().get(SECRET.slack);
  if (!cookie) fail("Slack 还没连上（chief connect slack）");
  const found = await findPeople(cookie, query);
  if (found.length > 0) {
    withLock(paths().people, () => {
      const known = readJson<Record<string, string>>(paths().people, {});
      for (const p of found) known[p.id] = p.name;
      writeJson(paths().people, known);
    });
  }
  process.stdout.write(`${JSON.stringify(found.map((p) => ({ ...p, mention: `<@${p.id}>` })), null, 2)}\n`);
}

// ── 测试 ──

// chief test [--from 名字] [--where 位置] [--why dm|mention|thread]（标准输入给消息内容）：
// 造一条「有人找你」的消息，走一遍主会话的判断、派活、回复。回复会进待发出，但发不出去（标着测试）。
async function testEvent(args: string[]): Promise<void> {
  const from = oneLine(flag(args, "--from") ?? "测试同事", 40);
  const where = oneLine(flag(args, "--where") ?? "测试私信", 60);
  const why = flag(args, "--why") ?? "dm";
  if (!["dm", "mention", "thread"].includes(why)) fail("--why 是 dm|mention|thread 之一");
  const text = await stdinText();
  if (!text) fail("从标准输入给消息内容");
  const id = withLock(paths().state, () => {
    const st = loadState();
    const e: ChiefEvent = {
      id: st.nextId++, at: new Date().toISOString(), source: "slack", kind: "message.received", title: `[测试] ${where}`, url: null, from,
      text, why: [why], keys: [`test:${Date.now()}`, ...keysOf(text)], reply: {}, test: true,
    };
    saveState(st);
    appendEvent(e);
    return e.id;
  });
  process.stdout.write(`造了测试消息 #${id}，主会话在听的话马上会处理\n`);
}

// ── 演练：拿例子测主会话会怎么办 ──

const EXPECTS: Record<Expect, string> = { dispatch: "派人去办", note: "只记下", ignore: "忽略", ask: "问你" };
const EMPTY_EVALS: EvalsFile = { nextId: 1, nextRun: 1, cases: [], runs: [] };

function updateEvals<T>(fn: (e: EvalsFile) => T): T {
  return updateJson<EvalsFile, T>(paths().evals, { ...EMPTY_EVALS, cases: [], runs: [] }, fn);
}

// chief eval add（标准输入 JSON：{from, where, why, text, expect, note}）| from-event <事件号> [expect] | list | remove <号> | run | report
async function evals(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "add") {
    let c: Partial<EvalCase>;
    try {
      c = JSON.parse(await stdinText()) as Partial<EvalCase>;
    } catch {
      fail('标准输入要是 JSON：{"from","where","why","text","expect":"dispatch|note|ignore|ask","note"}');
    }
    if (typeof c.text !== "string" || !c.text.trim()) fail("text 不能空");
    if (!c.expect || !(c.expect in EXPECTS)) fail(`expect 是 ${Object.keys(EXPECTS).join("|")} 之一`);
    const x = { from: oneLine(c.from ?? "同事", 40), where: oneLine(c.where ?? "私信", 60), why: ["dm", "mention", "thread", "self"].includes(c.why ?? "") ? c.why! : "dm", text: c.text.trim().slice(0, 2000), expect: c.expect, ...(c.note ? { note: oneLine(c.note, 300) } : {}) };
    const id = updateEvals((e) => {
      const y: EvalCase = { id: e.nextId++, ...x, at: new Date().toISOString() };
      e.cases.push(y);
      return y.id;
    });
    process.stdout.write(`加好了：例子 ${id}\n`);
    return;
  }
  // 把一条真实判断存成例子：默认「应该怎么办」就是当时的判断（你标过对的那种）；也可以写明应该怎么办。
  if (sub === "from-event") {
    const ev = eventById(num(args.shift(), "事件号"));
    const d = [...loadDecisions()].reverse().find((x) => x.event === ev.id && !x.dry);
    const want = (args.shift() as Expect | undefined) ?? (d ? expectOf(d.verdict) : undefined);
    if (!want || !(want in EXPECTS)) fail(`这条还没判断过：写明应该怎么办（${Object.keys(EXPECTS).join("|")}）`);
    const id = updateEvals((e) => {
      const y: EvalCase = { id: e.nextId++, from: ev.from ?? "同事", where: ev.title, why: ev.why[0] ?? "dm", text: ev.text, expect: want, fromEvent: ev.id, at: new Date().toISOString() };
      e.cases.push(y);
      return y.id;
    });
    process.stdout.write(`存成例子 ${id}（应该：${EXPECTS[want]}）\n`);
    return;
  }
  if (sub === "list") {
    process.stdout.write(`${JSON.stringify(readJson<EvalsFile>(paths().evals, EMPTY_EVALS).cases, null, 2)}\n`);
    return;
  }
  if (sub === "remove") {
    const id = num(args.shift(), "例子号");
    updateEvals((e) => {
      e.cases = e.cases.filter((c) => c.id !== id);
    });
    return;
  }
  // 跑一遍：每个例子造一条演练消息交给主会话（它只判断、说会怎么办，什么都不真的做）。
  if (sub === "run") {
    const cases = readJson<EvalsFile>(paths().evals, EMPTY_EVALS).cases;
    if (cases.length === 0) fail("还没有例子：chief eval add，或者在测评页把判断记录存成例子");
    const events: Record<string, number> = {};
    for (const c of cases) {
      events[c.id] = withLock(paths().state, () => {
        const st = loadState();
        const e: ChiefEvent = {
          id: st.nextId++, at: new Date().toISOString(), source: "slack", kind: "message.received", title: `[演练] ${c.where}`, url: null, from: c.from,
          text: c.text, why: [c.why], keys: [`eval:${c.id}:${Date.now()}`, ...keysOf(c.text)], reply: {}, test: true, dryrun: true, eval: c.id,
        };
        saveState(st);
        appendEvent(e);
        return e.id;
      });
    }
    const runId = updateEvals((e) => {
      const r: EvalRun = { id: e.nextRun++, at: new Date().toISOString(), events };
      e.runs = [...e.runs, r].slice(-20);
      return r.id;
    });
    process.stdout.write(`第 ${runId} 次演练：交了 ${cases.length} 个例子给主会话，判断完用 chief eval report 看结果\n`);
    return;
  }
  // 对结果：每个例子，主会话这次判断成什么、对不对、为什么。
  if (sub === "report") {
    const e = readJson<EvalsFile>(paths().evals, EMPTY_EVALS);
    const run = e.runs.at(-1) ?? fail("还没跑过：chief eval run");
    const decisions = loadDecisions();
    const results = e.cases.filter((c) => run.events[c.id] !== undefined).map((c) => {
      const d = [...decisions].reverse().find((x) => x.event === run.events[c.id]);
      const got = d ? expectOf(d.verdict) : null;
      return { case: c.id, text: oneLine(c.text, 80), expect: c.expect, got, ok: got === null ? null : got === c.expect, reason: d?.reason ?? null };
    });
    const done = results.filter((r) => r.got !== null);
    process.stdout.write(`${JSON.stringify({ run: run.id, at: run.at, total: results.length, judged: done.length, correct: done.filter((r) => r.ok).length, results }, null, 2)}\n`);
    return;
  }
  fail("chief eval add|from-event|list|remove|run|report");
}

// ── 导入你现在在做的事 ──

// chief import：从 Jira（指派给你、没做完的）和 GitHub（你开着的 PR、等你 review 的）拉一份清单，
// 标出哪些已经在事情清单里了。Claude App 里的会话由主会话自己列（它有会话工具），再和这份合并。
async function importCandidates(): Promise<void> {
  const signal = AbortSignal.timeout(90_000);
  const known = new Set(loadThings().things.filter((x) => x.status !== "done" && x.status !== "dropped").flatMap((x) => x.keys ?? []));
  const out: { source: string; key: string; title: string; state: string; url: string; updated: string; known: boolean; due?: string | null }[] = [];
  const errors: string[] = [];
  const enabled = loadEnabled();
  if (enabled.jira) {
    const cli = findJiraCli();
    try {
      if (!cli) throw new Error("没找到 acli 或 twg");
      for (const it of await new JiraSource(cli).open(signal)) {
        out.push({ source: "jira", key: it.key, title: it.title, state: it.status, url: it.url, updated: it.updated, known: known.has(it.key), due: it.due });
      }
    } catch (error) {
      errors.push(`Jira：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (enabled.github) {
    const gh = findGh();
    try {
      if (!gh) throw new Error("没找到 gh");
      for (const it of await new GitHubSource(ghRunner(gh)).open(signal)) {
        const key = keysOf(it.url)[0] ?? it.url;
        out.push({ source: "github", key, title: `${it.ref} ${it.title}`, state: it.mine ? "我开的 PR" : "等我 review", url: it.url, updated: it.updated, known: known.has(key) });
      }
    } catch (error) {
      errors.push(`GitHub：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.stdout.write(`${JSON.stringify({ items: out, errors })}\n`);
}

// ── 你的规矩 ──

const HANDLES = HANDLE_LABELS;
const HANDLE_VALUES = Object.keys(HANDLE_LABELS) as Handle[];
const MODES: Record<ReplyMode, string> = { ask: "回复先给我确认", auto: "回复直接发（发前 5 秒可撤回）" };

function savePolicy(p: Policy): void {
  writeJson(paths().policy, p);
}

// 锁着改 policy.json（面板和主会话可能同时改）。
function updatePolicy<T>(fn: (p: Policy) => T): T {
  return withLock(paths().policy, () => {
    const p = loadPolicy();
    const out = fn(p);
    savePolicy(p);
    return out;
  });
}

// 改哪一条：内置场景写场景名（slack_dm），你加的情况写 custom:<号>。
function ruleOf(pp: Policy, target: string): ScenarioRule {
  const m = /^custom:(\d{1,6})$/.exec(target);
  if (m) return pp.custom.find((c) => c.id === Number(m[1])) ?? oops(`没有你加的情况 ${m[1]}`);
  if (target in SCENARIOS) return pp.scenarios[target as Scenario];
  return oops(`要改的是场景名（${Object.keys(SCENARIOS).join("|")}）或 custom:<号>`);
}

function ruleLine(r: ScenarioRule): string {
  const replyPart = r.handle === "ignore" || r.handle === "note" ? "" : `；${r.handle === "approve" ? (r.reply === "auto" ? "不用问我（5 秒可撤回）" : "approve 前先问我") : MODES[r.reply]}`;
  return `${HANDLES[r.handle]}${replyPart}${r.brief ? `；交代：${r.brief}` : ""}`;
}

// chief rules：给消息中心读的规矩全文。
// chief rules set <场景|custom:号> handle=… reply=ask|auto；chief rules brief <场景|custom:号>（标准输入）；
// chief rules custom add（标准输入：一句「什么情况」，或 JSON {when, handle, reply, brief}）| custom remove <号>；
// chief rules add（标准输入一句）；chief rules remove（标准输入给那一条的原文）
async function rules(args: string[]): Promise<void> {
  const sub = args.shift();
  const p = loadPolicy();
  // 第一次看规矩时把默认的写下来；老的文件缺后来加的东西（我加的情况、新场景）就补上。面板直接读这个文件。
  const onDisk = readJson<Partial<Policy>>(paths().policy, {});
  const missing = Object.keys(SCENARIOS).some((k) => !(k in (onDisk.scenarios ?? {})));
  if (!existsSync(paths().policy) || onDisk.custom === undefined || missing || onDisk.placement === undefined || onDisk.style === undefined || onDisk.trusted === undefined || onDisk.bots === undefined) updatePolicy(() => undefined);
  if (sub === undefined || sub === "show") {
    const lines = ["# 我的规矩（chief rules）", "", "## 我加的情况（先对这些，对上了就照它办，比下面的场景表优先）", ""];
    if (p.custom.length === 0) lines.push("（没有）");
    for (const c of p.custom) lines.push(`- custom:${c.id} 当「${c.when}」：${ruleLine(c)}`);
    lines.push("", "## 每个场景怎么办", "");
    for (const [k, v] of Object.entries(p.scenarios) as [Scenario, ScenarioRule][]) {
      lines.push(`- ${SCENARIOS[k]}（${k}）：${ruleLine(v)}`);
    }
    lines.push("", "## 我写的规矩（比上面的场景表优先）", "");
    p.notes.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
    lines.push("", "## 白名单：回这些人的话直接发，不用我确认（我写的「一定问我」的规矩照样优先）", "");
    lines.push(p.trusted.length > 0 ? p.trusted.map((x) => `- ${x}`).join("\n") : "（没有）");
    lines.push("", "## GitHub 上不报的机器人（它们的 review、评论不算有人找我；名字带 bot 的本来就不报）", "");
    lines.push(p.bots.length > 0 ? p.bots.map((x) => `- ${x}`).join("\n") : "（没有）");
    lines.push("", "## 回复写法（替我写的话都照这个写）", "");
    p.style.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push("", `Slack 回复放哪（对方本来在 thread 里说的总是回 thread）：${(Object.keys(p.placement) as Audience[]).map((k) => `${AUDIENCE_LABELS[k]} ${p.placement[k] === "thread" ? "回到 thread" : "直接回在对话里"}`).join("，")}。个别回复要不一样，reply add 时加 --in thread|inline。`);
    lines.push("", `替我发到 Slack 的话，正文上方会自动加一行灰色小字署名：${p.signature ? `${p.signature} · confirmed by @我` : "（不加）"}（署名不在正文里，你写回复时不用自己加）`);
    lines.push("", "规矩没说到的：往保守了办，对外发的东西先给我确认。");
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (sub === "json") {
    process.stdout.write(`${JSON.stringify(p)}\n`);
    return;
  }
  if (sub === "set") {
    const target = args.shift() ?? fail("chief rules set <场景|custom:号> handle=… reply=…");
    const changes: [string, string][] = args.map((kv) => {
      const [k, v] = kv.split("=");
      if ((k === "handle" && HANDLE_VALUES.includes(v as Handle)) || (k === "reply" && (v === "ask" || v === "auto"))) return [k, v!];
      fail(`看不懂 ${oneLine(kv, 40)}：handle=${HANDLE_VALUES.join("|")} reply=ask|auto`);
    });
    const now = updatePolicy((pp) => {
      const r = ruleOf(pp, target);
      for (const [k, v] of changes) {
        if (k === "handle") r.handle = v as Handle;
        else r.reply = v as ReplyMode;
      }
      return { ...r };
    });
    process.stdout.write(`${target in SCENARIOS ? SCENARIOS[target as Scenario] : target}：${ruleLine(now)}\n`);
    return;
  }
  if (sub === "custom") {
    const what = args.shift();
    if (what === "add") {
      const raw = await stdinText();
      let c: { when?: unknown; handle?: unknown; reply?: unknown; brief?: unknown };
      try {
        c = raw.startsWith("{") ? (JSON.parse(raw) as typeof c) : { when: raw };
      } catch {
        fail("标准输入是一句「什么情况」，或 JSON：{\"when\": \"…\", \"handle\": \"dispatch\", \"reply\": \"ask\", \"brief\": \"…\"}");
      }
      if (typeof c.when !== "string" || !c.when.trim()) fail("when（什么情况）不能空");
      const handle = typeof c.handle === "string" && HANDLE_VALUES.includes(c.handle as Handle) ? (c.handle as Handle) : "dispatch";
      const reply: ReplyMode = c.reply === "auto" ? "auto" : "ask";
      const brief = typeof c.brief === "string" && c.brief.trim() ? oneLine(c.brief, 500) : undefined;
      const when = oneLine(c.when, 200);
      const id = updatePolicy((pp) => {
        const x: CustomScenario = { id: pp.nextCustom++, when, handle, reply, ...(brief ? { brief } : {}) };
        pp.custom.push(x);
        return x.id;
      });
      process.stdout.write(`加好了：custom:${id}\n`);
      return;
    }
    if (what === "remove") {
      const id = num(args.shift(), "情况号");
      const gone = updatePolicy((pp) => {
        const before = pp.custom.length;
        pp.custom = pp.custom.filter((c) => c.id !== id);
        return before !== pp.custom.length;
      });
      if (!gone) fail(`没有你加的情况 ${id}（可能已经删了）`);
      return;
    }
    fail("chief rules custom add|remove");
  }
  // chief rules trust add|remove（标准输入：Slack 用户编号 U… 或名字的一部分）：白名单
  if (sub === "trust") {
    const what = args.shift();
    const text = oneLine(await stdinText(), 80);
    if (!text) fail("从标准输入给一个人：Slack 用户编号（U…）或名字的一部分");
    if (what === "add") {
      updatePolicy((pp) => {
        if (!pp.trusted.includes(text)) pp.trusted.push(text);
      });
      process.stdout.write(`加好了：回 ${text} 的话直接发\n`);
      return;
    }
    if (what === "remove") {
      const gone = updatePolicy((pp) => {
        const before = pp.trusted.length;
        pp.trusted = pp.trusted.filter((x) => x !== text);
        return before !== pp.trusted.length;
      });
      if (!gone) fail("白名单里没有这个");
      return;
    }
    fail("chief rules trust add|remove");
  }
  // chief rules bot add|remove（标准输入一个 GitHub 登录名）：GitHub 上不报的机器人
  if (sub === "bot") {
    const what = args.shift();
    const login = (await stdinText()).trim().toLowerCase();
    // GitHub 登录名：字母、数字、连字符，最多 39 个字；机器人账号可能带 [bot]。
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?$/.test(login)) fail("从标准输入给一个 GitHub 登录名，比如 acme-review-bot");
    if (what === "add") {
      updatePolicy((pp) => {
        if (!pp.bots.includes(login)) pp.bots.push(login);
      });
      process.stdout.write(`加好了：${login} 的 review 和评论以后不报\n`);
      return;
    }
    if (what === "remove") {
      const gone = updatePolicy((pp) => {
        const before = pp.bots.length;
        pp.bots = pp.bots.filter((x) => x !== login);
        return before !== pp.bots.length;
      });
      if (!gone) fail("机器人名单里没有这个");
      return;
    }
    fail("chief rules bot add|remove");
  }
  // chief rules style add（标准输入一句）| style remove（标准输入那一条的原文）：回复写法
  if (sub === "style") {
    const what = args.shift();
    const text = oneLine(await stdinText(), 300);
    if (!text) fail("从标准输入给那一条写法");
    if (what === "add") {
      updatePolicy((pp) => {
        if (!pp.style.includes(text)) pp.style.push(text);
      });
      process.stdout.write("加好了\n");
      return;
    }
    if (what === "remove") {
      const gone = updatePolicy((pp) => {
        const before = pp.style.length;
        pp.style = pp.style.filter((x) => x !== text);
        return before !== pp.style.length;
      });
      if (!gone) fail("没有这一条（可能已经删了）");
      return;
    }
    fail("chief rules style add|remove");
  }
  // chief rules place direct=inline group=inline channel=thread self=thread：Slack 回复默认放哪
  if (sub === "place") {
    const changes = args.map((kv) => {
      const [k, v] = kv.split("=");
      if (k && k in AUDIENCE_LABELS && (v === "inline" || v === "thread")) return [k as Audience, v as Placement] as const;
      fail(`看不懂 ${oneLine(kv, 40)}：direct|group|channel|self = inline|thread`);
    });
    const now = updatePolicy((pp) => {
      for (const [k, v] of changes) pp.placement[k] = v;
      return { ...pp.placement };
    });
    process.stdout.write(`${(Object.keys(now) as Audience[]).map((k) => `${AUDIENCE_LABELS[k]}：${now[k] === "thread" ? "回到 thread" : "直接回在对话里"}`).join("；")}\n`);
    return;
  }
  // chief rules sign（标准输入给一行标识，显示在替你发到 Slack 的话正文上方；空的就是不加）
  if (sub === "sign") {
    const text = oneLine(await stdinText(), 80);
    updatePolicy((pp) => {
      pp.signature = text;
    });
    process.stdout.write(text ? `Slack 回复正文上方会加：${text} · confirmed by @你\n` : "Slack 回复不加标识了\n");
    return;
  }
  // chief rules brief <场景|custom:号>（标准输入给交代的话；空的就是清掉）
  if (sub === "brief") {
    const target = args.shift() ?? fail("chief rules brief <场景|custom:号>");
    const text = oneLine(await stdinText(), 500);
    updatePolicy((pp) => {
      const r = ruleOf(pp, target);
      if (text) r.brief = text;
      else delete r.brief;
    });
    process.stdout.write(text ? `${target}：交代「${text}」\n` : `${target}：清掉了交代\n`);
    return;
  }
  if (sub === "add") {
    const text = oneLine(await stdinText(), 300);
    if (!text) fail("规矩是空的（从标准输入给一句）");
    const n = updatePolicy((pp) => {
      if (!pp.notes.includes(text)) pp.notes.push(text);
      return pp.notes.length;
    });
    process.stdout.write(`加好了，一共 ${n} 条\n`);
    return;
  }
  // 按原文删（标准输入给那一条）：连点两下也只删这一条，不会删到下一条。
  if (sub === "remove") {
    const text = oneLine(await stdinText(), 300);
    if (!text) fail("从标准输入给要删的那一条的原文");
    const gone = updatePolicy((pp) => {
      const before = pp.notes.length;
      pp.notes = pp.notes.filter((n) => n !== text);
      return before !== pp.notes.length;
    });
    if (!gone) fail("没有这一条（可能已经删了）");
    return;
  }
  // 主会话根据你的纠正提议一条（标准输入给 JSON：{"text": "…", "basis": "…"}）；你在面板上采纳或不要。
  if (sub === "propose") {
    let body: { text?: unknown; basis?: unknown };
    try {
      body = JSON.parse(await stdinText()) as typeof body;
    } catch {
      fail('标准输入要是 JSON：{"text": "…", "basis": "…"}');
    }
    if (typeof body.text !== "string" || !body.text.trim()) fail("text 不能空");
    const text = oneLine(body.text, 300);
    const basis = typeof body.basis === "string" ? oneLine(body.basis, 300) : "";
    const id = updatePolicy((pp) => {
      const x = { id: pp.nextProposal++, text, basis, at: new Date().toISOString() };
      pp.proposals.push(x);
      return x.id;
    });
    process.stdout.write(`${id}\n`);
    return;
  }
  if (sub === "accept" || sub === "reject") {
    const id = num(args.shift(), "提议号");
    const x = updatePolicy((pp) => {
      const found = pp.proposals.find((y) => y.id === id) ?? oops(`没有提议 ${id}（可能已经处理了）`);
      pp.proposals = pp.proposals.filter((y) => y.id !== id);
      if (sub === "accept" && !pp.notes.includes(found.text)) pp.notes.push(found.text);
      return found;
    });
    process.stdout.write(sub === "accept" ? `采纳了：${x.text}\n` : "不要了\n");
    return;
  }
  fail("chief rules [show|json|set|brief|sign|place|style|trust|custom|add|remove|propose|accept|reject]");
}

// ── 你给判断标对错 ──

// chief review <事件号> ok|wrong（标准输入给「应该怎样」）。
async function review(args: string[]): Promise<void> {
  const id = num(args.shift(), "事件号");
  const verdict = args.shift();
  if (verdict !== "ok" && verdict !== "wrong") fail("chief review <事件号> ok|wrong");
  eventById(id);
  const note = verdict === "wrong" ? await stdinText() : "";
  updateJson<Reviews, void>(paths().reviews, {}, (all) => {
    all[id] = { ok: verdict === "ok", at: new Date().toISOString(), ...(note ? { note } : {}) };
  });
}

// ── 回复 ──

// 回复正文只从 drafts 目录里读：消息中心先用 Write 把正文写进去，正文不经过命令行参数和 shell。
function draftText(file: string): string {
  const dir = realpathSync(paths().drafts);
  const full = resolve(file);
  if (!existsSync(full)) fail("文件不存在");
  if (lstatSync(full).isSymbolicLink()) fail("不收软链接");
  const real = realpathSync(full);
  if (!real.startsWith(dir + sep)) fail(`回复正文要放在 ${dir} 里`);
  if (statSync(real).size > MAX_REPLY) fail("回复太长了");
  const body = readFileSync(real, "utf8").trim();
  if (!body) fail("回复是空的");
  return body;
}

// 点了发送以后，这么久之内还能撤回；到点由引擎发出去。
const UNDO_MS = 5_000;

async function reply(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "add") {
    const event = eventById(num(flag(args, "--event") ?? undefined, "--event "));
    const body = draftText(flag(args, "--file") ?? fail("要 --file <drafts 里的文件>"));
    const thingFlag = flag(args, "--thing");
    const thingId = thingFlag === null ? null : num(thingFlag, "--thing ");
    // --in thread|inline：这一条要不要放 thread（不写就按规矩里这种对话的默认）。
    const place = flag(args, "--in");
    if (place !== null && place !== "thread" && place !== "inline") fail("--in 是 thread 或 inline");
    // --image：附图，只有 Slack 能发（GitHub、Jira 的评论 chief 只发文字）。
    const imagePaths = flags(args, "--image");
    if (imagePaths.length > 0 && event.source !== "slack") fail(`只有 Slack 的回复能附图；${event.source} 的回复只发文字`);
    const images = imagesOf(imagePaths);
    const r = updateReplies((all) => {
      // 同一条消息只留一份待确认的稿子：新稿子替掉旧的。
      for (const old of all.items) if (old.event === event.id && old.status === "pending") old.status = "dropped";
      const x: Reply = {
        id: all.nextId++, event: event.id, source: event.source, target: { ...event.reply, ...(place ? { in: place } : {}) }, body, status: "pending", at: new Date().toISOString(),
        context: { who: event.from, where: event.title, said: event.text.slice(0, 2000), url: event.url },
        ...(thingId !== null ? { thing: thingId } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      all.items.push(x);
      return x;
    });
    // 回复按哪条规矩发：对方在白名单里就直接发；否则按这个场景的设置。
    const pol = loadPolicy();
    const trusted = isTrusted(pol.trusted, event.from, event.fromId);
    process.stdout.write(`${JSON.stringify({ id: r.id, source: r.source, scenario: scenarioOf(event), policy: trusted ? "auto" : pol.scenarios[scenarioOf(event)].reply, ...(trusted ? { trusted: true } : {}) })}\n`);
    return;
  }
  // chief reply approve --event N --ref owner/repo#号 [--thing T] [--custom 号]：放一条「approve 这个 PR」进待发出。
  // 返回这条按哪条规矩办（policy 是 auto 就可以直接 queue --policy）。
  if (sub === "approve") {
    const event = eventById(num(flag(args, "--event") ?? undefined, "--event "));
    const ref = flag(args, "--ref") ?? fail("要 --ref owner/repo#号");
    if (!/^[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,9}$/.test(ref)) fail("--ref 写成 owner/repo#号");
    const thingFlag = flag(args, "--thing");
    const thingId = thingFlag === null ? null : num(thingFlag, "--thing ");
    const customFlag = flag(args, "--custom");
    const pol = loadPolicy();
    const rule = customFlag !== null ? pol.custom.find((c) => c.id === num(customFlag, "--custom ")) ?? fail(`没有你加的情况 ${customFlag}`) : pol.scenarios[scenarioOf(event)];
    const r = updateReplies((all) => {
      for (const old of all.items) if (old.event === event.id && old.kind === "approve" && old.status === "pending") old.status = "dropped";
      const x: Reply = {
        id: all.nextId++, kind: "approve", event: event.id, source: "github", target: { ref }, body: "", status: "pending", at: new Date().toISOString(),
        context: { who: event.from, where: event.title, said: event.text.slice(0, 2000), url: `https://github.com/${ref.replace("#", "/pull/")}` },
        ...(thingId !== null ? { thing: thingId } : {}),
      };
      all.items.push(x);
      return x;
    });
    process.stdout.write(`${JSON.stringify({ id: r.id, kind: "approve", ref, policy: rule.reply })}\n`);
    return;
  }
  // chief reply new --to <Slack 用户编号 U… / 邮箱 / 频道编号 C…> [--name 对方名字] [--thing T] --file <drafts 里的文件>：
  // 主动给人发一条新消息（不是回复谁）。放进待发出；你说了要发，再 queue。
  if (sub === "new") {
    const raw = flag(args, "--to") ?? fail("要 --to <Slack 用户编号 U… / 邮箱 / 频道编号 C… / 一条消息的链接>");
    // 给的是一条消息的链接：回到那条帖子的 thread 里（别人发的帖子也行）。
    const link = raw.startsWith("https://") ? parsePermalink(raw) ?? fail("--to 的链接要是 Slack 消息链接（https://….slack.com/archives/C…/p…）") : null;
    const to = link?.channel ?? raw;
    if (!link && !/^([UWCGD][A-Z0-9]{2,20}|[\w.+-]{1,64}@[\w.-]{1,100}\.[a-z]{2,20})$/i.test(to)) fail("--to 写 Slack 用户编号（U…）、邮箱、频道编号（C…），或一条消息的链接");
    const threadFlag = flag(args, "--thread");
    if (threadFlag !== null && (!/^\d{10}\.\d{6}$/.test(threadFlag) || !/^[CGD]/.test(to))) fail("--thread 写帖子的 ts（1795079290.188699），--to 要是频道编号");
    const thread = link?.thread_ts ?? threadFlag;
    const name = oneLine(flag(args, "--name") ?? to, 60);
    const thingFlag = flag(args, "--thing");
    const thingId = thingFlag === null ? null : num(thingFlag, "--thing ");
    const body = draftText(flag(args, "--file") ?? fail("要 --file <drafts 里的文件>"));
    const images = imagesOf(flags(args, "--image"));
    const r = updateReplies((all) => {
      const x: Reply = {
        id: all.nextId++, kind: "message", event: 0, source: "slack", target: { to, ...(thread ? { thread_ts: thread } : {}) }, body, status: "pending", at: new Date().toISOString(),
        context: { who: name, where: thread ? "回到帖子的 thread" : /^[CG]/.test(to) ? "发到频道" : "新私信", said: "", url: link ? raw : null },
        ...(thingId !== null ? { thing: thingId } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      all.items.push(x);
      return x;
    });
    process.stdout.write(`${JSON.stringify({ id: r.id, kind: "message", to, ...(thread ? { thread_ts: thread } : {}) })}\n`);
    return;
  }
  if (sub === "list") {
    const all = args.includes("--all");
    const items = loadReplies().items.filter((r) => all || r.status === "pending" || r.status === "queued" || r.status === "failed");
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  const id = num(args.shift(), "回复编号");
  const now = new Date();
  const find = (all: RepliesFile) => {
    const r = all.items.find((x) => x.id === id);
    if (!r) throw new Error(`没有回复 ${id}`);
    return r;
  };
  if (sub === "edit") {
    const text = (await stdinText()).trim();
    if (!text) fail("新稿子是空的（从标准输入给）");
    updateReplies((all) => {
      const r = find(all);
      if (r.status !== "pending" && r.status !== "failed") throw new Error(`回复 ${id} 现在是 ${r.status}，不能改`);
      r.original ??= r.body;
      r.body = text;
    });
    return;
  }
  if (sub === "queue") {
    // 你点了发送（by you），或者规矩允许直接发（--policy）。
    const byPolicy = args.includes("--policy");
    // 锁外先读好（锁里不能 fail）。
    const testEvents = new Set(readEvents().filter((e) => e.test).map((e) => e.id));
    updateReplies((all) => {
      const r = find(all);
      if (r.status !== "pending" && r.status !== "failed") throw new Error(`回复 ${id} 现在是 ${r.status}，不能发`);
      if (r.source === "notion") throw new Error("Notion 集成只读，这条请你到页面上自己回");
      if (Object.keys(r.target).length === 0) throw new Error("这是测试消息的回复，不会真的发出去");
      if (r.kind === "approve" && testEvents.has(r.event)) throw new Error("这是测试消息，不会真的 approve");
      r.status = "queued";
      r.by = byPolicy ? "policy" : "you";
      r.sendAt = new Date(now.getTime() + UNDO_MS).toISOString();
      delete r.error;
    });
    process.stdout.write(`5 秒后发出，之前可以 chief reply undo ${id}\n`);
    return;
  }
  if (sub === "undo") {
    updateReplies((all) => {
      const r = find(all);
      if (r.status !== "queued") throw new Error(`回复 ${id} 已经${r.status === "sending" || r.status === "sent" ? "发出去了" : `是 ${r.status}`}，撤不回`);
      r.status = "pending";
      delete r.sendAt;
      delete r.by;
    });
    return;
  }
  if (sub === "drop") {
    updateReplies((all) => {
      const r = find(all);
      if (r.status === "sending" || r.status === "sent") throw new Error("已经发出去了");
      r.status = "dropped";
    });
    return;
  }
  if (sub === "redo") {
    const feedback = (await stdinText()).trim();
    updateReplies((all) => {
      const r = find(all);
      if (r.status === "sending" || r.status === "sent") throw new Error("已经发出去了");
      r.status = "redo";
      if (feedback) r.feedback = feedback;
    });
    return;
  }
  fail("chief reply add|approve|new|list|edit|queue|undo|drop|redo");
}

// ── 连来源 ──

async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += String(chunk);
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  let value = "";
  return new Promise((done) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          stdin.pause();
          process.stderr.write("\n");
          done(value.trim());
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

function printChecks(checks: SecretCheck[]): boolean {
  for (const c of checks) process.stdout.write(`${c.pass ? "✓" : "✗"} ${c.label}：${c.detail}\n`);
  return checks.length > 0 && checks.every((c) => c.pass);
}

async function connect(source: string | undefined, args: string[] = []): Promise<void> {
  if (!source || !SOURCES.includes(source as EventSource)) fail(`chief connect ${SOURCES.join("|")}`);
  const id = source as EventSource;
  const secrets = new KeychainStore();
  const signal = AbortSignal.timeout(60_000);
  let ok: boolean;
  if (id === "slack") {
    // 默认开一个独立的 Chrome 窗口让你自己登录，拿到 Cookie 直接存进钥匙串，不经过剪贴板和聊天。
    // --workspace acme：从工作区地址登（公司 SSO 要这样）；不给就用上次登录成功时记下的。
    const given = flag(args, "--workspace");
    const workspace = given ?? loadSettings().slackWorkspace;
    if (given !== null) {
      try {
        workspaceUrl(given);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    const login = args.includes("--stdin")
      ? { cookie: await readSecret("Slack 会话 Cookie（xoxd-…，输入不显示）：") }
      : await browserLogin({ log: (line) => process.stdout.write(`${line}\n`), ...(workspace ? { workspace } : {}) }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    const cookie = login.cookie;
    if (!isStorableSecret(cookie)) fail("Cookie 里有不支持的字符");
    ok = printChecks(await new SlackPlugin().test({ [SLACK_COOKIE_D]: cookie }));
    if (ok) await secrets.set(SECRET.slack, cookie);
    // 记下这次登的工作区（你给的，或登录时看出来的），下次重新登录直接从工作区地址打开。
    const seen = given ?? ("workspace" in login ? login.workspace : undefined);
    if (ok && seen) {
      const name = new URL(workspaceUrl(seen)).hostname.split(".")[0]!;
      updateJson<Partial<Settings>, void>(paths().settings, {}, (s) => { s.slackWorkspace = name; });
    }
  } else if (id === "notion") {
    const token = await readSecret("Notion 集成令牌（输入不显示）：");
    if (!isStorableSecret(token)) fail("令牌里有不支持的字符");
    ok = printChecks(await new NotionSource(token).check(signal));
    if (ok) await secrets.set(SECRET.notion, token);
  } else if (id === "github") {
    const gh = findGh() ?? fail("没找到 gh：brew install gh，再 gh auth login");
    ok = printChecks(await new GitHubSource(ghRunner(gh)).check(signal));
  } else {
    const cli = findJiraCli() ?? fail("没找到 acli 或 twg：装 Atlassian 官方的 acli 再 acli jira auth login --web，或者装 twg 再 twg login");
    ok = printChecks(await new JiraSource(cli).check(signal));
  }
  if (!ok) fail("没通过，什么都没存");
  const enabled: Enabled = { ...loadEnabled(), [id]: true };
  writeJson(paths().sources, enabled);
  await restartIfInstalled();
  process.stdout.write(`${id} 连上了\n`);
}

async function disconnect(source: string | undefined): Promise<void> {
  if (!source || !SOURCES.includes(source as EventSource)) fail(`chief disconnect ${SOURCES.join("|")}`);
  const id = source as EventSource;
  writeJson(paths().sources, { ...loadEnabled(), [id]: false });
  if (id === "slack") await new KeychainStore().delete(SECRET.slack);
  if (id === "notion") await new KeychainStore().delete(SECRET.notion);
  await restartIfInstalled();
  process.stdout.write(`${id} 断开了\n`);
}

async function restartIfInstalled(): Promise<void> {
  if ((await serviceState()).loaded) await kickstart();
}

// ── 安装 ──

const TSX = () => join(ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs");

async function install(): Promise<void> {
  ensureHome();
  if (!existsSync(TSX())) fail("先在 chief 目录里 npm install");
  const p = paths();
  // chief 命令：写死这个 node 和 tsx，launchd、Monitor 里 PATH 不全也能跑。
  const binDir = join(p.home, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "chief");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --import "${TSX()}" "${join(ROOT, "src", "cli.ts")}" "$@"\n`, { mode: 0o755 });
  const plist = plistPath();
  writeFileSync(plist, renderPlist({
    node: process.execPath,
    args: ["--import", TSX(), join(ROOT, "src", "main.ts")],
    workingDir: ROOT,
    logFile: join(p.logs, "engine.log"),
    env: { HOME: homedir(), ...(process.env.CHIEF_HOME ? { CHIEF_HOME: process.env.CHIEF_HOME } : {}) },
  }));
  await bootstrap(plist);
  process.stdout.write(`装好了：${LABEL}\n  chief 命令：${bin}\n`);
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function uninstall(): Promise<void> {
  await bootout();
  for (const p of [plistPath(), join(homedir(), ".local", "bin", "chief")]) {
    if (lstatExists(p) && (p === plistPath() || lstatSync(p).isSymbolicLink())) unlinkSync(p);
  }
  process.stdout.write(`卸掉了（${paths().home} 里的数据没删）\n`);
}

async function status(): Promise<void> {
  const svc = await serviceState();
  const secrets = new KeychainStore();
  const enabled = loadEnabled();
  const evts = readEvents();
  const cursor = loadCursor();
  const pending = loadReplies().items.filter((r) => r.status === "pending" || r.status === "failed");
  const lines = [
    `引擎：${svc.loaded ? (svc.running ? `在跑（pid ${svc.pid}）` : `装了但没在跑（上次退出 ${svc.lastExit ?? "?"}）`) : "没装（chief install）"}`,
    `来源：${SOURCES.map((s) => `${s} ${enabled[s] ? "开" : "关"}`).join("，")}`,
    `钥匙串：Slack Cookie ${(await secrets.has(SECRET.slack)) ? "有" : "没有"}，Notion 令牌 ${(await secrets.has(SECRET.notion)) ? "有" : "没有"}`,
    `事件：一共 ${evts.length} 条，消息中心处理到 #${cursor}，还有 ${evts.filter((e) => e.id > cursor).length} 条没处理`,
    `对应表：${Object.keys(loadRoutes()).length} 个键`,
    `回复：${pending.length} 条等你`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

// 设置页用：一次看全「还差哪步」。gh / acli（或 twg）装了才去试登录，试不过的把原因带回去。
async function doctor(): Promise<void> {
  const svc = await serviceState();
  const secrets = new KeychainStore();
  const enabled = loadEnabled();
  const signal = AbortSignal.timeout(20_000);
  const tried = async (run: () => Promise<SecretCheck[]>) => {
    try {
      const checks = await run();
      const bad = checks.find((c) => !c.pass);
      return { ok: !bad, detail: bad ? `${bad.label}：${bad.detail}` : "" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };
  const gh = findGh();
  const jira = findJiraCli();
  const out = {
    version: existsSync(join(ROOT, "VERSION")) ? readFileSync(join(ROOT, "VERSION"), "utf8").trim() : null,
    node: process.version,
    engine: svc.running ? "running" : svc.loaded ? "stopped" : "missing",
    chrome: findChrome() !== null,
    sources: {
      slack: { enabled: enabled.slack === true, ready: await secrets.has(SECRET.slack) },
      github: { enabled: enabled.github === true, tool: gh !== null, ...(gh ? await tried(() => new GitHubSource(ghRunner(gh)).check(signal)) : { ok: false, detail: "" }) },
      jira: { enabled: enabled.jira === true, tool: jira !== null, ...(jira ? await tried(() => new JiraSource(jira).check(signal)) : { ok: false, detail: "" }) },
      notion: { enabled: enabled.notion === true, ready: await secrets.has(SECRET.notion) },
    },
    hub: hubAlive(),
    awake: loadSettings().awake,
    slackWorkspace: loadSettings().slackWorkspace ?? null,
    workspace: { path: workspaceDir(), ready: existsSync(join(workspaceDir(), "CLAUDE.md")) },
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// 插电时不让电脑睡：开关开着就挂一个 caffeinate -s -w <引擎>，引擎退出它也跟着退。每分钟看一次开关，改了不用重启引擎。
function keepAwake(): void {
  let child: ChildProcess | null = null;
  const check = () => {
    const want = loadSettings().awake;
    if (want && child === null) {
      const c = spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" });
      c.on("exit", () => { if (child === c) child = null; });
      c.on("error", () => { if (child === c) child = null; });
      child = c;
    } else if (!want && child !== null) {
      child.kill();
      child = null;
    }
  };
  check();
  setInterval(check, 60_000).unref();
}

// chief awake [on|off]：插电时不让电脑睡（引擎一分钟内跟上）。不带参数只看现在是开是关。
function awake(arg: string | undefined): void {
  if (arg === "on" || arg === "off") updateJson<Partial<Settings>, void>(paths().settings, {}, (s) => { s.awake = arg === "on"; });
  else if (arg !== undefined) fail("chief awake [on|off]");
  process.stdout.write(loadSettings().awake ? "插电时不让电脑睡：开\n" : "插电时不让电脑睡：关\n");
}

function logs(): void {
  const file = join(paths().logs, "engine.log");
  if (!existsSync(file)) fail("还没有日志");
  process.stdout.write(`${readFileSync(file, "utf8").split("\n").slice(-50).join("\n")}\n`);
}

// ── 入口 ──

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const cmd = args.shift();
  ensureHome();
  switch (cmd) {
    case "run": {
      const engine = new Engine();
      await engine.start();
      keepAwake();
      const quit = () => void engine.stop().then(() => process.exit(0));
      process.on("SIGTERM", quit);
      process.on("SIGINT", quit);
      return;
    }
    case "install": return install();
    case "uninstall": return uninstall();
    case "status": return status();
    case "logs": return logs();
    case "connect": return connect(args[0], args.slice(1));
    case "doctor": return doctor();
    case "awake": return awake(args[0]);
    case "disconnect": return disconnect(args[0]);
    case "events": return events(args);
    case "watch": return watchHome();
    case "show": {
      {
        const e = eventById(num(args[0], "事件号"));
        const related = relatedOf(e);
        process.stdout.write(`${JSON.stringify({ ...e, ...(related ? { related } : {}) }, null, 2)}\n`);
      }
      return;
    }
    case "hub": {
      // chief hub stop：让主会话停下（它的监听看到就退出，标题改回普通会话）。下次在哪个会话发 /chief:hub，哪个就是主会话。
      if (args[0] === "stop") {
        updateJson<Record<string, unknown>, void>(paths().alive, {}, (a) => {
          a.stopped = true;
          a.at = new Date().toISOString();
        });
        process.stdout.write("主会话会在 1 秒内停下\n");
        return;
      }
      process.stdout.write(`${JSON.stringify(hubAlive())}\n`);
      return;
    }
    case "engine": {
      // chief engine stop|start|restart：停下 / 开起引擎（launchd）。停了就不收消息、不发回复，数据都在。
      const what = args[0];
      if (what === "stop") {
        await bootout();
        process.stdout.write("引擎停了（不收消息、不发回复；chief engine start 再开）\n");
      } else if (what === "start") {
        if (!existsSync(plistPath())) fail("还没装：chief install");
        await bootstrap(plistPath());
        process.stdout.write("引擎开起来了\n");
      } else if (what === "restart") {
        await kickstart();
        process.stdout.write("引擎重启了\n");
      } else fail("chief engine stop|start|restart");
      return;
    }
    case "cursor": {
      if (args[0] === undefined) {
        process.stdout.write(`${loadCursor()}\n`);
        return;
      }
      const to = num(args[0], "事件号");
      updateJson<{ cursor?: number }, void>(paths().hub, {}, (h) => {
        // 进度只往前走：两边同时记时，不会被旧的盖回去。
        h.cursor = Math.max(h.cursor ?? 0, to);
      });
      return;
    }
    case "route": return route(args);
    case "reply": return reply(args);
    case "mark": return mark(args);
    case "board": return board();
    case "thing": return thing(args);
    case "ask": return ask(args);
    case "rules": return rules(args);
    case "review": return review(args);
    case "import": return importCandidates();
    case "test": return testEvent(args);
    case "eval": return evals(args);
    case "slack": return slackCmd(args);
    case "archive": {
      const n = archiveOld();
      process.stdout.write(`搬好了：事件 ${n.events}、判断 ${n.decisions}、事情 ${n.things}、问题 ${n.asks}、回复 ${n.replies}\n`);
      return;
    }
    default:
      fail("chief run|install|uninstall|status|logs|connect|disconnect|events|show|cursor|hub|engine|route|reply|mark|board|thing|ask|rules|review|import|test|eval|slack");
  }
}

main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
