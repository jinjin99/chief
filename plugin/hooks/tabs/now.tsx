// 「要你」页：所有要你动手的事都在这一页（算法在 inbox.ts）。
//   最上面是 chief 自己的事（钥匙被动过、引擎 / 主会话 / 来源出了问题、插件更新了要重读规则、它提议的规矩），每条带一个能直接解决的按钮。
//   下面一件事一张卡，这件事等你的都在卡里：会话停在对话框上等你点、要你定的问题、等你确认的回复；最急的在前。
//   空的时候说一句没事，最底下一行是今天替你办了多少。
import type { EngineInterface as Engine } from 'claude-code'

import type { AskRow, DecisionRow, Snapshot } from '../../types'
import { ackKeyAlerts, answerAll, answerAsk, decideProposal, dismissAsk, engineDo, openSession, reopenAsk, setTab, skipOld, tell, toggle } from '../actions'
import { markReread } from '../data'
import { inboxOf, type Card, type SysItem } from '../inbox'
import { sourceName, t } from '../i18n'
import { RELOAD_SKILL, ago, dueLabel, listify, prFlags, replyGist, short, splitAsk, startOfToday, whatOf, type Els } from '../ui'
import { replyCard, sendingRow } from './outbox'

export function nowTab($: Engine, ui: Els, s: Snapshot, opened: string[] = [], edit: Record<string, string> = {}) {
  const { Box, Text, Button } = ui
  const w = t().now
  const box = inboxOf(s)
  const dayStart = startOfToday()
  const today = s.decisions.filter(d => Date.parse(d.at) >= dayStart)
  const count = (...v: DecisionRow['verdict'][]) => today.filter(d => v.includes(d.verdict)).length
  const sentToday = s.replies.filter(r => r.status === 'sent' && r.sentAt !== undefined && Date.parse(r.sentAt) >= dayStart).length

  // ── chief 自己的事：一条一行，说清怎么了，带一个能直接解决的按钮 ──
  const sysRow = (x: SysItem, i: number) => {
    const row = (color: 'error' | 'warning' | undefined, text: string, help: string | null, ...buttons: unknown[]) => (
      <Box key={`sys${i}`} flexDirection="column" gap="xs" marginTop={i > 0 ? 'sm' : undefined}>
        <Text weight="semibold" color={color} wrap="wrap">{text}</Text>
        {help && <Text size="footnote" dimColor wrap="wrap">{help}</Text>}
        {buttons.some(Boolean) && <Box flexDirection="row" gap="sm" flexWrap="wrap">{buttons as never}</Box>}
      </Box>
    )
    const hd = t().header
    switch (x.kind) {
      case 'key':
        return row('error', `${hd.keyTitle}：${x.what === 'reset' ? hd.keyReset : hd.keySet}（${ago(x.at)}）`, hd.keyHelp, <Button key="ack-key" onPress={() => ackKeyAlerts($, x.at)}>{hd.keyAck}</Button>)
      case 'corrupt':
        return row('error', hd.corruptWhy(x.why || t().noReason), null, <Button key="sys-corrupt" onPress={() => setTab($, 'setup')}>{w.toSetup}</Button>)
      case 'engine':
        return row('error', w.engineDown, null, <Button key="sys-engine" variant="primary" onPress={() => engineDo($, 'start')}>{w.startEngine}</Button>)
      case 'hub':
        return row('warning', w.hubDown(ago(x.lastAt), x.unhandled), hd.hubDownHelp, x.unhandled > 20 ? <Button key="skip-old" onPress={() => skipOld($, s.maxEvent)}>{hd.skipOld(x.unhandled)}</Button> : null)
      case 'source':
        return row('error', w.sourceDown(sourceName(x.id), short(x.why || t().noReason, 80)), null, <Button key={`sys-src-${x.id}`} onPress={() => setTab($, 'setup')}>{w.toSetup}</Button>)
      case 'reread':
        return row(undefined, w.reread, null, <Button key="sys-reread" variant="primary" onPress={() => { void tell($, RELOAD_SKILL, w.rereadButton); void markReread($) }}>{w.rereadButton}</Button>)
      case 'proposal':
        return row(undefined, w.proposal(x.text), x.basis ? t().policy.basis(x.basis) : null,
          <Button key={`pa${x.id}`} variant="primary" onPress={() => decideProposal($, x.id, true)}>{t().policy.accept}</Button>,
          <Button key={`pr${x.id}`} onPress={() => decideProposal($, x.id, false)}>{t().policy.reject}</Button>)
    }
  }

  // ── 一个问题一张卡：问什么（加粗）→ 背景（灰字，全文）→ 建议 → 照办 / 不同意… / 不用问了 ──
  const askCard = (q: AskRow, fresh: boolean) => {
    const linked = q.reply === undefined ? undefined : s.replies.find(r => r.id === q.reply)
    const { context, ask } = splitAsk(q.question)
    const typing = opened.includes(`dis${q.id}`)
    return (
      <Box key={`q${q.id}`} flexDirection="column" gap="xs" borderStyle="round" borderColor="inactive" borderDimColor paddingX="md" paddingY="sm">
        <Text weight="semibold" wrap="wrap">{fresh && <Text size="caption" color="warning">{w.fresh}{t().gap}</Text>}{listify(ask).replace(/\n\n/g, '\n')}</Text>
        {context !== '' && <Text size="footnote" dimColor wrap="wrap">{context}</Text>}
        {q.suggest !== '' && <Text size="footnote" wrap="wrap"><Text dimColor>{w.suggest}{t().gap}</Text>{listify(q.suggest).replace(/\n\n/g, '\n')}</Text>}
        {linked && <Text size="footnote" dimColor wrap="wrap">{w.linked(replyGist(linked))}</Text>}
        {/* 问的这件事提到的 PR 已经合了、关了、有冲突：问题可能不成立了（主会话收到 ref.changed 会去撤）。 */}
        {prFlags(s, `a${q.id}`).map((f, i) => <Text key={`pf${q.id}-${i}`} size="footnote" color="warning" wrap="wrap">{f}</Text>)}
        <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
          {q.suggest !== '' && (
            <Button key={`ok${q.id}`} variant="primary" onPress={() => answerAsk($, q.id, '照建议办', w.ok, `chief：问题 #${q.id} 照建议办`)}>{w.ok}</Button>
          )}
          <Button key={`no${q.id}`} plain onPress={() => toggle($, `dis${q.id}`)}>{w.disagreeShort}</Button>
          <Button key={`dm${q.id}`} plain onPress={() => dismissAsk($, q.id, w.dismiss)}>{w.dismiss}</Button>
        </Box>
        {/* 三行高、占满一行：写得长也看得全。回车发送，换行和输入框一样。 */}
        {typing && 'Input' in ui && (
          <Box width="100%">
            <ui.Input key={`in${q.id}`} autoFocus rows={3} placeholder={w.disagree} submitLabel={w.send} onSubmit={(v: string) => {
              if (v.trim()) void answerAsk($, q.id, v.trim(), w.yourCall, `chief：问题 #${q.id} 的回答：${v.trim()}`)
            }} />
          </Box>
        )}
      </Box>
    )
  }

  // 定过的、撤掉的：缩成一行。你刚定的两分钟内能撤回。
  const closedRow = (q: AskRow) => (
    <Box key={`c${q.id}`} flexDirection="row" gap="sm" alignItems="center" marginTop="xs">
      {/* 不用 truncate：在横排里截断的一行会冲出卡片，按字数截短再换行。 */}
      <Box flexShrink={1}>
        <Text size="footnote" dimColor wrap="wrap">
          {q.status === 'withdrawn' ? `${short(splitAsk(q.question).ask, 24)} · ${w.withdrawn(short(q.reason ?? '', 40))}` : `✓ ${short(splitAsk(q.question).ask, 24)} · ${q.status === 'dismissed' ? w.dismissed : w.decided(short(q.answer ?? '', 30))}`}
        </Text>
      </Box>
      {q.status !== 'withdrawn' && <Button key={`re${q.id}`} plain onPress={() => reopenAsk($, q.id, w.reopen)}>{w.reopen}</Button>}
    </Box>
  )

  // ── 一件事一张卡：标题、截止、去会话；会话在等你点的最前，然后问题、回复 ──
  // ── 一件事一组，外框 inactive、里面每项淡 inactive（深一档才分得出两层）：小标题（事情、截止、等你的有几样、去会话），下面会话等你点、每个问题、每条回复各一个浅框。
  // 不用底色（主题的 subtle 底在 App 里是深灰），也不用 Svg 细线（App 里看不出来）。过期、今天截止、会话在等你点的组，框是红的。
  const group = (c: Card) => {
    const th = c.thing
    const title = th ? th.title : c.replies[0] ? whatOf(c.replies[0]) : c.sending[0] ? whatOf(c.sending[0]) : w.ask
    const due = th?.due === undefined ? undefined : dueLabel(th.due)
    const ready = c.asks.filter(q => q.suggest !== '')
    const counts = [c.waiting ? w.nWaiting : '', c.asks.length > 0 ? w.nAsks(c.asks.length) : '', c.replies.length > 0 ? w.nReplies(c.replies.length) : ''].filter(Boolean).join(' · ')
    const id = th ? `card${th.id}` : `card-${c.key}`
    return (
      <Box key={id} flexDirection="column" gap="sm" marginTop="md" borderStyle="round" borderColor={c.rank <= 1 ? 'error' : 'inactive'} paddingX="md" paddingY="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap="sm">
          <Box flexDirection="column" flexShrink={1}>
            <Text weight="semibold" wrap="wrap">{title}</Text>
            <Text size="caption" wrap="wrap">
              {due && <Text color={due.color} dimColor={due.color === undefined}>{due.text}</Text>}
              {due && counts ? ' · ' : ''}
              {counts && <Text color="warning">{counts}</Text>}
            </Text>
          </Box>
          {c.session && <Button key={`oa-${c.key}`} plain onPress={() => openSession($, c.session ?? '', title)}>{w.goSession}</Button>}
        </Box>
        {c.waiting && (
          <Box key={`wait-${c.key}`} flexDirection="column" gap="xs" borderStyle="round" borderColor="error" borderDimColor paddingX="md" paddingY="sm">
            <Text size="caption" weight="semibold" color="error">{w.waiting}</Text>
            <Text wrap="wrap">{c.waiting}</Text>
            <Box flexDirection="row"><Button key={`go-${c.key}`} variant="primary" onPress={() => openSession($, c.session ?? '', title)}>{w.goPoint}</Button></Box>
          </Box>
        )}
        {c.asks.map(q => askCard(q, c.asks.length > 1 && Date.parse(q.at) - Math.min(...c.asks.map(a => Date.parse(a.at))) > 60_000))}
        {c.replies.map(r => (
          <Box key={`rc${r.id}`} flexDirection="column" borderStyle="round" borderColor={r.status === 'failed' ? 'error' : 'inactive'} borderDimColor paddingX="md" paddingY="sm">
            {replyCard($, ui, s, edit, opened, r)}
          </Box>
        ))}
        {c.sending.map(r => sendingRow($, ui, r))}
        {c.closed.map(closedRow)}
        {ready.length > 1 && (
          <Box flexDirection="row">
            <Button key={`all-${c.key}`} onPress={() => answerAll($, ready.map(q => q.id), w.allOk)}>{w.allN(ready.length)}</Button>
          </Box>
        )}
      </Box>
    )
  }

  const empty = box.system.length === 0 && box.cards.length === 0
  return (
    <Box flexDirection="column" marginTop="sm">
      {box.system.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={box.system.some(x => x.kind === 'key' || x.kind === 'corrupt' || x.kind === 'engine' || x.kind === 'source') ? 'error' : 'suggestion'} paddingX="md" paddingY="sm" gap="xs">
          {box.system.map(sysRow)}
        </Box>
      )}
      {empty && <Box marginTop="sm"><Text color="success">{w.clear}</Text></Box>}
      {box.cards.map(group)}
      {box.withdrawn.length > 0 && (
        <Box flexDirection="column" marginTop="sm">
          <Text size="caption" dimColor>{w.withdrawnToday}</Text>
          {box.withdrawn.map(q => <Text key={`wd${q.id}`} size="footnote" dimColor wrap="truncate-end">{s.things.find(x => x.id === q.thing)?.title ?? w.ask} · {short(splitAsk(q.question).ask, 30)} · {w.withdrawn(q.reason ?? '')}</Text>)}
        </Box>
      )}
      <Box marginTop="md">
        <Text size="caption" dimColor wrap="wrap">{w.today(today.length, count('forwarded', 'opened'), count('noted', 'asked'), count('ignored'), sentToday)}</Text>
      </Box>
    </Box>
  )
}
