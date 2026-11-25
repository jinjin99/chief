// 设置页：主会话、后台引擎、来源、这台电脑、试一下（原来的「控制」页也在这）。第一次装时从上往下点。
// 引擎还没装时 ~/chief/data/bin/chief 不存在，面板只画这一页；装好以后它是最后一个页签「设置」。
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, RenderChildren } from 'claude-code'

import { HHMM, parseQuietRange } from '../engine/src/shared/schedule'
import type { Locale } from '../engine/src/shared/i18n'
import { SOURCE_IDS, SOURCE_META, type SetupMeta, type SourceId } from '../engine/src/shared/sources'
import type { Doctor, Setup, Snapshot } from '../types'
import { act, engineDo, hubStop, setLanguage, showLogs, skipOld, tell, testMessage, toggle } from './actions'
import { ensureKey } from './confirm'
import { chiefDir, markReread, refresh } from './data'
import { usageBox } from './tabs/eval'
import { locale, sourceName, t } from './i18n'
import { RELOAD_SKILL, ago, select, type Els } from './ui'

const setup = atom({ plugin: 'chief', key: 'setup' } as const, { installed: false, doctor: null, busy: '', said: '', cwd: '', key: 'none' } as Setup)

const INSTALL_MS = 10 * 60_000
const LOGIN_MS = 6 * 60_000

async function installed($: Engine): Promise<boolean> {
  try {
    await $.fs.read(`${await chiefDir($)}/bin/chief`)
    return true
  } catch {
    return false
  }
}

