// 可调的数字和开关：~/chief/config.json（和 rules.json 放一起；用 CHIEF_HOME 时放在那个目录里）。没有这个文件就全用默认值。
// 不认得的键不管；值不对（类型不对、格式不对）用默认值，超出范围的取最近的边界，都在 problems 里说一句（引擎启动时写进日志）。
// 改了以后重启引擎才生效（chief engine restart）；免打扰、每天汇总和语言例外，引擎用到时现读（见 liveConfig）。chief config 打出现在生效的值，chief config set <键> <值> 改一项。
//   pollMinutes        每隔几分钟拉一次 GitHub / Jira / Notion                 默认 5     1–120
//   firstLookbackHours 第一次连上一个来源，往回看几小时                          默认 24    1–720
//   missedMinutes      交给主会话多久还没判断算漏掉了（再交一次）                默认 10    1–1440
//   hubDownMinutes     主会话多久没在听、又有消息等着，就弹通知叫你              默认 5     1–1440
//   nagMinutes         主会话一直没在听时，最多每隔几分钟再提醒一次              默认 30    5–1440
//   keepDays           办完的东西留几天再归档                                     默认 7     1–365
//   undoSeconds        点了发送以后几秒内还能撤回                                 默认 5     0–60
//   items.github       每次最多拉几条 GitHub 动态                                 默认 50    1–100
//   items.jira         每次最多拉几张 Jira 单                                     默认 50    1–200
//   slackCatchUpHours  Slack 连上以后补收最近几小时的私信、群聊                   默认 48    0–168
//   logMaxMB           engine.log 超过多少 MB 就换一个（留 .1 .2 两份旧的）        默认 10    1–500
//   refCheckMinutes    每隔几分钟查一次开着的问题、待发出的回复提到的 PR 变没变   默认 10    2–120
//   staleDraftHours    待发出的回复放了几小时还没发，交给主会话核一遍            默认 12    1–168
//   locale             面板、通知、主会话跟你说话的语言："zh" | "en"（见 messages.ts、shared/i18n.ts） 默认 "zh"
//   quietHours         免打扰时段：{"start":"22:00","end":"08:00"} 或 null         默认 null
//   digest             每天汇总：{"morning":"HH:MM" 或 null, "evening":"HH:MM" 或 null} 默认都是 null
//   triage             只用记一笔的事件先给 Haiku 看、不叫醒主会话（见 triage.ts）：true | false   默认 true
//   triageModel        分诊用哪个模型（走主会话的订阅）："haiku" | "sonnet" | "opus"             默认 "haiku"
import { existsSync, readFileSync } from "node:fs";
import { HHMM } from "./shared/schedule";
import { paths, withLock, writeJson } from "./store";

export interface Config {
  pollMinutes: number;
  firstLookbackHours: number;
  missedMinutes: number;
  hubDownMinutes: number;
  nagMinutes: number;
  keepDays: number;
  undoSeconds: number;
  items: { github: number; jira: number };
  slackCatchUpHours: number;
  logMaxMB: number;
  refCheckMinutes: number;
  staleDraftHours: number;
  locale: "zh" | "en";
  quietHours: { start: string; end: string } | null;
  digest: { morning: string | null; evening: string | null };
  triage: boolean;
  triageModel: TriageModel;
}

export const TRIAGE_MODELS = ["haiku", "sonnet", "opus"] as const;
export type TriageModel = (typeof TRIAGE_MODELS)[number];

export function defaultConfig(): Config {
  return {
    pollMinutes: 5, firstLookbackHours: 24, missedMinutes: 10, hubDownMinutes: 5, nagMinutes: 30, keepDays: 7, undoSeconds: 5,
    items: { github: 50, jira: 50 }, slackCatchUpHours: 48, logMaxMB: 10, refCheckMinutes: 10, staleDraftHours: 12,
    locale: "zh", quietHours: null, digest: { morning: null, evening: null }, triage: true, triageModel: "haiku",
  };
}

// 数字项的范围（含两头）。键写成点分的路径（items.github）。
const RANGES: Record<string, [number, number]> = {
  pollMinutes: [1, 120], firstLookbackHours: [1, 720], missedMinutes: [1, 1440], hubDownMinutes: [1, 1440], nagMinutes: [5, 1440],
  keepDays: [1, 365], undoSeconds: [0, 60], "items.github": [1, 100], "items.jira": [1, 200], slackCatchUpHours: [0, 168], logMaxMB: [1, 500],
  refCheckMinutes: [2, 120], staleDraftHours: [1, 168],
};

