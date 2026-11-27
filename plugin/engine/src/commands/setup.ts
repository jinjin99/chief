// 装和连：chief run / install / uninstall [--purge] / engine / status / logs / config / awake / connect / disconnect / doctor / slack / archive。
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveOld } from "../archive";
import { fail, flag } from "../args";
import { CONFIG_KEYS, LIVE_KEYS, liveConfig, loadConfig, setConfig } from "../config";
import { Engine, notifyCorrupt } from "../engine";
import { quietNow } from "../quiet";
import { LABEL, bootout, bootstrap, kickstart, plistPath, renderPlist, serviceState } from "../launchd";
import { tailLines } from "../logfile";
import { scrubTokens } from "../scrub";
import { KeychainStore } from "../secrets";
import { SOURCE_IDS, SOURCE_LABELS, isSourceId } from "../shared/sources";
import type { Doctor, DoctorSource } from "../shared/types";
import { findChrome } from "../slack/login";
import { findPeople } from "../slack/people";
import type { SecretCheck } from "../slack/types";
import { DESCRIPTORS, SOURCES } from "../sources/registry";
import { CorruptFileError, ensureHome, loadCursor, loadEnabled, loadReplies, loadRoutes, loadSettings, paths, readEvents, readJson, updateJson, withLock, workspaceDir, writeJson, type Settings } from "../store";
import { hubAlive } from "./events";
import { PURGE_LEFT, describePlan, purgePlan, runPurge, type PurgePlan } from "./export";
import { askInTerminal } from "./key";

