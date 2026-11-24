// 生成一个演示用的 chief 目录（编的人和事），用来在 Claude App 里截真面板的图。和你在用的 ~/chief 完全分开：
//   cd plugin/engine && node --import tsx ../../scripts/demo-data.mts [目录，默认 ~/chief-demo] [--lang en|zh] [--keep]
// 然后在 Claude App 里对那个目录开一个新会话，输入 /chief。目录里的 .claude/settings.json 把这个会话的 CHIEF_HOME 指到演示数据，
// bin/chief 用这个仓库里的引擎代码读写演示数据（doctor 和 key 直接给假的结果：不碰钥匙串、不登录、不动你的钥匙）。
// --keep：一直开着，每 5 秒刷新「主会话在听、引擎在跑」，面板上点了发送的回复 5 秒后标成已发出（什么都不会真的发出去）。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { files } from './demo-fixtures.ts'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? null : (args.splice(i, 2)[1] ?? null) }
const keep = args.includes('--keep')
const lang = flag('--lang') === 'zh' ? 'zh' : 'en'
const dir = resolve(args.find(a => !a.startsWith('--')) ?? join(homedir(), 'chief-demo'))
if (dir === join(homedir(), 'chief') || dir.startsWith(`${join(homedir(), 'chief')}/`)) throw new Error('演示目录不能放在 ~/chief 里，那是你在用的 chief')
const data = join(dir, 'data')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(repo, 'plugin', 'engine')

for (const [name, text] of Object.entries(files(lang))) {
  const path = join(data, name.replace(/^data\//, ''))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const doctor = {
  version: readFileSync(join(repo, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8').match(/"version":\s*"([^"]+)"/)?.[1] ?? null,
  node: process.version, engine: 'running', chrome: true, awake: true, slackWorkspace: 'example',
  sources: { slack: { enabled: true, ready: true }, github: { enabled: true, tool: true, ok: true, detail: '' }, jira: { enabled: true, tool: true, ok: true, detail: '' }, notion: { enabled: false, ready: false } },
  hub: { listening: true, lastAt: new Date().toISOString() },
  workspace: { path: dir, ready: true },
  quietHours: null, digest: { morning: '09:00', evening: null },
}
writeFileSync(join(data, 'doctor.json'), `${JSON.stringify(doctor)}\n`)

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const bin = join(data, 'bin', 'chief')
mkdirSync(dirname(bin), { recursive: true })
writeFileSync(bin, `#!/bin/sh
# 演示用的 chief：读写 ${data}，不碰你在用的 ~/chief。
export CHIEF_HOME=${q(data)}
case "$1" in
  doctor) cat "$CHIEF_HOME/doctor.json"; exit 0 ;;
  key) cat >/dev/null; exit 0 ;;
esac
exec ${q(process.execPath)} --import ${q(join(engine, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'))} ${q(join(engine, 'src', 'cli.ts'))} "$@"
`)
chmodSync(bin, 0o755)

mkdirSync(join(dir, '.claude'), { recursive: true })
writeFileSync(join(dir, '.claude', 'settings.json'), `${JSON.stringify({ env: { CHIEF_HOME: data } }, null, 2)}\n`)
if (!existsSync(join(dir, 'CLAUDE.md'))) writeFileSync(join(dir, 'CLAUDE.md'), '# chief demo\n\nMade-up data for screenshots of the chief panel. Nothing here is real.\n')

console.log(`演示目录：${dir}（${lang === 'en' ? '英文' : '中文'}）`)
console.log('在 Claude App 里对这个目录开一个新会话，输入 /chief。')

function tick() {
  const now = new Date()
  writeFileSync(join(data, 'alive.json'), JSON.stringify({ at: now.toISOString() }))
  const eng = JSON.parse(readFileSync(join(data, 'engine.json'), 'utf8')) as { at: string }
  writeFileSync(join(data, 'engine.json'), JSON.stringify({ ...eng, at: now.toISOString() }))
  const path = join(data, 'replies.json')
  const r = JSON.parse(readFileSync(path, 'utf8')) as { items: { status: string; sendAt?: string; sentAt?: string; by?: string }[] }
  let changed = false
  for (const x of r.items) if (x.status === 'queued' && x.sendAt && Date.parse(x.sendAt) <= now.getTime()) { x.status = 'sent'; x.sentAt = now.toISOString(); x.by ??= 'you'; changed = true }
  if (changed) writeFileSync(path, JSON.stringify(r))
}

if (keep) {
  console.log('一直开着（Ctrl-C 停）：每 5 秒刷新一次。')
  tick()
  setInterval(tick, 5_000)
}