// chief config set 认得的键。
export const CONFIG_KEYS = [...Object.keys(RANGES), "locale", "quietHours", "quietHours.start", "quietHours.end", "digest", "digest.morning", "digest.evening", "triage", "triageModel"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// 把文件里的东西对一遍：好的照用，不好的换成默认值，说一句为什么。
export function validateConfig(raw: unknown): { config: Config; problems: string[] } {
  const config = defaultConfig();
  const problems: string[] = [];
  if (!isObj(raw)) {
    if (raw !== undefined) problems.push("config.json 不是一个 JSON 对象，全用默认值");
    return { config, problems };
  }
  const get = (key: string): unknown => key.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), raw);
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = get(key);
    if (v === undefined) continue;
    const [a, b] = key.split(".") as [string, string | undefined];
    const set = (n: number) => {
      if (b === undefined) (config as unknown as Record<string, number>)[a] = n;
      else (config as unknown as Record<string, Record<string, number>>)[a]![b] = n;
    };
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`${key} 要是数字，用默认值 ${String(defaultOf(key))}`);
      continue;
    }
    const n = Math.min(max, Math.max(min, v));
    if (n !== v) problems.push(`${key} 要在 ${min}–${max} 之间，按 ${n} 算`);
    set(n);
  }
  const locale = get("locale");
  if (locale !== undefined) {
    if (locale === "zh" || locale === "en") config.locale = locale;
    else problems.push('locale 只能是 "zh" 或 "en"，用默认值 "zh"');
  }
  const triage = get("triage");
  if (triage !== undefined) {
    if (typeof triage === "boolean") config.triage = triage;
    else problems.push("triage 只能是 true 或 false，按 true 算");
  }
  const model = get("triageModel");
  if (model !== undefined) {
    if ((TRIAGE_MODELS as readonly unknown[]).includes(model)) config.triageModel = model as TriageModel;
    else problems.push(`triageModel 只能是 ${TRIAGE_MODELS.map((m) => `"${m}"`).join("、")}，按 "haiku" 算`);
  }
  const quiet = get("quietHours");
  if (quiet !== undefined && quiet !== null) {
    if (isObj(quiet) && typeof quiet.start === "string" && typeof quiet.end === "string" && HHMM.test(quiet.start) && HHMM.test(quiet.end)) {
      config.quietHours = { start: quiet.start, end: quiet.end };
    } else problems.push('quietHours 要是 {"start":"HH:MM","end":"HH:MM"} 或 null，按 null 算');
  }
  const digest = get("digest");
  if (digest !== undefined) {
    if (!isObj(digest)) problems.push('digest 要是 {"morning":"HH:MM"|null,"evening":"HH:MM"|null}，按都不汇总算');
    else {
      for (const k of ["morning", "evening"] as const) {
        const v = digest[k];
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && HHMM.test(v)) config.digest[k] = v;
        else problems.push(`digest.${k} 要是 "HH:MM" 或 null，按 null 算`);
      }
    }
  }
  return { config, problems };
}

function defaultOf(key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), defaultConfig());
}

function readRaw(): { raw: unknown; problems: string[] } {
  const file = paths().config;
  if (!existsSync(file)) return { raw: undefined, problems: [] };
  try {
    const text = readFileSync(file, "utf8");
    return { raw: text.trim() === "" ? undefined : JSON.parse(text), problems: [] };
  } catch (error) {
    // 你手改的文件：写坏了不挪走（等你改好），先全用默认值。
    return { raw: undefined, problems: [`config.json 读不了（${error instanceof Error ? error.message : String(error)}），全用默认值`] };
  }
}

let cached: { home: string; config: Config; problems: string[] } | null = null;

// 现在生效的设置。一个进程只读一次文件（引擎改了要重启）；换了 CHIEF_HOME（测试）会重读。
export function loadConfig(): { config: Config; problems: string[] } {
  const home = paths().home;
  if (cached?.home !== home) {
    const { raw, problems } = readRaw();
    const v = validateConfig(raw);
    cached = { home, config: v.config, problems: [...problems, ...v.problems] };
  }
  return { config: cached.config, problems: cached.problems };
}

export function config(): Config {
  return loadConfig().config;
}

// 不用缓存、现读一遍文件：免打扰和每天汇总改了马上生效（文件很小，引擎每分钟读一次也不费事）。
export function liveConfig(): Config {
  return validateConfig(readRaw().raw).config;
}

// 改了马上生效、不用重启引擎的键。
export const LIVE_KEYS = ["quietHours", "digest", "locale", "triage", "triageModel"];

// 命令行给的值：能当 JSON 读的（数字、null、对象、带引号的字符串）就当 JSON，否则当字符串（08:30、en）。
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// chief config set <键> <值>：改一项。值不对就报错、不写（不会悄悄变成默认值）。
export function setConfig(key: string, text: string): Config {
  if (!CONFIG_KEYS.includes(key)) throw new Error(`没有 ${key} 这一项。能改的：${CONFIG_KEYS.join("、")}`);
  const value = parseValue(text);
  const file = paths().config;
  const out = withLock(file, () => {
    const { raw, problems } = readRaw();
    if (problems.length > 0) throw new Error(`${problems[0]}；先把 ${file} 改好`);
    const data: Record<string, unknown> = isObj(raw) ? raw : {};
    const [a, b] = key.split(".") as [string, string | undefined];
    if (b === undefined) data[a] = value;
    else {
      const parent = isObj(data[a]) ? data[a] : a === "quietHours" ? { ...(config().quietHours ?? { start: "22:00", end: "08:00" }) } : {};
      parent[b] = value;
      data[a] = parent;
    }
    const v = validateConfig(data);
    const bad = v.problems.find((p) => p.startsWith(a));
    if (bad) throw new Error(bad.replace(/，(用默认值|按).*$/, ""));
    writeJson(file, data);
    return v.config;
  });
  cached = null;
  return out;
}
