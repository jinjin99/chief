import { expect, test } from 'claude-code/testing'

import { HUB_COMPACT, hubInstructions } from '../hooks/compact'

test('主会话压缩：没给说明就用 chief 的；你手敲了说明，chief 的接在后面', () => {
  expect(hubInstructions(undefined)).toBe(HUB_COMPACT)
  expect(hubInstructions('  ')).toBe(HUB_COMPACT)
  expect(hubInstructions('保留和同事的讨论')).toBe(`保留和同事的讨论\n\n${HUB_COMPACT}`)
  expect(HUB_COMPACT).toContain('chief 的文件里')
})
