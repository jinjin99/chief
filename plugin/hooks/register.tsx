// chief 面板：在「chief 消息中心」（你的私人助理主会话）旁边。按你会问的三个问题分三页，加一个设置：
//   要你：所有要你动手的事都在这（inbox.ts 算）——会话等你点、要你定的、等你确认的回复、chief 自己出的问题、它提议的规矩。
//   进度：每件事做到哪了；搜以前的事；最近 7 天它做了什么，判断错了在这里说。只看，要你动手的在「要你」。
//   规矩：每种消息怎么办、你的规矩、人、回复怎么写、它做得怎么样（准确率、演练）。
//   设置：引擎、来源、主会话、免打扰和汇总、语言、导入、额度（setup.tsx）。引擎还没装时面板只有这一页。
// 数据直接读 ~/chief/data 里的文件（data.ts，每 3 秒一次）；动作在 actions.ts；每个页签的画法在 tabs/ 里，共用的小东西在 ui.tsx。
import { atom, read } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import { refresh, chiefDir } from './data'
import { confirmAsked, ensureKey, noteUserSaid } from './confirm'
import { hubInstructions, startCompactWatch, turnEnded, turnStarted } from './compact'
import { startTriage } from './triage'
import { isHub, isHubMonitor, markHub, recordCall } from './usage'
import { autoUpdate, checkSetup, missing, readSetup, setupTab } from './setup'
import { t } from './i18n'
import { overlaySending } from './inbox'
import { header } from './tabs/header'
import { nowTab } from './tabs/now'
import { policyTab } from './tabs/policy'
import { thingsTab } from './tabs/things'
import type { Els } from './ui'

const snap = atom({ plugin: 'chief', key: 'snap' } as const, null)
const note = atom({ plugin: 'chief', key: 'note' } as const, '')
const tab = atom({ plugin: 'chief', key: 'tab' } as const, 'now')
const edits = atom({ plugin: 'chief', key: 'edits' } as const, {})
const sending = atom({ plugin: 'chief', key: 'sending' } as const, {})
const open = atom({ plugin: 'chief', key: 'open' } as const, [])
const logs = atom({ plugin: 'chief', key: 'logs' } as const, '')
const basket = atom({ plugin: 'chief', key: 'basket' } as const, [])
const found = atom({ plugin: 'chief', key: 'found' } as const, null)

const PANE = 'chief'
const TITLE = 'chief'
// 保底：监听意外断了，每分钟也会重读一次。
const FALLBACK_MS = 60_000

let ticking = false
let watching = false

// 开始跟着数据刷新（插件重新加载、会话重启以后，面板还开着但监听没了，画的时候补上）。
// 挂一个 chief watch：~/chief/data 里有文件一变它就打一行，面板马上重读；不用一直去读。保底每分钟读一次。
async function startRefresh($: Engine) {
  if (!ticking) {
    ticking = true
    await checkSetup($)
    await refresh($)
    $.clock.every(FALLBACK_MS, () => refresh($))
  }
  if (!watching) {
    watching = true
    void watchChanges($)
  }
}

async function watchChanges($: Engine) {
  // 引擎还没装就没有 chief watch 可挂：等装好后下次画面板时再挂。
  if (!(await readSetup($)).installed) {
    watching = false
    return
  }
  try {
    const watcher = $.process.spawn({ argv: [`${await chiefDir($)}/bin/chief`, 'watch'] })
    for await (const piece of watcher) {
      if (piece.stream === 'stdout' && piece.text.includes('changed')) await refresh($)
    }
  } catch {
    // 起不来：只剩保底的每分钟一次。
  }
  // 监听停了（chief 被重装、进程被杀）：下次画面板时再挂上。
  watching = false
}

