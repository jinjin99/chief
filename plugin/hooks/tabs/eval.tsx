// 它做得怎么样（规矩页最底下）和主会话用掉的额度（设置页）。每条判断的记录和标对错在进度页的「最近」（timeline.tsx）。
import type { EngineInterface as Engine } from 'claude-code'

import { expectOf } from '../../engine/src/shared/rules'
import type { HubUsage, Snapshot, Usage } from '../../types'
import { removeCase, runEvals } from '../actions'
import { L, t } from '../i18n'
import { ago, type Els } from '../ui'
import { EVAL_DAYS, chartSvg, statsOf } from '../data'
import { dayOf } from '../usage'

// 上下文超过这么多，每来一条消息都要把它整个读一遍，额度涨得快：提醒换个新主会话。
const LONG_CONTEXT = 300_000

const pts = (n: number) => (n < 0.05 ? t().eval.lessThan : n.toFixed(1))

function resetAt(iso: string | undefined, withDay: boolean): string {
  if (!iso) return ''
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return t().eval.resets(`${withDay ? t().eval.weekday[d.getDay()] : ''}${hm}`)
}

// 主会话用掉的订阅额度：份额和分到的点数引擎算（usage.json），调了几次模型插件记（hub-usage.json）。
// 今天、最近几天、账号现在的两个窗口、上下文多长。
export function usageBox(ui: Els, u: HubUsage, usage: Usage) {
  const { Box, Text } = ui
  const w = t().eval
  const days = [...new Set([...Object.keys(u.days), ...Object.keys(usage.days)])].sort((a, b) => b.localeCompare(a))
  const now = u.now
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX="md" paddingY="sm" gap="xs" marginTop="sm">
      <Text weight="semibold">{w.usageTitle}</Text>
      {days.length === 0
        ? <Text dimColor wrap="wrap">{w.usageNone}</Text>
        : (
          <Box flexDirection="column" gap="xs">
            {days.slice(0, 7).map((day, i) => {
              const d = usage.days[day]
              const label = day === dayOf(Date.now()) ? w.today : day.slice(5)
              return (
                <Text key={`ud-${day}`} wrap="wrap" dimColor={i > 0}>
                  {d && d.share !== null
                    ? w.usageDay(label, Math.round(d.share * 100), pts(d.five), pts(d.week), u.days[day]?.calls ?? 0)
                    : w.usageCalls(label, u.days[day]?.calls ?? 0)}
                </Text>
              )
            })}
          </Box>
        )}
      {now && (now.five !== null || now.week !== null) && (
        <Text size="footnote" dimColor wrap="wrap">
          {w.accountNow}{now.five !== null ? w.fiveUsed(now.five, resetAt(now.fiveReset, false)) : ''}{now.five !== null && now.week !== null ? ' · ' : ''}{now.week !== null ? w.weekUsed(now.week, resetAt(now.weekReset, true)) : ''}
        </Text>
      )}
      {now && now.context !== null && (
        <Text size="footnote" color={now.context > LONG_CONTEXT ? 'warning' : undefined} dimColor={now.context <= LONG_CONTEXT} wrap="wrap">
          {w.context(now.context)}
          {now.context > LONG_CONTEXT ? w.contextLong : ''}
        </Text>
      )}
      <Text size="caption" dimColor wrap="wrap">{usage.fitted ? w.usageHowFitted : w.usageHow}</Text>
    </Box>
  )
}

// 规矩页最底下「它做得怎么样」：最近 7 天的判断和回复、准确率、柱状图、演练、估算省下的时间（一行）。
export function howItDoes($: Engine, ui: Els, s: Snapshot) {
  const { Box, Text, Button } = ui
  const w = t().eval
  const st = statsOf(s)
  const accuracy = st.reviewed === 0 ? w.notReviewed : w.accuracy(Math.round(((st.reviewed - st.wrong) / st.reviewed) * 100), st.reviewed, st.wrong)
  const sentByYou = st.replies.asIs + st.replies.edited
  const v = st.value
  const hours = v.minutes >= 60 ? w.hours((v.minutes / 60).toFixed(1)) : w.minutes(v.minutes)
  const EXPECT: Record<string, string> = L().expect
  const kind = expectOf
  const lastRun = s.evals.runs.at(-1)
  const results = lastRun ? s.evals.cases.filter(c => lastRun.events[c.id] !== undefined).map(c => {
    const d = [...s.dryDecisions].reverse().find(x => x.event === lastRun.events[c.id])
    return { c, d, ok: d ? kind(d.verdict) === c.expect : null }
  }) : []
  const judged = results.filter(r => r.ok !== null)

  return (
    <Box flexDirection="column" gap="xs">
      <Text size="footnote" wrap="wrap">{w.accuracyLine(accuracy)}</Text>
      <Text size="footnote" wrap="wrap">{w.judged(st.judged, (st.byVerdict.forwarded ?? 0) + (st.byVerdict.opened ?? 0), st.byVerdict.noted ?? 0, st.byVerdict.ignored ?? 0, st.byVerdict.asked ?? 0)}</Text>
      <Text size="footnote" wrap="wrap">{w.interrupts(st.asks)}</Text>
      <Text size="footnote" wrap="wrap">{w.replies(st.replies)}</Text>
      {sentByYou > 0 && <Text dimColor size="caption">{w.asIsRate(Math.round((st.replies.asIs / sentByYou) * 100))}</Text>}
      {'Svg' in ui && st.judged > 0 && (
        <Box flexDirection="column" marginTop="sm">
          <ui.Svg source={chartSvg(st.days)} alt={st.days.map(d => w.chartAlt(d.label, d.judged, d.dispatched, d.asks)).join(w.chartSep)} />
          <Text dimColor size="caption">{w.legend}</Text>
        </Box>
      )}
      <Text size="caption" dimColor wrap="wrap">{w.savedLine(EVAL_DAYS, hours)}</Text>

      <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop="sm">
        <Text weight="semibold" size="footnote">{w.drill(s.evals.cases.length)}</Text>
        {s.evals.cases.length > 0 && <Button key="run-evals" onPress={() => runEvals($)}>{w.runDrill}</Button>}
      </Box>
      <Text size="caption" dimColor wrap="wrap">{w.drillHelp}</Text>
      {lastRun && (
        <Text size="footnote">{w.lastRun(ago(lastRun.at), judged.length < results.length ? w.running(judged.length, results.length) : w.score(judged.filter(r => r.ok).length, results.length))}</Text>
      )}
      {results.map(({ c, d, ok }) => (
        <Box key={`ev-${c.id}`} flexDirection="column" paddingY="xs">
          <Box flexDirection="row" gap="sm" alignItems="flex-start">
            <Text color={ok === null ? undefined : ok ? 'success' : 'error'}>{ok === null ? '…' : ok ? '✓' : '✗'}</Text>
            <Box flexGrow={1} flexShrink={1}><Text size="footnote" wrap="truncate-end">{c.from}{t().colon}{c.text}</Text></Box>
            <Button key={`rmcase-${c.id}`} plain onPress={() => removeCase($, c.id)}>{w.removeCase}</Button>
          </Box>
          <Box paddingLeft="md" flexDirection="column">
            <Text size="caption" dimColor>{w.should(EXPECT[c.expect] ?? c.expect)}{d ? w.it(EXPECT[kind(d.verdict)] ?? '') : ''}</Text>
            {d && ok === false && <Text size="caption" color="error" wrap="wrap">{w.itsReason(d.reason)}</Text>}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
