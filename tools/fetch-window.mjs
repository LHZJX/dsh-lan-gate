// 只读:拉取主会话最新一页原始事件,把 seq 99 万区间的关键事件原样打印,
// 复刻 app 端 foldHistoryEvents 的判定(compact 标记/遮蔽/大小)。
'use strict';
const SID = 'session-038874da-f995-4c13-8e9f-752a3251d32f';
const res = await fetch('http://127.0.0.1:3080/api/session.history', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'w1', method: 'session.history', payload: { sessionId: SID, maxMessages: 60 } }),
});
const j = await res.json();
const events = (j.result && j.result.value && j.result.value.events) || [];
console.log('page events:', events.length, 'hasMore:', j.result.value.hasMore);

function txtOf(m) {
  const c = m && m.content;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

for (const { event } of events) {
  if (!event) continue;
  const seq = event.seq;
  const d = event.data || {};
  const m = d.message || d;
  // 只关心 999000-999120 与最新几条
  const near = seq >= 999000 && seq <= 999120;
  const isMsg = event.type === 'user/message' || event.type === 'assistant/message';
  if (!near && !isMsg) continue;
  if (isMsg && seq < 976700) continue;
  const txt = txtOf(m);
  const source = m.source ? JSON.stringify(m.source) : '';
  const meta = m.metadata ? JSON.stringify(m.metadata).slice(0, 200) : '';
  const ctypes = Array.isArray(m.content) ? m.content.map((b) => b && b.type).join(',') : '';
  console.log('----');
  console.log(`seq=${seq} type=${event.type} role=${m.role || d.role || ''} len=${txt.length}`);
  console.log(`  contentTypes=[${ctypes}] source=${source} metadata=${meta}`);
  if (seq >= 999000 && seq <= 999120) {
    console.log('  TEXT> ' + txt.slice(0, 260).replace(/\s+/g, ' '));
  }
}