async function openPane($: Engine) {
  await $.ui.open({ id: PANE, title: TITLE })
  await checkSetup($)
  await refresh($)
  await startRefresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'chief', description: t().app.command })
    // 引擎跟着插件自动更新、配好「以你的名义发」的钥匙：放后台跑，不拖慢会话开起来。
    void autoUpdate($).then(() => ensureKey($)).catch(() => {})
    // 这个会话是主会话（插件重新加载、会话恢复）：接着分诊。
    if (await isHub($).catch(() => false)) {
      startTriage($)
      startCompactWatch($)
    }
    return next(e)
  })

  // 你亲口说的话（Claude Code 标的来源是你在输入框敲的，或手机 / 网页端发的）记下来：你在会话里说「发」，插件凭这句核对。
  // Slack 通知、插件塞的、别的会话发来的、斜杠命令都不记。
  on('prompt.submit', async ($, e, next) => {
    const from = e.origin?.kind
    if ((from === 'composer' || from === 'bridge') && !e.command && !e.isMeta && e.text.trim() !== '') {
      await noteUserSaid($, e.text).catch(() => {})
    }
    return next(e)
  })

  // 主会话跑了 chief reply ask-confirm：插件核对你说过话，再带钥匙以你的名义发。
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.command.includes('ask-confirm')) await confirmAsked($).catch(() => {})
    return ran
  })

  // 挂上 chief events --follow 的 Monitor：这个会话就是主会话，之后它调模型用掉的额度记下来（面板「测评」页看）。
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    // 工具的参数直接在 e 上（e.command），不在 e.input 里。
    const command = (e as { command?: unknown }).command
    if (isHubMonitor(typeof command === 'string' ? command : undefined)) {
      await markHub($).catch(() => {})
      startTriage($)
      startCompactWatch($)
    }
    return next(e)
  })

  // 主会话（不算它派出的子代理）每调完一次模型：读额度，记一笔。
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (e.agentId === undefined && res.usage && await isHub($).catch(() => false)) await recordCall($, res.usage).catch(() => {})
    return res
  })

  // 主会话的回合在不在跑：闲了一会儿插件才替它压缩（见 compact.ts）。只看主线程，不看子代理。
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turnStarted()
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) turnEnded()
    return next(e)
  })

  // 主会话压缩时（插件、自动、你手敲的都算）：告诉总结器哪些在 chief 的文件里、不用留。
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || !(await isHub($).catch(() => false))) return next(e)
    return next({ ...e, instructions: hubInstructions(e.instructions) })
  })

  on('command.run', { command: 'chief' }, async ($, e) => {
    await openPane($)
    return { text: t().app.opened }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    // 画的时候出错：把原因画出来，而不是留一块空白。
    try {
      return await draw($, ui)
    } catch (error) {
      return (
        <Box flexDirection="column" padding="sm" gap="xs">
          <Text color="error">{t().app.crashed(error instanceof Error ? error.message : String(error))}</Text>
          <Text dimColor wrap="wrap">{t().app.crashHint}</Text>
        </Box>
      )
    }
  })
}

async function draw($: Engine, ui: Els) {
  const { Box, Text } = ui
  {
    void startRefresh($)
    const st = await readSetup($)
    if (!st.installed) return <Box flexDirection="column" padding="sm">{setupTab($, ui, st, null)}</Box>
    const snapped = await read($, snap)
    if (snapped === null) return <Text dimColor>{t().app.loading}</Text>
    // 点了发送、命令还没跑完的回复先显示成「正在发」（规则见 overlaySending）。
    const s = { ...snapped, replies: overlaySending(snapped.replies, await read($, sending), Date.now()) }
    const current = await read($, tab)
    const said = await read($, note)
    const opened = await read($, open)
    // 原来的「待发出」并进了「要你」，「测评」并进了「规矩」，「控制」并进了「设置」：上次停在那几页的照样有地方去。
    const body = current === 'things' ? thingsTab($, ui, s, opened, await read($, found))
      : current === 'policy' || current === 'eval' ? policyTab($, ui, s, opened)
      : current === 'setup' || (current as string) === 'control' ? setupTab($, ui, st, s, await read($, logs), opened)
      : nowTab($, ui, s, opened, await read($, edits))
    return (
      <Box flexDirection="column" padding="sm">
        {header($, ui, s, said, current, await read($, basket), missing(st))}
        {body}
      </Box>
    )
  }
}
