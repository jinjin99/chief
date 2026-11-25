// 面板几个页签共用的小东西：元素表的类型、名字表、时间和截止日的说法、批注按钮，App 才有的元素（Markdown、下拉）在终端里的退路。
// 元素来自当前界面（App / 终端）的元素表；App 才有的（输入框、下拉、Markdown、图）没有时退回纯文字。
import type { EngineInterface as Engine } from 'claude-code'

import type { DecisionRow, ReplyRow, Snapshot, ThingRow } from '../types'
import { annotate, toggle } from './actions'
import { L, t } from './i18n'

export type Els = ReturnType<Engine['ui']['resolve']>

// 判断的名字、场景的名字：和 chief 命令行同一份（engine/src/shared/），按当前语言。
export function verdictName(v: DecisionRow['verdict']): string {
  return L().verdict[v]
}

export function scenarioName(k: string): string {
  return (L().scenario as Record<string, string>)[k] ?? k
}

export function short(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

export function ago(iso: string | null | undefined): string {
  const w = t().time
  if (!iso) return w.never
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return w.justNow
  if (s < 3600) return w.minutes(Math.round(s / 60))
  if (s < 86400) return w.hours(Math.round(s / 3600))
  return w.days(Math.round(s / 86400))
}

export function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 离截止还有几天（今天截止是 0，过期是负数）。
export function daysLeft(due: string): number {
  const [y, m, d] = due.split('-').map(Number)
  return Math.round((new Date(y!, m! - 1, d!).getTime() - startOfToday()) / 86_400_000)
}

export function dueLabel(due: string): { text: string; color: 'error' | 'warning' | undefined } {
  const n = daysLeft(due)
  const w = t().time
  if (n < 0) return { text: w.overdue(-n, due), color: 'error' }
  if (n === 0) return { text: w.dueToday, color: 'error' }
  if (n <= 2) return { text: w.dueIn(n, due), color: 'warning' }
  return { text: w.dueOn(due), color: undefined }
}

export const live = (t: ThingRow) => t.status !== 'done' && t.status !== 'dropped'

// 稍后再说、还没到点的：不在进行中的列表里，它的问题也先收起。到点了引擎还没来得及叫醒的（比如引擎停着）照常显示。
export const snoozed = (t: ThingRow) => live(t) && t.snooze !== undefined && Date.parse(t.snooze.until) > Date.now()

// 现在要跟的：没办完、也没在稍后再说。
export const awake = (t: ThingRow) => live(t) && !snoozed(t)

// 什么时候叫醒：今天 15:00、明天 09:00、11/30 09:00。
export function wakeLabel(iso: string): string {
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - startOfToday()) / 86_400_000)
  return days === 0 ? t().time.today(hm) : days === 1 ? t().time.tomorrow(hm) : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// 一条回复一句话说清：回谁、发给谁、approve 哪个 PR。
export function whatOf(r: ReplyRow): string {
  const w = t().reply
  return r.kind === 'approve' ? w.approve(r.target.ref ?? '') : r.kind === 'message' ? w.message(r.context.who ?? r.target.to ?? '') : w.reply(r.context.who ?? r.context.where)
}

// 卡片上这一条（问题 a<号>、回复 r<号>，见 refs.json 的 links）提到的 PR 里不正常的：已合并、已关闭、有冲突，一个一句。好好开着的不说。
export function prFlags(s: Pick<Snapshot, 'refs'>, key: string, skip?: string): string[] {
  const w = t().refs
  return (s.refs?.links?.[key] ?? []).flatMap(pr => {
    const p = s.refs.prs?.[pr]
    if (!p || pr === skip) return []
    if (p.state === 'merged') return [w.merged(pr, ago(p.mergedAt))]
    if (p.state === 'closed') return [w.closed(pr, ago(p.closedAt))]
    return p.conflict ? [w.conflict(pr)] : []
  })
}

// 问题挂着的那条回复：回谁、说什么、现在发没发（不显示 chief 的回复号，用户看不懂）。
export function replyGist(r: ReplyRow): string {
  const w = t()
  const state = w.reply.state[r.status]
  return `${whatOf(r)}${r.kind === 'approve' ? '' : w.quote(short(r.body, 40))}${state ? w.paren(state) : ''}`
}

