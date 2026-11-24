// 回复：chief reply add / approve / new / list / edit / queue / confirm / ask-confirm / undo / drop / redo。
// 回复正文只从 drafts 目录里读；以你的名义发要插件的钥匙；发不发、什么时候发由引擎再核一遍（见 gate.ts）。
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { archivedEvent } from "../archive";
import { fail, flag, flags, num, oneLine, plainOnly, stdinRaw, stdinText } from "../args";
import { loadConfig } from "../config";
import { autoReason, prsOf, replyHash } from "../gate";
import { MAX_IMAGES, takeImage, type ReplyImage } from "../images";
import { isSourceId, type SourceMeta } from "../shared/sources";
import { parsePermalink } from "../slack/people";
import { SOURCES } from "../sources/registry";
import { loadPolicy, loadReplies, paths, readEvents, scenarioOf, updateReplies, type RepliesFile, type Reply } from "../store";
import { eventById } from "./events";
import { approveDone, settleReplyAsks } from "./things";
import { keyMatches } from "./key";

export const MAX_REPLY = 20_000;

// --image：检查、复制进 drafts/images，返回记录；不是图片、太大、太多都直接拒收。
export function imagesOf(files: string[]): ReplyImage[] {
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

// 回复正文只从 drafts 目录里读：消息中心先用 Write 把正文写进去，正文不经过命令行参数和 shell。
export function draftText(file: string): string {
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
// 撤回期：config.json 的 undoSeconds（默认 5 秒）。
export const undoMs = () => loadConfig().config.undoSeconds * 1000;

// 排队发：发前的检查（还能不能发、是不是测试消息）都在这，谁让发的由 mark 写。
export function queueReply(id: number, now: Date, mark: (r: Reply) => void): void {
  // 锁外先读好（锁里不能 fail）。
  const testEvents = new Set(readEvents().filter((e) => e.test).map((e) => e.id));
  let queued: Reply | null = null;
  updateReplies((all) => {
    const r = all.items.find((x) => x.id === id);
    if (!r) throw new Error(`没有回复 ${id}`);
    if (r.status !== "pending" && r.status !== "failed") throw new Error(`回复 ${id} 现在是 ${r.status}，不能发`);
    const readOnly = isSourceId(r.source) ? (SOURCES[r.source].meta as SourceMeta).readOnly : undefined;
    if (readOnly) throw new Error(`${readOnly}，这条请你到页面上自己回`);
    if (Object.keys(r.target).length === 0) throw new Error("这是测试消息的回复，不会真的发出去");
    if (r.kind === "approve" && testEvents.has(r.event)) throw new Error("这是测试消息，不会真的 approve");
    r.status = "queued";
    r.sendAt = new Date(now.getTime() + undoMs()).toISOString();
    delete r.error;
    mark(r);
    queued = r;
  });
  if (!queued) return;
  const done: Reply = queued;
  settleReplyAsks(done.id, "sent");
  if (done.kind === "approve" && done.thing !== undefined) approveDone(done.thing, done.target.ref ?? "PR");
}

export async function reply(args: string[]): Promise<void> {
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
    plainOnly(body, "回复正文", { github: event.source === "github" });
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
    // 回复按哪条规矩发：引擎按规矩算（和 queue --policy 一样），auto 就可以直接 queue --policy。
    const why = autoReason(r, loadPolicy(), event);
    // 稿子多长、开头是什么：主会话据此决定要不要打开全文看（工作会话把稿子写在文件里，只给主会话路径）。
    const size = { lines: body.split("\n").filter((l) => l.trim() !== "").length, chars: body.length, preview: oneLine(body, 60) };
    process.stdout.write(`${JSON.stringify({ id: r.id, source: r.source, scenario: scenarioOf(event), policy: why === null ? "ask" : "auto", ...(why === "白名单" ? { trusted: true } : {}), ...size })}\n`);
    return;
  }
  // chief reply approve --event N --ref owner/repo#号 [--thing T] [--custom 号]：放一条「approve 这个 PR」进待发出。
  // 返回这条按哪条规矩办（policy 是 auto 就可以直接 queue --policy）。
  if (sub === "approve") {
    const event = eventById(num(flag(args, "--event") ?? undefined, "--event "));
    const ref = flag(args, "--ref") ?? fail("要 --ref owner/repo#号");
    if (!/^[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,9}$/.test(ref)) fail("--ref 写成 owner/repo#号");
    // 只能 approve 这条消息自己的 PR：GitHub 的事件就是那个 PR，Slack 里的是消息里贴的 PR 链接。
    const own = prsOf(event);
    if (!own.includes(ref.toLowerCase())) fail(own.length === 0 ? `事件 #${event.id} 里没有 PR，不能 approve` : `--ref 要是这条消息自己的 PR：${own.join(" / ")}`);
    const thingFlag = flag(args, "--thing");
    const thingId = thingFlag === null ? null : num(thingFlag, "--thing ");
    const customFlag = flag(args, "--custom");
    const pol = loadPolicy();
    if (customFlag !== null && !pol.custom.some((c) => c.id === num(customFlag, "--custom "))) fail(`没有你加的情况 ${customFlag}`);
    const r = updateReplies((all) => {
      for (const old of all.items) if (old.event === event.id && old.kind === "approve" && old.status === "pending") old.status = "dropped";
      const x: Reply = {
        id: all.nextId++, kind: "approve", event: event.id, source: "github", target: { ref }, body: "", status: "pending", at: new Date().toISOString(),
        ...(customFlag !== null ? { custom: num(customFlag, "--custom ") } : {}),
        context: { who: event.from, where: event.title, said: event.text.slice(0, 2000), url: `https://github.com/${ref.replace("#", "/pull/")}` },
        ...(thingId !== null ? { thing: thingId } : {}),
      };
      all.items.push(x);
      return x;
    });
    process.stdout.write(`${JSON.stringify({ id: r.id, kind: "approve", ref, policy: autoReason(r, pol, event) === null ? "ask" : "auto" })}\n`);
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
    plainOnly(body, "消息正文");
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
    process.stdout.write(`${JSON.stringify({ id: r.id, kind: "message", to, policy: autoReason(r, loadPolicy(), null) === null ? "ask" : "auto", ...(thread ? { thread_ts: thread } : {}) })}\n`);
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
  // chief reply edit R（标准输入给新稿子）：改稿。新稿子一样不许带 chief 的编号。
  // chief reply edit-yours R（标准输入 JSON {key, text}，带插件的钥匙）：你在面板上自己改的稿子。你自己写的话照原样收，不拦；主会话没有钥匙。
  // 单独一个子命令而不是 edit 加参数：插件比引擎新时，旧引擎认不出 edit-yours 直接报错，不会把带钥匙的 JSON 当成稿子存下来。
  if (sub === "edit" || sub === "edit-yours") {
    const yours = sub === "edit-yours";
    let text: string;
    if (yours) {
      let req: { key?: unknown; text?: unknown };
      try {
        req = JSON.parse(await stdinRaw(MAX_REPLY * 2)) as typeof req;
      } catch {
        fail("edit-yours 的标准输入给 JSON：{\"key\": …, \"text\": …}");
      }
      if (typeof req.key !== "string" || !keyMatches(req.key)) fail("钥匙对不上：edit-yours 只给你在面板上自己改稿用");
      text = typeof req.text === "string" ? req.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
      if (text.length > MAX_REPLY) fail("回复太长了");
    } else {
      text = (await stdinText()).trim();
    }
    if (!text) fail("新稿子是空的（从标准输入给）");
    if (!yours) {
      const current = loadReplies().items.find((x) => x.id === id) ?? fail(`没有回复 ${id}`);
      plainOnly(text, "回复正文", { github: current.source === "github" });
    }
    updateReplies((all) => {
      const r = find(all);
      if (r.status !== "pending" && r.status !== "failed") throw new Error(`回复 ${id} 现在是 ${r.status}，不能改`);
      r.original ??= r.body;
      r.body = text;
    });
    return;
  }
  // chief reply queue R --policy：主会话按规矩直接发。引擎按规矩再算一遍（autoReason），要你确认的拒掉，留在待发出。
  // 以你的名义发不走这里：面板上点发送、或你在会话里说了发，由 chief 插件带钥匙走 chief reply confirm。
  if (sub === "queue") {
    if (!args.includes("--policy")) {
      fail(`以你的名义发要你确认：你在面板上点发送；你在会话里说了「发」，用 chief reply ask-confirm ${id}，chief 插件核对你真的说过再发`);
    }
    const current = loadReplies().items.find((x) => x.id === id) ?? fail(`没有回复 ${id}`);
    const event = current.kind === "message" ? null : readEvents().find((e) => e.id === current.event) ?? archivedEvent(current.event) ?? null;
    const why = autoReason(current, loadPolicy(), event);
    if (why === null) fail(`回复 ${id} 按规矩要你确认，不能直接发：留在待发出，等你在面板上点发送（或你在会话里说发）`);
    queueReply(id, now, (r) => {
      r.by = "policy";
      delete r.confirm;
    });
    process.stdout.write(`按规矩直接发（${why}）：5 秒后发出，之前可以 chief reply undo ${id}\n`);
    return;
  }
  // chief reply confirm R（标准输入 JSON：{key, how: panel|chat, said?}）：以你的名义发。只有 chief 插件有钥匙。
  if (sub === "confirm") {
    let req: { key?: unknown; how?: unknown; said?: unknown };
    try {
      req = JSON.parse(await stdinText()) as typeof req;
    } catch {
      fail("标准输入给 JSON：{\"key\": …, \"how\": \"panel\"|\"chat\", \"said\": …}");
    }
    if (typeof req.key !== "string" || !keyMatches(req.key)) fail("钥匙对不上：以你的名义发只能你在面板上点，或你在会话里说了由 chief 插件核对后发");
    const how = req.how === "chat" ? "chat" : req.how === "panel" ? "panel" : fail("how 是 panel 或 chat");
    const said = typeof req.said === "string" ? oneLine(req.said, 300) : "";
    if (how === "chat" && !said) fail("会话里确认的要带上你的原话");
    queueReply(id, now, (r) => {
      r.by = "you";
      r.confirm = { how, ...(said ? { said } : {}), at: now.toISOString(), hash: replyHash(r) };
      delete r.confirmAsk;
    });
    process.stdout.write(`5 秒后发出，之前可以 chief reply undo ${id}\n`);
    return;
  }
  // chief reply ask-confirm R：你在主会话里说了发，主会话用这个请求以你的名义发。这一步不发：
  // chief 插件看到请求，核对你在这一轮真的说过话，才带钥匙 confirm；核对不上就留着，面板上请你点。
  if (sub === "ask-confirm") {
    updateReplies((all) => {
      const r = find(all);
      if (r.status !== "pending" && r.status !== "failed") throw new Error(`回复 ${id} 现在是 ${r.status}，不能发`);
      r.confirmAsk = { at: now.toISOString() };
    });
    process.stdout.write(`记下了：chief 插件核对你在会话里说过发，就以你的名义发；核对不上会留在待发出等你点\n`);
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
    settleReplyAsks(id, "undo");
    return;
  }
  if (sub === "drop") {
    updateReplies((all) => {
      const r = find(all);
      if (r.status === "sending" || r.status === "sent") throw new Error("已经发出去了");
      r.status = "dropped";
    });
    settleReplyAsks(id, "dropped");
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
    settleReplyAsks(id, "redo");
    return;
  }
  fail("chief reply add|approve|new|list|edit|edit-yours|queue|undo|drop|redo");
}