// 插件自己的版本：和引擎目录里的 VERSION 对不上就提示更新。
async function pluginVersion($: Engine): Promise<string | null> {
  try {
    return (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

let wanted: string | null = null

export async function checkSetup($: Engine) {
  wanted ??= await pluginVersion($)
  const has = await installed($)
  let doctor: Doctor | null = null
  if (has) {
    const out = await $.process.run([`${await chiefDir($)}/bin/chief`, 'doctor'], { timeoutMs: 60_000 }).catch(() => null)
    try {
      doctor = out && out.exitCode === 0 ? (JSON.parse(out.stdout) as Doctor) : null
    } catch {
      doctor = null
    }
  }
  const cwd = await $.session.cwd().catch(() => '')
  const key = has ? await ensureKey($).catch((): Setup['key'] => 'mismatch') : 'none'
  await update($, setup, s => ({ ...s, installed: has, doctor, cwd, key }))
}

export async function readSetup($: Engine) {
  return read($, setup)
}

// 还差几步（必需的：引擎、Slack、消息中心）。引擎比插件新也算装好了（见 engineBehind）。
export function missing(s: Setup): number {
  const d = s.doctor
  if (!s.installed || d === null) return 3
  return [d.engine === 'running' && !engineBehind(d.version, wanted), d.sources.slack?.enabled === true && d.sources.slack.ready === true, d.hub.listening].filter(ok => !ok).length
}

async function step($: Engine, busy: Setup['busy'], run: () => Promise<{ exitCode: number; stdout: string; stderr: string } | null>) {
  await update($, setup, s => ({ ...s, busy, said: '' }))
  let said: string
  try {
    const out = await run()
    said = out === null ? '' : out.exitCode === 0 ? '' : (out.stderr.trim() || out.stdout.trim().split('\n').slice(-3).join('\n') || t().noReason).slice(0, 400)
  } catch (error) {
    said = error instanceof Error ? error.message : String(error)
  }
  await update($, setup, (s): Setup => ({ ...s, busy: '', said }))
  await checkSetup($)
  await refresh($).catch(() => {})
}

// 比两个版本号（x.y.z，后面的 -beta 之类不管）：a 比 b 新是正数。认不出来的返回 null。
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number) ?? null
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

// 引擎要不要换成这个插件的版本：只在插件比引擎新（或版本号认不出来，比如上次没装完、VERSION 是空的）时换。
// 引擎比插件新（别的会话已经用新插件更新过引擎）不往回装，算装好了。自动更新和设置页都按这一条。
export function engineBehind(have: string | null, want: string | null): boolean {
  if (want === null || have === want) return false
  if (have === null) return true
  const cmp = compareVersions(want, have)
  return cmp === null || cmp > 0
}

// 插件更新了、引擎还是旧的：插件每次加载都看一眼，插件比引擎新就在后台跑一遍 setup.sh（复制新引擎、装依赖、重启），
// 不用谁去点「更新引擎」。版本一样什么都不做；还没装过的交给设置页。几个会话同时加载只有一个真跑（setup.sh 拿锁）。
// 插件比引擎旧（别的会话已经用新插件更新过引擎）：不往回装，只提示一句。不然新旧两个会话会来回把引擎装成自己的版本。
export async function autoUpdate($: Engine) {
  wanted ??= await pluginVersion($)
  if (!wanted) return
  let have: string
  try {
    have = (await $.fs.read(`${await chiefDir($)}/app/VERSION`)).trim()
  } catch {
    return
  }
  if (have === wanted) return
  if (!engineBehind(have, wanted)) {
    void $.ui.toast(t().setup.pluginOlder(wanted, have))
    return
  }
  const out = await $.process.run(['/bin/sh', `${$.plugin.root}/setup.sh`], { timeoutMs: INSTALL_MS }).catch(() => null)
  if (out?.exitCode === 0 && !out.stdout.includes('已经有别的会话在更新引擎了')) void $.ui.toast(t().setup.updated(wanted))
  else if (out === null || out.exitCode !== 0) void $.ui.toast(t().setup.updateFailed)
  await checkSetup($).catch(() => {})
}

function installEngine($: Engine) {
  return step($, 'engine', () => $.process.run(['/bin/sh', `${$.plugin.root}/setup.sh`], { timeoutMs: INSTALL_MS }))
}

async function chief($: Engine, args: string[], timeoutMs = 60_000) {
  return $.process.run([`${await chiefDir($)}/bin/chief`, ...args], { timeoutMs })
}

// workspace：第一次登时在设置页填的工作区（可以不填）。填了直接从工作区地址登，要公司 SSO 的只用登一次；
// 不填的话先登账号、看出工作区再换窗口登一次（会多要一次验证码）。登过一次 chief 就记下了，之后不用给。
function loginSlack($: Engine, workspace?: string) {
  return step($, 'slack', () => chief($, ['connect', 'slack', ...(workspace ? ['--workspace', workspace] : [])], LOGIN_MS))
}

function connect($: Engine, source: SourceId) {
  return step($, source, () => chief($, ['connect', source]))
}

function setAwake($: Engine, on: boolean) {
  return step($, 'awake', () => chief($, ['awake', on ? 'on' : 'off']))
}

// 免打扰、每天汇总：写进 config.json（chief config set），引擎每分钟现读，不用重启。
function setConfig($: Engine, key: string, value: string) {
  return step($, 'config', () => chief($, ['config', 'set', key, value]))
}

function setQuiet($: Engine, text: string) {
  if (text.trim() === '') return setConfig($, 'quietHours', 'null')
  const q = parseQuietRange(text)
  if (!q) return void $.ui.toast(t().setup.quietFormat)
  return setConfig($, 'quietHours', JSON.stringify(q))
}

function setDigest($: Engine, slot: 'morning' | 'evening', text: string) {
  const hm = text.trim().replace(/^(\d):/, '0$1:')
  if (hm !== '' && !HHMM.test(hm)) return void $.ui.toast(t().setup.timeFormat)
  return setConfig($, `digest.${slot}`, hm === '' ? 'null' : hm)
}

function recheck($: Engine) {
  return step($, 'check', async () => null)
}

function openWorkspace($: Engine, path: string) {
  void $.process.run(['/usr/bin/open', path]).catch(() => {})
}

function startHub($: Engine) {
  void $.prompt.submit({ text: '开 chief 消息中心' })
  void markReread($)
}

// 插件自己开不了别的会话（插件接口里没有），但 Claude App 的会话有 start_session 工具：
// 让这个会话替你在工作目录开一个新会话当主会话。工具不在（终端里）就让它告诉你怎么手动开。
function openHubThere($: Engine, path: string) {
  void $.prompt.submit({ text: t().setup.openHubThere(path) })
}

// 免打扰、每天汇总的常用选项（现在设的不在里面也会列上）。
const QUIET = ['21:00-08:00', '22:00-08:00', '23:00-08:00', '22:00-09:00', '23:00-09:00']
const MORNING = ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00']
const EVENING = ['17:00', '17:30', '18:00', '18:30', '19:00', '20:00']

// 语言选项：各用自己的语言写，看不懂当前语言的人也认得出。
const LANGUAGES: { value: Locale; label: string }[] = [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]

// 设置页（原来的「控制」也并进来了）：主会话、后台引擎、来源、这台电脑、试一下，一块一块框起来。
// 每块标题前打勾：好了是 ✓、边框变绿；还要你弄的是 ○。第一次装时从上往下点就行。
// 引擎还没装时没有 Snapshot（s 是 null），只看 doctor 和装没装。
export function setupTab($: Engine, ui: Els, st: Setup, s: Snapshot | null, logText = '', opened: string[] = []) {
  const { Box, Text, Button } = ui
  const w = t().setup
  const d = st.doctor
  const busy = st.busy !== ''
  const note = (text: string) => <Text size="footnote" dimColor wrap="wrap">{text}</Text>
  // 按钮没有「不可点」的样子：不能点的时候画成灰字。
  const button = (key: string, label: string, enabled: boolean, onPress: () => void, primary = true) => enabled
    ? (primary ? <Button key={key} variant="primary" onPress={onPress}>{label}</Button> : <Button key={key} onPress={onPress}>{label}</Button>)
    : <Text key={key} size="footnote" dimColor>{label}</Text>
  const buttons = (...items: RenderChildren[]) => <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">{items}</Box>
  // 少用、点错了影响大的（停引擎、重装、断开、停下主会话）收在 ⋯ 里。
  const more = (key: string) => opened.includes(`more-${key}`)
  const moreButton = (key: string) => <Button key={`more-${key}`} plain onPress={() => toggle($, `more-${key}`)}>{more(key) ? t().less : t().more}</Button>
  // 好了的不上色，还要你弄的框黄色：一眼看出哪块要动。
  const block = (key: string, done: boolean | null, title: string, body: RenderChildren, optional = false) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={done === false ? 'warning' : 'inactive'} paddingX="md" paddingY="sm" gap="xs">
      <Text weight="semibold">{done === null ? '' : done ? <Text color="success">✓ </Text> : '○ '}{title}{optional ? <Text dimColor>{w.optional}</Text> : ''}</Text>
      {body}
    </Box>
  )

  // ── 后台引擎 ──
  const outdated = st.installed && d !== null && engineBehind(d.version, wanted)
  // 引擎比这个会话的插件新：不往回装，算好了，只说一句。
  const ahead = st.installed && d !== null && !outdated && wanted !== null && d.version !== wanted
  const running = s !== null ? s.engineAt !== null : d?.engine === 'running'
  const engineOk = st.installed && d !== null && running && !outdated
  const engine = st.busy === 'engine'
    ? note(w.installing)
    : !st.installed ? (
      <Box flexDirection="column" gap="xs">
        {note(w.installHelp)}
        {buttons(button('setup-engine', w.install, !busy, () => void installEngine($)))}
      </Box>
    ) : (
      <Box flexDirection="column" gap="xs">
        <Text wrap="wrap">{running ? w.running(s?.engineAt ? ago(s.engineAt) : null) : w.stopped}{d ? <Text dimColor>{w.version(d.version ?? '?', d.node)}</Text> : ''}</Text>
        {outdated && note(w.outdated(wanted ?? '?', d?.version ?? w.oldVersion))}
        {ahead && note(w.ahead(d?.version ?? '?', wanted ?? '?'))}
        {d?.workspace.ready && note(w.workspace(d.workspace.path))}
        {buttons(
          outdated ? button('setup-engine', w.update, !busy, () => void installEngine($)) : null,
          running ? null : <Button key="eng-start" variant="primary" onPress={() => engineDo($, 'start')}>{w.start}</Button>,
          <Button key="logs" onPress={() => showLogs($)}>{w.logs}</Button>,
          d?.workspace.ready ? <Button key="setup-workspace" onPress={() => openWorkspace($, d.workspace.path)}>{w.openWorkspace}</Button> : null,
          moreButton('engine'),
          more('engine') && running ? <Button key="eng-stop" onPress={() => engineDo($, 'stop')}>{w.stop}</Button> : null,
          more('engine') ? <Button key="eng-restart" onPress={() => engineDo($, 'restart')}>{w.restart}</Button> : null,
          more('engine') && !outdated ? button('setup-engine', w.reinstall, !busy, () => void installEngine($), false) : null,
        )}
        {logText !== '' && ('Code' in ui ? <ui.Code source={logText} language="text" /> : <Text dimColor wrap="wrap">{logText}</Text>)}
      </Box>
    )

  // ── 主会话 ──
  const listening = s?.hub.listening ?? d?.hub.listening === true
  // 消息中心最好开在工作目录里：那样才读得到 CLAUDE.md、notes/ 和那里的 skill。
  const elsewhere = d !== null && d.workspace.ready && st.cwd !== '' && st.cwd !== d.workspace.path
  const unhandled = s?.unhandled ?? 0
  const skip = unhandled > 0 && s ? <Button key="skip-old2" onPress={() => skipOld($, s.maxEvent)}>{w.skipOld(unhandled)}</Button> : null
  const keyWarn = st.key === 'mismatch'
    ? note(w.keyMismatch)
    : null
  const hub = listening ? (
    <Box flexDirection="column" gap="xs">
      {keyWarn}
      {note(w.listening)}
      {buttons(
        <Button key="hub-reload" onPress={() => { void tell($, RELOAD_SKILL, w.reload); void markReread($) }}>{w.reload}</Button>,
        skip,
        moreButton('hub'),
        more('hub') ? <Button key="hub-stop" onPress={() => hubStop($)}>{w.hubStop}</Button> : null,
      )}
    </Box>
  ) : (
    <Box flexDirection="column" gap="xs">
      {note(elsewhere
        ? w.elsewhere(st.cwd, d!.workspace.path)
        : w.useThis)}
      {buttons(
        elsewhere && engineOk ? button('setup-hub-there', w.hubThere, !busy, () => openHubThere($, d!.workspace.path)) : null,
        button('setup-hub', !engineOk ? w.hubNeedsEngine : elsewhere ? w.hubThis : w.hubStart, !busy && engineOk, () => startHub($), !elsewhere),
        skip,
      )}
    </Box>
  )

  // ── 来源：每个一行，状态和按钮在一起。按来源名单（engine/src/shared/sources.ts）的顺序和连法画 ──
  const on = (src: SourceId) => s !== null ? s.sources[src] === true : d?.sources[src]?.enabled === true
  const fails = (src: SourceId) => (s?.health[src]?.fails ?? 0)
  const state = (src: SourceId) => on(src) && fails(src) > 0
    ? <Text color="error">{w.failing(fails(src))}</Text>
    : <Text color={on(src) ? 'success' : undefined} dimColor={!on(src)}>{on(src) ? w.on : w.off}</Text>
  const line = (src: SourceId, ...rest: RenderChildren[]) => (
    <Box key={`src-${src}`} flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
      <Text>{sourceName(src)}</Text>
      {state(src)}
      {rest}
    </Box>
  )
  const off = (src: SourceId) => on(src) && more(`src-${src}`) ? <Button key={`dc-${src}`} onPress={() => act($, w.disconnectLabel(sourceName(src)), ['disconnect', src])}>{w.disconnect}</Button> : null
  const slackReady = d?.sources.slack?.ready === true
  // 还没记过工作区、又不在登录中：Slack 那行给一个填工作区的输入框，代替「登录 Slack」按钮。
  const askWorkspace = st.busy !== 'slack' && st.installed && d !== null && !d.slackWorkspace && d.chrome !== false
  const slackOk = on('slack') && fails('slack') === 0 && (d === null || slackReady)
  // 用本机命令的来源（gh、acli）：装了、登录了才给「连上」，不然说在终端跑什么。
  const tool = (id: SourceId, install: string, login: string) => {
    const t = d?.sources[id]
    if (on(id)) return [line(id, moreButton(`src-${id}`), off(id))]
    if (st.busy === id) return [line(id, <Text key={`${id}-busy`} size="footnote" dimColor>{w.trying}</Text>)]
    // doctor 说了没装 / 没登录才给提示；没 doctor 时照样给「连上」按钮，连不上会在下面说为什么。
    if (t !== undefined && !t.tool) return [line(id), note(w.noTool(sourceName(id), install, login))]
    if (t !== undefined && !t.ok) return [line(id), note(w.notLoggedIn(sourceName(id), login, t.detail))]
    return [line(id, <Button key={`cn-${id}`} onPress={() => void connect($, id)}>{w.connect}</Button>)]
  }
  // 浏览器登录（Slack）：登录 / 重新登录、填工作区。
  const browser = (id: SourceId) => [
    // 登录进行中两个按钮都不画：只藏「重新登录」的话「断开」会挪到它的位置，再点一下就把 Slack 断了。
    // 连得好好的：重新登录、断开都收在 ⋯ 里；连不上或没登录才把登录按钮摆出来。
    line(id,
      st.busy === id || askWorkspace || (slackOk && !more(`src-${id}`)) ? null : button(`setup-${id}`, on(id) || slackReady ? w.relogin : w.loginSlack, !busy && st.installed && d?.chrome !== false, () => void loginSlack($), !(on(id) || slackReady)),
      st.busy === id || !slackOk ? null : moreButton(`src-${id}`),
      st.busy === id ? null : off(id)),
    d?.slackWorkspace && note(w.slackWorkspace(d.slackWorkspace)),
    // 还没记过工作区：先问一句（可以不填）。填了只用登一次。
    askWorkspace && 'Input' in ui && (
      <Box key={`${id}-ws`} flexDirection="column" gap="xs">
        {note(w.workspaceHelp)}
        <ui.Input key="slack-workspace" placeholder={w.workspacePlaceholder} submitLabel={on(id) || slackReady ? w.relogin : w.loginSlack} onSubmit={(v: string) => {
          if (!busy) void loginSlack($, v.trim() || undefined)
        }} />
      </Box>
    ),
    st.busy === id && note(w.loggingIn),
    d?.chrome === false && note(w.needChrome),
  ]
  // 令牌从终端给的（Notion）：这里只看开没开、能断开。
  const sourceRows = (id: SourceId, setup: SetupMeta) => setup.kind === 'cli' ? tool(id, setup.install, setup.login)
    : setup.kind === 'browser' ? browser(id)
    : [line(id, on(id) ? moreButton(`src-${id}`) : null, off(id))]
  const sources = (
    <Box flexDirection="column" gap="xs">
      {SOURCE_IDS.flatMap(id => sourceRows(id, SOURCE_META[id].setup))}
      {SOURCE_IDS.filter(src => on(src) && fails(src) > 0).map(src => (
        <Text key={`err-${src}`} size="footnote" color="error" wrap="wrap">{w.sourceError(sourceName(src), ago(s!.health[src]!.at), s!.health[src]!.error ?? t().noReason)}</Text>
      ))}
      {/* 都连好了不用看说明。 */}
      {(!slackOk || SOURCE_IDS.some(src => on(src) && fails(src) > 0)) && note(w.sourcesHelp)}
    </Box>
  )

  const timeRow = (key: string, label: string, value: string, choices: string[], none: string, onSelect: (v: string) => void) => (
    <Box key={`tr-${key}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
      <Text>{label}</Text>
      {select(ui, `time-${key}`, value, [{ value: '', label: none }, ...[...new Set([...choices, ...(value ? [value] : [])])].sort().map(v => ({ value: v, label: v }))], v => { if (!busy) onSelect(v) })}
    </Box>
  )

  return (
    <Box flexDirection="column" gap="sm" marginTop="sm">
      {!st.installed && <Text weight="semibold">{w.firstTitle}</Text>}
      {!st.installed && note(w.firstSteps)}
      {block('set-engine', engineOk, w.engineTitle, engine)}
      {block('set-sources', slackOk, w.sourcesTitle, sources)}
      {block('set-hub', listening, w.hubTitle, hub)}
      {d !== null && block('set-awake', null, w.awakeTitle, (
        <Box flexDirection="column" gap="xs">
          {buttons(
            <Text key="awake-state" color={d.awake ? 'success' : undefined} dimColor={!d.awake}>{d.awake ? w.on : w.off}</Text>,
            button('setup-awake', st.busy === 'awake' ? '…' : d.awake ? w.turnOff : w.turnOn, !busy, () => void setAwake($, !d.awake), false),
          )}
          {note(d.awake ? w.awakeOn : w.awakeOff)}
        </Box>
      ), true)}
      {d !== null && block('set-quiet', null, w.quietTitle, 'Select' in ui ? (
        // 选了就生效：免打扰几个常用时段、汇总几个常用时间；现在设的不在选项里也列上。
        <Box flexDirection="column" gap="xs">
          {timeRow('quiet', w.quietLabel, d.quietHours ? `${d.quietHours.start}-${d.quietHours.end}` : '', QUIET, w.quietNone, v => void (v === '' ? setConfig($, 'quietHours', 'null') : setQuiet($, v)))}
          {timeRow('morning', w.morningLabel, d.digest?.morning ?? '', MORNING, w.digestNone, v => void setDigest($, 'morning', v))}
          {timeRow('evening', w.eveningLabel, d.digest?.evening ?? '', EVENING, w.digestNone, v => void setDigest($, 'evening', v))}
          {note(w.quietHelp)}
        </Box>
      ) : (
        <Box flexDirection="column" gap="xs">
          {note(d.quietHours
            ? w.quietOn(d.quietHours.start, d.quietHours.end)
            : w.quietOff)}
          {note(w.digest(d.digest?.morning ?? null, d.digest?.evening ?? null))}
        </Box>
      ), true)}
      {st.installed && block('set-language', null, w.languageTitle, (
        <Box flexDirection="column" gap="xs">
          {note(w.languageHelp)}
          {'Select' in ui
            ? select(ui, 'language', locale(), LANGUAGES, v => { if (!busy) void setLanguage($, v as Locale) })
            : buttons(...LANGUAGES.map(x => button(`lang-${x.value}`, x.label, !busy && x.value !== locale(), () => void setLanguage($, x.value), false)))}
        </Box>
      ), true)}
      {s !== null && block('set-try', null, w.tryTitle, (
        <Box flexDirection="column" gap="xs">
          {note(w.tryHelp)}
          {'Input' in ui && (
            <ui.Input key="test-msg" placeholder={w.tryPlaceholder} submitLabel={w.trySend} onSubmit={(v: string) => {
              if (v.trim()) void testMessage($, v.trim())
            }} />
          )}
          {note(w.tryDm)}
        </Box>
      ))}
      {s !== null && listening && block('set-import', null, w.importTitle, (
        <Box flexDirection="column" gap="xs">
          {note(w.importHelp)}
          {buttons(<Button key="import" onPress={() => tell($, 'chief：导入现在在做的事', t().things.import)}>{t().things.import}</Button>)}
        </Box>
      ))}
      {s !== null && usageBox(ui, s.hubUsage, s.usage)}
      {st.said !== '' && <Text size="footnote" color="error" wrap="wrap">{w.lastFailed(st.said)}</Text>}
      {buttons(button('setup-recheck', st.busy === 'check' ? w.checking : w.recheck, !busy, () => void recheck($), false))}
    </Box>
  )
}
