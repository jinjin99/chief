// 你的规矩：chief rules（含白名单、「一定问我」、固定回复、提议）、review（给判断标对错）、import（导入手上的事）。
import { existsSync } from "node:fs";
import { MAX_TEXT, fail, num, oneLine, oops, stdinRaw, stdinText } from "../args";
import { REPLY_MODE_LABELS } from "../shared/rules";
import { DESCRIPTORS } from "../sources/registry";
import type { ImportItem } from "../sources/types";
import { AUDIENCE_LABELS, HANDLE_LABELS, SCENARIOS, loadEnabled, loadPolicy, loadThings, paths, readJson, updateJson, withLock, writeJson, type Audience, type CustomScenario, type Handle, type Placement, type Policy, type ReplyMode, type Reviews, type Scenario, type ScenarioRule } from "../store";
import { MODES_LIST, type Mode } from "../shared/types";
import { eventById } from "./events";
import { keyMatches } from "./key";

export const HANDLES = HANDLE_LABELS;

export const HANDLE_VALUES = Object.keys(HANDLE_LABELS) as Handle[];

export const MODES: Readonly<Record<ReplyMode, string>> = REPLY_MODE_LABELS;

export function savePolicy(p: Policy): void {
  writeJson(paths().policy, p);
}

// 锁着改 policy.json（面板和主会话可能同时改）。
export function updatePolicy<T>(fn: (p: Policy) => T): T {
  return withLock(paths().policy, () => {
    const p = loadPolicy();
    const out = fn(p);
    savePolicy(p);
    return out;
  });
}

// 改哪一条：内置场景写场景名（slack_dm），你加的情况写 custom:<号>。
export function ruleOf(pp: Policy, target: string): ScenarioRule {
  const m = /^custom:(\d{1,6})$/.exec(target);
  if (m) return pp.custom.find((c) => c.id === Number(m[1])) ?? oops(`没有你加的情况 ${m[1]}`);
  if (target in SCENARIOS) return pp.scenarios[target as Scenario];
  return oops(`要改的是场景名（${Object.keys(SCENARIOS).join("|")}）或 custom:<号>`);
}

export function ruleLine(r: ScenarioRule): string {
  const replyPart = r.handle === "ignore" || r.handle === "note" ? "" : `；${r.handle === "approve" ? (r.reply === "auto" ? "不用问我（5 秒可撤回）" : "approve 前先问我") : MODES[r.reply]}`;
  return `${HANDLES[r.handle]}${replyPart}${r.brief ? `；交代：${r.brief}` : ""}`;
}

// 放宽发送的改动（让更多回复、approve 不问你就发）要你点头。主会话读的是别人写的原文，可能被人带着改规矩：
//   chief rules --yours <子命令…>：带 chief 插件的钥匙（面板上改的），标准输入给 JSON {key, text}，text 是这条命令本来从标准输入给的东西。直接生效。
//   不带钥匙：放宽的改动不生效，记成提议放进面板「它提议的规矩」，你点采纳（面板带钥匙）才照原样生效。收紧的不用钥匙。
// 算放宽的：场景 / 你加的情况改成 reply=auto 或 handle=approve|command，加这样的情况，白名单加人，固定回复加句子，改署名，「一定问我」名单删掉一项（always remove）。
// 主会话和你是同一个系统用户，直接改 rules.json 拦不住；这里管的是它照正常路子（chief 命令）改规矩时不能自己放宽。
export type RulesOpts = { yours: boolean; text: string };

// 放宽的改动没带钥匙：记成提议（说清改的是什么），告诉主会话还没生效。
export function proposeLoosen(argv: string[], input: string, text: string): void {
  const id = updatePolicy((pp) => {
    const x = { id: pp.nextProposal++, text, basis: "这条会放宽发送（更多东西不问你就发），主会话改不了，要你点采纳才生效", at: new Date().toISOString(), change: { args: argv, input } };
    pp.proposals.push(x);
    return x.id;
  });
  process.stdout.write(`没改：这条会放宽发送，要用户点头。已放进面板「它提议的规矩」（提议 ${id}），用户点采纳才生效\n`);
}

