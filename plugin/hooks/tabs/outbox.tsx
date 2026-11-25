// 等你确认的回复（画在「要你」页的事情卡里）：改了再发、不发、让它重写；发送后 5 秒内能撤回。发出去的进进度页的「最近」。
import type { EngineInterface as Engine } from 'claude-code'

import { DEFAULT_PLACEMENT, DEFAULT_SIGNATURE, placementOf } from '../../engine/src/shared/rules'
import type { ReplyRow, Snapshot } from '../../types'
import { act, openImage, redo, send, setEdit, toggle } from '../actions'
import { sourceName, t } from '../i18n'
import { ago, md, prFlags, short, whatOf, type Els } from '../ui'

export function replyCard($: Engine, ui: Els, s: Snapshot, edit: Record<string, string>, opened: string[], r: ReplyRow) {
  const { Box, Text, Button } = ui
  const w = t().outbox
  const th = s.things.find(x => x.id === r.thing)
  const approve = r.kind === 'approve'
  const who = r.context.who ?? r.target.to ?? w.them
  const editKey = `edit-${r.id}`
  const redoKey = `redo-${r.id}`
  const moreKey = `more-r${r.id}`
  const editing = opened.includes(editKey)
  const redoing = opened.includes(redoKey)
  const more = opened.includes(moreKey)
  const body = edit[String(r.id)] ?? r.body
  const sign = s.policy?.signature ?? DEFAULT_SIGNATURE
  // 稿子写了多久：放久了（staleDraftHours）变黄，对方、PR 可能都变了。
  const old = Date.now() - Date.parse(r.at) >= s.staleDraftHours * 3600_000
  // 要去的 PR 不正常了：发之前查到合了、关了退回来的先说，其余按引擎最近一次查的。
  const flags = [
    ...(r.prState ? [t().refs.bounced(r.prState.ref, r.prState.state === 'merged')] : []),
    ...prFlags(s, `r${r.id}`, r.prState?.ref),
  ]
  // 一行说清：哪来的、发到哪（属于哪件事看卡片标题）。
  const meta = [
    `${sourceName(r.source)} · ${short(r.context.where, 30)}`,
    r.source === 'slack' && !approve ? (r.kind === 'message' ? (r.target.thread_ts ? '' : w.newMessage) : placementOf(r.target, s.policy?.placement ?? DEFAULT_PLACEMENT) === 'thread' ? w.toThread : w.inline) : '',
  ].filter(Boolean).join(' · ')
  return (
    <Box key={`r${r.id}`} flexDirection="column" gap="xs" marginTop="xs">
      <Text wrap="wrap"><Text color={r.status === 'failed' ? 'error' : undefined}>✉ </Text><Text weight="semibold">{approve ? t().reply.approve(r.target.ref ?? '') : r.kind === 'message' ? t().reply.message(who) : t().reply.reply(who)}</Text><Text size="caption" dimColor>{t().gap}{meta}</Text><Text size="caption" color={old ? 'warning' : undefined} dimColor={!old}>{' · '}{t().refs.written(ago(r.at))}</Text></Text>
      {r.context.said !== '' && <Text size="footnote" dimColor wrap="truncate-end">{short(r.context.who ?? w.them, 16)}{t().colon}{short(r.context.said, 160)}</Text>}
      {r.status === 'failed' && <Text size="footnote" color="error" wrap="wrap">{w.notSent(r.error ?? t().noReason)}</Text>}
      {flags.map((f, i) => <Text key={`pf${r.id}-${i}`} size="footnote" color="warning" wrap="wrap">{f}</Text>)}

      {!approve && (editing && 'Input' in ui
        ? (
          <Box width="100%">
            <ui.Input key={`body${r.id}`} rows={8} autoFocus value={body} submitLabel={w.doneEditing}
              onInput={(v: string) => void setEdit($, r.id, v)}
              onSubmit={(v: string) => { void setEdit($, r.id, v); void toggle($, editKey) }} />
          </Box>
        )
        : (
          // 按发出去的样子显示：正文上方的署名小字、分行、列表都和 Slack 上一样。
          <Box flexDirection="column" borderStyle="round" borderColor="inactive" borderDimColor paddingX="md" paddingY="xs">
            {sign !== '' && r.source === 'slack' && <Text size="caption" dimColor>{w.confirmedBy(sign)}</Text>}
            {md(ui, body.replace(/<@([UW][A-Z0-9]+)>/g, (_, id: string) => `**@${s.people?.[id] ?? id}**`))}
          </Box>
        ))}
      {/* 主会话说你在会话里同意了，插件没核对上你亲口说过：不会自己发，等你点。 */}
      {r.confirmAsk && <Text size="footnote" color="warning" wrap="wrap">{w.confirmAsk}</Text>}
      {/* 附的图：发之前让你看到会跟着发出去哪几张。 */}
      {(r.images ?? []).length > 0 && (
        <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
          <Text size="footnote" dimColor>{w.images(r.images!.length)}</Text>
          {r.images!.map((i, n) => (
            <Button key={`im${r.id}-${n}`} plain onPress={() => openImage($, i.file)}>{w.image(i.name, Math.max(1, Math.round(i.bytes / 1024)))}</Button>
          ))}
        </Box>
      )}

      <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
        <Button key={`sd${r.id}`} variant="primary" onPress={() => send($, r)}>{r.status === 'failed' ? w.resend : approve ? w.approve : w.send}</Button>
        {!approve && <Button key={`ed${r.id}`} onPress={() => toggle($, editKey)}>{editing ? w.doneEditing : w.edit}</Button>}
        {approve && <Button key={`dp${r.id}`} onPress={() => act($, w.noApprove, ['reply', 'drop', String(r.id)])}>{w.noApprove}</Button>}
        {!approve && <Button key={`mr${r.id}`} plain onPress={() => toggle($, moreKey)}>{more ? t().less : t().more}</Button>}
        {!approve && more && <Button key={`rw${r.id}`} onPress={() => toggle($, redoKey)}>{w.redo}</Button>}
        {!approve && more && <Button key={`dp${r.id}`} onPress={() => act($, w.drop, ['reply', 'drop', String(r.id)])}>{w.drop}</Button>}
      </Box>

      {redoing && 'Input' in ui && (
        <Box width="100%">
          <ui.Input key={`rd${r.id}`} autoFocus rows={2} placeholder={w.redoPlaceholder} submitLabel={w.redo}
            onSubmit={(v: string) => { if (v.trim()) { void redo($, r, v.trim()); void toggle($, redoKey) } }} />
        </Box>
      )}
    </Box>
  )
}

// 正在发的（5 秒内）：一行，能撤回。
export function sendingRow($: Engine, ui: Els, r: ReplyRow) {
  const { Box, Text, Button } = ui
  const w = t().outbox
  return (
    <Box key={`q${r.id}`} flexDirection="row" gap="sm" alignItems="center" marginTop="xs">
      <Box flexShrink={1}><Text size="footnote" color="suggestion" wrap="truncate-end">{r.status === 'sending' ? w.sending : w.queued}{t().colon}{whatOf(r)}{r.kind === 'approve' ? '' : t().quote(short(r.body, 30))}</Text></Box>
      {r.status === 'queued' && <Button key={`ud${r.id}`} onPress={() => act($, w.undo, ['reply', 'undo', String(r.id)])}>{w.undo}</Button>}
    </Box>
  )
}

// 发出去的这条是谁让发的：你在面板上点的、你在会话里说的（带你的原话）、还是规矩允许直接发的。
export function whoSent(r: ReplyRow): string {
  const w = t().outbox
  if (r.by === 'policy') return w.byPolicy
  if (r.confirm?.how === 'chat') return w.saidInChat(short(r.confirm.said ?? '', 20))
  return r.original !== undefined ? w.editedByYou : w.pressedSend
}
