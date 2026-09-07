/**
 * 离线验证 app.js 的压缩(compaction)折叠逻辑:
 * 合成一页“旧消息 + compaction/start|summary + checkpoint user/message(replace)”,
 * 断言:checkpoint 摘要不渲染成气泡、被遮蔽旧消息不出现、只有压缩标记、无 chunk 残留。
 * Run: node tools/compact-test.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../public/mobile/app.js', import.meta.url), 'utf8')
const boot = src.indexOf('(async function boot')
if (boot < 0) throw new Error('cannot locate boot')
const head = src.slice(0, boot)
const factory = new Function(head + `; return { foldHistoryEvents, normalizeMessage, shadowRanges };`)
const { foldHistoryEvents, shadowRanges } = factory()
const wrap = (evs) => evs.map((event) => ({ event }))

const msg = (id, role, turn, step, text, extra) => ({
  type: role === 'user' ? 'user/message' : 'assistant/message',
  seq: extra && extra.seq,
  time: 1,
  data: { turn, step, message: { id, role, content: [{ type: 'text', text }], source: extra && extra.source } },
  ...(extra && extra.envelope ? extra.envelope : {}),
})
const chunk = (seq, turn, step, text) => ({ type: 'assistant/chunk', seq, time: 1, data: { turn, step, chunk: { type: 'text-delta', text } } })

let failures = 0
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' -> ' + JSON.stringify(extra)}`)
  if (!cond) failures += 1
}

// —— 一页:两轮旧对话(seq1-10)被压缩,checkpoint(seq13)替换,之后 seq14-15 是新的正常对话 ——
const events = [
  msg('m1', 'user', 1, 0, '旧问题1', { seq: 1 }),
  chunk(2, 1, 0, '旧'), chunk(3, 1, 0, '回'), chunk(4, 1, 0, '答'),
  msg('m2', 'assistant', 1, 0, '旧回答1', { seq: 5 }),
  msg('m3', 'user', 2, 0, '旧问题2', { seq: 6 }),
  chunk(7, 2, 0, '再'), chunk(8, 2, 0, '答'), chunk(9, 2, 0, '一次'),
  msg('m4', 'assistant', 2, 0, '旧回答2', { seq: 10 }),
  { type: 'compaction/start', seq: 11, time: 1, data: { compactionId: 'c1', turn: null } },
  { type: 'compaction/summary', seq: 12, time: 1, data: { compactionId: 'c1', summary: [{ type: 'text', text: '这是一段压缩摘要' }], shadowedSeqs: [1, 5, 6, 10], shadowedTokenCount: 1234, shadowedRange: { start: 1, end: 10 } } },
  { type: 'user/message', seq: 13, time: 1, data: { turn: 3, step: 0, message: { id: 'chk1', role: 'user', content: [{ type: 'text', text: '（压缩指令框架 + 摘要正文,不得作为用户消息展示）' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' } } }, surfaceOp: { op: 'replace', start: 1, end: 10 }, sourceEventSeqs: [11, 12, 1, 5, 6, 10] },
  msg('m5', 'user', 4, 0, '压缩后的新问题', { seq: 14 }),
  msg('m6', 'assistant', 4, 0, '压缩后的新回答', { seq: 15 }),
]

const { items, leftovers, minSeq } = foldHistoryEvents(wrap(events), 'sess-test')

const kinds = items.map((x) => x.kind)
check('返回最小 seq 为 1', minSeq === 1, minSeq)
check('只出现:压缩标记 + 2 条新消息', JSON.stringify(kinds) === JSON.stringify(['compact', 'msg', 'msg']), kinds)
const marker = items[0]
check('标记 kind=compact', marker.kind === 'compact', marker.kind)
check('标记携带 tokens=1234', marker.tokens === 1234, marker.tokens)
check('标记携带遮蔽条数(来自 compaction/summary 的 shadowedSeqs=4)', marker.shadowed === 4, marker.shadowed)
const texts = items.map((x) => (x.kind === 'msg' ? x.parts[0].text : '(marker)'))
check('旧消息与压缩摘要正文均未渲染', JSON.stringify(texts) === JSON.stringify(['(marker)', '压缩后的新问题', '压缩后的新回答']), texts)
check('无 chunk 残留(旧 chunk 全部被折叠)', leftovers.length === 0, leftovers.map((x) => x.id))
check('遮蔽区间已登记并合并', JSON.stringify(shadowRanges.get('sess-test')) === JSON.stringify([{ start: 1, end: 10 }]), shadowRanges.get('sess-test'))

// —— 第二页(更早的历史):全局遮蔽区间应对 seq1-10 内的消息同样生效 ——
const older = [
  msg('m0', 'user', 0, 0, '更早问题', { seq: 1 }),
  msg('m0b', 'assistant', 0, 0, '更早回答', { seq: 5 }),
]
const r2 = foldHistoryEvents(wrap(older), 'sess-test')
check('更早页中被全局遮蔽的消息被跳过', r2.items.length === 0 && r2.leftovers.length === 0, { items: r2.items.length, leftovers: r2.leftovers.length })

console.log(failures === 0 ? 'compact-test: PASS' : `compact-test: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