// 引擎目录（这个文件在 src/commands/ 下）。
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// chief slack who <名字>：找人，拿到用户编号。稿子里写 <@U…> 对方才会收到提醒；查过的人记下来，面板显示成 @名字。
export async function slackCmd(args: string[]): Promise<void> {
  if (args[0] !== "who") fail("chief slack who <名字>");
  const query = args.slice(1).join(" ").trim();
  if (!query || query.length > 60 || /[\n<>]/.test(query)) fail("给一个名字（60 字以内），比如 chief slack who Dave");
  const cookie = await new KeychainStore().get(SOURCES.slack.secret!);
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

export async function readSecret(prompt: string): Promise<string> {
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

export function printChecks(checks: SecretCheck[]): boolean {
  for (const c of checks) process.stdout.write(`${c.pass ? "✓" : "✗"} ${c.label}：${c.detail}\n`);
  return checks.length > 0 && checks.every((c) => c.pass);
}

// chief connect <来源>：来源自己检查能不能用（SourceDescriptor 的 connect），都过了才存、才记成开着。
export async function connect(source: string | undefined, args: string[] = []): Promise<void> {
  if (!source || !isSourceId(source)) fail(`chief connect ${SOURCE_IDS.join("|")}`);
  const d = SOURCES[source];
  const got = await d.connect({
    flag: (name) => flag(args, name),
    has: (name) => args.includes(name),
    secrets: new KeychainStore(),
    signal: AbortSignal.timeout(60_000),
    readSecret,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const ok = printChecks(got.checks);
  if (ok) await got.save?.();
  if (!ok) fail("没通过，什么都没存");
  writeJson(paths().sources, { ...loadEnabled(), [d.id]: true });
  await restartIfInstalled();
  process.stdout.write(`${d.id} 连上了\n`);
}

export async function disconnect(source: string | undefined): Promise<void> {
  if (!source || !isSourceId(source)) fail(`chief disconnect ${SOURCE_IDS.join("|")}`);
  const d = SOURCES[source];
  writeJson(paths().sources, { ...loadEnabled(), [d.id]: false });
  if (d.secret) await new KeychainStore().delete(d.secret);
  await restartIfInstalled();
  process.stdout.write(`${d.id} 断开了\n`);
}

export async function restartIfInstalled(): Promise<void> {
  if ((await serviceState()).loaded) await kickstart();
}

export const TSX = () => join(ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs");

export async function install(): Promise<void> {
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

export function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// 卸掉 launchd 里的引擎和 ~/.local/bin/chief 这个链接（是链接才删）。返回删了的。
async function unload(): Promise<string[]> {
  await bootout();
  const done: string[] = [];
  for (const p of [plistPath(), join(homedir(), ".local", "bin", "chief")]) {
    if (lstatExists(p) && (p === plistPath() || lstatSync(p).isSymbolicLink())) {
      unlinkSync(p);
      done.push(p);
    }
  }
  return done;
}

// chief uninstall [--purge]：卸掉引擎，数据留着；--purge 连数据、工作目录、钥匙串里的 chief 密钥一起删（要你在终端里敲 purge）。
export async function uninstall(args: string[] = []): Promise<void> {
  if (args.includes("--purge")) return purge();
  await unload();
  process.stdout.write(`卸掉了（${paths().home} 里的数据没删）\n`);
}

async function purge(): Promise<void> {
  // 先看是不是你在终端里亲手跑的：主会话、管道里跑的一律不删，什么都不动。
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail("chief uninstall --purge 会删掉 chief 的全部数据，要你在终端里亲手敲 purge 确认：请直接在终端里跑。删之前可以先 chief export 留一份。");
  }
  let plan: PurgePlan;
  try {
    plan = purgePlan(paths().home, homedir());
  } catch (error) {
    fail(`不删：${error instanceof Error ? error.message : String(error)}`);
  }
  process.stderr.write(`${describePlan(plan)}\n\n删了就找不回来。想先留一份：按回车取消，跑 chief export（导出不含密钥）。\n`);
  const typed = await askInTerminal("确定全删就敲 purge：");
  if (typed !== "purge") fail("没敲 purge，什么都没删");
  const done = [...await unload()];
  try {
    done.push(...await runPurge(plan, paths().home, homedir(), new KeychainStore()));
  } catch (error) {
    process.stdout.write(`删掉了：\n${done.map((p) => `  - ${p}`).join("\n")}\n`);
    fail(`删到一半停下了：${error instanceof Error ? error.message : String(error)}`);
  }
  process.stdout.write([
    "删掉了：",
    ...done.map((p) => `  - ${p}`),
    ...(plan.keep.length > 0 ? ["留着（你导出的备份）：", ...plan.keep.map((p) => `  - ${p}`)] : []),
    PURGE_LEFT,
  ].join("\n") + "\n");
}

export async function status(): Promise<void> {
  const svc = await serviceState();
  const secrets = new KeychainStore();
  const enabled = loadEnabled();
  const evts = readEvents();
  const cursor = loadCursor();
  const pending = loadReplies().items.filter((r) => r.status === "pending" || r.status === "failed");
  const lines = [
    `引擎：${svc.loaded ? (svc.running ? `在跑（pid ${svc.pid}）` : `装了但没在跑（上次退出 ${svc.lastExit ?? "?"}）`) : "没装（chief install）"}`,
    `来源：${SOURCE_IDS.map((s) => `${s} ${enabled[s] ? "开" : "关"}`).join("，")}`,
    `钥匙串：${(await Promise.all(DESCRIPTORS.filter((d) => d.secret).map(async (d) => `${d.meta.label} ${d.meta.secretLabel ?? "密钥"} ${(await secrets.has(d.secret!)) ? "有" : "没有"}`))).join("，")}`,
    `事件：一共 ${evts.length} 条，消息中心处理到 #${cursor}，还有 ${evts.filter((e) => e.id > cursor).length} 条没处理`,
    `对应表：${Object.keys(loadRoutes()).length} 个键`,
    `回复：${pending.length} 条等你`,
    `免打扰：${quietLine()}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function quietLine(): string {
  const q = quietNow();
  if (!q.hours) return "没设";
  return `${q.hours.start}–${q.hours.end}，${q.quiet && q.until ? `现在是，到 ${new Date(q.until).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "现在不是"}`;
}

// 设置页用：一次看全「还差哪步」。存钥匙的来源看钥匙串里有没有；用本机命令的（gh、acli 或 twg）装了才去试登录，试不过的把原因带回去。
export async function doctor(): Promise<void> {
  const svc = await serviceState();
  const secrets = new KeychainStore();
  const enabled = loadEnabled();
  const signal = AbortSignal.timeout(20_000);
  const tried = async (run: () => Promise<SecretCheck[]>) => {
    try {
      const checks = await run();
      const bad = checks.find((c) => !c.pass);
      return { ok: !bad, detail: bad ? scrubTokens(`${bad.label}：${bad.detail}`) : "" };
    } catch (error) {
      return { ok: false, detail: scrubTokens(error instanceof Error ? error.message : String(error)) };
    }
  };
  const sources: Record<string, DoctorSource> = {};
  for (const d of DESCRIPTORS) {
    if (d.secret) {
      sources[d.id] = { enabled: enabled[d.id] === true, ready: await secrets.has(d.secret) };
    } else {
      const local = d.local?.() ?? null;
      sources[d.id] = { enabled: enabled[d.id] === true, tool: local !== null, ...(local ? await tried(() => local.check(signal)) : { ok: false, detail: "" }) };
    }
  }
  const out: Doctor = {
    version: existsSync(join(ROOT, "VERSION")) ? readFileSync(join(ROOT, "VERSION"), "utf8").trim() : null,
    node: process.version,
    engine: svc.running ? "running" : svc.loaded ? "stopped" : "missing",
    chrome: findChrome() !== null,
    sources,
    hub: hubAlive(),
    awake: loadSettings().awake,
    slackWorkspace: loadSettings().slackWorkspace ?? null,
    workspace: { path: workspaceDir(), ready: existsSync(join(workspaceDir(), "CLAUDE.md")) },
    list: DESCRIPTORS.map((d) => ({ id: d.id, label: SOURCE_LABELS[d.id], setup: d.meta.setup.kind, ...sources[d.id]! })),
    quietHours: liveConfig().quietHours,
    digest: liveConfig().digest,
    triage: liveConfig().triage ? liveConfig().triageModel : "off",
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// 插电时不让电脑睡：开关开着就挂一个 caffeinate -s -w <引擎>，引擎退出它也跟着退。每分钟看一次开关，改了不用重启引擎。
export function keepAwake(): void {
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
export function awake(arg: string | undefined): void {
  if (arg === "on" || arg === "off") updateJson<Partial<Settings>, void>(paths().settings, {}, (s) => { s.awake = arg === "on"; });
  else if (arg !== undefined) fail("chief awake [on|off]");
  process.stdout.write(loadSettings().awake ? "插电时不让电脑睡：开\n" : "插电时不让电脑睡：关\n");
}

// 只读日志结尾一段（日志可能很大）。
export function logs(): void {
  const file = join(paths().logs, "engine.log");
  if (!existsSync(file)) fail("还没有日志");
  process.stdout.write(`${tailLines(file, 50).join("\n")}\n`);
}

// chief config：打出现在生效的设置（JSON）；有不对的值在 problems 里。chief config set <键> <值>：改一项（引擎重启后生效）。
export function configCmd(args: string[]): void {
  const sub = args[0];
  if (sub === undefined || sub === "show") {
    const { config, problems } = loadConfig();
    process.stdout.write(`${JSON.stringify(problems.length > 0 ? { ...config, problems } : config, null, 2)}\n`);
    return;
  }
  if (sub === "set") {
    const [key, value] = [args[1], args[2]];
    if (key === undefined || value === undefined) fail(`chief config set <键> <值>，键是 ${CONFIG_KEYS.join("、")} 之一`);
    try {
      setConfig(key, value);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    process.stdout.write(LIVE_KEYS.includes(key.split(".")[0]!) ? `改好了（${paths().config}），马上生效\n` : `改好了（${paths().config}）。引擎重启后生效：chief engine restart\n`);
    return;
  }
  fail("chief config [show] | chief config set <键> <值>");
}

// chief run：前台跑引擎（launchd 里跑的也是它）。
export async function run(): Promise<void> {
  let engine: Engine;
  try {
    engine = new Engine();
    await engine.start();
  } catch (error) {
    // 要紧的数据文件坏了（见 store.ts 的 readJson）：弹个通知再退出，不拿空的接着跑。
    if (error instanceof CorruptFileError) notifyCorrupt();
    throw error;
  }
  keepAwake();
  const quit = () => void engine.stop().then(() => process.exit(0));
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}

// chief engine stop|start|restart：停下 / 开起引擎（launchd）。停了就不收消息、不发回复，数据都在。
export async function engineCmd(args: string[]): Promise<void> {
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
}

// chief archive：把办完超过 7 天的搬进 ~/chief/data/archive（引擎每天自己搬一次）。
export function archive(): void {
  const n = archiveOld();
  process.stdout.write(`搬好了：事件 ${n.events}、判断 ${n.decisions}、事情 ${n.things}、问题 ${n.asks}、回复 ${n.replies}\n`);
}
