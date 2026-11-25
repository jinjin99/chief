// 演示用的 chief 数据文件（scripts/demo-data.mts 用）：人、项目、消息都是编的。时间按生成的这一刻往前推。
// README 里的截图就是用这份数据在 Claude App 里截的真面板。
type Lang = 'en' | 'zh'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function files(lang: Lang): Record<string, string> {
  const now = Date.now()
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const day = (n: number) => {
    const d = new Date(now + n * DAY)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const tomorrow9 = new Date(now + DAY)
  tomorrow9.setHours(9, 0, 0, 0)
  const L = <T,>(en: T, zh: T) => (lang === 'en' ? en : zh)

  const things = [
    {
      id: 31, title: L('Fix CSV export timeout (Maya)', '修 CSV 导出超时（Maya）'), session: 'local_demo_exports', status: 'waiting_you', due: day(0),
      progress: L('Root cause: a missing index on exports.created_at. Hotfix PR exports#77 raises the query timeout; tests pass.', '原因：exports.created_at 少一个索引。hotfix PR exports#77 先调大了查询超时，测试过了。'),
      next: L('Your call on the migration, then send the reply to Maya', '等你定迁移怎么做，再把回复发给 Maya'),
      results: ['[PR exports#77](https://github.com/example/exports/pull/77)'], events: [101, 108], updatedAt: ago(6 * MIN), log: [],
    },
    {
      id: 29, title: L('Review PR billing#482: retry webhooks on 5xx', 'Review PR billing#482：5xx 时重试 webhook'), session: 'local_demo_billing', status: 'doing',
      progress: L('Read the diff; the retry loop has no cap on attempts', '看完 diff 了；重试循环没有次数上限'),
      next: L('Run the tests, then comment on the backoff', '跑完测试，再评论退避时间'), events: [104], updatedAt: ago(20 * MIN), log: [],
    },
    {
      id: 27, title: L('Release notes for v2.4', 'v2.4 发版说明'), status: 'waiting_others', due: day(1),
      progress: L('Draft covers web and api; the billing section is empty', '草稿写了 web 和 api；billing 那段还空着'),
      next: L('Add Sam\'s part, then post to #releases', '加上 Sam 那部分，再发到 #releases'), blocker: L('Sam\'s changelog for the billing changes', 'Sam 的 billing 改动 changelog'),
      events: [96], updatedAt: ago(3 * HOUR), log: [],
    },
    {
      id: 24, title: L('Onboarding doc: local setup on Apple silicon', '入职文档：Apple 芯片的本地环境'), status: 'waiting_others',
      progress: L('Asked Priya to confirm the Docker steps', '请 Priya 确认 Docker 那几步'), next: L('Publish once Priya confirms', 'Priya 确认后发布'),
      events: [88], updatedAt: ago(DAY + 2 * HOUR), log: [],
    },
    {
      id: 21, title: L('Flaky test: payments-api retries_spec', '不稳定的测试：payments-api retries_spec'), session: 'local_demo_flaky', status: 'doing',
      progress: L('Reproduced 3 of 50 runs', '50 次复现了 3 次'), next: L('Freeze the clock, run it 200 times', '冻结时钟，跑 200 次'),
      events: [80], updatedAt: ago(5 * HOUR), log: [],
    },
    {
      id: 18, title: L('Move cron jobs to the new scheduler', '定时任务搬到新的调度器'), status: 'doing',
      progress: L('3 of 7 jobs moved', '7 个任务搬了 3 个'), next: L('Move the billing reports', '搬 billing 报表那几个'),
      events: [61], updatedAt: ago(4 * DAY), log: [],
    },
    {
      id: 20, title: L('Comments on the Q1 planning doc', 'Q1 规划文档的评论'), status: 'doing', progress: L('Read half of it', '看了一半'),
      snooze: { until: tomorrow9.toISOString(), at: ago(HOUR) }, events: [70], updatedAt: ago(HOUR), log: [],
    },
    { id: 15, title: L('Approve PR web#466: dark mode for settings', 'Approve PR web#466：设置页深色模式'), status: 'done', progress: L('Approved', '已 approve'), events: [52], updatedAt: ago(DAY), log: [] },
    { id: 12, title: L('Answer Leo about API rate limits', '回 Leo 关于 API 限流的问题'), status: 'done', progress: L('Replied in thread', '在 thread 里回了'), events: [40], updatedAt: ago(2 * DAY), log: [] },
    { id: 9, title: L('Jira OPS-112: rotate staging certificates', 'Jira OPS-112：更换 staging 证书'), status: 'done', progress: L('Rotated and verified', '换好并验证过了'), events: [31], updatedAt: ago(3 * DAY), log: [] },
  ]

  const asks = [
    {
      id: 40, thing: 31, status: 'open', at: ago(6 * MIN), reply: 41,
      question: L('The fix needs an index on exports.created_at; on the big table the migration takes about 4 minutes. Add the index in the hotfix PR, or run it as a separate migration tonight?', '修这个要给 exports.created_at 加索引，大表上迁移大约要 4 分钟。索引放进 hotfix PR，还是今晚单独做一次迁移？'),
      suggest: L('Separate migration tonight, so the hotfix ships today.', '今晚单独迁移，hotfix 今天就能上。'),
    },
    {
      id: 42, thing: 27, status: 'open', at: ago(3 * HOUR),
      question: L('Sam\'s changelog is late. Post the v2.4 notes tomorrow without the billing section, or wait for it?', 'Sam 的 changelog 晚了。明天先发不带 billing 的 v2.4 说明，还是等他？'),
      suggest: L('Post without it and add billing in a follow-up.', '先发，billing 之后补一条。'),
    },
  ]

  const replies = [
    {
      id: 41, event: 101, thing: 31, source: 'slack', status: 'pending', at: ago(6 * MIN),
      target: { channel: 'C0DEMO01', ts: '1700000000.000100', thread_ts: '1700000000.000100' },
      context: { who: 'Maya', where: '#support-escalations', said: L('CSV export times out again for big workspaces 😩 can you take a look today?', '大一点的工作区导出 CSV 又超时了 😩 今天能看下吗？'), url: null },
      body: L('Found it: a missing index makes exports on large workspaces scan the whole table.\n\n- Today: a hotfix that raises the timeout, so exports finish again\n- Tonight: the index migration, which makes them fast\n\nI\'ll ping you once both are out.', '找到原因了：少一个索引，大工作区导出时会扫全表。\n\n- 今天：先上一个 hotfix，调大超时，导出能跑完\n- 今晚：加索引的迁移，之后就快了\n\n两个都上了我再告诉你。'),
    },
    {
      id: 43, kind: 'approve', event: 106, source: 'github', status: 'pending', at: ago(25 * MIN),
      target: { ref: 'web#479' }, context: { who: 'Leo', where: 'web#479', said: L('Small fix, CI is green. Could you approve? 🙏', '小改动，CI 过了，帮忙 approve 一下 🙏'), url: 'https://github.com/example/web/pull/479' }, body: '',
    },
    {
      id: 39, event: 90, thing: 12, source: 'slack', status: 'sent', by: 'you', at: ago(2 * DAY), sentAt: ago(2 * DAY), confirm: { how: 'panel', at: ago(2 * DAY) },
      target: { channel: 'D0DEMO02', ts: '1' }, context: { who: 'Leo', where: L('DM with Leo', 'Leo 的私信'), said: '', url: null },
      body: L('Limits are 100 requests per minute per key; bursts up to 200 are fine.', '每个 key 每分钟 100 次，短时间冲到 200 也没事。'),
    },
    {
      id: 37, event: 85, thing: 15, source: 'slack', status: 'sent', by: 'policy', at: ago(DAY), sentAt: ago(DAY),
      target: { channel: 'C0DEMO03', ts: '2' }, context: { who: 'Ana', where: '#web', said: '', url: null }, body: 'approved ✅',
    },
  ]

  type D = { at: string; event: number; scenario: string; verdict: string; reason: string; what?: { source: string; title: string; from: string; text: string } }
  const decisions: D[] = [
    { at: ago(9 * MIN), event: 109, scenario: 'slack_thread', verdict: 'noted', reason: L('Haiku: a status update in a thread you follow, nothing to do', 'Haiku：你跟着的 thread 里的通报，不用做什么'), what: { source: 'slack', title: '#deploys', from: 'Ana', text: L('web v2.3.1 is out ✅', 'web v2.3.1 发出去了 ✅') } },
    { at: ago(25 * MIN), event: 104, scenario: 'github_review', verdict: 'forwarded', reason: L('The billing session already has this repo; your brief says check tests first', 'billing 那个会话已经开着这个仓库；你的交代是先看测试'), what: { source: 'github', title: 'billing#482', from: 'Leo', text: L('Review requested: Retry webhooks on 5xx', '请你 review：5xx 时重试 webhook') } },
    { at: ago(40 * MIN), event: 101, scenario: 'slack_dm', verdict: 'opened', reason: L('A bug report asking you to look today; no session on exports yet, opened one', '报 bug、要你今天看；还没有会话在做导出，开了一个'), what: { source: 'slack', title: L('DM', '私信'), from: 'Maya', text: L('CSV export times out again for big workspaces 😩 can you take a look today?', '大一点的工作区导出 CSV 又超时了 😩 今天能看下吗？') } },
    { at: ago(HOUR), event: 99, scenario: 'slack_mention', verdict: 'ignored', reason: L('An @here broadcast, not for you specifically', '@here 群发，不是专门找你'), what: { source: 'slack', title: '#random', from: 'Kim', text: L('@here lunch order closes at 11:30 🍜', '@here 午饭 11:30 截单 🍜') } },
    { at: ago(3 * HOUR), event: 96, scenario: 'session_update', verdict: 'asked', reason: L('The release notes are blocked on Sam; whether to wait is your call', '发版说明卡在 Sam 那里；等不等要你定'), what: { source: 'session', title: 'v2.4', from: 'session', text: L('Billing section still missing', 'billing 那段还没有') } },
    { at: ago(5 * HOUR), event: 93, scenario: 'jira_comment', verdict: 'noted', reason: L('QA confirmed the fix on OPS-118', 'QA 确认 OPS-118 修好了'), what: { source: 'jira', title: 'OPS-118', from: 'Tom', text: L('Verified on staging', 'staging 上验证过了') } },
    ...Array.from({ length: 26 }, (_, i): D => ({
      at: ago((i % 6 + 1) * DAY + (i % 5) * HOUR), event: 10 + i,
      scenario: ['slack_thread', 'slack_dm', 'github_review', 'session_update', 'slack_mention', 'jira_assigned'][i % 6]!,
      verdict: ['noted', 'forwarded', 'forwarded', 'noted', 'ignored', 'opened', 'noted', 'asked', 'noted'][i % 9]!,
      reason: L('Handled by your rules', '按你的规矩办了'),
    })),
  ]

  const policy = {
    scenarios: {
      slack_self: { handle: 'command', reply: 'auto' },
      slack_dm: { handle: 'dispatch', reply: 'ask' },
      slack_mention: { handle: 'dispatch', reply: 'ask' },
      slack_thread: { handle: 'note', reply: 'ask' },
      github_review: { handle: 'dispatch', reply: 'ask', brief: L('check tests first', '先看测试') },
      github_mention: { handle: 'dispatch', reply: 'ask' },
      github_comment: { handle: 'dispatch', reply: 'ask' },
      github_assigned: { handle: 'dispatch', reply: 'ask' },
      github_approved: { handle: 'dispatch', reply: 'ask', brief: L('check CI and open comments; ask me before merging', '看 CI 过没过、还有没有没回的评论；能合就问我要不要合，别自己合') },
      github_changes: { handle: 'dispatch', reply: 'ask' },
      jira_assigned: { handle: 'dispatch', reply: 'ask' },
      jira_mention: { handle: 'dispatch', reply: 'ask' },
      jira_comment: { handle: 'note', reply: 'ask' },
      session_update: { handle: 'note', reply: 'ask' },
      other: { handle: 'note', reply: 'ask' },
    },
    custom: [{ id: 1, when: L('Bugs filed by QA on Jira and assigned to me', 'QA 在 Jira 上提给我的 bug'), handle: 'dispatch', reply: 'ask', brief: L('reproduce first, link the failing test in the reply', '先复现，回复里附上失败的测试') }],
    notes: [L('Anything about scheduling needs my OK', '约时间的事都要问我')],
    style: [L('Lead with the answer, keep it to three sentences', '先说结论，三句以内')],
    quick: ['approved ✅'],
    trusted: ['U0DEMOLEO'],
    askAlways: ['C0DEMOVIP'],
    signature: 'agent reply',
    placement: { direct: 'inline', group: 'inline', channel: 'thread', self: 'inline' },
    proposals: [{ id: 1, at: ago(2 * HOUR), text: L('Follow-ups in #deploys threads that only say a deploy finished: just note them', '#deploys 里只说部署完了的 thread 后续，只记下'), basis: L('you marked 3 of these "wrong call: no need to tell me"', '这类消息你标了 3 次「判断错了：不用告诉我」') }],
  }

  const today = new Date(now)
  const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const usageDays = Object.fromEntries(Array.from({ length: 5 }, (_, i) => {
    const d = new Date(today.getTime() - i * DAY)
    const five = [3.1, 4.6, 2.2, 5.0, 3.8][i]!
    return [dayKey(d), { calls: [212, 340, 160, 380, 290][i]!, weight: 1, five, week: five / 8 }]
  }))
  const shareDays = Object.fromEntries(Object.entries(usageDays).map(([day, d], i) => {
    const share = [0.18, 0.21, 0.15, 0.24, 0.2][i]!
    return [day, { share, accountFive: d.five / share, accountWeek: d.week / share, five: d.five, week: d.week }]
  }))

  const json = (x: unknown) => JSON.stringify(x)
  return {
    'config.json': json({ locale: lang }),
    'rules.json': json(policy),
    'data/alive.json': json({ at: ago(5_000) }),
    'data/engine.json': json({ at: ago(8_000), health: { slack: { ok: true, at: ago(MIN), fails: 0 }, github: { ok: true, at: ago(2 * MIN), fails: 0 }, jira: { ok: true, at: ago(3 * MIN), fails: 0 } } }),
    'data/state.json': json({ nextId: 110 }),
    'data/dispatch.json': json(Object.fromEntries(Array.from({ length: 109 }, (_, i) => [i + 1, {}]))),
    'data/things.json': json({ nextThing: 40, nextAsk: 50, things, asks }),
    'data/replies.json': json({ nextId: 50, items: replies }),
    'data/decisions.jsonl': decisions.map(d => json(d)).join('\n'),
    'data/reviews.json': json({ 93: { ok: true, at: ago(4 * HOUR) }, 99: { ok: true, at: ago(50 * MIN) } }),
    'data/sources.json': json({ slack: true, github: true, jira: true }),
    'data/activity.json': json({
      local_demo_exports: { at: ago(6 * MIN), saidAt: ago(6 * MIN), title: 'exports', last: L('Found it: the missing index on exports.created_at. Hotfix PR exports#77 is up; reply to Maya drafted.', '找到了：exports.created_at 少索引。hotfix PR exports#77 提了，给 Maya 的回复写好了。'), permissionMode: 'default', archived: false },
      local_demo_billing: { at: ago(2 * MIN), title: 'billing', last: '', waiting: L('Allow Bash: npm test in billing-service?', '允许运行 Bash：billing-service 里的 npm test？'), permissionMode: 'default', archived: false },
      local_demo_flaky: { at: ago(2 * HOUR), saidAt: ago(2 * HOUR), title: 'payments', last: L('Found an unfrozen clock in the backoff test.', '在退避测试里找到一处没冻结的时钟。'), permissionMode: 'default', archived: false },
      _hub: { permissionMode: 'default' },
    }),
    'data/people.json': json({ U0DEMOLEO: 'Leo' }),
    'data/usage.json': json({ fitted: false, days: shareDays }),
    'data/hub-usage.json': json({ days: Object.fromEntries(Object.entries(usageDays).map(([day, d]) => [day, { calls: d.calls, weight: d.weight }])), now: { at: ago(MIN), context: 96_000, window: 1_000_000, five: 21, week: 9, fiveReset: new Date(now + 3 * HOUR).toISOString(), weekReset: new Date(now + 4 * DAY).toISOString() } }),
    'data/undo.json': json({ nextId: 10, items: [
      { id: 2, at: ago(HOUR), kind: 'mark', label: L('Ignored: #random lunch order', '忽略：#random 午饭截单'), events: [{ id: 99 }] },
      { id: 3, at: ago(9 * MIN), kind: 'mark', label: L('Noted: #deploys v2.3.1 is out', '只记下：#deploys v2.3.1 发出去了'), events: [{ id: 109 }] },
    ] }),
    'data/evals.json': json({ cases: [], runs: [] }),
    'data/key-log.jsonl': '',
  }
}
