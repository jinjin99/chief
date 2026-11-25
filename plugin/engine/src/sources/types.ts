// 照搬 aide 的 engine/src/sources/types.ts（去掉给 agent 的工具和对账）。
// 外部来源（GitHub、Jira、Notion）：定时拉跟你有关的新动态。都只读。
// 每个来源还交一份 SourceDescriptor（放进 registry.ts）：引擎、命令行按它建、连、查、发，不再一个来源一个分支。
import type { SecretStore } from "../secrets";
import type { SourceId, SourceMeta } from "../shared/sources";
import type { SecretCheck } from "../slack/types";

export type { SourceId };

export interface SourceItem {
  // 同一个来源里，同一个编号只记一次（一般是「东西的地址@更新时间」）。
  externalId: string;
  kind: string;
  // 给你看的一行：「acme/shop#10318 xxx」。
  title: string;
  url: string;
  // 给主会话看的一句：发生了什么（状态、谁评论了什么）。原文是别人写的，当材料。
  summary: string;
  at: string;
  payload: Record<string, unknown>;
  // 跟你本人直接有关：你开的、你评论了、评论里 @了你（GitHub）；指派给你、你评论了、评论里提到你（Jira）。
  // 只是被一起请了 review、你在关注列表里的，不算。没归到事情、又不跟你直接有关的动态只记下，不交给主会话。
  mine: boolean;
  // 这条动态里有人找你：请你 review、新指派给你、别人的评论里 @ 了你、别人评论了你的 PR / 工单、
  // 你开的 PR 被 approve 了（approved）、被要求修改（changes）。
  // 没有就是只变了状态，或者只是你自己的动作（你开的、你评论的）——这种交给代码对账，不一定要跑一轮主会话。
  asks?: Ask[];
  // 是谁在找你（GitHub 的登录名、Jira 的显示名）：「一定问我」名单按它拦。来源认不出人就不填。
  from?: string | null;
  // 这条动态里说话的所有人加上作者：from 只记一个，名单要对每一个。
  speakers?: string[];
}

export type Ask = "review" | "assigned" | "mention" | "comment" | "approved" | "changes";

export interface Source {
  readonly id: SourceId;
  readonly label: string;
  // 拉 since 之后跟你有关的动态，旧的在前。
  poll(since: Date, signal: AbortSignal): Promise<SourceItem[]>;
  // 检查能不能用（连接时、你点「检查」时）。
  check(signal: AbortSignal): Promise<SecretCheck[]>;
}

// chief connect <来源> 给来源用的：后面的参数、钥匙串、从终端读密钥（输入不显示；不是终端就读标准输入）。
export interface ConnectIo {
  flag(name: string): string | null;
  has(name: string): boolean;
  secrets: SecretStore;
  signal: AbortSignal;
  readSecret(prompt: string): Promise<string>;
  log(line: string): void;
}

// chief import 的一行：来源里你手上还没做完的东西。
export interface ImportItem {
  key: string;
  title: string;
  state: string;
  url: string;
  updated: string;
  due?: string | null;
}

// 一个来源的全部：名字和场景（meta，面板也用）、引擎怎么建、动态怎么变成事件、能往外发什么、怎么连、怎么查。
// 出错直接 throw（命令行把 message 打到标准错误、退出码 1）。
export interface SourceDescriptor {
  readonly id: SourceId;
  readonly meta: SourceMeta;
  // 钥匙串里存东西的名字（Slack 的 Cookie、Notion 的令牌）；用本机命令的来源没有。
  readonly secret?: string;
  // 本机命令搭出来的来源（gh、acli）：没装就是 null。设置页拿它试登录。
  local?(): Pick<Source, "check"> | null;
  // 引擎要拉的：搭不出来返回一句为什么（日志里记「跳过」）。推送的来源（Slack）由引擎自己接，没有这个。
  build?(ctx: { secrets: SecretStore; bots: () => readonly string[] }): Promise<Source | string>;
  // 一条动态 → 这件事自己的键、回复回到哪（事件的 keys[0] 和 reply）。
  event?(item: SourceItem): { key: string; reply: Record<string, string> };
  // 往外发：回复（评论）、approve。没有的就是只读（meta.readOnly 说为什么）。
  comment?(target: Readonly<Record<string, string>>, body: string, signal: AbortSignal): Promise<{ url: string | null }>;
  approve?(ref: string, body: string, signal: AbortSignal): Promise<{ url: string | null }>;
  // chief connect：检查能不能用；都过了才调 save（存钥匙之类）。
  connect(io: ConnectIo): Promise<{ checks: SecretCheck[]; save?: () => Promise<void> }>;
  // chief import：rank 小的排前面。
  readonly open?: { rank: number; list(signal: AbortSignal): Promise<ImportItem[]> };
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

// 拼进正则的文字（账号名、人名）：特殊字符转义。
export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 给模型看的文字：去掉尖括号，免得冒充提示词里的标签；太长截断。
export function plain(text: string, max = 600): string {
  const one = text.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

// 带超时的 JSON 请求。出错信息不带响应正文（可能有内部信息），只说状态码。
export async function getJson(fetchFn: typeof fetch, url: string, init: RequestInit, signal: AbortSignal, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  } catch (error) {
    if (signal.aborted) throw new SourceError("取消了");
    throw new SourceError(`连不上 ${what}${error instanceof Error && error.name === "TimeoutError" ? "（20 秒没回应）" : ""}`);
  }
  if (res.status === 401 || res.status === 403) throw new SourceError(`${what} 拒绝了（${res.status}）：令牌不对或没权限`);
  if (!res.ok) throw new SourceError(`${what} 出错了（${res.status}）`);
  return res.json();
}
