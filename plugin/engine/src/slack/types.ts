// 照搬 aide 的 channels/src/types.ts。
// 消息通道：一个消息应用（Slack、以后的飞书、邮件……）是一个插件。
// 插件只做三件事：连上来源、认出「跟你有关的消息」、把它交给 host。分诊、起草、发送都不在插件里。
// host 只认这里的接口，不出现任何具体应用的名字。

// 为什么这条消息跟你有关。
//   dm：私信或者群聊里发给你的；mention：@了你；thread：你在里面说过话、或者本来就找过你的对话里的后续。
// self：你在「和自己的私信」里写的话（写给助理的指令）。
export type Relevance = "dm" | "mention" | "thread" | "self";

// 谁说的。self：你本人在来源里说的话（以后用来认出「你已经自己回了」）。
export type InboundRole = "message" | "self";

export interface InboundMessage {
  // 来源名，也是工作记录的 source。
  channel: string;
  // 去重用的编号：同一次投递只记一次（Slack 是 <频道>:<ts>）。
  deliveryId: string;
  kind: "message.received" | "message.edited" | "message.deleted";
  // edited、deleted：被改、被删的那条消息的 deliveryId。
  amends?: string;
  role: InboundRole;
  // self 的消息没有 relevance。
  relevance: Relevance | null;
  conversation: {
    // 整个对话的键，以来源名开头，例如 slack:D123。
    key: string;
    // 这条消息所在的 thread 的键（不在 thread 里时就是它自己将来的 thread）。
    threadKey: string;
    // 给人看的名字，例如「Carol 的私信」「#design」。
    label: string;
    // 谁看得到回复。
    audience: "direct" | "group" | "channel";
  };
  sender: { id: string; name: string; bot: boolean };
  // 原文，是不可信的外部文字。
  text: string;
  // 消息上方自称的 agent 署名行（Slack 里正文上方那行灰色小字），不在 text 里。谁都能写，不能当证据。
  attribution?: string;
  occurredAt: string;
  // 以后回复要用的定位（Slack 是 channel、thread_ts）。
  replyTarget: Record<string, string>;
  // 消息里 @ 了谁（编号和名字）：以后 Aide 写的话里 @ 这个人时，换成真的 @。
  mentions?: { id: string; name: string }[];
}

export type ChannelStatus =
  | { state: "connecting" }
  | { state: "connected"; account: string }
  | { state: "error"; error: string };

// 插件要的一个密钥。存在钥匙串里，名字是 chief:<channel>.<name>。
export interface SecretSpec {
  name: string;
  label: string;
  prefix: string;
  hint: string;
}

export interface SecretCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface ChannelContext {
  secrets: Readonly<Record<string, string>>;
  // 交给 host。host 记进工作记录；同一个 deliveryId 只记一次。
  deliver(message: InboundMessage): Promise<void>;
  // 这个对话里记过东西没有（你说过话，或者它本来就找过你）。插件用它判断 thread 里的后续算不算跟你有关。
  threadSeen(threadKey: string): boolean;
  status(update: ChannelStatus): void;
  // 日志。不要写密钥和消息原文。
  log(line: string): void;
}

export interface ChannelPlugin {
  readonly id: string;
  readonly label: string;
  readonly secrets: readonly SecretSpec[];
  // 建应用的说明（例如 Slack 的 manifest）。没有时是 null。
  setupManifest(): string | null;
  // 检查一组密钥：格式、来源认不认、是不是你本人、权限够不够。不保存，不建长连接。不抛错。
  test(secrets: Readonly<Record<string, string>>): Promise<SecretCheck[]>;
  start(context: ChannelContext): Promise<void>;
  // 停下：断开连接，等已经收下的消息交完。停了以后能再开。
  stop(): Promise<void>;
  // 可选：在一条消息所在的线程里回一句，以你本人的身份。target 就是那条消息交来时的 replyTarget。
  // 只在你本人在 App 里点了「发送」时调用。text 是你确认过的原文（纯文本），插件原样发，不要改写。
  // 发出去了返回新消息的编号；发不出去就抛错（错误信息会给你看，不要带令牌）。
  send?(target: Readonly<Record<string, string>>, text: string): Promise<{ ref: string }>;
  // 可选：给一条消息加一个表情（emoji 是表情名，不带冒号，比如 eyes）。已经加过的当成功。
  react?(target: Readonly<Record<string, string>>, emoji: string): Promise<void>;
}