// 一段话的要点：去掉表格和 Markdown 符号，取第一句。
export function gist(text: string, max = 70): string {
  const plain = text
    .split('\n').filter(l => !/^\s*\|/.test(l)).join(' ')
    .replace(/\|[^|]*\|/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  const first = plain.split(/(?<=[。！？!?；;])\s*|\s+-\s+/)[0] ?? plain
  return short(first, max)
}

// 批注：一个 💬 按钮，点开一个整行的输入框，写完记进待发的批注里（不马上发）。
export function annotateButton($: Engine, ui: Els, key: string, opened: string[]) {
  const { Button } = ui
  return <Button key={`an-${key}`} onPress={() => toggle($, `an-${key}`)}>{opened.includes(`an-${key}`) ? t().annotate.close : t().annotate.open}</Button>
}

export function annotateBox($: Engine, ui: Els, key: string, label: string, opened: string[]) {
  const { Box } = ui
  if (!opened.includes(`an-${key}`) || !('Input' in ui)) return null
  return (
    <Box width="100%">
      <ui.Input key={`ai-${key}`} autoFocus rows={2} placeholder={t().annotate.placeholder} submitLabel={t().annotate.submit}
        onSubmit={(v: string) => { if (v.trim()) { void annotate($, key, label, v.trim()); void toggle($, `an-${key}`) } }} />
    </Box>
  )
}

// 主会话常把几个问题挤在一段里（「两件事要你定：1 …？2 …？」）：按 1、2、3… 的顺序认出编号，拆成编号列表，一条一行。
// 编号前面得是开头、空格或标点，后面不能紧跟数字（25/26 号、第 9 层不算）；凑不齐 1 和 2 就原样返回。
export function listify(text: string): string {
  if (/\n\s*(\d+[.)、]|[-*] )/.test(text)) return text
  const marks: { start: number; end: number }[] = []
  for (const m of text.matchAll(/(^|[\s：:；;？?。，,])([1-9])(?!\d)[.、．)）]?\s*/g)) {
    if (Number(m[2]) !== marks.length + 1) continue
    marks.push({ start: m.index + m[1].length, end: m.index + m[0].length })
  }
  if (marks.length < 2) return text
  const head = text.slice(0, marks[0].start).trim()
  const items = marks.map((k, i) => text.slice(k.end, marks[i + 1]?.start ?? text.length).trim().replace(/[；;，,]$/, ''))
  return `${head === '' ? '' : `${head}\n\n`}${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
}

// 问题常是「背景……。要你定的事？」：从第一个问号往前找最后一个句号，前面是背景（淡一点），后面才是要你定的。
// 英文的问题（「Context. Should we ship?」）没有中文句号：找最后一个后面跟空格的 . 或 !。
export function splitAsk(question: string): { context: string; ask: string } {
  const q = question.search(/[？?]/)
  const zhCut = q < 0 ? -1 : question.lastIndexOf('。', q)
  const enCut = q < 0 || zhCut >= 0 ? -1 : Math.max(-1, ...[...question.slice(0, q).matchAll(/[.!](?=\s)/g)].map(m => m.index))
  const cut = zhCut >= 0 ? zhCut : enCut
  return cut < 0 ? { context: '', ask: question.trim() } : { context: question.slice(0, cut + 1).trim(), ask: question.slice(cut + 1).trim() }
}

export function md(ui: Els, text: string, dim = false) {
  const { Text } = ui
  return 'Markdown' in ui ? <ui.Markdown text={text} dimColor={dim} /> : <Text dimColor={dim} wrap="wrap">{text}</Text>
}

export function select(ui: Els, key: string, value: string, options: { value: string; label: string }[], onSelect: (v: string) => void) {
  const { Text } = ui
  return 'Select' in ui
    ? <ui.Select key={key} options={options} value={value} onSelect={(v: string) => onSelect(v)} />
    : <Text>{options.find(o => o.value === value)?.label ?? value}</Text>
}

// 「重读规则」发给主会话的话：写全怎么做，主会话手上还是旧规则也看得懂。
export const RELOAD_SKILL = 'chief：重读规则。插件更新过：用 Skill 工具重新调用 chief:hub，读到最新的规则。不用重新开张，也不用重挂 Monitor（监听一直挂着）。读完只回一句「规则重读好了」，有什么和之前不一样的顺带说一句。'
