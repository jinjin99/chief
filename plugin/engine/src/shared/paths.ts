// chief 的文件放在哪：引擎（store.ts 的 paths）和面板（hooks/data.ts）按同一份算。纯 TypeScript，面板也 import（见 sources.ts 开头）。
// 数据目录 home 默认是 ~/chief/data（CHIEF_HOME 可以改成别的绝对路径）；规矩和设置放在 top：
// 数据在默认位置时是工作目录 ~/chief 最上层（给你看、给你改），不然（测试）就和数据放一起。

export function workspaceOf(userHome: string): string {
  return `${userHome}/chief`;
}

export function defaultHomeOf(userHome: string): string {
  return `${workspaceOf(userHome)}/data`;
}

export function topOf(home: string, userHome: string): string {
  return home === defaultHomeOf(userHome) ? workspaceOf(userHome) : home;
}

// 数据目录里的文件（文件各自是什么见 store.ts 开头）。
const DATA = {
  events: "events.jsonl",
  state: "state.json",
  sources: "sources.json",
  settings: "settings.json",
  confirmKey: "confirm-key.sha256",
  // 钥匙换过的记录（一行一次，只追加）：面板看到没确认过的就一直挂着提醒，见 commands/key.ts。
  keyLog: "key-log.jsonl",
  routes: "routes.json",
  hub: "hub.json",
  dispatch: "dispatch.json",
  replies: "replies.json",
  things: "things.json",
  decisions: "decisions.jsonl",
  reviews: "reviews.json",
  evals: "evals.json",
  alive: "alive.json",
  engineAlive: "engine.json",
  activity: "activity.json",
  drafts: "drafts",
  logs: "logs",
  slackState: "slack-state",
  // 查过的 Slack 人：用户编号 → 名字（面板把稿子里的 <@U…> 显示成 @名字）。
  people: "people.json",
  // 办完的旧东西搬到这里（见 archive.ts）：<种类>-<年月>.jsonl。
  archive: "archive",
  // 读坏了的数据文件（见 readJson）：文件名 → 挪到哪了、什么时候、通知过没有。引擎把它并进 engine.json 的 health，面板就标红。
  corrupt: "corrupt.json",
  // 主会话用掉的额度（面板的 hooks/usage.ts 记）。
  hubUsage: "hub-usage.json",
  // 主会话占本机所有会话用量的份额、分到它头上的额度（引擎的 usage.ts 算），和读会话记录读到哪了。
  usage: "usage.json",
  usageScan: "usage-scan.json",
  // 免打扰时没弹的通知（见 quiet.ts）：免打扰一结束合成一条弹出来，也进下一份汇总。
  held: "held.json",
  // 能撤回的操作：不做了、只记下 / 忽略、跳过积下的（见 undo.ts）。
  undo: "undo.json",
  // 开着的问题、待发出的回复、进行中的事情提到的 PR 现在什么样（见 refs.ts）：面板在卡片上标「已合并」「有冲突」。
  refs: "refs.json",
  // 分诊：扣住的事件插件看到哪了（见 triage.ts）。
  triage: "triage.json",
} as const;

// 放在 top 的：你的规矩、可调的数字和开关（见 config.ts）、chief export 导出的备份。
const TOP = { policy: "rules.json", config: "config.json", exports: "exports" } as const;

export type Layout = { home: string } & { [K in keyof typeof DATA | keyof typeof TOP]: string };

export function layoutOf(home: string, top: string): Layout {
  const out: Record<string, string> = { home };
  for (const [k, name] of Object.entries(DATA)) out[k] = `${home}/${name}`;
  for (const [k, name] of Object.entries(TOP)) out[k] = `${top}/${name}`;
  return out as Layout;
}
