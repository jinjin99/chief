// 设置页：主会话、后台引擎、来源、这台电脑、试一下（原来的「控制」页也在这）。第一次装时从上往下点。
// 引擎还没装时 ~/chief/data/bin/chief 不存在，面板只画这一页；装好以后它是最后一个页签「设置」。
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, RenderChildren } from 'claude-code'

import type { Doctor, Setup, Snapshot } from '../types'
import { act, engineDo, hubStop, showLogs, skipOld, tell, testMessage } from './actions'
import { chiefDir, refresh } from './data'
import { RELOAD_SKILL, SOURCE, ago, type Els } from './views'

const setup = atom({ plugin: 'chief', key: 'setup' } as const, { installed: false, doctor: null, busy: '', said: '', cwd: '' } as Setup)

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
  await update($, setup, s => ({ ...s, installed: has, doctor, cwd }))
}

export async function readSetup($: Engine) {
  return read($, setup)
}

// 还差几步（必需的：引擎、Slack、消息中心）。
export function missing(s: Setup): number {
  const d = s.doctor
  if (!s.installed || d === null) return 3
  return [d.engine === 'running' && d.version === wanted, d.sources.slack.enabled && d.sources.slack.ready, d.hub.listening].filter(ok => !ok).length
}

async function step($: Engine, busy: Setup['busy'], run: () => Promise<{ exitCode: number; stdout: string; stderr: string } | null>) {
  await update($, setup, s => ({ ...s, busy, said: '' }))
  let said: string
  try {
    const out = await run()
    said = out === null ? '' : out.exitCode === 0 ? '' : (out.stderr.trim() || out.stdout.trim().split('\n').slice(-3).join('\n') || '没说为什么').slice(0, 400)
  } catch (error) {
    said = error instanceof Error ? error.message : String(error)
  }
  await update($, setup, (s): Setup => ({ ...s, busy: '', said }))
  await checkSetup($)
  await refresh($).catch(() => {})
}

// 插件更新了、引擎还是旧的：插件每次加载都看一眼，不一样就在后台跑一遍 setup.sh（复制新引擎、装依赖、重启），
// 不用谁去点「更新引擎」。版本一样什么都不做；还没装过的交给设置页。几个会话同时加载只有一个真跑（setup.sh 拿锁）。
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
  const out = await $.process.run(['/bin/sh', `${$.plugin.root}/setup.sh`], { timeoutMs: INSTALL_MS }).catch(() => null)
  if (out?.exitCode === 0 && !out.stdout.includes('已经有别的会话在更新引擎了')) void $.ui.toast(`chief 引擎更新到 ${wanted} 了`)
  else if (out === null || out.exitCode !== 0) void $.ui.toast('chief 引擎没更新成功：打开 /chief 的设置页，点「更新引擎」看看哪里不对')
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

function connect($: Engine, source: 'github' | 'jira') {
  return step($, source, () => chief($, ['connect', source]))
}

function setAwake($: Engine, on: boolean) {
  return step($, 'awake', () => chief($, ['awake', on ? 'on' : 'off']))
}

function recheck($: Engine) {
  return step($, 'check', async () => null)
}

function openWorkspace($: Engine, path: string) {
  void $.process.run(['/usr/bin/open', path]).catch(() => {})
}

function startHub($: Engine) {
  void $.prompt.submit({ text: '开 chief 消息中心' })
}

