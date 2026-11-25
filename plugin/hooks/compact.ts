// 主会话的上下文到了一定大小（config.json 的 hubCompactK，默认 20 万 token）、又闲了 2 分钟：插件替它压缩一次，
// 和你敲 /compact 一样，不用等快满了 Claude Code 才自动压（那时已经背着近百万 token 醒了一整天）。
// 不管谁触发的压缩（插件、自动、你手敲），在主会话里都告诉总结器哪些不用留：事情、问题、规矩、判断都在 chief 的文件里。
import type { EngineInterface as Engine } from 'claude-code'

import { chiefDir, chiefFiles, readJson } from './data'

export const HUB_COMPACT = [
  '这是 chief 消息中心（主会话）。事情、问题、回复、规矩、判断记录都存在 chief 的文件里，随时能用 chief 命令查，摘要里不要重复。',
  '只保留：',
  '1. 用户还没聊完的话题，和他交代了还没办完的事（原话要点）；',
  '2. 你答应用户要做、还没做的；',
  '3. 正处理到一半的事件：事件号、做到哪一步、下一步是什么；',
  '4. Monitor 挂着的命令和处理到的事件号（cursor）。',
  '处理完的消息、汇报、命令输出、搜索结果都不要留。',
].join('\n')

const CHECK_MS = 60_000
const IDLE_MS = 2 * 60_000
// 压过一次，半小时内不再压（压完还大，多半是正在聊的东西，再压也压不下去）。
const COOLDOWN_MS = 30 * 60_000
const DEFAULT_K = 200

let started = false
// 主会话最后一次有动静（回合开始、调模型、回合结束）的时间：闲够 2 分钟才压。
let lastActivity = Date.now()
let lastCompact = 0

export function turnActivity() {
  lastActivity = Date.now()
}

// 主会话压缩时，在总结器的说明后面加上这一段。
export function hubInstructions(given: string | undefined): string {
  return given?.trim() ? `${given.trim()}\n\n${HUB_COMPACT}` : HUB_COMPACT
}

async function compactAt($: Engine): Promise<number> {
  const config = await readJson<{ hubCompactK?: unknown }>($, (await chiefFiles($)).config, {})
  const k = typeof config.hubCompactK === 'number' && Number.isFinite(config.hubCompactK) ? config.hubCompactK : DEFAULT_K
  return Math.max(0, Math.min(1000, k)) * 1000
}

// 主会话挂上 Monitor（或插件重新加载、这个会话本来就是主会话）时开始，每分钟看一次。
export function startCompactWatch($: Engine) {
  if (started) return
  started = true
  $.clock.every(CHECK_MS, () => maybeCompact($))
}

async function maybeCompact($: Engine) {
  const now = Date.now()
  if (now - lastActivity < IDLE_MS) return
  if (now - lastCompact < COOLDOWN_MS) return
  let context: number | null = null
  try {
    const limit = await compactAt($)
    if (limit === 0) return
    context = (await $.session.usage()).context.tokens ?? null
    if ((context ?? 0) < limit) return
    lastCompact = now
    try {
      const { skip } = await $.session.compact({ instructions: HUB_COMPACT })
      await note($, { at: new Date(now).toISOString(), context, result: skip ? 'skipped' : 'compacted' })
    } catch {
      // Claude App 的会话（SDK）里插件不能直接压：像你敲 /compact 一样跑这个命令，等它闲下来跑，说明在 session.compact 里加上。
      await $.command.run({ command: 'compact', args: '' })
      await note($, { at: new Date(now).toISOString(), context, result: 'ran /compact' })
    }
  } catch (error) {
    // 正好有一轮在跑、或者压缩没成：记下原因，下一分钟再看（不算冷却）。
    lastCompact = 0
    await note($, { at: new Date(now).toISOString(), context, result: 'failed', error: error instanceof Error ? error.message.slice(0, 200) : String(error) })
  }
}

// 最近一次试着压的结果写进 chief 数据目录的 compact.json：没压成能看出为什么。
async function note($: Engine, entry: { at: string; context: number | null; result: string; error?: string }) {
  try {
    await $.fs.write(`${await chiefDir($)}/compact.json`, `${JSON.stringify(entry)}\n`)
  } catch {
    // 写不了就算了。
  }
}
