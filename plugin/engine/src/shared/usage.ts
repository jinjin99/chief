// 主会话用掉多少额度的算法（纯函数，引擎和面板都用）。
// Claude Code 只给整个账号的百分比，不按会话拆。办法：
//   1. 本机每个会话的记录里有每次调模型的 token 数。按 10 分钟一格累计「所有会话」和「主会话」各用了多少（引擎的 usage.ts 读）。
//   2. 各种 token 折成同一种份量（weights），算主会话占所有会话的份额。
//   3. 面板记下的账号百分比（hub-usage.json 的 readings）涨了多少，按份额分给主会话。
// 折算比例：读数够多时用这个账号自己的数据拟合（fitWeights），不够时用社区实测的（DEFAULT_WEIGHTS）。

// 一格里四种 token 各多少：输入、输出、写缓存、读缓存。
export type Tokens = [number, number, number, number];
export type Weights = { input: number; output: number; cacheWrite: number; cacheRead: number };

// 社区实测：读缓存几乎不占额度（约 1.7 亿个读缓存涨 1%，66 万个输出也涨 1%），输出最贵。按输入 = 1 折。
export const DEFAULT_WEIGHTS: Weights = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.02 };

// 一格 10 分钟；记两周。
export const SLOT_MS = 10 * 60_000;
export const KEEP_MS = 14 * 86_400_000;

// 拟合要的最少行数、账号百分比最少涨了多少点：不够就用默认的。
const FIT_MIN_ROWS = 30;
const FIT_MIN_POINTS = 20;

export function isHubMonitor(command: string | undefined): boolean {
  return command !== undefined && /chief events\b/.test(command) && command.includes('--follow');
}

export const zero = (): Tokens => [0, 0, 0, 0];

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}

export function weigh(t: Tokens, w: Weights): number {
  return t[0] * w.input + t[1] * w.output + t[2] * w.cacheWrite + t[3] * w.cacheRead;
}

// 一格的开始时间（毫秒，作 key）。
export function slotOf(ms: number): number {
  return Math.floor(ms / SLOT_MS) * SLOT_MS;
}

// 本地日期（面板按天显示）。
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type Reading = { at: number; five: number | null; week: number | null };
export type Slot = { all: Tokens; hub: Tokens };

// 两次读数之间账号涨了几个点：变小了是窗口重置了，只算重置后的这点。
function rise(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return b >= a ? b - a : b;
}

// 读数之间的每一段：多长、账号两个窗口涨了多少、这段时间所有会话和主会话的 token。
export type Span = { from: number; to: number; five: number | null; week: number | null; reset: boolean; all: Tokens; hub: Tokens };

export function spansOf(readings: readonly Reading[], slots: Readonly<Record<string, Slot>>): Span[] {
  const sorted = [...readings].sort((a, b) => a.at - b.at);
  const keys = Object.keys(slots).map(Number).sort((a, b) => a - b);
  const out: Span[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    // 格子按开始时间归到它落在的那一段（读数之间隔得近时会差几分钟，长期看抵掉）。
    let all = zero();
    let hub = zero();
    for (const k of keys) {
      if (k < slotOf(a.at) || k >= slotOf(b.at)) continue;
      all = addTokens(all, slots[String(k)]!.all);
      hub = addTokens(hub, slots[String(k)]!.hub);
    }
    const reset = (a.five !== null && b.five !== null && b.five < a.five) || (a.week !== null && b.week !== null && b.week < a.week);
    out.push({ from: a.at, to: b.at, five: rise(a.five, b.five), week: rise(a.week, b.week), reset, all, hub });
  }
  return out;
}

// 解一个小的线性方程组（高斯消元）；奇异就返回 null。
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r]!;
      const f = row[c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) row[k] = row[k]! - f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

// 用这个账号自己的数据拟合折算比例：每一段「5 小时窗口涨了几个点」≈ 四种 token 各乘一个系数再加起来。
// 系数不许是负的（四个系数，挨个试哪几个取 0，挑误差最小的）。行数、点数不够，或拟合不出（输出的系数是 0），返回 null。
export function fitWeights(spans: readonly Span[]): Weights | null {
  const rows = spans.filter(s => !s.reset && s.five !== null && s.all.some(x => x > 0));
  if (rows.length < FIT_MIN_ROWS) return null;
  if (rows.reduce((n, s) => n + (s.five ?? 0), 0) < FIT_MIN_POINTS) return null;
  // 各列先缩放到同一个量级，免得读缓存的数太大把方程弄坏。
  const scale = [0, 1, 2, 3].map(j => Math.max(1, ...rows.map(s => s.all[j as 0])));
  const x = rows.map(s => s.all.map((v, j) => v / scale[j]!));
  const y = rows.map(s => s.five!);
  let best: { err: number; coef: number[] } | null = null;
  for (let mask = 1; mask < 16; mask++) {
    const cols = [0, 1, 2, 3].filter(j => mask & (1 << j));
    const ata = cols.map(i => cols.map(j => x.reduce((s, r) => s + r[i]! * r[j]!, 0)));
    const aty = cols.map(i => x.reduce((s, r, k) => s + r[i]! * y[k]!, 0));
    const sol = solve(ata, aty);
    if (!sol || sol.some(v => v < 0)) continue;
    const coef = [0, 0, 0, 0];
    cols.forEach((j, k) => (coef[j] = sol[k]!));
    const err = x.reduce((s, r, k) => s + (r.reduce((t, v, j) => t + v * coef[j]!, 0) - y[k]!) ** 2, 0);
    if (!best || err < best.err) best = { err, coef };
  }
  if (!best) return null;
  const raw = best.coef.map((c, j) => c / scale[j]!);
  if (raw[1]! <= 0) return null;
  // 换成和默认的一样的刻度（输出 = 5），面板好对照。
  const k = 5 / raw[1]!;
  return { input: raw[0]! * k, output: 5, cacheWrite: raw[2]! * k, cacheRead: raw[3]! * k };
}

export type UsageDayShare = {
  // 主会话占这台电脑所有会话用量的份额（0–1）；这天没有用量就是 null。
  share: number | null;
  // 账号两个窗口这天涨了几个点，和按份额分给主会话的。
  accountFive: number;
  accountWeek: number;
  five: number;
  week: number;
};

// 按天算：每一段账号涨的点数按这段里主会话的份额分给它；这段里本机没有用量（别的电脑、云端），不算给主会话。
export function daysOf(spans: readonly Span[], w: Weights): Record<string, UsageDayShare> {
  const days: Record<string, UsageDayShare & { all: number; hub: number }> = {};
  for (const s of spans) {
    const day = localDay(s.to);
    const d = (days[day] ??= { share: null, accountFive: 0, accountWeek: 0, five: 0, week: 0, all: 0, hub: 0 });
    const all = weigh(s.all, w);
    const hub = weigh(s.hub, w);
    const part = all > 0 ? hub / all : 0;
    d.all += all;
    d.hub += hub;
    d.accountFive += s.five ?? 0;
    d.accountWeek += s.week ?? 0;
    d.five += (s.five ?? 0) * part;
    d.week += (s.week ?? 0) * part;
  }
  return Object.fromEntries(Object.entries(days).map(([day, d]) => [day, {
    share: d.all > 0 ? d.hub / d.all : null, accountFive: d.accountFive, accountWeek: d.accountWeek, five: d.five, week: d.week,
  }]));
}
