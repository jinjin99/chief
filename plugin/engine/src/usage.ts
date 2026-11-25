// 主会话用掉多少额度：读本机所有 Claude 会话的记录（~/.claude/projects 下的 .jsonl），算法见 shared/usage.ts。
// 只看每次调模型的 token 数、时间，和有没有挂 chief events --follow 的 Monitor（认出主会话）；不留任何对话内容。
// 每个文件记着读到哪了（usage-scan.json），下次只读新写的；结果写进 usage.json，面板设置页显示。
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { paths, readJson, writeJson } from "./store";
import { DEFAULT_WEIGHTS, KEEP_MS, addTokens, daysOf, fitWeights, isHubMonitor, slotOf, spansOf, zero, type Reading, type Slot, type Tokens, type UsageDayShare, type Weights } from "./shared/usage";

type FileState = { offset: number; hub: boolean; lastId?: string | undefined };
export type ScanState = { files: Record<string, FileState>; slots: Record<string, Slot> };
export type UsageFile = { at: string; weights: Weights; fitted: boolean; spans: number; days: Record<string, UsageDayShare> };

const CHUNK = 4 * 1024 * 1024;

export function transcriptsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

// 子代理的记录在 <会话>/subagents/ 下：算在它的会话头上。
function sessionOf(file: string): string {
  return file.includes("/subagents/") ? basename(dirname(dirname(file))) : basename(file, ".jsonl");
}

async function listFiles(dir: string, since: number, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await listFiles(p, since, out);
    else if (e.name.endsWith(".jsonl")) {
      try {
        if ((await stat(p)).mtimeMs >= since) out.push(p);
      } catch {
        // 刚被删了
      }
    }
  }
  return out;
}

type Line = { type?: string; timestamp?: string; message?: { id?: string; usage?: Record<string, number>; content?: unknown } };

// 一行里挂没挂 chief events --follow 的 Monitor。
function hubLine(d: Line): boolean {
  const content = d.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c: { type?: string; name?: string; input?: { command?: string } }) => c?.type === "tool_use" && c.name === "Monitor" && isHubMonitor(c.input?.command));
}

// 读一行：是调模型的就记进它那一格。纯函数（测试直接调）。
export function takeLine(text: string, st: FileState, hubSession: boolean, slots: Record<string, Slot>, cutoff: number): void {
  const monitor = text.includes('"Monitor"');
  if (!monitor && !text.includes('"usage"')) return;
  let d: Line;
  try {
    d = JSON.parse(text) as Line;
  } catch {
    return;
  }
  if (monitor && !st.hub && hubLine(d)) st.hub = true;
  const u = d.message?.usage;
  if (d.type !== "assistant" || !u || !d.timestamp) return;
  // 一次回答拆成好几行（每块内容一行），用的是同一个编号和同一份 usage：只算一次。
  const id = d.message?.id;
  if (id !== undefined && id === st.lastId) return;
  st.lastId = id;
  const at = Date.parse(d.timestamp);
  if (!Number.isFinite(at) || at < cutoff) return;
  const t: Tokens = [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0];
  const key = String(slotOf(at));
  const slot = (slots[key] ??= { all: zero(), hub: zero() });
  slot.all = addTokens(slot.all, t);
  if (hubSession || st.hub) slot.hub = addTokens(slot.hub, t);
}

// 把每个文件新写的部分读一遍。先读会话本身，再读子代理（要先知道哪个会话是主会话）。
export async function scan(state: ScanState, root = transcriptsRoot(), now = Date.now()): Promise<ScanState> {
  const cutoff = now - KEEP_MS;
  const files = (await listFiles(root, cutoff)).sort((a, b) => Number(a.includes("/subagents/")) - Number(b.includes("/subagents/")));
  const seen = new Set(files);
  const next: ScanState = { files: Object.fromEntries(Object.entries(state.files).filter(([f]) => seen.has(f))), slots: state.slots };
  for (const file of files) {
    const st = (next.files[file] ??= { offset: 0, hub: false });
    const hubSession = file.includes("/subagents/") && Object.entries(next.files).some(([f, s]) => s.hub && !f.includes("/subagents/") && sessionOf(f) === sessionOf(file));
    let handle;
    try {
      handle = await open(file, "r");
      const size = (await handle.stat()).size;
      // 文件变短了（被重写）：从头读。
      if (size < st.offset) {
        st.offset = 0;
        st.lastId = undefined;
      }
      // 按字节切行（一个汉字可能跨两块）；只处理到最后一个换行，半行留到下次（正在写）。
      const buf = Buffer.alloc(CHUNK);
      let carry = Buffer.alloc(0);
      let pos = st.offset;
      while (pos < size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, size - pos), pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const end = data.lastIndexOf(10);
        if (end < 0) {
          carry = Buffer.from(data);
          continue;
        }
        for (const line of data.toString("utf8", 0, end).split("\n")) if (line) takeLine(line, st, hubSession, next.slots, cutoff);
        carry = Buffer.from(data.subarray(end + 1));
        st.offset = pos - carry.length;
      }
    } catch {
      // 读不了这个就跳过，下次再试。
    } finally {
      await handle?.close();
    }
  }
  next.slots = Object.fromEntries(Object.entries(next.slots).filter(([k]) => Number(k) >= cutoff));
  return next;
}

// 面板记下的账号百分比（hub-usage.json 的 readings）。
function readings(): Reading[] {
  const f = readJson<{ readings?: Reading[] }>(paths().hubUsage, {});
  return Array.isArray(f.readings) ? f.readings : [];
}

let running = false;

// 读一遍新写的记录、重新算一遍，写进 usage.json。引擎每 10 分钟跑一次；chief usage 也调。
export async function refreshUsage(now = Date.now()): Promise<UsageFile | null> {
  if (running) return null;
  running = true;
  try {
    const p = paths();
    const state = await scan(readJson<ScanState>(p.usageScan, { files: {}, slots: {} }), transcriptsRoot(), now);
    writeJson(p.usageScan, state);
    const spans = spansOf(readings().filter(r => r.at >= now - KEEP_MS), state.slots);
    const fitted = fitWeights(spans);
    const weights = fitted ?? DEFAULT_WEIGHTS;
    const out: UsageFile = { at: new Date(now).toISOString(), weights, fitted: fitted !== null, spans: spans.length, days: daysOf(spans, weights) };
    writeJson(p.usage, out);
    return out;
  } finally {
    running = false;
  }
}
