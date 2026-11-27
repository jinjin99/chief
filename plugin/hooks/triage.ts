// 分诊：引擎先扣住多半只用记一笔的事件（见 engine/src/triage.ts），这里用小模型看一眼（默认 Haiku，设置页能换；走主会话的订阅）。
//   只记下：照主会话的办法记（工作会话的进展先写到卡片上，再 chief mark … noted），主会话不用醒。
//   要处理、拿不准、模型出错：chief triage wake，交给主会话，带上理由。
// 只在主会话所在的会话里跑（主会话不在听，也就没人要处理消息）；每 15 秒看一次。
import type { EngineInterface as Engine } from 'claude-code'

import { chiefDir, refresh } from './data'
import { SYSTEM, parseVerdict, promptOf, type Item, type Rules } from './triage-prompt'

const TICK_MS = 15_000

// 设置页能选的模型；引擎给的不在这里面就用 Haiku。
const MODELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

let started = false
let busy = false

// 主会话挂上 Monitor（或插件重新加载、这个会话本来就是主会话）时开始。
export function startTriage($: Engine) {
  if (started) return
  started = true
  void tick($)
  $.clock.every(TICK_MS, () => tick($))
}

async function tick($: Engine) {
  if (busy) return
  busy = true
  try {
    const bin = `${await chiefDir($)}/bin/chief`
    const run = (args: string[], stdin?: string) => $.process.run([bin, ...args], stdin === undefined ? undefined : { stdin })
    const listed = await run(['triage', 'list'])
    if (listed.exitCode !== 0) return
    const { model, rules, items } = JSON.parse(listed.stdout) as { model?: string; rules: Rules; items: Item[] }
    const m = model !== undefined && model in MODELS ? model : 'haiku'
    let done = 0
    for (const it of items) {
      if ((await run(['triage', 'claim', String(it.id)])).exitCode !== 0) continue
      await settle($, run, m, rules, it)
      done++
    }
    if (done > 0) await refresh($)
  } catch {
    // 这一轮没成：扣着的过一会儿自己交给主会话（见 engine/src/triage.ts）。
  } finally {
    busy = false
  }
}

type Run = (args: string[], stdin?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

async function settle($: Engine, run: Run, model: string, rules: Rules, it: Item) {
  const name = MODELS[model]!
  const wake = (reason: string) => run(['triage', 'wake', String(it.id)], reason)
  const r = await $.model.complete({ model, system: SYSTEM, prompt: promptOf(rules, it), maxTokens: 1024, effort: 'low', timeoutMs: 60_000 })
  const v = r.isAnswered ? parseVerdict(r.text, it.kind) : null
  if (!v) return void (await wake(`${name} 没给出判断`))
  if (v.action === 'wake') return void (await wake(v.reason))
  const thing = it.thing?.id
  if (it.kind === 'session') {
    if (thing === undefined) return void (await wake('找不到这个会话的事情'))
    if (v.card && Object.keys(v.card).length > 0) {
      const up = await run(['thing', 'update', String(thing)], JSON.stringify(v.card))
      if (up.exitCode !== 0) return void (await wake(`${name} 整理的进展没记上：${up.stderr.trim().slice(0, 120)}`))
    }
  }
  const marked = await run(['mark', String(it.id), 'noted', ...(it.kind === 'session' ? ['--thing', String(thing)] : [])], `${name}：${v.reason}`)
  if (marked.exitCode !== 0) await wake(`${name} 判断只记下，但没记上：${marked.stderr.trim().slice(0, 120)}`)
}