// chief rules：给消息中心读的规矩全文。
// chief rules set <场景|custom:号> handle=… reply=ask|auto；chief rules brief <场景|custom:号>（标准输入）；
// chief rules custom add（标准输入：一句「什么情况」，或 JSON {when, handle, reply, brief}）| custom remove <号>；
// chief rules add（标准输入一句）；chief rules remove（标准输入给那一条的原文）
// 放宽发送的（见上面）不带 --yours 只会变成提议。
export async function rules(args: string[], given?: RulesOpts): Promise<void> {
  let opts = given;
  if (opts === undefined && args[0] === "--yours") {
    args.shift();
    let req: { key?: unknown; text?: unknown };
    try {
      req = JSON.parse(await stdinRaw(MAX_TEXT * 4)) as typeof req;
    } catch {
      fail("--yours 的标准输入给 JSON：{\"key\": …, \"text\": …}");
    }
    if (typeof req.key !== "string" || !keyMatches(req.key)) fail("钥匙对不上：--yours 只给你在面板上改规矩用");
    opts = { yours: true, text: typeof req.text === "string" ? req.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT) : "" };
  }
  const yours = opts?.yours === true;
  const input = async () => (opts !== undefined ? opts.text : stdinText());
  // 这条命令原样（提议采纳时再跑一遍）。
  const argv = [...args];
  const sub = args.shift();
  const p = loadPolicy();
  // 第一次看规矩时把默认的写下来；老的文件缺后来加的东西（我加的情况、新场景）就补上。面板直接读这个文件。
  const onDisk = readJson<Partial<Policy>>(paths().policy, {});
  const missing = Object.keys(SCENARIOS).some((k) => !(k in (onDisk.scenarios ?? {})));
  if (!existsSync(paths().policy) || onDisk.custom === undefined || missing || onDisk.placement === undefined || onDisk.style === undefined || onDisk.trusted === undefined || onDisk.askAlways === undefined || onDisk.bots === undefined || onDisk.quick === undefined) updatePolicy(() => undefined);
  if (sub === undefined || sub === "show") {
    const lines = ["# 我的规矩（chief rules）", "", `做事方式：${p.mode}（normal 规矩没放行的都问我；auto 少问我；yolo 全部代我决策，只有「一定问我」名单拦得住）`, "", "## 我加的情况（先对这些，对上了就照它办，比下面的场景表优先）", ""];
    if (p.custom.length === 0) lines.push("（没有）");
    for (const c of p.custom) lines.push(`- custom:${c.id} 当「${c.when}」：${ruleLine(c)}`);
    lines.push("", "## 每个场景怎么办", "");
    for (const [k, v] of Object.entries(p.scenarios) as [Scenario, ScenarioRule][]) {
      lines.push(`- ${SCENARIOS[k]}（${k}）：${ruleLine(v)}`);
    }
    lines.push("", "## 我写的规矩（比上面的场景表优先）", "");
    p.notes.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
    lines.push("", "## 一定问我：这些人、这些对话的回复和 approve 都要我确认，什么规矩都不能让它直接发（比白名单优先）", "");
    lines.push(p.askAlways.length > 0 ? p.askAlways.map((x) => `- ${x}`).join("\n") : "（没有）");
    lines.push("", "## 白名单：回这些人的话直接发，不用我确认（「一定问我」名单里的照样问我）", "");
    lines.push(p.trusted.length > 0 ? p.trusted.map((x) => `- ${x}`).join("\n") : "（没有）");
    lines.push("", "## 固定回复：回复和这几句一字不差，才能不问我直接发（别的规矩只管怎么写，不能让你直接发）", "");
    lines.push(p.quick.length > 0 ? p.quick.map((x) => `- ${x}`).join("\n") : "（没有）");
    lines.push("", "## GitHub 上不报的机器人（它们的 review、评论不算有人找我；名字带 bot 的本来就不报）", "");
    lines.push(p.bots.length > 0 ? p.bots.map((x) => `- ${x}`).join("\n") : "（没有）");
    lines.push("", "## 回复写法（替我写的话都照这个写）", "");
    p.style.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push("", `Slack 回复放哪（对方本来在 thread 里说的总是回 thread）：${(Object.keys(p.placement) as Audience[]).map((k) => `${AUDIENCE_LABELS[k]} ${p.placement[k] === "thread" ? "回到 thread" : "直接回在对话里"}`).join("，")}。个别回复要不一样，reply add 时加 --in thread|inline。`);
    lines.push("", `替我发到 Slack 的话，正文上方会自动加一行灰色小字署名：${p.signature ? `${p.signature} · confirmed by @我` : "（不加）"}（署名不在正文里，你写回复时不用自己加）`);
    lines.push("", p.mode === "normal" ? "规矩没说到的：往保守了办，对外发的东西先给我确认。" : p.mode === "auto" ? "规矩没说到的：approve 别人的 PR、回我自己 PR 上的话你自己办；回别人的话往保守了办，先给我确认。" : "规矩没说到的：按我过去的决定和规矩自己定，事后告诉我；「一定问我」名单里的先问我。");
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  // chief rules mode [normal|auto|yolo]：换做事方式。升到 auto / yolo 是放宽发送：要钥匙（面板上改），主会话改不了，只能记成提议；降回去不用钥匙。
  if (sub === "mode") {
    const to = args.shift();
    if (to === undefined) {
      process.stdout.write(`${p.mode}\n`);
      return;
    }
    if (!MODES_LIST.includes(to as Mode)) fail("chief rules mode normal|auto|yolo");
    const next = to as Mode;
    if (MODES_LIST.indexOf(next) > MODES_LIST.indexOf(p.mode) && !yours) return proposeLoosen(argv, "", `做事方式改成 ${next}（${next === "auto" ? "少问你：approve 别人的 PR、回你自己 PR 上的话直接发" : "全部由助理代决策，只有「一定问我」名单拦得住"}）`);
    updatePolicy((pp) => {
      pp.mode = next;
    });
    process.stdout.write(`做事方式：${next}\n`);
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
    // 「当成我的指令」只给你自己发的话用：别人的消息不能被当成你的指令。
    if (target !== "slack_self" && changes.some(([k, v]) => k === "handle" && v === "command")) fail("「当成我的指令」只能用在你给自己发的私信（slack_self）上");
    const cur = ruleOf(p, target);
    const loosen = changes.some(([k, v]) => (k === "reply" && v === "auto" && cur.reply !== "auto") || (k === "handle" && (v === "approve" || v === "command") && cur.handle !== v));
    if (loosen && !yours) {
      const after = { ...cur, ...Object.fromEntries(changes) } as ScenarioRule;
      return proposeLoosen(argv, "", `「${target in SCENARIOS ? SCENARIOS[target as Scenario] : target}」改成：${ruleLine(after)}`);
    }
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
      const raw = await input();
      let c: { when?: unknown; handle?: unknown; reply?: unknown; brief?: unknown };
      try {
        c = raw.startsWith("{") ? (JSON.parse(raw) as typeof c) : { when: raw };
      } catch {
        fail("标准输入是一句「什么情况」，或 JSON：{\"when\": \"…\", \"handle\": \"dispatch\", \"reply\": \"ask\", \"brief\": \"…\"}");
      }
      if (typeof c.when !== "string" || !c.when.trim()) fail("when（什么情况）不能空");
      if (c.handle === "command") fail("「当成我的指令」只能用在你给自己发的私信（slack_self）上");
      const handle = typeof c.handle === "string" && HANDLE_VALUES.includes(c.handle as Handle) ? (c.handle as Handle) : "dispatch";
      const reply: ReplyMode = c.reply === "auto" ? "auto" : "ask";
      const brief = typeof c.brief === "string" && c.brief.trim() ? oneLine(c.brief, 500) : undefined;
      const when = oneLine(c.when, 200);
      if ((reply === "auto" || handle === "approve") && !yours) {
        return proposeLoosen(argv, raw, `加一种情况「${when}」：${ruleLine({ handle, reply, ...(brief ? { brief } : {}) })}`);
      }
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
  // chief rules trust add|remove（标准输入：Slack 用户编号 U…，或完整的显示名）：白名单。名字要一字不差（不分大小写），不认名字的一部分
  if (sub === "trust") {
    const what = args.shift();
    const text = oneLine(await input(), 80);
    if (!text) fail("从标准输入给一个人：Slack 用户编号（U…，最稳），或完整的显示名（一字不差，不分大小写）");
    if (what === "add") {
      if (!yours && !p.trusted.includes(text)) return proposeLoosen(argv, text, `白名单加上 ${text}：回 ta 的话不用你确认直接发`);
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
  // chief rules always add|remove（标准输入：Slack 用户编号 U…、频道 / 私信编号 C… D…，或完整的显示名；GitHub 写登录名，Jira 写显示名）：「一定问我」名单。
  // 加是收紧，直接生效；删是放宽，不带钥匙只会变成提议。
  if (sub === "always") {
    const what = args.shift();
    const text = oneLine(await input(), 80);
    if (!text) fail("从标准输入给一个人或一个对话：Slack 用户编号（U…）、频道 / 私信编号（C… / D…），或完整的显示名；GitHub 写登录名，Jira 写显示名");
    if (what === "add") {
      updatePolicy((pp) => {
        if (!pp.askAlways.includes(text)) pp.askAlways.push(text);
      });
      process.stdout.write(`加好了：${text} 的回复一定先问你\n`);
      return;
    }
    if (what === "remove") {
      if (!p.askAlways.includes(text)) fail("「一定问我」名单里没有这个");
      if (!yours) return proposeLoosen(argv, text, `「一定问我」名单去掉 ${text}：回 ta 的话又可以按别的规矩直接发`);
      updatePolicy((pp) => {
        pp.askAlways = pp.askAlways.filter((x) => x !== text);
      });
      return;
    }
    fail("chief rules always add|remove");
  }
  // chief rules quick add|remove（标准输入一句原文）：固定回复，一字不差才允许直接发
  if (sub === "quick") {
    const what = args.shift();
    const text = (await input()).trim();
    if (!text || text.length > 200) fail("从标准输入给一句原文（200 字以内）");
    if (what === "add") {
      if (!yours && !p.quick.includes(text)) return proposeLoosen(argv, text, `固定回复加上「${text}」：回复正好是这句就不问你直接发`);
      updatePolicy((pp) => {
        if (!pp.quick.includes(text)) pp.quick.push(text);
      });
      process.stdout.write(`加好了：回复正好是「${text}」时可以直接发\n`);
      return;
    }
    if (what === "remove") {
      const gone = updatePolicy((pp) => {
        const before = pp.quick.length;
        pp.quick = pp.quick.filter((x) => x !== text);
        return before !== pp.quick.length;
      });
      if (!gone) fail("固定回复里没有这句");
      return;
    }
    fail("chief rules quick add|remove");
  }
  // chief rules bot add|remove（标准输入一个 GitHub 登录名）：GitHub 上不报的机器人
  if (sub === "bot") {
    const what = args.shift();
    const login = (await input()).trim().toLowerCase();
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
    const text = oneLine(await input(), 300);
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
  // 署名告诉对方这是 agent 代发的：改它（尤其清掉）算放宽，要你点头。
  if (sub === "sign") {
    const text = oneLine(await input(), 80);
    if (!yours && text !== p.signature) return proposeLoosen(argv, text, text ? `Slack 回复的署名改成「${text}」` : "Slack 回复不再加署名（对方看不出是 agent 代发的）");
    updatePolicy((pp) => {
      pp.signature = text;
    });
    process.stdout.write(text ? `Slack 回复正文上方会加：${text} · confirmed by @你\n` : "Slack 回复不加标识了\n");
    return;
  }
  // chief rules brief <场景|custom:号>（标准输入给交代的话；空的就是清掉）
  if (sub === "brief") {
    const target = args.shift() ?? fail("chief rules brief <场景|custom:号>");
    const text = oneLine(await input(), 500);
    updatePolicy((pp) => {
      const r = ruleOf(pp, target);
      if (text) r.brief = text;
      else delete r.brief;
    });
    process.stdout.write(text ? `${target}：交代「${text}」\n` : `${target}：清掉了交代\n`);
    return;
  }
  if (sub === "add") {
    const text = oneLine(await input(), 300);
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
    const text = oneLine(await input(), 300);
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
      body = JSON.parse(await input()) as typeof body;
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
  // 采纳放宽发送的提议要钥匙（你在面板上点）：主会话不能自己提、自己采纳。不要（拒掉）不用。
  if (sub === "accept" || sub === "reject") {
    const id = num(args.shift(), "提议号");
    const pending = p.proposals.find((y) => y.id === id);
    if (sub === "accept" && pending?.change && !yours) fail("这条会放宽发送：要用户自己在面板上点采纳");
    const x = updatePolicy((pp) => {
      const found = pp.proposals.find((y) => y.id === id) ?? oops(`没有提议 ${id}（可能已经处理了）`);
      pp.proposals = pp.proposals.filter((y) => y.id !== id);
      if (sub === "accept" && !found.change && !pp.notes.includes(found.text)) pp.notes.push(found.text);
      return found;
    });
    if (sub === "accept" && x.change) await rules([...x.change.args], { yours: true, text: x.change.input });
    process.stdout.write(sub === "accept" ? `采纳了：${x.text}\n` : "不要了\n");
    return;
  }
  fail("chief rules [--yours] [show|json|set|brief|sign|place|style|trust|always|quick|bot|custom|add|remove|propose|accept|reject]");
}

// chief review <事件号> ok|wrong（标准输入给「应该怎样」）。
export async function review(args: string[]): Promise<void> {
  const id = num(args.shift(), "事件号");
  const verdict = args.shift();
  if (verdict !== "ok" && verdict !== "wrong") fail("chief review <事件号> ok|wrong");
  eventById(id);
  const note = verdict === "wrong" ? await stdinText() : "";
  updateJson<Reviews, void>(paths().reviews, {}, (all) => {
    all[id] = { ok: verdict === "ok", at: new Date().toISOString(), ...(note ? { note } : {}) };
  });
}

// chief import：从 Jira（指派给你、没做完的）和 GitHub（你开着的 PR、等你 review 的）拉一份清单，
// 标出哪些已经在事情清单里了。Claude App 里的会话由主会话自己列（它有会话工具），再和这份合并。
export async function importCandidates(): Promise<void> {
  const signal = AbortSignal.timeout(90_000);
  const known = new Set(loadThings().things.filter((x) => x.status !== "done" && x.status !== "dropped").flatMap((x) => x.keys ?? []));
  const out: ({ source: string; known: boolean } & ImportItem)[] = [];
  const errors: string[] = [];
  const enabled = loadEnabled();
  // 开着、能导入的来源（来源注册表里有 open 的），按 rank 排。
  for (const d of DESCRIPTORS.filter((x) => x.open && enabled[x.id]).sort((x, y) => x.open!.rank - y.open!.rank)) {
    try {
      for (const it of await d.open!.list(signal)) {
        const { due, ...rest } = it;
        out.push({ source: d.id, ...rest, known: known.has(it.key), ...(due !== undefined ? { due } : {}) });
      }
    } catch (error) {
      errors.push(`${d.meta.label}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.stdout.write(`${JSON.stringify({ items: out, errors })}\n`);
}
