// 主会话调模型的记录：每调完一次模型，记一笔调用次数和折算的份量，账号两个窗口的百分比变了就记一个读数，
// 写进 chief 数据目录的 hub-usage.json。Claude Code 只给整个账号的百分比、不按会话拆，所以这里不直接算主会话用了几个点：
// 引擎拿这些读数和本机所有会话的用量按份额分（见 engine/src/usage.ts、engine/src/shared/usage.ts），结果在 usage.json。
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, ModelUsage } from 'claude-code'

import { DEFAULT_WEIGHTS, isHubMonitor, weigh } from '../engine/src/shared/usage'
import type { HubUsage, UsageDay, UsageReading } from '../types'
import { chiefFiles } from './data'

// 本会话是不是主会话：挂上 chief events --follow 的 Monitor 时记下（只记本会话的，不跨会话）。
const hub = atom({ plugin: 'chief', key: 'hub' } as const, false)

type Reading = { at: number; five: number | null; week: number | null }

const KEEP_DAYS = 14
const KEEP_READINGS_MS = KEEP_DAYS * 86_400_000

export { isHubMonitor }

// 一次调用折成的份量（比例和引擎算份额用的一样）。
export function weightOf(u: ModelUsage): number {
  return weigh([u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens], DEFAULT_WEIGHTS)
}

export async function markHub($: Engine) {
  await update($, hub, () => true)
}

export async function isHub($: Engine): Promise<boolean> {
  return read($, hub)
}

export async function readingNow($: Engine): Promise<Reading & { context: number | null; window: number; fiveReset?: string; weekReset?: string }> {
  const u = await $.session.usage()
  const five = u.rateLimits.find(r => r.kind === 'five_hour')
  const week = u.rateLimits.find(r => r.kind === 'seven_day')
  return {
    at: Date.now(), five: five?.percentUsed ?? null, week: week?.percentUsed ?? null,
    context: u.context.tokens ?? null, window: u.context.window,
    ...(five?.resetsAt ? { fiveReset: five.resetsAt } : {}), ...(week?.resetsAt ? { weekReset: week.resetsAt } : {}),
  }
}

export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const emptyDay = (): UsageDay => ({ calls: 0, weight: 0 })

// 记一次调模型：after 是调完读到的。读数和上一个一样就不再记。纯函数，测得到。
export function addCall(file: HubUsage, after: Awaited<ReturnType<typeof readingNow>>, usage: ModelUsage): HubUsage {
  const day = dayOf(after.at)
  const d = { ...emptyDay(), ...file.days[day] }
  const days = Object.fromEntries(Object.entries({ ...file.days, [day]: { calls: d.calls + 1, weight: d.weight + weightOf(usage) } }).sort(([a], [b]) => a.localeCompare(b)).slice(-KEEP_DAYS))
  const old = (file.readings ?? []).filter(r => r.at >= after.at - KEEP_READINGS_MS)
  const last = old.at(-1)
  const reading: UsageReading = { at: after.at, five: after.five, week: after.week }
  const readings = last && last.five === reading.five && last.week === reading.week ? old : [...old, reading]
  return {
    days,
    readings,
    now: {
      at: new Date(after.at).toISOString(), context: after.context, window: after.window, five: after.five, week: after.week,
      ...(after.fiveReset ? { fiveReset: after.fiveReset } : {}), ...(after.weekReset ? { weekReset: after.weekReset } : {}),
    },
  }
}

// 主会话调了一次模型：读额度、记一笔。出错不影响主会话。
export async function recordCall($: Engine, usage: ModelUsage) {
  const after = await readingNow($)
  const path = (await chiefFiles($)).hubUsage
  let file: HubUsage = { days: {} }
  try {
    file = JSON.parse(await $.fs.read(path)) as HubUsage
  } catch {
    // 第一次记
  }
  await $.fs.write(path, JSON.stringify(addCall(file, after, usage)))
}
