// 面板的六个页签怎么画。元素来自当前界面（App / 终端）的元素表；App 才有的（输入框、下拉、Markdown、图）没有时退回纯文字。
import type { EngineInterface as Engine, RenderChildren } from 'claude-code'

import type { AskRow, DecisionRow, Handle, ReplyMode, ReplyRow, Rule, Snapshot, ThingRow } from '../types'
import {
  act, addCustom, addRule, addStyle, removeCase, runEvals, saveCase, trust, annotate, clearBasket, openSession, removeStyle, sendBasket, setPlacement, setSignature, unannotate, decideProposal, engineDo, finish, hubStop, markRight, markWrong, redo, removeCustom, removeRule, send, setBrief,
  setEdit, setScenario, setTab, showLogs, skipOld, tell, testMessage, toggle,
} from './actions'
import { EVAL_DAYS, MINUTES, chartSvg, statsOf } from './data'

export type Els = ReturnType<Engine['ui']['resolve']>

export const SOURCE: Record<ReplyRow['source'], string> = { slack: 'Slack', github: 'GitHub', jira: 'Jira', notion: 'Notion', session: '会话' }
const STATUS: Record<ThingRow['status'], string> = {
  waiting_you: '等你定', doing: '在做', waiting_others: '等别人', done: '办完了', dropped: '不做了',
}
const VERDICT: Record<DecisionRow['verdict'], string> = {
  forwarded: '送进会话', opened: '开了新会话', asked: '问你', noted: '只记下', ignored: '忽略',
}
// 和 chief 的 src/store.ts SCENARIOS 一致。
const SCENARIO: Record<string, string> = {
  slack_self: '我在 Slack 上给自己发的话', slack_dm: 'Slack 私信', slack_mention: 'Slack 频道里 @我', slack_thread: '我在的 thread 有后续',
  github_review: 'PR 请我 review', github_mention: 'GitHub 上 @我', github_comment: '别人评论了我的 PR / issue', github_assigned: 'GitHub 指派给我',
  github_approved: '我的 PR 被 approve 了', github_changes: '我的 PR 被要求修改',
  jira_assigned: 'Jira 指派给我', jira_mention: 'Jira 评论里提到我', jira_comment: '别人评论了我的 Jira 单',
  notion_comment: 'Notion 页面有新评论', session_update: '我的会话有新进展', other: '其他',
}
const HANDLES: { value: Handle; label: string }[] = [
  { value: 'dispatch', label: '派人去办' }, { value: 'note', label: '只记下' }, { value: 'ignore', label: '忽略' },
  { value: 'approve', label: '直接 approve PR' }, { value: 'command', label: '当成我的指令' },
]
const MODES: { value: ReplyMode; label: string }[] = [
  { value: 'ask', label: '对外先问我' }, { value: 'auto', label: '对外直接发' },
]
const DEFAULT_PLACEMENT = { direct: 'inline', group: 'inline', channel: 'thread', self: 'thread' } as const

// 和 chief 的 placementOf 一样：这条 Slack 回复会放在 thread 里，还是直接回在对话里。
function placeOf(s: Snapshot, r: ReplyRow): 'inline' | 'thread' {
  if (r.target.thread_ts) return 'thread'
  if (r.target.in === 'thread' || r.target.in === 'inline') return r.target.in
  const a = (r.target.audience ?? (r.target.channel?.startsWith('D') ? 'direct' : 'channel')) as keyof typeof DEFAULT_PLACEMENT
  return (s.policy?.placement ?? DEFAULT_PLACEMENT)[a] ?? 'thread'
}