// 设置页（原来的「控制」也并进来了）：主会话、后台引擎、来源、这台电脑、试一下，一块一块框起来。
// 每块标题前打勾：好了是 ✓、边框变绿；还要你弄的是 ○。第一次装时从上往下点就行。
// 引擎还没装时没有 Snapshot（s 是 null），只看 doctor 和装没装。
export function setupTab($: Engine, ui: Els, st: Setup, s: Snapshot | null, logText = '') {
  const { Box, Text, Button } = ui
  const d = st.doctor
  const busy = st.busy !== ''
  const note = (text: string) => <Text size="footnote" dimColor wrap="wrap">{text}</Text>
  // 按钮没有「不可点」的样子：不能点的时候画成灰字。
  const button = (key: string, label: string, enabled: boolean, onPress: () => void, primary = true) => enabled
    ? (primary ? <Button key={key} variant="primary" onPress={onPress}>{label}</Button> : <Button key={key} onPress={onPress}>{label}</Button>)
    : <Text key={key} size="footnote" dimColor>{label}</Text>
  const buttons = (...items: RenderChildren[]) => <Box flexDirection="row" gap="sm" flexWrap="wrap">{items}</Box>
  const block = (key: string, done: boolean | null, title: string, body: RenderChildren, optional = false) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={done ? 'success' : 'inactive'} paddingX="md" paddingY="sm" gap="xs">
      <Text weight="semibold">{done === null ? '' : done ? <Text color="success">✓ </Text> : '○ '}{title}{optional ? <Text dimColor>（可选）</Text> : ''}</Text>
      {body}
    </Box>
  )

  // ── 后台引擎 ──
  const outdated = st.installed && d !== null && d.version !== wanted
  const running = s !== null ? s.engineAt !== null : d?.engine === 'running'
  const engineOk = st.installed && d !== null && running && !outdated
  const engine = st.busy === 'engine'
    ? note('正在装：复制引擎、装依赖、装进后台服务。第一次要一两分钟。')
    : !st.installed ? (
      <Box flexDirection="column" gap="xs">
        {note('把收消息的后台程序装到这台电脑上，开机自动跑。chief 的东西都放在工作目录 ~/chief 里。要先装好 Node 24 以上。')}
        {buttons(button('setup-engine', '装引擎', !busy, () => void installEngine($)))}
      </Box>
    ) : (
      <Box flexDirection="column" gap="xs">
        <Text wrap="wrap">{running ? `在跑${s?.engineAt ? ` · ${ago(s.engineAt)}报到` : ''}` : '没在跑'}{d ? <Text dimColor>{`（${d.version ?? '?'}，Node ${d.node}）`}</Text> : ''}</Text>
        {outdated && note(`插件是 ${wanted ?? '?'}，引擎还是 ${d?.version ?? '旧版'}，点「更新引擎」。`)}
        {d?.workspace.ready && note(`工作目录 ${d.workspace.path}：CLAUDE.md 写你的交代，rules.json 是规矩，notes/ 是助理记的，data/ 是进展和消息。`)}
        {buttons(
          outdated ? button('setup-engine', '更新引擎', !busy, () => void installEngine($)) : null,
          running ? <Button key="eng-stop" onPress={() => engineDo($, 'stop')}>停引擎</Button> : <Button key="eng-start" variant="primary" onPress={() => engineDo($, 'start')}>开引擎</Button>,
          <Button key="eng-restart" onPress={() => engineDo($, 'restart')}>重启引擎</Button>,
          <Button key="logs" onPress={() => showLogs($)}>看日志</Button>,
          d?.workspace.ready ? <Button key="setup-workspace" onPress={() => openWorkspace($, d.workspace.path)}>打开工作目录</Button> : null,
          !outdated ? button('setup-engine', '重装引擎', !busy, () => void installEngine($), false) : null,
        )}
        {logText !== '' && ('Code' in ui ? <ui.Code source={logText} language="text" /> : <Text dimColor wrap="wrap">{logText}</Text>)}
      </Box>
    )

  // ── 主会话 ──
  const listening = s?.hub.listening ?? d?.hub.listening === true
  // 消息中心最好开在工作目录里：那样才读得到 CLAUDE.md、notes/ 和那里的 skill。
  const elsewhere = d !== null && d.workspace.ready && st.cwd !== '' && st.cwd !== d.workspace.path
  const unhandled = s?.unhandled ?? 0
  const skip = unhandled > 0 && s ? <Button key="skip-old2" onPress={() => skipOld($, s.maxEvent)}>跳过积下的 {unhandled} 条</Button> : null
  const hub = listening ? (
    <Box flexDirection="column" gap="xs">
      {note('在听，新消息进来会自动处理。停下以后新消息先攒着，在任何会话发 /chief:hub 接着处理。插件更新过的话点「重读规则」，主会话会读到新的做事方式，不用重新开张。')}
      {buttons(
        <Button key="hub-stop" onPress={() => hubStop($)}>停下主会话</Button>,
        <Button key="hub-reload" onPress={() => tell($, RELOAD_SKILL, '重读规则')}>重读规则</Button>,
        skip,
      )}
    </Box>
  ) : (
    <Box flexDirection="column" gap="xs">
      {note(elsewhere
        ? `这个会话开在 ${st.cwd}。消息中心最好开在工作目录：新建会话时文件夹选 ${d!.workspace.path}（权限模式选 bypass permissions），在那个会话里打 /chief 再点这里。`
        : '用这个会话当主会话：点下面的按钮，它会挂上监听、改名叫「chief 消息中心」。这个会话之后就一直开着，权限模式选 bypass permissions。')}
      {buttons(button('setup-hub', !engineOk ? '开消息中心（先装好引擎）' : elsewhere ? '就用这个会话' : '开消息中心', !busy && engineOk, () => startHub($), !elsewhere), skip)}
    </Box>
  )

  // ── 来源：每个一行，状态和按钮在一起 ──
  const on = (src: 'slack' | 'github' | 'jira' | 'notion') => s !== null ? s.sources[src] === true : d?.sources[src].enabled === true
  const fails = (src: 'slack' | 'github' | 'jira' | 'notion') => (s?.health[src]?.fails ?? 0)
  const state = (src: 'slack' | 'github' | 'jira' | 'notion') => on(src) && fails(src) > 0
    ? <Text color="error">连不上（连着 {fails(src)} 次）</Text>
    : <Text color={on(src) ? 'success' : undefined} dimColor={!on(src)}>{on(src) ? '开着' : '没开'}</Text>
  const line = (src: 'slack' | 'github' | 'jira' | 'notion', ...rest: RenderChildren[]) => (
    <Box key={`src-${src}`} flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
      <Text>{SOURCE[src]}</Text>
      {state(src)}
      {rest}
    </Box>
  )
  const off = (src: 'slack' | 'github' | 'jira' | 'notion') => on(src) ? <Button key={`dc-${src}`} onPress={() => act($, `断开 ${SOURCE[src]}`, ['disconnect', src])}>断开</Button> : null
  const slackReady = d?.sources.slack.ready === true
  // 还没记过工作区、又不在登录中：Slack 那行给一个填工作区的输入框，代替「登录 Slack」按钮。
  const askWorkspace = st.busy !== 'slack' && st.installed && d !== null && !d.slackWorkspace && d.chrome !== false
  const slackOk = on('slack') && fails('slack') === 0 && (d === null || slackReady)
  const tool = (id: 'github' | 'jira', install: string, login: string) => {
    const t = d?.sources[id]
    if (on(id)) return [line(id, off(id))]
    if (st.busy === id) return [line(id, <Text key={`${id}-busy`} size="footnote" dimColor>正在试…</Text>)]
    // doctor 说了没装 / 没登录才给提示；没 doctor 时照样给「连上」按钮，连不上会在下面说为什么。
    if (t !== undefined && !t.tool) return [line(id), note(`${SOURCE[id]}：没找到命令，在终端跑 ${install}，再 ${login}，然后点「重新检查」。`)]
    if (t !== undefined && !t.ok) return [line(id), note(`${SOURCE[id]}：还没登录，在终端跑 ${login}，然后点「重新检查」。${t.detail ? `（${t.detail}）` : ''}`)]
    return [line(id, <Button key={`cn-${id}`} onPress={() => void connect($, id)}>连上</Button>)]
  }
  const sources = (
    <Box flexDirection="column" gap="xs">
      {/* 登录进行中两个按钮都不画：只藏「重新登录」的话「断开」会挪到它的位置，再点一下就把 Slack 断了。 */}
      {line('slack',
        st.busy === 'slack' || askWorkspace ? null : button('setup-slack', on('slack') || slackReady ? '重新登录' : '登录 Slack', !busy && st.installed && d?.chrome !== false, () => void loginSlack($), !(on('slack') || slackReady)),
        st.busy === 'slack' ? null : off('slack'))}
      {d?.slackWorkspace && note(`工作区：${d.slackWorkspace}.slack.com`)}
      {/* 还没记过工作区：先问一句（可以不填）。填了只用登一次。 */}
      {askWorkspace && 'Input' in ui && (
        <Box flexDirection="column" gap="xs">
          {note('你的 Slack 工作区：浏览器里打开 Slack 时地址栏 xxx.slack.com 的 xxx。公司要 SSO 的一定要填，填了只用登一次；不知道可以留空直接点。')}
          <ui.Input key="slack-workspace" placeholder="比如 acme（可以留空）" submitLabel={on('slack') || slackReady ? '重新登录' : '登录 Slack'} onSubmit={(v: string) => {
            if (!busy) void loginSlack($, v.trim() || undefined)
          }} />
        </Box>
      )}
      {st.busy === 'slack' && note('在弹出的 Chrome 窗口里登录 Slack（公司 SSO、确认新设备都照做），登好窗口会自己关掉。')}
      {d?.chrome === false && note('登录 Slack 要用 Google Chrome：先装一个 Chrome。')}
      {tool('github', 'brew install gh', 'gh auth login')}
      {tool('jira', 'brew install acli', 'acli jira auth login --web（用 twg 的话：twg login）')}
      {line('notion', off('notion'))}
      {(['slack', 'github', 'jira', 'notion'] as const).filter(src => on(src) && fails(src) > 0).map(src => (
        <Text key={`err-${src}`} size="footnote" color="error" wrap="wrap">{SOURCE[src]} {ago(s!.health[src]!.at)}：{s!.health[src]!.error ?? '没说为什么'}</Text>
      ))}
      {note('Slack 连不上（比如登录过期）就点「重新登录」。GitHub、Jira 用你电脑上已经登录的 gh、acli（Jira 也可以用 twg）。Notion 要令牌，在终端里连：pbpaste | chief connect notion（先复制好）。')}
    </Box>
  )

  return (
    <Box flexDirection="column" gap="sm" marginTop="sm">
      {!st.installed && <Text weight="semibold">设置 chief：从上往下点，先装引擎</Text>}
      {block('set-engine', engineOk, '后台引擎（收消息、发回复）', engine)}
      {block('set-sources', slackOk, '来源', sources)}
      {block('set-hub', listening, '主会话', hub)}
      {d !== null && block('set-awake', d.awake, '插电时不让电脑睡', (
        <Box flexDirection="column" gap="xs">
          {note(d.awake
            ? '开着：插着电时电脑不会自己睡，屏幕照样会关、会锁，消息照收照办。没插电、合上盖子还是会睡，醒了再接着处理。'
            : '关着：电脑睡着时收不到消息，醒了才接着处理。')}
          {buttons(button('setup-awake', st.busy === 'awake' ? '…' : d.awake ? '关掉' : '打开', !busy, () => void setAwake($, !d.awake), false))}
        </Box>
      ), true)}
      {s !== null && block('set-try', null, '试一下', (
        <Box flexDirection="column" gap="xs">
          {note('造一条「同事找你」的消息，看主会话怎么判断、派活、写回复。回复不会真的发出去。')}
          {'Input' in ui && (
            <ui.Input key="test-msg" placeholder="比如：OPS-35121 的压测报告今天能给吗" submitLabel="发测试消息" onSubmit={(v: string) => {
              if (v.trim()) void testMessage($, v.trim())
            }} />
          )}
          {note('也可以在 Slack 里给自己发私信，那是给主会话的指令（比如「帮我看看现在工作进度」），它办完会回到你和自己的私信里。')}
        </Box>
      ))}
      {st.said !== '' && <Text size="footnote" color="error" wrap="wrap">上一步没成：{st.said}</Text>}
      {buttons(button('setup-recheck', st.busy === 'check' ? '检查中…' : '重新检查', !busy, () => void recheck($), false))}
    </Box>
  )
}
