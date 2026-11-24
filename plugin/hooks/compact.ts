// 主会话的上下文到了一定大小（config.json 的 hubCompactK，默认 20 万 token）、又闲了 2 分钟：插件替它压缩一次，
// 和你敲 /compact 一样，不用等快满了 Claude Code 才自动压（那时已经背着近百万 token 醒了一整天）。
// 不管谁触发的压缩（插件、自动、你手敲），在主会话里都告诉总结器哪些不用留：事情、问题、规矩、判断都在 chief 的文件里。
import type { EngineInterface as Engine } from 'claude-code'

import { chiefFiles, readJson } from './data'

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
let running = false
let lastTurnEnd = Date.now()
let lastCompact = 0

export function turnStarted() {
  running = true
}

export function turnEnded() {
  running = false
  lastTurnEnd = Date.now()
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
  if (running || now - lastTurnEnd < IDLE_MS || now - lastCompact < COOLDOWN_MS) return
  try {
    const limit = await compactAt($)
    if (limit === 0) return
    const { context } = await $.session.usage()
    if ((context.tokens ?? 0) < limit) return
    lastCompact = now
    await $.session.compact({ instructions: HUB_COMPACT })
  } catch {
    // 正好有一轮在跑、或者压缩没成：下一分钟再看。
  }
}