function short(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '从没'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 离截止还有几天（今天截止是 0，过期是负数）。
function daysLeft(due: string): number {
  const [y, m, d] = due.split('-').map(Number)
  return Math.round((new Date(y!, m! - 1, d!).getTime() - startOfToday()) / 86_400_000)
}

function dueLabel(due: string): { text: string; color: 'error' | 'warning' | undefined } {
  const n = daysLeft(due)
  if (n < 0) return { text: `过期 ${-n} 天（${due}）`, color: 'error' }
  if (n === 0) return { text: `今天截止`, color: 'error' }
  if (n <= 2) return { text: `${n} 天后截止（${due}）`, color: 'warning' }
  return { text: `${due} 截止`, color: undefined }
}

const live = (t: ThingRow) => t.status !== 'done' && t.status !== 'dropped'

// 一段话的要点：去掉表格和 Markdown 符号，取第一句。
function gist(text: string, max = 70): string {
  const plain = text
    .split('\n').filter(l => !/^\s*\|/.test(l)).join(' ')
    .replace(/\|[^|]*\|/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  const first = plain.split(/(?<=[。！？!?；;])\s*|\s+-\s+/)[0] ?? plain
  return short(first, max)
}

// 批注：一个 💬 按钮，点开一个整行的输入框，写完记进待发的批注里（不马上发）。
function annotateButton($: Engine, ui: Els, key: string, opened: string[]) {
  const { Button } = ui
  return <Button key={`an-${key}`} onPress={() => toggle($, `an-${key}`)}>{opened.includes(`an-${key}`) ? '收起批注' : '💬 批注'}</Button>
}

function annotateBox($: Engine, ui: Els, key: string, label: string, opened: string[]) {
  const { Box } = ui
  if (!opened.includes(`an-${key}`) || !('Input' in ui)) return null
  return (
    <Box width="100%">
      <ui.Input key={`ai-${key}`} autoFocus rows={2} placeholder="写一句批注：要它做什么、哪里不对……先攒着，在顶上一起发给主会话" submitLabel="记下"
        onSubmit={(v: string) => { if (v.trim()) { void annotate($, key, label, v.trim()); void toggle($, `an-${key}`) } }} />
    </Box>
  )
}

function md(ui: Els, text: string, dim = false) {
  const { Text } = ui
  return 'Markdown' in ui ? <ui.Markdown text={text} dimColor={dim} /> : <Text dimColor={dim} wrap="wrap">{text}</Text>
}

function select(ui: Els, key: string, value: string, options: { value: string; label: string }[], onSelect: (v: string) => void) {
  const { Text } = ui
  return 'Select' in ui
    ? <ui.Select key={key} options={options} value={value} onSelect={(v: string) => onSelect(v)} />
    : <Text>{options.find(o => o.value === value)?.label ?? value}</Text>
}

// ── 顶上：主会话和引擎在不在、页签 ──

export function header($: Engine, ui: Els, s: Snapshot, said: string, current: string, basket: { key: string; label: string; text: string }[] = [], setupMissing = 0) {
  const { Box, Text, Button } = ui
  const toSend = s.replies.filter(r => r.status === 'pending' || r.status === 'failed').length
  const asks = s.asks.filter(a => a.status === 'open').length
  const proposals = s.policy?.proposals.length ?? 0
  // 提示是「时间|文字」：只显示最近 8 秒的。
  const bar = said.indexOf('|')
  const noteText = bar > 0 && Date.now() - Number(said.slice(0, bar)) < 8000 ? said.slice(bar + 1) : ''
  const tabs: { key: 'now' | 'outbox' | 'things' | 'policy' | 'eval' | 'setup'; label: string; n: number }[] = [
    { key: 'now', label: '现在要你', n: asks },
    { key: 'outbox', label: '待发出', n: toSend },
    { key: 'things', label: '进度', n: 0 },
    { key: 'policy', label: '策略', n: proposals },
    { key: 'eval', label: '测评', n: 0 },
    { key: 'setup', label: '设置', n: setupMissing },
  ]
  // 连着失败两次以上的来源：一次可能只是网络抖了一下。
  const broken = Object.entries(s.health).filter(([, h]) => h.fails >= 2).map(([k]) => k)
  return (
    <Box flexDirection="column" gap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        {s.hub.listening
          ? <Text size="caption" color="success">● 主会话在听</Text>
          : <Text size="caption" color="warning">● 主会话没在听 · 上次 {ago(s.hub.lastAt)}</Text>}
        {s.engineAt === null
          ? <Text size="caption" color="error">引擎没在跑</Text>
          : broken.length > 0 ? <Text size="caption" color="error">{broken.map(k => SOURCE[k as keyof typeof SOURCE] ?? k).join('、')} 连不上</Text>
          : s.unhandled > 0 ? <Text size="caption" dimColor>{s.unhandled} 条等判断</Text> : <Text size="caption" dimColor>引擎在跑</Text>}
      </Box>
      {!s.hub.listening && (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX="md" paddingY="sm" gap="xs">
          <Text weight="semibold">新消息现在没人判断</Text>
          <Text size="footnote" dimColor wrap="wrap">在这个会话里发 /chief:hub，它会接着处理。</Text>
          {s.unhandled > 20 && <Button key="skip-old" onPress={() => skipOld($, s.maxEvent)}>跳过积下的 {s.unhandled} 条</Button>}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" gap="lg" alignItems="center">
        {tabs.map(t => current === t.key
          // 当前页不是按钮：按钮里的字 App 一律画成同一个颜色，分不出选中。
          ? <Text key={`tab-${t.key}`} weight="semibold" color="claude" underline>{t.label}{t.n > 0 ? ` ${t.n}` : ''}</Text>
          : <Button key={`tab-${t.key}`} plain onPress={() => setTab($, t.key)}>{t.n > 0 ? `${t.label} ${t.n}` : t.label}</Button>)}
      </Box>
      {noteText !== '' && <Text size="footnote" color="suggestion">{noteText}</Text>}
      {basket.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX="md" paddingY="sm" gap="xs">
          <Text weight="semibold">要发给主会话的批注 · {basket.length}</Text>
          {basket.map((x, i) => (
            <Box key={`bk-${i}`} flexDirection="row" gap="sm" alignItems="flex-start">
              <Box flexGrow={1} flexShrink={1}>
                <Text size="footnote" wrap="wrap">{x.key === 'note' ? '' : <Text dimColor>{short(x.label, 30)}　</Text>}{x.text}</Text>
              </Box>
              <Button key={`unb-${i}`} plain onPress={() => unannotate($, i)}>✕</Button>
            </Box>
          ))}
          <Box flexDirection="row" gap="sm" marginTop="xs">
            <Button key="send-basket" variant="primary" onPress={() => sendBasket($)}>一起发给主会话</Button>
            <Button key="clear-basket" onPress={() => clearBasket($)}>清空</Button>
          </Box>
        </Box>
      )}
    </Box>
  )
}

export function nowTab($: Engine, ui: Els, s: Snapshot, opened: string[] = [], edit: Record<string, string> = {}) {
  const { Box, Text, Button } = ui
  const dayStart = startOfToday()
  const today = s.decisions.filter(d => Date.parse(d.at) >= dayStart)
  const count = (...v: DecisionRow['verdict'][]) => today.filter(d => v.includes(d.verdict)).length
  const sentToday = s.replies.filter(r => r.status === 'sent' && r.sentAt !== undefined && Date.parse(r.sentAt) >= dayStart).length
  const asks = s.asks.filter(a => a.status === 'open')
  const toSend = s.replies.filter(r => r.status === 'pending' || r.status === 'failed').length
  const thingOf = (id: number) => s.things.find(t => t.id === id)
  const dueSoon = s.things.filter(t => live(t) && t.due !== undefined && daysLeft(t.due) <= 3).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))
  const blocked = s.things.filter(t => live(t) && t.blocker !== undefined)

  const askCard = (q: AskRow) => {
    const t = thingOf(q.thing)
    return (
      <Box key={`a${q.id}`} flexDirection="column" borderStyle="round" borderColor="inactive" paddingX="md" paddingY="sm" gap="xs" marginTop="sm">
        <Box flexDirection="row" alignItems="center" gap="xs">
          
          {t ? <Text dimColor size="caption">{t.title}</Text> : <Text dimColor size="caption">要你定</Text>}
        </Box>
        <Text weight="semibold" wrap="wrap">{q.question}</Text>
        {q.suggest !== '' && <Box flexDirection="column"><Text dimColor size="caption">建议</Text>{md(ui, q.suggest)}</Box>}
        <Box flexDirection="row" gap="sm">
          {q.suggest !== '' && (
            <Button key={`ok${q.id}`} variant="primary" onPress={() => tell($, `chief：问题 #${q.id} 照建议办`, '照建议办')}>照建议办</Button>
          )}
          {t?.session && (
            <Button key={`oa${q.id}`} onPress={() => openSession($, t.session ?? '', t.title)}>看细节</Button>
          )}
        </Box>
        {/* 要你定的卡片只给三条路：照建议办、去会话里看、写你的决定。攒着一起发的「批注」只放在进度页。 */}
        {'Input' in ui && (
          <ui.Input key={`in${q.id}`} placeholder="不同意？写你的决定" submitLabel="发送" onSubmit={(v: string) => {
            if (v.trim()) void tell($, `chief：问题 #${q.id} 的回答：${v.trim()}`, '你的决定')
          }} />
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop="sm">
      <Text dimColor wrap="wrap">
        今天：判断了 {today.length} 条 · 派人去办 {count('forwarded', 'opened')} · 只记下 {count('noted', 'asked')} · 忽略 {count('ignored')} · 替你发出 {sentToday}
      </Text>
      {asks.length === 0 && toSend === 0 ? <Box marginTop="sm"><Text color="success">没有要你定、要你确认的事。</Text></Box> : asks.map(askCard)}
      {toSend > 0 && (
        <Box flexDirection="column" marginTop="md">
          <Text size="footnote" weight="semibold">等你确认再发 · {toSend}</Text>
          {s.replies.filter(r => r.status === 'pending' || r.status === 'failed').map(r => replyCard($, ui, s, edit, opened, r))}
        </Box>
      )}
      {(dueSoon.length > 0 || blocked.length > 0) && (
        <Box flexDirection="column" marginTop="md" gap="xs">
          <Text weight="semibold">要盯一下的</Text>
          {dueSoon.map(t => {
            const d = dueLabel(t.due!)
            return <Text key={`ds${t.id}`} wrap="wrap"><Text color={d.color}>{d.text}</Text> · {t.title}{t.progress ? <Text dimColor> · {short(t.progress, 40)}</Text> : ''}</Text>
          })}
          {blocked.filter(t => !dueSoon.includes(t)).map(t => (
            <Text key={`bk${t.id}`} wrap="wrap"><Text color="error">卡住</Text> · {t.title} <Text dimColor>· {short(t.blocker ?? '', 60)}</Text></Text>
          ))}
          <Button key="go-things" onPress={() => setTab($, 'things')}>看全部进度</Button>
        </Box>
      )}
    </Box>
  )
}

// ── 待发出 ──

export function replyCard($: Engine, ui: Els, s: Snapshot, edit: Record<string, string>, opened: string[], r: ReplyRow) {
  const { Box, Text, Button } = ui
  const t = s.things.find(x => x.id === r.thing)
  const approve = r.kind === 'approve'
  const who = r.context.who ?? r.target.to ?? '对方'
  const editKey = `edit-${r.id}`
  const redoKey = `redo-${r.id}`
  const editing = opened.includes(editKey)
  const redoing = opened.includes(redoKey)
  const body = edit[String(r.id)] ?? r.body
  const sign = s.policy?.signature ?? '🤖 agent reply'
  // 一行说清：哪来的、属于哪件事、发到哪。
  const meta = [
    `${SOURCE[r.source]} · ${short(r.context.where, 30)}`,
    t ? `事情：${short(t.title, 24)}` : '',
    r.source === 'slack' && !approve ? (r.kind === 'message' ? (r.target.thread_ts ? '' : '新消息') : placeOf(s, r) === 'thread' ? '回到 thread' : '直接回在对话里') : '',
  ].filter(Boolean).join(' · ')
  return (
    <Box key={`r${r.id}`} flexDirection="column" borderStyle="round" borderColor={r.status === 'failed' ? 'error' : 'inactive'} paddingX="md" paddingY="sm" gap="sm" marginTop="sm">
      <Box flexDirection="column">
        <Text weight="semibold">{approve ? `approve PR ${r.target.ref ?? ''}` : r.kind === 'message' ? `发给 ${who}` : `回 ${who}`}</Text>
        <Text size="caption" dimColor wrap="wrap">{meta}</Text>
      </Box>

      {r.context.said !== '' && (
        <Box paddingLeft="sm" flexDirection="column">
          <Text size="footnote" dimColor wrap="wrap">{short(r.context.who ?? '对方', 16)}：{short(r.context.said, 160)}</Text>
        </Box>
      )}

      {r.status === 'failed' && <Text color="error" wrap="wrap">没发出去：{r.error ?? '没说为什么'}</Text>}

      {!approve && (editing && 'Input' in ui
        ? (
          <Box width="100%">
            <ui.Input key={`body${r.id}`} rows={8} autoFocus value={body} submitLabel="改好了"
              onInput={(v: string) => void setEdit($, r.id, v)}
              onSubmit={(v: string) => { void setEdit($, r.id, v); void toggle($, editKey) }} />
          </Box>
        )
        : (
          // 按发出去的样子显示：正文上方的署名小字、分行、列表都和 Slack 上一样。
          <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX="md" paddingY="sm">
            {sign !== '' && r.source === 'slack' && <Text size="footnote" dimColor>{sign} · confirmed by 你</Text>}
            {md(ui, body.replace(/<@([UW][A-Z0-9]+)>/g, (_, id: string) => `**@${s.people?.[id] ?? id}**`))}
          </Box>
        ))}

      <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
        <Button key={`sd${r.id}`} variant="primary" onPress={() => send($, r)}>{r.status === 'failed' ? '重发' : approve ? 'approve' : '发送'}</Button>
        {!approve && <Button key={`ed${r.id}`} onPress={() => toggle($, editKey)}>{editing ? '改好了' : '改稿'}</Button>}
        {!approve && <Button key={`rw${r.id}`} onPress={() => toggle($, redoKey)}>让它重写</Button>}
        <Button key={`dp${r.id}`} onPress={() => act($, approve ? '不 approve' : '不发', ['reply', 'drop', String(r.id)])}>{approve ? '不 approve' : '不发'}</Button>
        {t?.session && <Button key={`or${r.id}`} plain onPress={() => openSession($, t.session ?? '', t.title)}>看细节</Button>}
      </Box>

      {redoing && 'Input' in ui && (
        <Box width="100%">
          <ui.Input key={`rd${r.id}`} autoFocus rows={2} placeholder="哪里不对？比如：太长了、语气太硬、先说结论" submitLabel="让它重写"
            onSubmit={(v: string) => { if (v.trim()) { void redo($, r, v.trim()); void toggle($, redoKey) } }} />
        </Box>
      )}
    </Box>
  )
}

export function outboxTab($: Engine, ui: Els, s: Snapshot, edit: Record<string, string>, opened: string[] = []) {
  const { Box, Text, Button } = ui
  const toSend = s.replies.filter(r => r.status === 'pending' || r.status === 'failed')
  const inFlight = s.replies.filter(r => r.status === 'queued' || r.status === 'sending')
  const dayStart = startOfToday()
  const sentToday = s.replies.filter(r => r.status === 'sent' && r.sentAt !== undefined && Date.parse(r.sentAt) >= dayStart).reverse()
  const thingOf = (id: number | undefined) => s.things.find(t => t.id === id)
  const what = (r: ReplyRow) => (r.kind === 'approve' ? `approve PR ${r.target.ref ?? ''}` : r.kind === 'message' ? `发给 ${r.context.who ?? r.target.to ?? ''}` : `回 ${r.context.who ?? r.context.where}`)

  const card = (r: ReplyRow) => replyCard($, ui, s, edit, opened, r)

  return (
    <Box flexDirection="column" marginTop="sm">
      {inFlight.map(r => (
        <Box key={`q${r.id}`} flexDirection="row" gap="sm" alignItems="center">
          <Text color="suggestion">{r.status === 'sending' ? '正在发' : '马上发出'}：{what(r)}{r.kind === 'approve' ? '' : `「${short(r.body, 30)}」`}</Text>
          {r.status === 'queued' && <Button key={`ud${r.id}`} onPress={() => act($, '撤回', ['reply', 'undo', String(r.id)])}>撤回</Button>}
        </Box>
      ))}
      {toSend.length === 0 && inFlight.length === 0 && <Text color="success">没有等你确认的回复。</Text>}
      {toSend.map(card)}
      {sentToday.length > 0 && <Box marginTop="md"><Text weight="semibold">今天发出的（{sentToday.length}）</Text></Box>}
      {sentToday.slice(0, 10).map(r => (
        <Text key={`st${r.id}`} dimColor wrap="truncate-end">
          {r.by === 'policy' ? '按规矩' : r.original !== undefined ? '你改过' : '你确认'} · {what(r)}{r.kind === 'approve' ? '' : `：${short(r.body, 60)}`}
        </Text>
      ))}
    </Box>
  )
}

// ── 进度：每件事做到哪了、下一步、卡在哪、结果、截止 ──

export function thingsTab($: Engine, ui: Els, s: Snapshot, opened: string[]) {
  const { Box, Text, Button } = ui
  const dayStart = startOfToday()
  const active = s.things.filter(live)
  const act = (t: ThingRow) => (t.session ? s.activity[t.session] : undefined)
  // 最后有动静的时间：chief 记的进展，和会话里你自己推进的，取晚的那个。
  const touched = (t: ThingRow) => {
    const a = act(t)?.at
    return a && a > t.updatedAt ? a : t.updatedAt
  }
  const staleDays = (t: ThingRow) => Math.floor((Date.now() - Date.parse(touched(t))) / 86_400_000)
  // 会话里最新说的话（它说话的时间比 chief 记的进展新时才算「最新」；收到消息不算说话）。
  const live_ = (t: ThingRow) => {
    const a = act(t)
    const said = a?.saidAt ?? a?.at
    return a && a.last && said && said > t.updatedAt ? { ...a, at: said } : null
  }
  // 「最近」：chief 记的进展和会话最新说的话，取新的那个，带上时间。每张卡都有这一行。
  const latest = (t: ThingRow): { when: string; text: string; fromSession: boolean } => {
    const f = live_(t)
    if (f) return { when: ago(f.at), text: gist(f.last, 90), fromSession: true }
    return { when: ago(t.updatedAt), text: t.progress || '还没有汇报', fromSession: false }
  }
  // 会话是「跳过权限」模式而主会话不是：主会话发过去的消息会被扣住。
  const bypass = (t: ThingRow) => {
    const m = act(t)?.permissionMode
    return m !== undefined && m !== null && s.hubMode !== null && (m === 'bypassPermissions') !== (s.hubMode === 'bypassPermissions')
  }

  // 为什么要关注这件事（没有就是正常推进）。rank 小的更急。
  type Risk = { rank: number; label: string; color: 'error' | 'warning' }
  const risk = (t: ThingRow): Risk | null => {
    // 会话停在问你的对话框上：最急，它什么都做不了，就等你。
    if (act(t)?.waiting) return { rank: -1, label: '会话在等你回答', color: 'error' }
    if (t.due !== undefined) {
      const n = daysLeft(t.due)
      if (n < 0) return { rank: 0, label: `过期 ${-n} 天`, color: 'error' }
      if (n === 0) return { rank: 1, label: '今天截止', color: 'error' }
      if (n === 1) return { rank: 2, label: '明天截止', color: 'warning' }
      if (n === 2) return { rank: 3, label: '后天截止', color: 'warning' }
    }
    if (t.blocker) return { rank: 4, label: '卡住了', color: 'error' }
    if (t.status === 'waiting_you') return { rank: 5, label: '等你定', color: 'warning' }
    if (staleDays(t) >= 3) return { rank: 6, label: `${staleDays(t)} 天没动静`, color: 'warning' }
    return null
  }
  const attention: { t: ThingRow; r: Risk }[] = []
  for (const t of active) {
    const r = risk(t)
    if (r) attention.push({ t, r })
  }
  attention.sort((a, b) => a.r.rank - b.r.rank)
  const moving = active.filter(t => risk(t) === null).sort((a, b) => touched(b).localeCompare(touched(a)))
  const done = s.things.filter(t => !live(t) && Date.parse(t.updatedAt) >= dayStart - 6 * 86_400_000).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const doneOpen = opened.includes('done-list')

  // 最上面一句话：现在最要紧的是什么。
  const top = attention[0]
  const headline = top
    ? `最要紧：${short(top.t.title, 34)} ${top.r.label}${top.t.blocker ? `，卡在${short(top.t.blocker, 24)}` : top.t.next ? `，还差${short(top.t.next, 24)}` : ''}`
    : active.length > 0 ? `${active.length} 件事都在正常推进，没有要你操心的` : '还没有事情'

  const goSession = (t: ThingRow) => openSession($, t.session ?? '', t.title)

  // 要关注的：一张卡，原因放最前面，写清还差什么，能直接动手。
  const attentionCard = ({ t, r }: { t: ThingRow; r: Risk }) => (
    <Box key={`at${t.id}`} flexDirection="column" borderStyle="round" borderColor={r.color} paddingX="md" paddingY="sm" gap="xs" marginTop="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
        <Text weight="semibold" color={r.color}>{r.label}</Text>
        {t.due && <Text size="caption" dimColor>{t.due} 截止</Text>}
      </Box>
      <Text weight="semibold" wrap="wrap">{t.title}</Text>
      {act(t)?.waiting && <Text size="footnote" color="error" wrap="wrap"><Text dimColor>它问你　</Text>{act(t)!.waiting}</Text>}
      {t.blocker && <Text size="footnote" color="error" wrap="wrap">卡在：{t.blocker}</Text>}
      <Text size="footnote" wrap="wrap"><Text dimColor>还差　　</Text>{t.next ?? <Text dimColor>还不清楚</Text>}</Text>
      <Text size="footnote" wrap="truncate-end"><Text dimColor>最近　　</Text>{latest(t).text}<Text dimColor>　{latest(t).when}{latest(t).fromSession ? ' · 会话' : ''}</Text></Text>
      {bypass(t) && <Text size="caption" color="warning" wrap="wrap">这个会话和主会话的权限模式不一样，主会话转告过去的消息会被扣住</Text>}
      <Box flexDirection="row" gap="sm" marginTop="xs">
        {t.session && <Button key={`ago${t.id}`} variant="primary" onPress={() => goSession(t)}>{act(t)?.waiting ? '去回答' : '去这个会话'}</Button>}
        {t.session && <Button key={`aask${t.id}`} onPress={() => tell($, `chief：转告事情 #${t.id}：现在进展怎么样？还差什么，能不能按时完成？`, '问进展')}>问进展</Button>}
        {annotateButton($, ui, `t${t.id}`, opened)}
        <Button key={`adn${t.id}`} onPress={() => finish($, t, 'done')}>办完了</Button>
      </Box>
      {annotateBox($, ui, `t${t.id}`, `【事情 #${t.id} ${t.title}】`, opened)}
    </Box>
  )

  // 正常推进的：收起时最多三行——标题、下一步（或现在）、会话最新一句；点开才看全文和操作。
  const movingRow = (t: ThingRow) => {
    const key = `t${t.id}`
    const isOpen = opened.includes(key)
    const fresh = live_(t)
    const block = (label: string, body: RenderChildren) => (
      <Box flexDirection="column" gap="xs">
        <Text size="caption" weight="semibold" dimColor>{label}</Text>
        {body}
      </Box>
    )
    return (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor="inactive" paddingX="md" paddingY="sm" gap="xs" marginTop="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Button key={`tg${t.id}`} plain onPress={() => toggle($, key)}><Text weight="semibold">{`${isOpen ? '▾' : '▸'} ${short(t.title, 48)}`}</Text></Button>
          {t.due ? <Text size="caption" dimColor>{t.due} 截止</Text> : null}
        </Box>
        {!isOpen && (
          <Box flexDirection="column" gap="xs" paddingLeft="md">
            <Text size="footnote" wrap="truncate-end"><Text dimColor>下一步　</Text>{t.next ?? <Text dimColor>还不清楚</Text>}</Text>
            <Text size="footnote" wrap="truncate-end"><Text dimColor>最近　　</Text>{latest(t).text}<Text dimColor>　{latest(t).when}{latest(t).fromSession ? ' · 会话' : ''}</Text></Text>
          </Box>
        )}
        {isOpen && (
          <Box flexDirection="column" gap="md" paddingLeft="md" marginTop="xs">
            {/* 会话自己说的比主会话记的新：会话的话更准，放前面；主会话记的标明是它记的、可能过时。 */}
            {fresh && block(`会话自己说的 · ${ago(fresh.at)}（最准）`, md(ui, fresh.last))}
            {block('下一步', <Text size="footnote" wrap="wrap">{t.next ?? '还不清楚'}</Text>)}
            {t.progress && block(fresh ? `主会话记的 · ${ago(t.updatedAt)}（可能过时）` : '现在', <Text size="footnote" dimColor={fresh !== null} wrap="wrap">{t.progress}</Text>)}
            {(t.results ?? []).length > 0 && block('结果', <Box flexDirection="column">{(t.results ?? []).map((r, i) => <Box key={`rs${t.id}-${i}`}>{md(ui, r)}</Box>)}</Box>)}
            {bypass(t) && <Text size="caption" color="warning" wrap="wrap">这个会话和主会话的权限模式不一样，主会话转告过去的消息会被扣住</Text>}
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {t.session && <Button key={`ot${t.id}`} variant="primary" onPress={() => goSession(t)}>去这个会话</Button>}
              {annotateButton($, ui, `t${t.id}`, opened)}
              <Button key={`dn${t.id}`} onPress={() => finish($, t, 'done')}>办完了</Button>
              <Button key={`dr${t.id}`} onPress={() => finish($, t, 'dropped')}>不做了</Button>
            </Box>
            {annotateBox($, ui, `t${t.id}`, `【事情 #${t.id} ${t.title}】`, opened)}
          </Box>
        )}
      </Box>
    )
  }

  const section = (title: string, n: number) => (
    <Box marginTop="lg" marginBottom="xs"><Text size="footnote" weight="semibold">{title} · {n}</Text></Box>
  )

  return (
    <Box flexDirection="column" marginTop="sm">
      <Text size="heading" weight="semibold" wrap="wrap" color={top?.r.color}>{headline}</Text>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm" marginTop="xs">
        <Text size="caption" dimColor>{active.length} 件在做 · {attention.length} 件要关注 · 最近 7 天办完 {done.length} 件</Text>
        <Box flexDirection="row" gap="sm">
          <Button key="import" onPress={() => tell($, 'chief：导入现在在做的事', '导入')}>导入</Button>
          <Button key="progress" onPress={() => tell($, 'chief：问一遍各事情的最新进展', '问进展')}>问一遍进展</Button>
        </Box>
      </Box>


      {attention.length > 0 && (
        <Box flexDirection="column">
          {section('要关注', attention.length)}
          {attention.map(attentionCard)}
        </Box>
      )}

      {moving.length > 0 && (
        <Box flexDirection="column">
          {section('在推进', moving.length)}
          {moving.map(movingRow)}
        </Box>
      )}

      {done.length > 0 && (
        <Box flexDirection="column">
          <Box marginTop="lg" marginBottom="xs">
            <Button key="done-list" plain onPress={() => toggle($, 'done-list')}>{`${doneOpen ? '▾' : '▸'} 办完了 · ${done.length}（最近 7 天）`}</Button>
          </Box>
          {doneOpen && (
            <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX="md" paddingY="sm" gap="xs">
              {done.map(t => <Text key={`dd${t.id}`} size="footnote" wrap="truncate-end"><Text color="success">✓ </Text>{t.title}</Text>)}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

// ── 策略 ──

export function policyTab($: Engine, ui: Els, s: Snapshot, opened: string[]) {
  const { Box, Text, Button } = ui
  const p = s.policy
  if (p === null) return <Text dimColor>正在读规矩…</Text>
  const helpOpen = opened.includes('policy-help')

  // 一条规矩：左边是什么情况，右边两个下拉；下面一行是交代（点了才出输入框）。
  const ruleRow = (target: string, label: string, r: Rule, onRemove?: () => void) => {
    const bk = `brief-${target}`
    const editing = opened.includes(bk)
    const takesBrief = r.handle === 'dispatch' || r.handle === 'approve'
    return (
      <Box key={`sc-${target}`} flexDirection="column" gap="xs" paddingY="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm" flexWrap="wrap">
          <Box flexGrow={1} flexShrink={1} minWidth={16}><Text wrap="wrap">{label}</Text></Box>
          <Box flexDirection="row" gap="sm" alignItems="center">
            {select(ui, `h-${target}`, r.handle, HANDLES, val => void setScenario($, target, 'handle', val as Handle))}
            {r.handle !== 'ignore' && r.handle !== 'note' && select(ui, `m-${target}`, r.reply, MODES, val => void setScenario($, target, 'reply', val as ReplyMode))}
          </Box>
        </Box>
        {takesBrief && (
          <Box flexDirection="row" gap="sm" alignItems="center">
            {r.brief
              ? <Text size="footnote" dimColor wrap="wrap">交代：{r.brief}</Text>
              : null}
            <Button key={`eb-${target}`} plain onPress={() => toggle($, bk)}>{editing ? '收起' : r.brief ? '改交代' : '+ 加交代'}</Button>
            {onRemove && <Button key={`rmc-${target}`} plain onPress={onRemove}>删除</Button>}
          </Box>
        )}
        {!takesBrief && onRemove && <Button key={`rmc-${target}`} plain onPress={onRemove}>删除</Button>}
        {takesBrief && editing && 'Input' in ui && (
          <ui.Input key={`bf-${target}`} value={r.brief ?? ''} submitLabel="存" autoFocus
            placeholder={r.handle === 'approve' ? '什么情况下不 approve（比如：CI 没过的先问我）' : '派这类活时交代什么（比如：review 先看有没有测试）'}
            onSubmit={(val: string) => { void setBrief($, target, val.trim()); void toggle($, bk) }} />
        )}
      </Box>
    )
  }

  // 每一块规矩框起来，一眼分得清层级。
  const section = (key: string, text: string, sub: string | undefined, ...body: RenderChildren[]) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor="inactive" paddingX="md" paddingY="sm" gap="xs" marginTop="sm">
      <Box flexDirection="column">
        <Text weight="semibold">{text}</Text>
        {sub && <Text size="caption" dimColor wrap="wrap">{sub}</Text>}
      </Box>
      {body}
    </Box>
  )

  return (
    <Box flexDirection="column" marginTop="sm">
      {p.proposals.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX="md" paddingY="sm" gap="sm">
          <Text weight="semibold">它提议的规矩 · {p.proposals.length}</Text>
          {p.proposals.map(x => (
            <Box key={`pp${x.id}`} flexDirection="column" gap="xs">
              <Text wrap="wrap">{x.text}</Text>
              {x.basis !== '' && <Text size="caption" dimColor wrap="wrap">依据：{x.basis}</Text>}
              <Box flexDirection="row" gap="sm">
                <Button key={`pa${x.id}`} variant="primary" onPress={() => decideProposal($, x.id, true)}>采纳</Button>
                <Button key={`pr${x.id}`} onPress={() => decideProposal($, x.id, false)}>不要</Button>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text size="caption" dimColor>改了马上生效：主会话每次判断前都重新读</Text>
        <Button key="policy-help" plain onPress={() => toggle($, 'policy-help')}>{helpOpen ? '收起说明' : '选项是什么意思？'}</Button>
      </Box>
      {helpOpen && (
        <Box flexDirection="column" gap="xs" marginTop="xs" paddingLeft="sm">
          <Text size="footnote" dimColor wrap="wrap">派人去办 — 送进在做这件事的会话，没有就挑目录开新会话，交代原样带过去</Text>
          <Text size="footnote" dimColor wrap="wrap">只记下 — 记进那件事的进展，不派活、不打扰你（「PR 合了」「好的收到」）</Text>
          <Text size="footnote" dimColor wrap="wrap">忽略 — 连记都不记</Text>
          <Text size="footnote" dimColor wrap="wrap">直接 approve PR — 找出消息里的 PR，看过状态再 approve</Text>
          <Text size="footnote" dimColor wrap="wrap">当成我的指令 — 你自己说的话，照办</Text>
          <Text size="footnote" dimColor wrap="wrap">对外先问我 / 直接发 — 回复和 approve 要不要你点头；直接发也有 5 秒能在「待发出」撤回</Text>
        </Box>
      )}

      {section('sec-trusted', '白名单：回这些人直接发', '名单里的人，替你写好的回复不用你确认就发（仍有 5 秒能撤回）；你写的「一定问我」的规矩照样优先。写名字的一部分或 Slack 用户编号',
        (p.trusted ?? []).length === 0 && <Text key="tr-none" size="footnote" dimColor>还没有。</Text>,
        (p.trusted ?? []).map((x, i) => (
          <Box key={`tr${i}`} flexDirection="row" justifyContent="space-between" alignItems="center" paddingY="xs">
            <Text>{x}</Text>
            <Button key={`rtr${i}`} plain onPress={() => trust($, x, false)}>移出</Button>
          </Box>
        )),
        'Input' in ui && (
          <Box key="tr-add" width="100%"><ui.Input key="add-trusted" placeholder="加一个人，比如：Bob Chen" submitLabel="加上" onSubmit={(v: string) => {
            if (v.trim()) void trust($, v.trim(), true)
          }} /></Box>
        ))}

      {section('sec-custom', '我加的情况', '主会话先拿消息对这些，对上了就照它办',
        p.custom.length === 0 && <Text key="cu-none" size="footnote" dimColor>还没有。</Text>,
        p.custom.map(c => ruleRow(`custom:${c.id}`, c.when, c, () => void removeCustom($, c.id))),
        'Input' in ui && (
          <Box key="cu-add" width="100%"><ui.Input key="add-custom" placeholder="加一种情况，比如：Jira 上 QA 提的 bug 指给我" submitLabel="加上" onSubmit={(v: string) => {
            if (v.trim()) void addCustom($, v.trim())
          }} /></Box>
        ))}

      {section('sec-scenarios', '每种消息', '没对上「我加的情况」的，按消息的种类办',
        Object.entries(p.scenarios).map(([k, v]) => ruleRow(k, SCENARIO[k] ?? k, v)))}

      {section('sec-style', '回复写法', '替你写的话都照这几条写；你在待发出里改过稿子，主会话会据此提议新的写法',
        (p.style ?? []).map((x, i) => (
          <Box key={`st${i}`} flexDirection="row" gap="sm" alignItems="flex-start" paddingY="xs">
            <Box flexGrow={1} flexShrink={1}><Text wrap="wrap">{x}</Text></Box>
            <Button key={`rst${i}`} plain onPress={() => removeStyle($, x)}>删除</Button>
          </Box>
        )),
        'Input' in ui && (
          <Box key="st-add" width="100%"><ui.Input key="add-style" placeholder="加一条写法，比如：不用「您」，直接叫名字" submitLabel="加上" onSubmit={(v: string) => {
            if (v.trim()) void addStyle($, v.trim())
          }} /></Box>
        ))}

      {section('sec-placement', 'Slack 回复放哪', '对方本来在 thread 里说的，总是回到那个 thread；其余按对话的种类',
        ([['direct', '一对一私信'], ['group', '群聊'], ['channel', '频道'], ['self', '你给自己发的']] as const).map(([k, label]) => (
          <Box key={`pl-${k}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm" paddingY="xs">
            <Text>{label}</Text>
            {select(ui, `pl-${k}`, (p.placement ?? DEFAULT_PLACEMENT)[k], [{ value: 'inline', label: '直接回在对话里' }, { value: 'thread', label: '回到 thread' }], v => void setPlacement($, k, v as 'inline' | 'thread'))}
          </Box>
        )))}

      {section('sec-signature', 'Slack 回复的署名', '替你发到 Slack 的话，正文上方加一行灰色小字「署名 · confirmed by 你」（不进正文），让对方一眼知道是 agent 代回的；清空就不加',
        'Input' in ui
          ? <ui.Input key="signature" value={p.signature ?? '🤖 agent reply'} submitLabel="存" onSubmit={(v: string) => void setSignature($, v.trim())} />
          : <Text key="sig">{p.signature ?? '🤖 agent reply'}</Text>)}

      {section('sec-notes', '我的规矩', '一句话，最优先',
        p.notes.length === 0 && <Text key="nt-none" size="footnote" dimColor>还没有。</Text>,
        p.notes.map((n, i) => (
          <Box key={`nt${i}`} flexDirection="row" gap="sm" alignItems="flex-start" paddingY="xs">
            <Box flexGrow={1} flexShrink={1}><Text wrap="wrap">{n}</Text></Box>
            <Button key={`rm${i}`} plain onPress={() => removeRule($, n)}>删除</Button>
          </Box>
        )),
        'Input' in ui && (
          <Box key="nt-add" width="100%"><ui.Input key="add-rule" placeholder="加一条，比如：涉及排期的都要问我" submitLabel="加上" onSubmit={(v: string) => {
            if (v.trim()) void addRule($, v.trim())
          }} /></Box>
        ))}
    </Box>
  )
}

// ── 测评 ──

export function evalTab($: Engine, ui: Els, s: Snapshot, opened: string[]) {
  const { Box, Text, Button } = ui
  const st = statsOf(s)
  const accuracy = st.reviewed === 0 ? '还没标过' : `${Math.round(((st.reviewed - st.wrong) / st.reviewed) * 100)}%（标了 ${st.reviewed} 条，错 ${st.wrong}）`
  const sentByYou = st.replies.asIs + st.replies.edited
  const recent = [...s.decisions].reverse().slice(0, 30)

  const decisionRow = (d: DecisionRow) => {
    const key = `d${d.event}`
    const r = s.reviews[String(d.event)]
    const isOpen = opened.includes(key)
    return (
      <Box key={key} flexDirection="column" marginTop="xs" gap="xs">
        <Box flexDirection="row" alignItems="center" gap="xs">
        
        <Button key={`dt${d.event}`} plain onPress={() => toggle($, key)}>
          {isOpen ? '▾ ' : '▸ '}{VERDICT[d.verdict]} <Text dimColor>· {SCENARIO[d.scenario] ?? d.scenario} · {ago(d.at)}</Text>
          {r ? (r.ok ? ' ✓' : ' ✗') : ''}
        </Button>
        </Box>
        <Box paddingLeft="md" flexDirection="column">
          {d.what && <Text dimColor wrap="truncate-end">{d.what.from ? `${d.what.from}：` : ''}{short(d.what.text, 80)}</Text>}
          <Text wrap="wrap">{short(d.reason, isOpen ? 300 : 80)}</Text>
          {r && !r.ok && r.note && <Text color="error" size="caption" wrap="wrap">你说：{r.note}</Text>}
        </Box>
        {isOpen && !r && (
          <Box flexDirection="column" paddingLeft="md" gap="xs">
            <Box flexDirection="row" gap="sm">
              <Button key={`ok-${d.event}`} onPress={() => markRight($, d.event)}>判断对</Button>
            </Box>
            {'Input' in ui && (
              <ui.Input key={`wr-${d.event}`} placeholder="判断错了？说应该怎样（会变成规矩提议）" submitLabel="判断错了" onSubmit={(v: string) => {
                if (v.trim()) void markWrong($, d.event, v.trim())
              }} />
            )}
          </Box>
        )}
        {isOpen && (
          <Box flexDirection="row" gap="sm" alignItems="center" paddingLeft="md">
            <Text size="caption" dimColor>存成演练例子，应该：</Text>
            {select(ui, `sc-${d.event}`, r && !r.ok ? '' : kind(d.verdict), [{ value: 'dispatch', label: '派人去办' }, { value: 'note', label: '只记下' }, { value: 'ignore', label: '忽略' }, { value: 'ask', label: '问你' }], val => { if (val) void saveCase($, d.event, val) })}
          </Box>
        )}
      </Box>
    )
  }

  const v = st.value
  const hours = v.minutes >= 60 ? `${(v.minutes / 60).toFixed(1)} 小时` : `${v.minutes} 分钟`
  const EXPECT: Record<string, string> = { dispatch: '派人去办', note: '只记下', ignore: '忽略', ask: '问你' }
  const kind = (verdict: DecisionRow['verdict']) => (verdict === 'forwarded' || verdict === 'opened' ? 'dispatch' : verdict === 'asked' ? 'ask' : verdict === 'ignored' ? 'ignore' : 'note')
  const lastRun = s.evals.runs.at(-1)
  const results = lastRun ? s.evals.cases.filter(c => lastRun.events[c.id] !== undefined).map(c => {
    const d = [...s.dryDecisions].reverse().find(x => x.event === lastRun.events[c.id])
    return { c, d, ok: d ? kind(d.verdict) === c.expect : null }
  }) : []
  const judged = results.filter(r => r.ok !== null)

  return (
    <Box flexDirection="column" marginTop="sm" gap="xs">
      <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX="md" paddingY="sm" gap="xs">
        <Text weight="semibold">最近 {EVAL_DAYS} 天替你做了</Text>
        <Text size="heading" weight="semibold" color="success">省下约 {hours}</Text>
        <Text wrap="wrap">
          没打扰你就处理掉 {v.quiet} 条 · 派人去办 {v.dispatched} 件 · 替你回了 {v.replies} 条 · approve {v.approves} 个 PR · 主动发 {v.messages} 条 · 办完 {v.done} 件
        </Text>
        <Text size="caption" dimColor wrap="wrap">
          估算：只记下 / 忽略的每条按 {MINUTES.quiet} 分钟（读、判断），派活每件 {MINUTES.dispatched} 分钟（找会话、交代），回复每条 {MINUTES.reply} 分钟，approve 每个 {MINUTES.approve} 分钟。只算它替你做的，不算会话里干的活。
        </Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX="md" paddingY="sm" gap="xs" marginTop="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text weight="semibold">演练 · {s.evals.cases.length} 个例子</Text>
          {s.evals.cases.length > 0 && <Button key="run-evals" variant="primary" onPress={() => runEvals($)}>跑一遍</Button>}
        </Box>
        <Text size="caption" dimColor wrap="wrap">拿例子测主会话会怎么判断：它只说会怎么办，不真的派活、不发消息。改了规矩以后跑一遍，看有没有改坏。下面判断记录里点开一条就能「存成例子」。</Text>
        {lastRun && (
          <Text>上次（{ago(lastRun.at)}）：{judged.length < results.length ? `判断了 ${judged.length}/${results.length}，还在跑` : `${judged.filter(r => r.ok).length}/${results.length} 对`}</Text>
        )}
        {results.map(({ c, d, ok }) => (
          <Box key={`ev-${c.id}`} flexDirection="column" paddingY="xs">
            <Box flexDirection="row" gap="sm" alignItems="flex-start">
              <Text color={ok === null ? undefined : ok ? 'success' : 'error'}>{ok === null ? '…' : ok ? '✓' : '✗'}</Text>
              <Box flexGrow={1} flexShrink={1}><Text size="footnote" wrap="truncate-end">{c.from}：{c.text}</Text></Box>
              <Button key={`rmcase-${c.id}`} plain onPress={() => removeCase($, c.id)}>删</Button>
            </Box>
            <Box paddingLeft="md" flexDirection="column">
              <Text size="caption" dimColor>应该：{EXPECT[c.expect]}{d ? `　它：${EXPECT[kind(d.verdict)]}` : ''}</Text>
              {d && ok === false && <Text size="caption" color="error" wrap="wrap">它的理由：{d.reason}</Text>}
            </Box>
          </Box>
        ))}
      </Box>

      <Box marginTop="md"><Text weight="semibold">最近 {EVAL_DAYS} 天</Text></Box>
      <Text wrap="wrap">
        判断 {st.judged} 条：派人去办 {(st.byVerdict.forwarded ?? 0) + (st.byVerdict.opened ?? 0)} · 只记下 {st.byVerdict.noted ?? 0} · 忽略 {st.byVerdict.ignored ?? 0} · 直接问你 {st.byVerdict.asked ?? 0}
      </Text>
      <Text>打扰你：要你定 {st.asks} 次</Text>
      <Text>判断准确率：{accuracy}</Text>
      <Text wrap="wrap">
        回复：你确认原样发 {st.replies.asIs} · 改了再发 {st.replies.edited} · 不发 {st.replies.dropped} · 让重写 {st.replies.redo} · 按规矩自动发 {st.replies.auto}{st.replies.failed > 0 ? ` · 没发出去 ${st.replies.failed}` : ''}
      </Text>
      {sentByYou > 0 && <Text dimColor size="caption">稿子原样可用的比例：{Math.round((st.replies.asIs / sentByYou) * 100)}%（越高越可以放开「对外直接发」）</Text>}
      {'Svg' in ui && st.judged > 0 && (
        <Box flexDirection="column" marginTop="sm">
          <ui.Svg source={chartSvg(st.days)} alt={st.days.map(d => `${d.label} 判断 ${d.judged} 派活 ${d.dispatched} 问你 ${d.asks}`).join('；')} />
          <Text dimColor size="caption">灰：判断的消息 · 蓝：其中派人去办的 · 橙点：那天要你定过</Text>
        </Box>
      )}

      <Box marginTop="md"><Text weight="semibold">判断记录（点开标对错）</Text></Box>
      {recent.length === 0 && <Text dimColor>还没有判断。主会话开始工作后，每条消息怎么处理、为什么，都会记在这里。</Text>}
      {recent.map(decisionRow)}
    </Box>
  )
}


// 「重读规则」发给主会话的话：写全怎么做，主会话手上还是旧规则也看得懂。
export const RELOAD_SKILL = 'chief：重读规则。插件更新过：用 Skill 工具重新调用 chief:hub，读到最新的规则。不用重新开张，也不用重挂 Monitor（监听一直挂着）。读完只回一句「规则重读好了」，有什么和之前不一样的顺带说一句。'
