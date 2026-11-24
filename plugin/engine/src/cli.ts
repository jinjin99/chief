// chief 命令行。你在终端里用它连来源、装引擎；消息中心（Claude App 里的主会话）和 chief 面板用它记判断、记事情、管回复。
//   chief run                          前台跑引擎（launchd 里跑的也是它）
//   chief install | uninstall          装进 / 卸掉 launchd，并装好 chief 命令（消息中心 skill 和面板在 chief 插件里）
//   chief uninstall --purge            卸掉，再删光数据、工作目录 ~/chief（exports/ 留着）、钥匙串里 chief 的密钥；要在终端里敲 purge 确认
//   chief export [--out 目录]           导出规矩、设置、交代、笔记、数据和归档（不含密钥），默认放在 ~/chief/exports
//   chief quiet                        现在是不是免打扰、到几点（JSON；config.json 的 quietHours）
//   chief digest [--event N] [--since 时间]  写每天汇总的材料（JSON）：等你的、要你定的、待发出、上一份以后的变化、免打扰时没弹的提醒
//   chief status | logs                看引擎、来源、进度；看最近的日志
//   chief config [set <键> <值>]       可调的数字和开关（~/chief/config.json，见 config.ts）
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
//   chief thing snooze <T> --until <时间> | wake <T>   稍后再说：到点引擎叫醒它、交给主会话；时间写 2h、1d、tomorrow 09:00、明天9点、下周一、ISO
//   chief undo [--list] [号]           撤回最近做的：不做了、只记下 / 忽略、跳过积下的（撤回的消息重新交给主会话）
//   chief search <字> [--limit N] [--kind thing|ask|reply|event|decision]  在现在的数据和归档里找以前的事，一行一条 JSON
//   chief test [--from 名字] [--where 位置] [--why dm|mention|thread]  造一条测试消息（标准输入给内容），回复不会真的发出去
//   chief eval add|from-event|list|remove|run|report  演练：拿例子测主会话会怎么办（不真的办），对结果
//   chief import                       导入用：Jira 指派给你没做完的、GitHub 你开着的 / 等你 review 的 PR
//   chief ask add|list|answer          要你定的
//   chief rules [show|json|set|brief|add|remove|propose|accept|reject]  你的规矩（含每类活的交代），和主会话提议的规矩；
//                                      always add|remove：「一定问我」名单（这些人、对话的回复引擎一律不直接发）；
//                                      放宽发送的改动（直接发、直接 approve、白名单、固定回复、署名、always remove）不带 --yours（插件的钥匙）只会变成提议，等你在面板上采纳
//   chief review <事件号> ok|wrong     你给主会话的一次判断标对错（错的时候标准输入给应该怎样）
//   chief reply add|approve|new|list|edit|queue|confirm|ask-confirm|undo|drop|redo   回复 / approve / 主动发新消息：加进待发出、改、
//                                      排队发（5 秒可撤回；queue --policy 按规矩直接发，引擎再核一遍；confirm 以你的名义发，要插件的钥匙；
//                                      ask-confirm 你在会话里说了发，等插件核对）、撤回、不发、让它重写
//                                      edit-yours 你在面板上自己改的稿子（带钥匙，不按「不许写 chief 编号」拦）
//   chief key set|check|reset          「以你的名义发」的钥匙：插件配，原文不落在这里；reset 要你在终端里敲 reset 确认，清、换都会弹通知、面板挂提醒
//                                      new --to 可以是一条 Slack 消息的链接：回到那条帖子的 thread 里
//   chief slack who <名字>             找 Slack 上的人，拿到 <@U…>（写进稿子才会真的提醒到人）
//   chief archive                      把办完超过 7 天的事件、判断、事情、回复搬进 ~/chief/data/archive（引擎每天自己搬一次）
// 从标准输入给的文字（理由、进展、问题、稿子）不经过命令行参数：里面会引用别人的原文，不能让 shell 当成命令。
// 写给用户看的话（问题、建议、事情标题和进展、回复正文）里带 chief 自己的编号（#98、问题 #63、回复 107）的一律拒收（见 plain.ts）；
// 问题要提待发出里的某条，用 chief ask add --reply R 挂上。
import { fail } from "./args";
import { cursor, events, hub, mark, route, show, watchHome } from "./commands/events";
import { digest, quiet } from "./commands/digest";
import { evals, testEvent } from "./commands/eval";
import { exportCmd } from "./commands/export";
import { keyCmd } from "./commands/key";
import { reply } from "./commands/reply";
import { importCandidates, review, rules } from "./commands/rules";
import { archive, awake, configCmd, connect, disconnect, doctor, engineCmd, install, logs, run, slackCmd, status, uninstall } from "./commands/setup";
import { searchCmd } from "./commands/search";
import { ask, board, thing } from "./commands/things";
import { triage } from "./commands/triage";
import { undoCmd } from "./commands/undo";
import { migrateAll } from "./migrate";
import { ensureHome } from "./store";

// 命令 → 做什么。各个命令的实现在 commands/ 里，按用途分文件；读参数、标准输入的小工具在 args.ts。
const COMMANDS: Readonly<Record<string, (args: string[]) => Promise<void> | void>> = {
  run: () => run(),
  install: () => install(),
  uninstall: (args) => uninstall(args),
  export: (args) => exportCmd(args),
  quiet: () => quiet(),
  digest: (args) => digest(args),
  status: () => status(),
  logs: () => logs(),
  config: (args) => configCmd(args),
  connect: (args) => connect(args[0], args.slice(1)),
  doctor: () => doctor(),
  awake: (args) => awake(args[0]),
  disconnect: (args) => disconnect(args[0]),
  events: (args) => events(args),
  watch: () => watchHome(),
  show: (args) => show(args),
  key: (args) => keyCmd(args),
  hub: (args) => hub(args),
  engine: (args) => engineCmd(args),
  cursor: (args) => cursor(args),
  route: (args) => route(args),
  reply: (args) => reply(args),
  mark: (args) => mark(args),
  board: () => board(),
  thing: (args) => thing(args),
  ask: (args) => ask(args),
  rules: (args) => rules(args),
  review: (args) => review(args),
  import: () => importCandidates(),
  test: (args) => testEvent(args),
  eval: (args) => evals(args),
  slack: (args) => slackCmd(args),
  archive: () => archive(),
  undo: (args) => undoCmd(args),
  search: (args) => searchCmd(args),
  triage: (args) => triage(args),
};

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const cmd = args.shift();
  ensureHome();
  // 旧格式的数据文件先升到现在的格式（见 migrate.ts）。
  migrateAll();
  if (cmd === undefined || !Object.hasOwn(COMMANDS, cmd)) {
    fail("chief run|install|uninstall|export|status|logs|config|quiet|digest|connect|disconnect|events|show|cursor|hub|engine|route|reply|mark|board|thing|ask|rules|review|import|test|eval|slack|undo|search|triage");
  }
  return COMMANDS[cmd]!(args);
}

main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
