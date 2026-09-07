// 只读诊断:遍历 session.history 从最新往最早翻页,输出会话结构地图
// 用法:node hist-inspect.mjs [sessionId] [maxPages]
'use strict';

const SID = process.argv[2] || 'session-038874da-f995-4c13-8e9f-752a3251d32f';
const MAX_PAGES = parseInt(process.argv[3] || '400', 10);
const BASE = 'http://127.0.0.1:3080';

function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'x' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function history(payload) {
  const rpcId = uuid();
  const res = await fetch(BASE + '/api/session.history', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.history', payload }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* ignore */ }
  if (res.status !== 200 || !parsed || parsed.type !== 'server-response') {
    throw new Error('history failed: HTTP ' + res.status + ' ' + text.slice(0, 200));
  }
  const r = parsed.result || {};
  if (r.ok !== true) throw new Error('rpc error: ' + JSON.stringify(r.error));
  return r.value;
}

function snip(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function textOfEvent(ev) {
  const d = ev.data || {};
  const m = d.message || d;
  const c = m.content || [];
  if (Array.isArray(c)) {
    const out = [];
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      else if (b.type === 'reasoning' && typeof b.text === 'string') out.push('⟦reasoning⟧ ' + b.text);
      else if (b.type === 'tool-call') out.push(`⟦tool-call ${b.name}⟧ ${(b.arguments || '').slice(0, 60)}`);
      else if (b.type === 'tool-result') out.push(`⟦tool-result${b.isError ? '!error' : ''}⟧`);
      else if (b.type === 'image') out.push('⟦image⟧');
    }
    return out.join(' | ');
  }
  if (typeof m.text === 'string') return m.text;
  return '';
}

const typeHist = new Map();
let pages = 0;
let totalEvents = 0;
let msgCount = 0;
let floor = null; // 当前页最老 seq
const interesting = []; // 关键消息摘要

const seenFlags = { giant: 0, swipe: 0, compactCard: 0 };

async function main() {
  let beforeSeq = undefined;
  let hasMore = true;
  while (hasMore && pages < MAX_PAGES) {
    const payload = { sessionId: SID, maxMessages: 50 };
    if (beforeSeq != null) payload.beforeSeq = beforeSeq;
    const page = await history(payload);
    hasMore = !!page.hasMore;
    const events = page.events || [];
    if (!events.length) { console.log(`page ${pages + 1}: EMPTY (hasMore=${hasMore})`); break; }
    pages++;
    let minSeq = Infinity, maxSeq = -1;
    const local = new Map();
    let msgs = 0;
    for (const { event } of events) {
      if (!event || typeof event.seq !== 'number') continue;
      totalEvents++;
      if (event.seq < minSeq) minSeq = event.seq;
      if (event.seq > maxSeq) maxSeq = event.seq;
      local.set(event.type, (local.get(event.type) || 0) + 1);
      typeHist.set(event.type, (typeHist.get(event.type) || 0) + 1);
    }
    // 只对每页内的 message 事件做摘要(防止输出爆炸)
    const msgsLog = [];
    for (const { event } of events) {
      if (!event) continue;
      const t = event.type;
      const d = event.data || {};
      if (t === 'user/message' || t === 'assistant/message') {
        msgs++;
        msgCount++;
        const txt = textOfEvent(event);
        const m = d.message || d;
        const isCompact = !!(m && (m.compactionId || (m.metadata && m.metadata.compactionId)));
        const line = `${t === 'user/message' ? 'U' : 'A'}#${event.seq} ${isCompact ? '[COMPACT-MSG] ' : ''}${snip(txt, 110)}`;
        msgsLog.push(line);
        if (txt.includes('先说结论')) { interesting.push(`★ 用户贴的 lan-gate 长文在 seq=${event.seq} (本页 ${msgsLog.length})`); seenFlags.giant = event.seq; }
        if (/左滑|分叉|长按/.test(txt) && txt.length < 500 && t === 'assistant/message') { interesting.push(`≈ 疑似“滑动/分叉”回复 seq=${event.seq}: ${snip(txt, 90)}`); seenFlags.swipe ||= event.seq; }
      } else if (t === 'compaction/summary' || t === 'compaction/start' || t === 'compaction/end') {
        const so = event.surfaceOp;
        interesting.push(`◆ ${t} seq=${event.seq} data=${JSON.stringify(d).slice(0, 160)} surfaceOp=${JSON.stringify(so)}`);
      } else if (event.surfaceOp && event.surfaceOp.op === 'replace') {
        interesting.push(`▤ replace surfaceOp seq=${event.seq} → ${JSON.stringify(event.surfaceOp)}`);
      }
    }
    floor = minSeq;
    const types = [...local.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`page ${pages} seq[${minSeq}..${maxSeq}] events=${events.length} msgs=${msgs} hasMore=${hasMore} | ${types}`);
    for (const l of msgsLog) console.log('   ' + l);
    for (const it of interesting) { console.log('   ' + it); }
    interesting.length = 0;
    beforeSeq = minSeq; // 下一页取更早
    await new Promise((r) => setTimeout(r, 60)); // 别把本地 dsh 打爆
  }
  console.log('----');
  console.log(`pages=${pages} totalEvents=${totalEvents} messages=${msgCount} oldestSeq=${floor} hasMore=${hasMore}`);
  console.log('typeHist:', [...typeHist.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
