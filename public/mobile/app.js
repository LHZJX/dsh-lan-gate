/* DSH 手机版 —— 独立移动端前端(v4)。
 *
 * v4 界面改造:
 *   1) 会话列表工作区改为手风琴分组:点分组标题展开/收起(状态持久化);
 *   2) 满屏布局(100dvh + 安全区),支持页面全屏切换与 PWA 添加到主屏幕;
 *   3) 打开会话自动定位最底部,滚动离开底部时出现“一键到底”悬浮按钮;
 *   4) 工具调用/思考过程默认收起(点击展开),默认只呈现用户与主 agent 文本;
 *   5) 对话文本支持 Markdown(标题/列表/表格/引用/行内样式),代码块保留;
 *   6) 顶部字符按钮全部换成 SVG 图标;“■ 停止”仅在有任务运行/流式输出时显示;
 *      原黑色方块按钮即为“停止”(session.cancel),未运行时不显示;
 *   7) 历史记录向前分页:向上滚到顶部自动加载更早记录,可一直翻到最早的对话
 *      (session.history 按消息边界分页,beforeSeq=当前最老 seq,hasMore 驱动);
 *   8) 上下文压缩(compaction):被压缩遮蔽的旧内容不展示,checkpoint 的摘要正文
 *      也不展示,只在原位置显示“上下文已压缩”标记;
 *   9) 用户消息正文里被发送端拼入的“运行上下文快照”(Current runtime context /
 *      Current DSH file policy / Approval policy 段)仅展示层过滤,不显示在对话中;
 *   10) 流式思考期间:思考块手动收起/展开状态跨重渲染记忆;自动贴底仅在用户
 *      几乎停在底部时跟随,上滑即停,不再被新内容拽回;
 *   11) 流式增量输出改就地更新(live 气泡不重建):思考框内可正常上下滑动,
 *      展开/收起与框内滚动位置在输出过程中保持不被打断。
 *
 * v3 新增:
 *   1) 会话列表按工作区分组(未分组会话放“其他会话”);
 *   2) 子代理(origin==='subagent')会话不再平铺在列表,而是藏进父会话,
 *      在父会话聊天页底部“子代理会话”区逐级打开(支持多级);
 *   3) 新建会话前弹出工作区选择,可现场新建工作区(输入电脑路径);
 *   4) 会话删除(物理,需 dsh-session-delete 插件)/归档(仅隐藏)。
 *
 * 协议与渲染模型同 v3(unary RPC + events.mux/events.host WS 下行;
 * flow 顺序渲染 msg/live/tool/pending/error;assistant/chunk 增量累积)。
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const LS_LAST_WS = 'dsh.mobile.lastWs';
const LS_WS_CLOSED = 'dsh.mobile.wsClosed';
const LS_BG = 'dsh.mobile.bg'; // 自定义背景 {img, dim} —— 仅存本机浏览器

// ── 工具 ────────────────────────────────────────────────────────────

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const b = window.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  const dt = new Date(ms);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}

function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function pathBase(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ── 传输层 ──────────────────────────────────────────────────────────

async function httpJson(url, body, opts) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: opts && opts.signal,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (res.status !== 200) {
    const msg = parsed && parsed.error ? parsed.error.message : `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return parsed;
}

async function rpc(method, payload = {}, opts) {
  const rpcId = uuid();
  const response = await httpJson('/api/' + method, { type: 'client-request', rpcId, method, payload }, opts);
  if (!response || response.type !== 'server-response' || response.rpcId !== rpcId) {
    throw new Error('传输失败:应答不匹配');
  }
  const result = response.result || {};
  if (result.ok !== true) {
    const err = result.error || {};
    const e = new Error(err.message || `业务错误 ${err.code || 'unknown'}`);
    e.code = err.code;
    throw e;
  }
  return result.value;
}

// ── 状态 ────────────────────────────────────────────────────────────

const state = {
  auth: null,
  loggedIn: false,
  session: null,
  sessions: [],
  workspaces: [],
  archivedIds: new Set(),
  flow: new Map(),
  seqBySession: new Map(),
  running: new Set(),
  navStack: [],
  mux: null, hostWs: null,
  reconnectTimer: null,
  rafPending: false,
};

function ensureFlow(sessionId) {
  let f = state.flow.get(sessionId);
  if (!f) { f = []; state.flow.set(sessionId, f); }
  return f;
}

// ── content 块解析 ──────────────────────────────────────────────────

function contentToParts(blocks) {
  const parts = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    const t = b.type;
    if (t === 'text' && typeof b.text === 'string' && b.text) parts.push({ kind: 'text', text: b.text });
    else if (t === 'reasoning' && b.text) parts.push({ kind: 'reasoning', text: b.text });
    else if (t === 'image' && b.attachment) parts.push({ kind: 'image', attachment: b.attachment });
    else if (t === 'tool-call') parts.push({ kind: 'tool', callId: b.id, name: b.name || 'tool', argsRaw: b.arguments || '', state: 'call' });
    else if (t === 'tool-result') parts.push({ kind: 'tool', callId: b.toolCallId, state: b.isError ? 'error' : 'ok', text: blocksToText(b.content) });
  }
  return parts;
}

function blocksToText(blocks) {
  let out = '';
  for (const b of blocks || []) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}

// ── 会话归类 ────────────────────────────────────────────────────────

function isSubagentSession(s) { return !!(s && s.origin === 'subagent'); }

function childrenOf(sessionId) {
  return state.sessions
    .filter((s) => isSubagentSession(s) && s.parentSessionId === sessionId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function visibleSessions() {
  return state.sessions.filter((s) => !isSubagentSession(s) && !state.archivedIds.has(s.sessionId));
}

function sessionTitleOf(s) {
  const t = s && s.projections && s.projections.values && s.projections.values.title;
  if (t) return t;
  if (s && s.blank) return '新会话';
  return '会话';
}

// ── 数据加载 ────────────────────────────────────────────────────────

async function loadSessions() {
  const { items } = await rpc('session.list');
  state.sessions = items || [];
}

async function loadWorkspaces() {
  const { items, archivedSessionIds } = await rpc('workspace.list');
  state.workspaces = items || [];
  state.archivedIds = new Set(archivedSessionIds || []);
}

/** 折叠一页历史事件为 flow 项。压缩语义:
 *   - 事件带 surfaceOp replace(压缩 checkpoint)→ 该区间内的旧内容被遮蔽,不展示;
 *   - source 标记为 compact 插件的 checkpoint 消息内容(摘要框架)不展示,
 *     只在原位置放一个“上下文已压缩”标记。返回 { items, leftovers, minSeq }。 */
function foldHistoryEvents(events, sessionId) {
  const items = [];
  const chunkAcc = new Map();
  const committed = new Set();
  let minSeq = Infinity;

  // 第一遍:收集本页声明的 replace 遮蔽区间 + 压缩摘要信息(compaction/summary 先于 checkpoint 落页)
  const newRanges = [];
  const summaries = new Map();
  for (const { event } of events || []) {
    if (!event) continue;
    const d = event.data || {};
    if (event.type === 'compaction/summary' && d.compactionId) {
      summaries.set(d.compactionId, {
        tokens: typeof d.shadowedTokenCount === 'number' ? d.shadowedTokenCount : null,
        items: Array.isArray(d.shadowedSeqs) ? fmtItems(d.shadowedSeqs.length) : null,
      });
    }
    const so = event.surfaceOp;
    if (so && so.op === 'replace' && typeof so.start === 'number' && typeof so.end === 'number') {
      newRanges.push({ start: so.start, end: so.end });
    }
  }
  const known = sessionId ? shadowRanges.get(sessionId) || [] : [];
  const ranges = known.concat(newRanges);
  const isSh = (seq) => inShadow(seq, ranges);

  for (const { event } of events || []) {
    if (!event) continue;
    const data = event.data || {};
    const type = event.type;
    if (typeof event.seq === 'number' && event.seq < minSeq) minSeq = event.seq;
    if (type === 'user/message' || type === 'assistant/message') {
      const key = `${data.turn}:${data.step}`;
      const rawMsg = data.message || data;
      if (isSh(event.seq)) { committed.add(key); continue; } // 被压缩遮蔽的旧消息
      const cid = compactOf(rawMsg);
      if (cid) {
        // 压缩 checkpoint:不渲染摘要内容,只放标记
        const info = summaries.get(cid);
        const fallbackShadowed = Array.isArray(event.sourceEventSeqs) ? fmtItems(Math.max(0, event.sourceEventSeqs.length - 2)) : null;
        items.push({
          kind: 'compact', id: 'cmp-' + (rawMsg.id || event.seq), seq: event.seq, compactionId: cid,
          tokens: info && info.tokens, shadowed: (info && info.items) || fallbackShadowed,
        });
        continue;
      }
      const msg = normalizeMessage(rawMsg);
      if (msg) { msg.key = key; msg.seq = event.seq; items.push(msg); committed.add(key); }
    } else if (type === 'assistant/chunk') {
      if (isSh(event.seq)) continue;
      const key = `${data.turn}:${data.step}`;
      let acc = chunkAcc.get(key);
      if (!acc) { acc = { text: '', reasoning: '' }; chunkAcc.set(key, acc); }
      const ch = data.chunk || {};
      if (ch.type === 'text-delta') acc.text += ch.text || '';
      else if (ch.type === 'reasoning-delta') acc.reasoning += ch.text || '';
    } else if (type === 'tool/call') {
      if (isSh(event.seq)) continue;
      items.push({ kind: 'tool', id: 'tool-' + data.callId, callId: data.callId, name: data.name || 'tool', argsRaw: data.arguments || '', state: 'running', startedAt: event.time, seq: event.seq });
    } else if (type === 'tool/result') {
      if (isSh(event.seq)) continue;
      const callId = toolResultCallId(data);
      const item = items.find((x) => x.kind === 'tool' && x.callId === callId);
      if (item) {
        const err = !!(data.error || isErrorResult(data));
        item.state = err ? 'error' : 'ok';
        item.finishedAt = event.time;
        item.output = blocksToText((data.message && data.message.content) || []);
        item.errorMsg = data.error && (data.error.message || data.error.code);
      }
    } else if (type === 'turn/end' && data.reason && data.reason.kind === 'error') {
      if (isSh(event.seq)) continue;
      items.push({ kind: 'error', id: 'err-' + event.seq, message: (data.reason.error && data.reason.error.message) || '回合出错', seq: event.seq });
    }
    // compaction/start|summary|end|prune 等:仅上面收集信息,不单独渲染
  }
  const leftovers = [];
  for (const [key, acc] of chunkAcc) {
    if (!committed.has(key) && (acc.text || acc.reasoning)) {
      leftovers.push({ kind: 'live', id: 'live-' + key, key, text: acc.text, reasoning: acc.reasoning, createdAt: Date.now() });
    }
  }
  if (sessionId) mergeShadowRanges(sessionId, newRanges);
  return { items, leftovers, minSeq };
}

async function loadHistory(sessionId) {
  // 初始页:普通会话 30 条足够;超大会话若已被自适应调小(histPageSize<30),沿用调小后的页宽
  const { events, hasMore } = await rpc('session.history', { sessionId, maxMessages: Math.min(30, histPageSize) });
  const flow = ensureFlow(sessionId);
  flow.length = 0;
  const { items, leftovers, minSeq } = foldHistoryEvents(events, sessionId);
  for (const it of items) flow.push(it);
  for (const it of leftovers) flow.push(it);
  // 兜底:重建后若已出现“上下文已压缩”标记,说明压缩早已完成,清掉进行中状态
  const cmr0 = compactRun.get(sessionId);
  if (cmr0 && cmr0.running && items.some((x) => x.kind === 'compact')) {
    cmr0.running = false; cmr0.done = true; cmr0.reloaded = true;
  }
  let maxSeq = -1;
  for (const { event } of events || []) {
    if (event && typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq;
  }
  state.seqBySession.set(sessionId, maxSeq);
  flowFloors.set(sessionId, { min: Number.isFinite(minSeq) ? minSeq : null, hasMore: !!hasMore });
  if (state.session === sessionId) rerenderChat();
}

let loadingMore = false;
let domPatched = false; // 本次实时事件已就地补丁 DOM(阅读历史时不再整表重建)
const atEndShown = new Set(); // 已在该会话顶部显示“已到最早/压缩到底”提示
let histPageSize = 50; // session.history 每页消息数;超大会话自动调小,避免手机端单页十几 MB 卡死

/** 向前加载更早记录。若某整页全是被压缩遮蔽(无可渲染项)的内容,自动连续向前翻,
 *  直到出现可见内容或翻到最早,避免“卡在遮蔽段”永远到不了顶。 */
async function loadOlder(sessionId) {
  if (loadingMore || !sessionId || atEndShown.has(sessionId)) return;
  const body = document.querySelector('[data-role="chat-body"]');
  const inView = state.session === sessionId && !!body;
  loadingMore = true;
  let mark = null;
  if (inView) {
    mark = el('div', 'msg load-more', '<span class="load-hint">加载更早记录…</span>');
    body.insertBefore(mark, body.firstChild);
  }
  try {
    let pre = [];
    let endReached = false; // 服务端确认已到最早
    for (let guard = 0; guard < 60; guard++) {
      const floor = flowFloors.get(sessionId);
      if (!floor || !floor.min || !floor.hasMore) { endReached = true; break; } // 已到最早
      // 单次请求 30s 超时,避免网络卡死时 loadingMore 永远占位
      const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
      let page;
      try {
        page = await rpc('session.history', { sessionId, beforeSeq: floor.min, maxMessages: histPageSize }, ctrl);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const events = (page && page.events) || [];
      // 超大页自适应:每页事件太多(流式 chunk 全量返回)说明消息跨度大,
      // 自动减小每页消息数,降低手机端单次下载/解析体积;页小了就恢复
      if (events.length > 20000) histPageSize = Math.max(12, Math.round(histPageSize / 2));
      else if (events.length < 6000 && histPageSize < 50) histPageSize = Math.min(50, histPageSize * 2);
      const hasMore = !!(page && page.hasMore);
      if (!events.length) {
        flowFloors.set(sessionId, { min: null, hasMore: false });
        endReached = true;
        break;
      }
      const { items, leftovers, minSeq } = foldHistoryEvents(events, sessionId);
      const flow = ensureFlow(sessionId);
      const have = new Set();
      for (const it of flow) if (it.key) have.add(it.key);
      const pageItems = items.slice();
      for (const it of leftovers) if (!have.has(it.key)) { pageItems.push(it); have.add(it.key); }
      flow.splice(0, 0, ...pageItems);
      flowFloors.set(sessionId, { min: Number.isFinite(minSeq) ? minSeq : null, hasMore: !!hasMore });
      if (pageItems.length) { pre = pageItems; break; }
      // 本页没有可见内容(整页为压缩遮蔽):不插入 DOM,继续向前翻
      if (!hasMore) { endReached = true; break; }
      if (state.session !== sessionId) break; // 用户已离开该会话,停止继续空翻
    }
    if (inView && pre.length && state.session === sessionId) {
      const prevTop = body.scrollTop;
      if (mark && mark.isConnected) mark.remove();
      const prevH = body.scrollHeight;
      const knownIds = knownToolCallIds(sessionId);
      const frag = document.createDocumentFragment();
      for (const it of pre) {
        const node = renderChatItem(it, sessionId, knownIds);
        if (node) frag.appendChild(node);
      }
      body.insertBefore(frag, body.firstChild);
      body.scrollTop = prevTop + (body.scrollHeight - prevH);
      renderImagesAsync(sessionId, body);
      syncChatUi(body);
    } else if (inView && state.session === sessionId) {
      if (mark && mark.isConnected) mark.remove();
      // 顶部没有更多可展示内容:放一条静态提示,避免“无声卡住”看起来像死墙,
      // 并记住状态,防止每次滚到顶都重复发起空翻页
      const fl = flowFloors.get(sessionId);
      if (!pre.length) atEndShown.add(sessionId);
      insertEndMarker(body, sessionId,
        endReached ? '已到最早记录' : '更早内容已全部被上下文压缩遮蔽');
      syncChatUi(body);
    } else if (mark && mark.isConnected) {
      mark.remove(); // 用户已离开该会话:清理临时加载提示
    }
  } catch {
    if (inView && mark && mark.isConnected) {
      // 失败:原地变成可点击的“点此重试”,而不是无声消失(否则顶部像被卡死)
      mark.className = 'msg load-fail-row';
      mark.innerHTML = '<span class="load-fail">加载更早记录失败,点此重试</span>';
      mark.onclick = (ev) => {
        ev.stopPropagation();
        if (loadingMore) return;
        mark.remove();
        loadOlder(sessionId);
      };
    }
    toast('加载更早记录失败');
  } finally {
    loadingMore = false;
  }
}

/** 列表最顶部插入一条“已到最早/更早内容被压缩”的静态提示(不参与 flow,重建时由 rerenderChat 补回)。 */
function insertEndMarker(body, sessionId, text) {
  if (!body || !sessionId || body.querySelector('.msg.at-end')) return;
  const m = el('div', 'msg at-end', `<span class="end-hint">${esc(text || '已到最早记录')}</span>`);
  body.insertBefore(m, body.firstChild);
}

/** 重建后若已知该会话已翻到最早,把静态提示放回列表顶部。 */
function maybeShowEndMarker(body, sid) {
  if (!body || !sid) return;
  const shown = atEndShown.has(sid);
  const fl = flowFloors.get(sid);
  if (!shown && (!fl || fl.hasMore)) return;
  insertEndMarker(body, sid, '已到最早记录');
}

/** 阅读历史(非贴底)时:新工具卡直接追加到聊天列表末尾,与 flow 追加位置一致。 */
function appendToolCardDom(item) {
  const body = document.querySelector('[data-role="chat-body"]');
  if (!body || !state.session) return false;
  const wrap = renderChatItem(item, state.session, new Set());
  if (!wrap) return false;
  body.appendChild(wrap);
  return true;
}

/** 阅读历史(非贴底)时:就地刷新已渲染工具卡的状态/输出,避免整表重建打断阅读。 */
function updateToolCardDom(callId, item) {
  const body = document.querySelector('[data-role="chat-body"]');
  if (!body) return false;
  let card = null;
  for (const c of body.querySelectorAll('.toolcard')) {
    if (c.dataset.tool === callId) { card = c; break; }
  }
  if (!card) return false;
  const tmp = document.createElement('div');
  tmp.innerHTML = toolCardHtml(item);
  const fresh = tmp.firstElementChild;
  if (!fresh) return false;
  card.replaceWith(fresh);
  return true;
}

function toolResultCallId(data) {
  const msg = data.message || {};
  const block = (msg.content || [])[0];
  if (block && block.toolCallId) return block.toolCallId;
  if (msg.source && msg.source.callId) return msg.source.callId;
  return data.callId;
}

function isErrorResult(data) {
  const msg = data.message || {};
  const block = (msg.content || [])[0];
  return !!(block && block.isError);
}

function normalizeMessage(raw) {
  if (!raw || !raw.id || !raw.role) return null;
  return {
    kind: 'msg',
    id: raw.id,
    role: raw.role === 'user' ? 'user' : 'assistant',
    parts: contentToParts(raw.content),
    createdAt: Date.now(),
  };
}

// ── 事件折叠(实时) ─────────────────────────────────────────────────

function applyLiveEvent(sessionId, event) {
  const type = event.type;
  const data = event.data || {};
  const flow = ensureFlow(sessionId);
  let changed = false;
  domPatched = false; // 每次事件重置:默认走整表重建,就地补丁成功则跳过

  // 压缩生命周期 / checkpoint 消息:更新进度状态;标记由 checkpoint 到达后的重建呈现
  if (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end' ||
      ((type === 'user/message' || type === 'assistant/message') && compactOf(data.message || data))) {
    const st2 = compactState(sessionId);
    if (type === 'compaction/start') {
      st2.running = true; st2.done = false; st2.reloaded = false; st2.summarized = false;
      if (!st2.startedAt) st2.startedAt = Date.now();
      changed = true;
    } else if (type === 'compaction/summary') {
      if (typeof data.shadowedTokenCount === 'number') st2.tokens = data.shadowedTokenCount;
      if (Array.isArray(data.shadowedSeqs)) st2.items = data.shadowedSeqs.length;
      st2.summarized = true;
      changed = true;
    } else if (type === 'compaction/end') {
      st2.running = false; st2.done = true;
      if (!st2.reloaded) { st2.reloaded = true; scheduleCompactionReload(sessionId); }
      if (sessionId === state.session && !st2.toasted) {
        st2.toasted = true;
        toast(data.error ? '压缩失败:' + (data.error.message || data.error.code) : compactDoneText(st2));
      }
      changed = true;
    } else {
      // checkpoint(user/message 替换) → 重建以显示“上下文已压缩”标记
      st2.running = false; st2.done = true;
      if (!st2.reloaded) { st2.reloaded = true; scheduleCompactionReload(sessionId); }
      if (sessionId === state.session && !st2.toasted) {
        st2.toasted = true;
        toast(compactDoneText(st2));
      }
      changed = true;
    }
    // 实时同步进度条(开始→显示;摘要→换文案;结束/checkpoint→隐藏),无需整页重绘
    if (sessionId === state.session) updateCompactBar();
    return changed;
  }

  if (type === 'user/message' || type === 'assistant/message') {
    const rawMsg = data.message || data;
    const key = `${data.turn}:${data.step}`;
    const li = flow.findIndex((x) => x.kind === 'live' && x.key === key);
    if (li !== -1) flow.splice(li, 1);
    const idx = flow.findIndex((x) => x.kind === 'msg' && x.id === rawMsg.id);
    const node = normalizeMessage(rawMsg);
    if (!node) return changed;
    if (idx === -1) flow.push(node); else flow[idx] = node;
    if (node.role === 'user') {
      const pIdx = flow.findIndex((x) => x.kind === 'pending' && x.text === blocksToText(rawMsg.content));
      if (pIdx !== -1) flow.splice(pIdx, 1);
    }
    changed = true;
  } else if (type === 'assistant/chunk') {
    const key = `${data.turn}:${data.step}`;
    let it = flow.find((x) => x.kind === 'live' && x.key === key);
    if (!it) {
      it = { kind: 'live', id: 'live-' + key, key, text: '', reasoning: '', createdAt: Date.now() };
      flow.push(it);
    }
    const ch = data.chunk || {};
    if (ch.type === 'text-delta') it.text += ch.text || '';
    else if (ch.type === 'reasoning-delta') it.reasoning += ch.text || '';
    // 增量输出:就地更新已渲染的 live 气泡(思考框/正文),避免整条重渲染打断框内滚动
    if (sessionId === state.session && (ch.type === 'text-delta' || ch.type === 'reasoning-delta')) {
      if (!patchLiveChat(sessionId, it)) changed = true; // 节点尚未创建,仍需整条渲染一次
    }
  } else if (type === 'tool/call') {
    const callId = data.callId;
    if (!flow.some((x) => x.kind === 'tool' && x.callId === callId)) {
      const item = { kind: 'tool', id: 'tool-' + callId, callId, name: data.name || 'tool', argsRaw: data.arguments || '', state: 'running', startedAt: event.time };
      flow.push(item);
      // 阅读历史(非贴底)时:新工具卡直接原地追加,不整表重建打断滚动位置
      if (sessionId === state.session && !stickBottom) domPatched = appendToolCardDom(item);
      changed = true;
    }
  } else if (type === 'tool/result') {
    const callId = toolResultCallId(data);
    const item = flow.find((x) => x.kind === 'tool' && x.callId === callId);
    if (item) {
      const err = !!(data.error || isErrorResult(data));
      item.state = err ? 'error' : 'ok';
      item.finishedAt = event.time;
      item.output = blocksToText((data.message && data.message.content) || []);
      item.errorMsg = data.error && (data.error.message || data.error.code);
      // 阅读历史(非贴底)时:就地刷新工具卡内容(状态/输出),不动整表
      if (sessionId === state.session && !stickBottom) domPatched = updateToolCardDom(callId, item);
      changed = true;
    }
  } else if (type === 'turn/end') {
    const reason = data.reason || {};
    if (reason.kind === 'error') {
      const errMsg = (reason.error && reason.error.message) || '回合出错';
      if (!flow.some((x) => x.kind === 'error' && x.message === errMsg)) {
        flow.push({ kind: 'error', id: 'err-' + (event.seq || uuid()), message: errMsg });
      }
      changed = true;
    }
  }
  if (typeof event.seq === 'number') {
    const last = state.seqBySession.get(sessionId);
    if (typeof last === 'number' && event.seq > last + 1) {
      if (sessionId === state.session) { loadHistory(sessionId); return changed; }
    }
    state.seqBySession.set(sessionId, Math.max(typeof last === 'number' ? last : -1, event.seq));
  }
  if (changed && sessionId === state.session && !domPatched) scheduleRerender();
  return changed;
}

/** 就地增量更新流式 live 气泡:思考框/正文内容就地刷新,元素不重建,
 *  因此思考框内部的滚动位置与手势不会被打断。返回是否定位到已渲染节点。 */
function patchLiveChat(sessionId, it) {
  const body = document.querySelector('[data-role="chat-body"]');
  if (!body || state.session !== sessionId) return false;
  let wrap = null;
  for (const child of body.children) {
    if (child.dataset && child.dataset.live === `${sessionId}:${it.key}`) { wrap = child; break; }
  }
  if (!wrap) return false;
  const bubble = wrap.querySelector('.bubble');
  if (!bubble) return false;
  const typing = bubble.querySelector('.typing');
  const thinkKey = `${sessionId}|live:${it.key}`;
  const thinkOpenNow = thinkOverrides.has(thinkKey) ? thinkOverrides.get(thinkKey) : !it.text;

  if (it.reasoning) {
    let think = bubble.querySelector(':scope > .think');
    if (!think) {
      const tmp = el('div', '', thinkHtml(it.reasoning, thinkKey, !it.text));
      think = tmp.firstElementChild;
      bubble.insertBefore(think, typing);
    } else {
      think.classList.toggle('open', thinkOpenNow);
      const tb = think.querySelector('.think-body');
      if (tb) {
        const wasBottom = tb.scrollTop + tb.clientHeight >= tb.scrollHeight - 12;
        const pos = tb.scrollTop;
        tb.innerHTML = esc(it.reasoning);
        tb.scrollTop = wasBottom ? tb.scrollHeight : Math.min(pos, tb.scrollHeight);
      }
    }
  }
  if (it.text) {
    let md = bubble.querySelector(':scope > .md');
    if (!md) {
      md = el('div', 'md', mdHtml(it.text));
      bubble.insertBefore(md, typing);
    } else {
      md.innerHTML = mdHtml(it.text);
    }
    // 出正文后,无手动覆盖时让思考块收回去(有覆盖则保持用户选择)
    const think2 = bubble.querySelector(':scope > .think');
    if (think2) think2.classList.toggle('open', thinkOverrides.has(thinkKey) ? thinkOverrides.get(thinkKey) : false);
  }
  if (stickBottom) body.scrollTop = body.scrollHeight;
  return true;
}

// ── 事件流 ──────────────────────────────────────────────────────────

function onFrame(frame) {
  const payload = frame.payload || frame;
  const type = payload.type;
  // 审批/选项卡片的 server-request 帧:应答需回显 frame.rpcId(POST /api/respond)
  const frameRpcId = frame && frame.rpcId;
  if (type === 'approval/requested' && payload.sessionId) { onApprovalRequested(frameRpcId, payload); return; }
  if (type === 'approval/resolved' && payload.sessionId) { onApprovalResolved(payload); return; }
  if (type === 'question/requested' && payload.sessionId) { onQuestionRequested(frameRpcId, payload); return; }
  if (type === 'question/resolved' && payload.sessionId) { onQuestionResolved(payload); return; }
  if (type === 'session/subscribed') {
    if (payload.sessionId) state.seqBySession.set(payload.sessionId, typeof payload.lastSeq === 'number' ? payload.lastSeq : -1);
    return;
  }
  if (type === 'session/event' && payload.sessionId && payload.event) {
    applyLiveEvent(payload.sessionId, payload.event);
    return;
  }
  if (type === 'session/projection' && payload.sessionId && payload.key === 'title') {
    const row = state.sessions.find((s) => s.sessionId === payload.sessionId);
    if (row) {
      row.projections = row.projections || { values: {} };
      row.projections.values = row.projections.values || {};
      row.projections.values.title = payload.value;
      if (state.session === payload.sessionId) refreshTitles();
      else renderList();
    }
    return;
  }
  if (type === 'host/session-status') {
    if (payload.running) state.running.add(payload.sessionId);
    else state.running.delete(payload.sessionId);
    if (state.session === payload.sessionId) scheduleRerender();
    return;
  }
  if (type === 'host/session-added' || type === 'host/session-removed' ||
      type === 'host/workspace-changed' || type === 'host/workspace-removed' || type === 'host/workspace-order-changed') {
    reloadLazy();
    return;
  }
  if (type === 'host/agent-error') {
    toast('运行错误:' + (payload.message || ''));
  }
}

function scheduleRerender() {
  if (state.rafPending) return;
  state.rafPending = true;
  requestAnimationFrame(() => {
    state.rafPending = false;
    rerenderChat();
  });
}

function connectStreams() {
  closeStreams();
  const open = (path, handler) => {
    let ws;
    try {
      // https 页面必须用 wss,否则浏览器/WebView 会拒绝明文 WS 混合内容
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${scheme}://${location.host}${path}`);
    } catch { return null; }
    ws.onmessage = (ev) => {
      try { handler(JSON.parse(ev.data)); } catch { /* 坏帧忽略 */ }
    };
    ws.onclose = () => scheduleReconnect();
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    return ws;
  };
  state.mux = open('/api/events.mux', onFrame);
  state.hostWs = open('/api/events.host', onFrame);
}

function closeStreams() {
  try { state.mux && state.mux.close(); } catch { /* ignore */ }
  try { state.hostWs && state.hostWs.close(); } catch { /* ignore */ }
  state.mux = null;
  state.hostWs = null;
}

function scheduleReconnect() {
  if (state.reconnectTimer || !state.loggedIn) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.loggedIn) return;
    connectStreams();
    if (state.session) loadHistory(state.session);
  }, 3000);
}

let listReloadTimer = null;
function reloadLazy() {
  if (listReloadTimer) return;
  listReloadTimer = setTimeout(async () => {
    listReloadTimer = null;
    try {
      await loadSessions();
      await loadWorkspaces();
      renderList();
      if (state.session) scheduleRerender();
    } catch { /* ignore */ }
  }, 600);
}

// ── 登录 ────────────────────────────────────────────────────────────

async function checkAuth() {
  const res = await fetch('/__lanauth/status', { headers: { accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return body || { auth: 'blocked', session: false, hasPassword: false };
}

async function doLogin(password) {
  const res = await fetch('/__lanauth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ password }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (res.status === 200 && body && body.ok === true) return null;
  return (body && body.error && body.error.message) || '登录失败,请重试';
}

async function doLogout() {
  try { await fetch('/__lanauth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* ignore */ }
}

// ── SVG 图标(避免个别机型把字符按钮渲染成豆腐块/黑色方块) ─────────

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  menu: '<circle cx="6" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  bot: '<rect x="4" y="7" width="16" height="11" rx="3"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><path d="M12 7V3"/><circle cx="12" cy="2.2" r="1.2" fill="currentColor" stroke="none"/>',
  warn: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  fold: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  shield: '<path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z"/>',
  ask: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.7 2.7 0 0 1 5.3 1c0 1.5-2.6 2.1-2.6 3.4"/><path d="M12 17h.01"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ── Markdown 渲染(先转义,再行内/块级加工) ─────────────────────────

function inlineMd(s) {
  // s 已是转义后的 HTML
  let out = s;
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (!/^(https?:|mailto:)/i.test(url)) return m; // 仅放行 http(s)/mailto
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

function mdHtml(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inlineMd(esc(l))).join('<br/>')}</p>`);
      para = [];
    }
  };
  const fenceOpen = (ln) => /^(`{3,}|~{3,})(.*)$/.exec(ln.trim());
  const headingOpen = (ln) => /^(#{1,6})\s+(.*)$/.exec(ln.trim());
  const isHr = (ln) => /^([-*_])(\s*\1){2,}\s*$/.test(ln.trim());
  const isQuote = (ln) => /^ {0,3}>/.test(ln);
  const listItem = (ln) => {
    const m = /^([-*+]|\d+[.)])\s+(.*)$/.exec(ln.trim());
    if (!m) return null;
    return { type: /^\d/.test(m[1]) ? 'ol' : 'ul', rest: m[2] };
  };
  const isTableDelim = (ln) => ln.includes('-') && /^\s*\|?[\s:\-|]+\|?\s*$/.test(ln);
  const tableCells = (ln) => ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const startsTable = (ln, next) => !!(ln.includes('|') && next !== undefined && isTableDelim(next));

  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }

    // 1) 围栏代码块:长度感知(外层用 4+ 反引号时,内部 ``` 不会被误判为闭合;也支持 ~~~)
    const fm = fenceOpen(lines[i]);
    if (fm && (fm[1][0] !== '`' || !fm[2].includes('`'))) {
      flushPara();
      const ch = fm[1][0];
      const need = fm[1].length;
      const info = fm[2].trim();
      const body = [];
      i++;
      while (i < lines.length) {
        const c = lines[i].trim();
        if (c && c[0] === ch) {
          const cm = /^(`+|~+)\s*$/.exec(c);
          if (cm && cm[1][0] === ch && cm[1].length >= need) { i++; break; }
        }
        body.push(lines[i]);
        i++;
      }
      out.push(codeBlockHtml(info, body.join('\n')));
      continue;
    }

    // 2) 标题(不要求前后有空行,紧贴正文也能识别)
    const hm = headingOpen(lines[i]);
    if (hm) {
      flushPara();
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${inlineMd(esc(hm[2].replace(/\s+#+\s*$/, '')))}</h${lvl}>`);
      i++;
      continue;
    }

    // 3) 分隔线
    if (isHr(lines[i])) { flushPara(); out.push('<hr/>'); i++; continue; }

    // 4) 引用块(连续 > 行)
    if (isQuote(lines[i])) {
      flushPara();
      const q = [];
      while (i < lines.length && isQuote(lines[i])) {
        q.push(inlineMd(esc(lines[i].replace(/^\s*>\s?/, ''))));
        i++;
      }
      out.push(`<blockquote>${q.join('<br/>')}</blockquote>`);
      continue;
    }

    // 5) 表格(表头 + 分隔行)
    if (startsTable(lines[i], lines[i + 1])) {
      flushPara();
      const head = tableCells(lines[i]);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(tableCells(lines[i]));
        i++;
      }
      let h = `<table><thead><tr>${head.map((c) => `<th>${inlineMd(esc(c))}</th>`).join('')}</tr></thead>`;
      if (rows.length) h += `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(h + '</table>');
      continue;
    }

    // 6) 列表(连续同类条目合并;条目间空行容忍)
    const li0 = listItem(lines[i]);
    if (li0) {
      flushPara();
      const kind = li0.type;
      const items = [];
      while (i < lines.length) {
        const t2 = lines[i].trim();
        if (!t2) { i++; continue; }
        const li = listItem(lines[i]);
        if (!li || li.type !== kind) break;
        items.push(inlineMd(esc(li.rest)));
        i++;
      }
      out.push(`<${kind}><li>${items.join('</li><li>')}</li></${kind}>`);
      continue;
    }

    // 7) 段落(连续普通行,遇到其它块级元素/空行结束)
    const buf = [lines[i]];
    i++;
    while (i < lines.length) {
      const t2 = lines[i].trim();
      if (!t2) break;
      if (fenceOpen(lines[i]) || headingOpen(lines[i]) || isHr(lines[i]) ||
          isQuote(lines[i]) || listItem(lines[i]) || startsTable(lines[i], lines[i + 1])) break;
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${buf.map((l) => inlineMd(esc(l))).join('<br/>')}</p>`);
  }
  return out.join('\n');
}

// ── 折叠状态(工具卡展开集 / 工作区收起集 / 粘底标记) ──────────────

const openTools = new Set(); // callId 集合:已展开的工具卡
const thinkOverrides = new Map(); // "sessionId|itemKey" -> true/false:用户手动展开/收起思考块的记忆(重渲染不重置)
let wsClosed = new Set(); // group key 集合:已收起的组
let stickBottom = false; // 聊天是否应保持贴底(自动滚到最新)
const flowFloors = new Map(); // sessionId -> { min: 已加载最早事件seq, hasMore: 是否还有更早 }
const shadowRanges = new Map(); // sessionId -> [{start,end}]:被压缩(compaction replace)遮蔽的原始事件 seq 区间

/** 压缩 checkpoint 来源:kind=plugin 且 plugin=compact(附带 compactionId)。 */
function compactOf(rawMsg) {
  const s = rawMsg && rawMsg.source;
  if (s && s.kind === 'plugin' && s.plugin === 'compact' && typeof s.compactionId === 'string') return s.compactionId;
  return null;
}
function inShadow(seq, ranges) {
  if (typeof seq !== 'number') return false;
  for (const r of ranges) if (seq >= r.start && seq <= r.end) return true;
  return false;
}
function mergeShadowRanges(sessionId, ranges) {
  if (!ranges || !ranges.length) return;
  const all = (shadowRanges.get(sessionId) || []).concat(ranges).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  shadowRanges.set(sessionId, merged);
}
function fmtTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}
function fmtItems(n) {
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 会话被压缩时(实时收到压缩事件),延迟合并重建一次,让“已压缩”标记尽快出现且数据一致。 */
let compactionReload = null;
function scheduleCompactionReload(sessionId) {
  if (!sessionId) return;
  if (compactionReload) clearTimeout(compactionReload);
  compactionReload = setTimeout(() => {
    compactionReload = null;
    loadHistory(sessionId).catch(() => { /* ignore */ });
  }, 400);
}

/** 每个会话的压缩进行状态(用于进度提示/完成通知):{running, summarized, done, items, tokens, startedAt, reloaded, toasted} */
const compactRun = new Map();
function compactState(sessionId) {
  let st = compactRun.get(sessionId);
  if (!st) { st = {}; compactRun.set(sessionId, st); }
  return st;
}
function compactDoneText(st) {
  let t = '压缩完成';
  const bits = [];
  if (st && st.items) bits.push(`已折叠 ${st.items} 条历史记录`);
  if (st && st.tokens) bits.push(`约 ${fmtTokens(st.tokens)} tokens`);
  return bits.length ? t + ':' + bits.join(',') : t;
}

const COMPACT_BAR_MS = 6 * 60e3; // 进度条最长展示 6 分钟,防止事件丢失时永远挂着

/** 更新“正在压缩”进度条(位于顶栏下方、消息区上方,固定可见,不随消息滚动)。
 *  仅在无事件也超时时自动隐藏;正常结束由 compaction/end 或 checkpoint 置 running=false。 */
function updateCompactBar() {
  const bar = document.querySelector('[data-role="compact-bar"]');
  if (!bar) return;
  const sid = state.session;
  const cmr = sid && compactRun.get(sid);
  const active = !!(cmr && cmr.running && (!cmr.startedAt || Date.now() - cmr.startedAt < COMPACT_BAR_MS));
  bar.classList.toggle('hidden', !active);
  if (active) {
    const txt = bar.querySelector('[data-role="compact-text"]');
    if (txt) txt.textContent = cmr.summarized
      ? '正在压缩上下文…摘要已生成,即将完成'
      : '正在压缩上下文…通常需要数十秒到几分钟';
  }
}

/** 超时兜底:超过 6 分钟仍未结束则隐藏进度条并提示(会话可能过大或事件未送达)。 */
function compactTimeout(sid) {
  setTimeout(() => {
    const st = compactRun.get(sid);
    if (st && st.running) {
      st.running = false; st.timedOut = true;
      updateCompactBar();
      toast('压缩超过 6 分钟仍未完成,已隐藏进度条;请到电脑端查看状态后重试');
    }
  }, COMPACT_BAR_MS);
}

function loadWsClosed() {
  try { wsClosed = new Set(JSON.parse(localStorage.getItem(LS_WS_CLOSED) || '[]')); } catch { wsClosed = new Set(); }
}
function saveWsClosed() {
  try { localStorage.setItem(LS_WS_CLOSED, JSON.stringify(Array.from(wsClosed))); } catch { /* ignore */ }
}
function toggleWsClosed(key) {
  if (wsClosed.has(key)) wsClosed.delete(key); else wsClosed.add(key);
  saveWsClosed();
}

function nearBottom(el, gap) {
  if (gap === undefined) gap = 160;
  return el.scrollHeight - el.scrollTop - el.clientHeight < gap;
}
function scrollBottomEl(el, smooth) {
  try { el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }
  catch { el.scrollTop = el.scrollHeight; }
}

// ── 渲染工具 ────────────────────────────────────────────────────────

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function partsHtml(parts, knownToolCallIds, sid, msgId) {
  const rows = [];
  let ti = 0;
  for (const p of parts) {
    if (p.kind === 'text') rows.push(`<div class="md">${mdHtml(p.text)}</div>`);
    else if (p.kind === 'reasoning') rows.push(thinkHtml(p.text, `${sid || ''}|${msgId || 'm'}#t${ti++}`, false));
    else if (p.kind === 'code') rows.push(codeBlockHtml(p.lang, p.text));
    else if (p.kind === 'image') rows.push(`<div class="msg-image" data-attachment-id="${esc((p.attachment && p.attachment.attachmentId) || '')}">图片…</div>`);
    else if (p.kind === 'tool') {
      if (knownToolCallIds && knownToolCallIds.has(p.callId)) continue;
      rows.push(toolCardHtml({ name: p.name || 'tool', callId: p.callId, state: p.state === 'error' ? 'error' : 'call', argsRaw: p.argsRaw || '', output: '', errorMsg: '' }));
    }
  }
  return rows.join('\n');
}

function codeBlockHtml(lang, text) {
  return `<pre>${lang ? `<span class="pre-lang">${esc(lang)}</span>\n` : ''}${esc(text)}</pre>`;
}

/** 思考块:key 用于跨重渲染记住用户的手动展开/收起;fallbackOpen 是默认态
 * (流式“纯思考”阶段为 true,正文出现后/历史消息为 false)。 */
function thinkHtml(text, key, fallbackOpen) {
  const k = key || '';
  const open = k && thinkOverrides.has(k) ? thinkOverrides.get(k) : !!fallbackOpen;
  return `<div class="think${open ? ' open' : ''}" data-think="${esc(k)}"><button type="button" class="think-head"><span class="think-ic">${icon('zap')}</span>` +
    `<span class="think-txt">思考过程</span><span class="think-caret">${icon('chevron')}</span></button>` +
    `<div class="think-body">${esc(text)}</div></div>`;
}

function knownToolCallIds(sessionId) {
  const ids = new Set();
  for (const it of state.flow.get(sessionId) || []) {
    if (it.kind === 'tool') ids.add(it.callId);
  }
  return ids;
}

function toolCardHtml(t) {
  const duration = t.finishedAt ? fmtDuration(t.finishedAt - t.startedAt) : '';
  const st = t.state || 'call';
  const statusIcon = st === 'error' ? '✕' : st === 'ok' ? '✓' : '…';
  const statusCls = st === 'error' ? 't-err' : st === 'ok' ? 't-ok' : 't-run';
  const open = t.callId && openTools.has(t.callId) ? ' open' : '';
  let body = '';
  if (t.argsRaw) body += `<div class="t-lbl">参数</div><pre>${esc(t.argsRaw)}</pre>`;
  if (t.output) body += `<div class="t-lbl">结果</div><pre>${esc(t.output)}</pre>`;
  if (t.errorMsg) body += `<div class="t-lbl">错误</div><pre class="t-err">${esc(t.errorMsg)}</pre>`;
  return `<div class="toolcard${open}" data-tool="${esc(t.callId || '')}"><button type="button" class="t-head">` +
    `<span class="t-ic">${icon('tool')}</span><span class="t-name">${esc(t.name || 'tool')}</span>` +
    `<span class="t-status ${statusCls}">${statusIcon}</span>` +
    (duration ? `<span class="t-status">${duration}</span>` : '') +
    `<span class="t-caret">${icon('chevron')}</span></button>` +
    `<div class="t-body">${body || '<span class="t-lbl">(运行中,暂无输出)</span>'}</div></div>`;
}

// ── 界面 ────────────────────────────────────────────────────────────

// ── 自定义背景(仅本机保存,不影响其它设备) ─────────────────────────

function loadBg() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_BG) || 'null');
    if (!v || !v.img) return null;
    return {
      img: v.img,
      dim: typeof v.dim === 'number' ? v.dim : 0.62,
      bubble: typeof v.bubble === 'number' ? v.bubble : 1,
      panel: typeof v.panel === 'number' ? v.panel : 1,
      blur: v.blur === true,
    };
  } catch { return null; }
}
function saveBg(bg) {
  try {
    if (bg && bg.img) localStorage.setItem(LS_BG, JSON.stringify({ img: bg.img, dim: bg.dim, bubble: bg.bubble, panel: bg.panel, blur: bg.blur === true }));
    else localStorage.removeItem(LS_BG);
    return true;
  } catch { return false; }
}
/** 应用背景 + 气泡/面板透明度(+可选毛玻璃)。透明度无论有无背景都生效。 */
function applyBg(bg) {
  const b = document.body;
  if (!b) return;
  const bubble = bg && typeof bg.bubble === 'number' ? bg.bubble : 1;
  const panel = bg && typeof bg.panel === 'number' ? bg.panel : 1;
  b.style.setProperty('--bubble-pct', `${Math.round(Math.min(1, Math.max(0, bubble)) * 100)}%`);
  b.style.setProperty('--panel-pct', `${Math.round(Math.min(1, Math.max(0, panel)) * 100)}%`);
  if (!bg || !bg.img) {
    b.style.backgroundImage = '';
    b.classList.remove('bg-on', 'bg-blur');
    return;
  }
  const d = typeof bg.dim === 'number' ? bg.dim : 0.62;
  const safe = String(bg.img).replace(/"/g, '');
  b.style.backgroundImage = `linear-gradient(rgba(5,7,10,${d}), rgba(5,7,10,${d})), url("${safe}")`;
  b.style.backgroundSize = 'cover';
  b.style.backgroundPosition = 'center';
  b.style.backgroundAttachment = 'fixed';
  b.classList.add('bg-on');
  b.classList.toggle('bg-blur', bg.blur === true);
}
/** 读取本地图片并压缩成 dataURL(最长边 1600,JPEG),避免超出 localStorage 容量。 */
function fileToBgData(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const max = 1600;
          const s = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * s));
          const h = Math.max(1, Math.round(img.height * s));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('无法解析该图片'));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

function bgMenu() {
  const saved = loadBg();
  const st = {
    img: saved ? saved.img : '',
    dim: saved ? saved.dim : 0.62,
    bubble: saved ? saved.bubble : 1,
    panel: saved ? saved.panel : 1,
    blur: saved ? saved.blur === true : false,
  };
  const card = el('div', 'login-card', `
    <h1>背景与气泡</h1>
    <p>背景只保存在本机浏览器;气泡透明度控制消息底色的通透程度。</p>
    <div class="bg-preview" data-role="bg-preview"></div>
    <label class="btn btn-ghost" data-role="pick" style="text-align:center">从相册/文件选择…</label>
    <input type="file" accept="image/*" hidden data-role="file" />
    <input type="text" data-role="url" placeholder="或粘贴图片网址(https://…)" style="margin-top:10px" />
    <div class="bg-dim-row"><span>暗化</span><input type="range" min="30" max="85" step="1" data-role="dim" /><span data-role="dimval"></span></div>
    <div class="bg-dim-row"><span>气泡透明度</span><input type="range" min="20" max="100" step="1" data-role="bub" /><span data-role="bubval"></span></div>
    <div class="bg-dim-row"><span>顶栏/输入区透明度</span><input type="range" min="20" max="100" step="1" data-role="pan" /><span data-role="panval"></span></div>
    <div class="bg-dim-row"><label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" data-role="blur" style="width:18px;height:18px;accent-color:var(--accent)" /> 毛玻璃(气泡后背景模糊)</label></div>
    <div class="error"></div>
    <button class="btn" type="button" data-role="ok">应用</button>
    <button class="btn btn-ghost" type="button" data-role="clear">清除背景</button>
    <button class="btn btn-ghost" type="button" data-role="cancel">取消</button>`);
  const preview = card.querySelector('[data-role="bg-preview"]');
  const fileEl = card.querySelector('[data-role="file"]');
  const urlEl = card.querySelector('[data-role="url"]');
  const dimEl = card.querySelector('[data-role="dim"]');
  const dimVal = card.querySelector('[data-role="dimval"]');
  const bubEl = card.querySelector('[data-role="bub"]');
  const bubVal = card.querySelector('[data-role="bubval"]');
  const panEl = card.querySelector('[data-role="pan"]');
  const panVal = card.querySelector('[data-role="panval"]');
  const blurEl = card.querySelector('[data-role="blur"]');
  const err = card.querySelector('.error');
  const paint = () => { applyBg(st); };
  const refresh = () => {
    preview.innerHTML = st.img ? `<img src="${st.img.replace(/"/g, '')}">` : '<span>未设置</span>';
    urlEl.value = /^data:/.test(st.img) ? '' : st.img;
    dimEl.value = Math.round(st.dim * 100);
    dimVal.textContent = dimEl.value + '%';
    bubEl.value = Math.round(st.bubble * 100);
    bubVal.textContent = bubEl.value + '%';
    panEl.value = Math.round(st.panel * 100);
    panVal.textContent = panEl.value + '%';
    blurEl.checked = st.blur === true;
  };
  dimEl.oninput = () => { st.dim = Number(dimEl.value) / 100; dimVal.textContent = dimEl.value + '%'; paint(); };
  bubEl.oninput = () => { st.bubble = Number(bubEl.value) / 100; bubVal.textContent = bubEl.value + '%'; paint(); };
  panEl.oninput = () => { st.panel = Number(panEl.value) / 100; panVal.textContent = panEl.value + '%'; paint(); };
  blurEl.onchange = () => { st.blur = blurEl.checked; paint(); };
  card.querySelector('[data-role="pick"]').onclick = () => fileEl.click();
  fileEl.onchange = async () => {
    const f = fileEl.files && fileEl.files[0];
    if (!f) return;
    try {
      st.img = await fileToBgData(f);
      err.textContent = '';
      refresh(); paint();
    } catch (e) {
      err.textContent = '图片读取失败:' + e.message;
    }
  };
  urlEl.onchange = () => {
    const v = (urlEl.value || '').trim();
    if (v) { st.img = v; refresh(); paint(); }
  };
  card.querySelector('[data-role="ok"]').onclick = () => {
    if (st.img) {
      if (!saveBg(st)) { err.textContent = '保存失败:图片过大,请换小图或使用网址'; return; }
      applyBg(st);
      hideModal();
      toast('已应用背景与气泡透明度');
    } else {
      saveBg(null);
      applyBg(null);
      hideModal();
      toast('已清除背景(气泡恢复不透明)');
    }
  };
  card.querySelector('[data-role="clear"]').onclick = () => {
    st.img = '';
    refresh(); paint();
  };
  card.querySelector('[data-role="cancel"]').onclick = () => {
    applyBg(saved); // 还原为已保存状态,预览不残留
    hideModal();
  };
  refresh(); paint();
  showModal(card);
}

function shellHtml() {
  return `
    <div class="view view-list active" data-view="list">
      <div class="topbar">
        <span class="title" data-role="list-title">会话</span>
        <button class="iconbtn" data-act="new-session" title="新会话">${icon('plus')}</button>
        <button class="iconbtn" data-act="workspaces" title="工作区">${icon('folder')}</button>
        <button class="iconbtn" data-act="bg" title="自定义背景">${icon('image')}</button>
      </div>
      <div class="list-scroll" data-role="list-body"></div>
    </div>
    <div class="view view-chat" data-view="chat">
      <div class="topbar">
        <button class="iconbtn" data-act="back" title="返回">${icon('back')}</button>
        <span class="title" data-role="chat-title"></span>
        <button class="iconbtn hidden" data-act="cancel" title="停止当前回合">${icon('stop')}</button>
        <button class="iconbtn" data-act="fullscreen" title="全屏/退出全屏">${icon('fullscreen')}</button>
        <button class="iconbtn" data-act="chat-menu" title="菜单">${icon('menu')}</button>
      </div>
      <div class="compact-bar hidden" data-role="compact-bar"><span class="load-hint"><span data-role="compact-text">正在压缩上下文…</span></span></div>
      <div class="chat-scroll" data-role="chat-body"></div>
      <button class="fab" data-act="goto-bottom" title="回到底部">${icon('down')}</button>
      <div class="composer">
        <textarea data-role="composer-input" placeholder="发消息…" rows="1" enterkeyhint="newline"></textarea>
        <button class="send" data-act="send" title="发送">${icon('send')}</button>
      </div>
    </div>
    <div class="modal hidden" data-role="modal"></div>`;
}

function viewLogin(auth) {
  const card = el('div', 'login-card', `
    <h1>DSH 手机版</h1>
    <p>连接电脑上的 DeepSeek Harness(局域网)</p>
    <input type="password" placeholder="访问密码" autocomplete="current-password" />
    <div class="error"></div>
    <button class="btn" type="button">登录</button>
    ${auth.auth === 'blocked' ? '<p class="hint">尚未设置访问密码:请在电脑 127.0.0.1 的 设置 → 局域网访问 中设置。</p>' : ''}
  `);
  const input = card.querySelector('input');
  const err = card.querySelector('.error');
  const btn = card.querySelector('.btn');
  const submit = async () => {
    if (btn.disabled) return;
    if (!input.value) { err.textContent = '请输入访问密码'; return; }
    btn.disabled = true; btn.textContent = '登录中…';
    const failure = await doLogin(input.value);
    btn.disabled = false; btn.textContent = '登录';
    if (failure) { err.textContent = failure; input.focus(); return; }
    startApp();
  };
  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  input.focus();
  return card;
}

// ── 会话列表(按工作区分组) ────────────────────────────────────────

function groupedSessions() {
  const visible = visibleSessions();
  const groups = [];
  const assigned = new Set();
  for (const w of state.workspaces) {
    const rows = visible
      .filter((s) => (w.sessionIds || []).includes(s.sessionId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const s of rows) assigned.add(s.sessionId);
    groups.push({ key: w.workspaceId, title: w.title || pathBase(w.path) || '工作区', path: w.path, rows });
  }
  const rest = visible.filter((s) => !assigned.has(s.sessionId)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (rest.length) groups.push({ key: 'other', title: '其他会话', path: '', rows: rest });
  return groups.filter((g) => g.rows.length);
}

function renderList() {
  const body = document.querySelector('[data-role="list-body"]');
  if (!body) return;
  const ptr = ensurePtrEl(body); // 下拉刷新指示器(重绘后保持在列表最前)
  body.replaceChildren();
  if (ptr) body.appendChild(ptr);
  const groups = groupedSessions();
  if (!groups.length) {
    body.appendChild(el('div', 'placeholder', '暂无会话,点右上角加号新建。'));
    return;
  }
  for (const g of groups) {
    const grp = el('div', 'group' + (wsClosed.has(g.key) ? ' closed' : ''));
    const head = el('button', 'group-title',
      `<span class="g-name"><span class="g-text">${esc(g.title)}</span><span class="g-count">${g.rows.length}</span></span>` +
      `<span class="g-caret">${icon('chevron')}</span>`);
    head.type = 'button';
    head.onclick = () => { toggleWsClosed(g.key); grp.classList.toggle('closed'); };
    const bodyWrap = el('div', 'group-body');
    for (const s of g.rows) {
      const front = el('div', 'sess-item swipe-front', `
        <div class="s-title">${esc(sessionTitleOf(s))}</div>
        <div class="s-meta">${s.running ? '<span class="s-dot">● 运行中</span>' : ''}<span>${timeAgo(s.updatedAt)}</span></div>
      `);
      front.onclick = () => openSession(s.sessionId);
      const acts = el('div', 'swipe-actions');
      const act = (cls, label, fn) => {
        const b = el('button', 'sw-act ' + cls, label);
        b.type = 'button';
        b.onclick = (ev) => { ev.stopPropagation(); fn(); };
        return b;
      };
      acts.appendChild(act('act-del', '删除', () => confirmDelete(s.sessionId)));
      acts.appendChild(act('act-fork', '分叉', () => forkList(s.sessionId)));
      acts.appendChild(act('act-arc', '归档', () => confirmArchive(s.sessionId)));
      const sw = el('div', 'swipe');
      sw.appendChild(acts);
      sw.appendChild(front);
      bodyWrap.appendChild(sw);
    }
    grp.appendChild(head);
    grp.appendChild(bodyWrap);
    body.appendChild(grp);
  }
}

function refreshTitles() {
  const t = document.querySelector('[data-role="chat-title"]');
  if (t && state.session) {
    const s = state.sessions.find((x) => x.sessionId === state.session);
    t.textContent = sessionTitleOf(s) + (isSubagentSession(s) ? ' · 子代理' : '');
  }
}

// ── 打开/关闭会话(带子代理导航栈) ────────────────────────────────

async function openSession(sessionId, quiet) {
  if (state.session !== sessionId) state.navStack.push(sessionId);
  state.session = sessionId;
  // 进入会话时在浏览器/ArkWeb 历史中留一条记录:返回键/侧滑可逐级后退到列表
  if (!quiet) {
    histStack.push({ v: 'chat', sid: sessionId });
    try { history.pushState({ v: 'chat', sid: sessionId }, ''); } catch (e) { /* ignore */ }
  }
  stickBottom = true; // 进入会话总是从最新(底部)开始
  document.querySelector('[data-view="list"]').classList.remove('active');
  document.querySelector('[data-view="chat"]').classList.add('active');
  const input = document.querySelector('[data-role="composer-input"]');
  if (input) { input.value = ''; input.style.height = ''; }
  await loadHistory(sessionId);
  refreshTitles();
  rerenderChat();
  // 若已加载内容不足一屏(几乎不滚动),自动继续向前翻页直到可滚动或到最早
  for (let k = 0; k < 10; k++) {
    const fl = flowFloors.get(sessionId);
    const b = document.querySelector('[data-role="chat-body"]');
    if (!fl || !fl.hasMore || !b || b.scrollHeight - b.clientHeight > 4) break;
    await loadOlder(sessionId);
  }
}

function backFromChat() {
  if (state.navStack.length > 1) {
    state.navStack.pop();
    const parentId = state.navStack[state.navStack.length - 1];
    state.session = parentId;
    stickBottom = true;
    loadHistory(parentId).then(() => { refreshTitles(); rerenderChat(); });
    return;
  }
  backToList();
}

function backToList() {
  state.session = null;
  state.navStack = [];
  document.querySelector('[data-view="chat"]').classList.remove('active');
  document.querySelector('[data-view="list"]').classList.add('active');
  renderList();
}

// ── 新建会话(选工作区) ────────────────────────────────────────────

function defaultWorkspaceId() {
  const last = localStorage.getItem(LS_LAST_WS);
  if (last && state.workspaces.some((w) => w.workspaceId === last)) return last;
  return null;
}

async function newSession() {
  await loadWorkspaces();
  if (!state.workspaces.length) {
    toast('请先创建工作区(电脑上已存在的文件夹)');
    askPath(true);
    return;
  }
  showWorkspacePicker();
}

function showWorkspacePicker() {
  const box = el('div', 'menu');
  box.appendChild(el('div', 'menu-title', '选择工作区以新建会话'));
  const current = defaultWorkspaceId();
  let selected = current || state.workspaces[0].workspaceId;
  for (const w of state.workspaces) {
    const item = el('div', 'menu-item' + (w.workspaceId === selected ? ' selected' : ''),
      `${esc(w.title || pathBase(w.path))}<span class="m-sub">${esc(w.path)} · ${(w.sessionIds || []).length} 个会话</span>`);
    item.onclick = () => {
      selected = w.workspaceId;
      box.querySelectorAll('.menu-item').forEach((n) => n.classList.remove('selected'));
      item.classList.add('selected');
    };
    box.appendChild(item);
  }
  const actions = el('div', 'menu-actions');
  const okBtn = el('button', 'btn', '在此工作区新建会话');
  okBtn.onclick = async () => {
    hideModal();
    await createSessionIn(selected);
  };
  const newWsBtn = el('button', 'btn btn-ghost', '新建工作区…');
  newWsBtn.onclick = () => { hideModal(); askPath(true); };
  actions.appendChild(okBtn);
  actions.appendChild(newWsBtn);
  box.appendChild(actions);
  showModal(box);
}

async function createSessionIn(workspaceId) {
  if (!workspaceId) { toast('请先创建工作区'); return; }
  try {
    localStorage.setItem(LS_LAST_WS, workspaceId);
    const { sessionId } = await rpc('session.create', { workspaceId });
    await loadSessions();
    renderList();
    await openSession(sessionId);
    focusComposer();
  } catch (e) {
    toast('新建失败:' + e.message);
  }
}

function askPath(createWorkspaceOnly) {
  const card = el('div', 'login-card', `
    <h1>新建工作区</h1>
    <p>输入电脑上已存在的文件夹路径(手机无法浏览电脑文件)</p>
    <input type="text" placeholder="例如 E:\\my_code\\dshChats" />
    <div class="error"></div>
    <button class="btn" type="button">创建</button>
    <button class="btn btn-ghost" type="button">取消</button>`);
  const input = card.querySelector('input');
  const err = card.querySelector('.error');
  const okBtn = card.querySelector('.btn');
  card.querySelector('.btn-ghost').onclick = hideModal;
  const submit = async () => {
    const path = (input.value || '').trim();
    if (!path) { err.textContent = '请输入路径'; return; }
    okBtn.disabled = true; okBtn.textContent = '创建中…';
    try {
      const { workspace } = await rpc('workspace.create', { path });
      hideModal();
      await loadWorkspaces();
      localStorage.setItem(LS_LAST_WS, workspace.workspaceId);
      toast('已创建工作区');
      if (createWorkspaceOnly) {
        showWorkspacePicker();
      }
    } catch (e) {
      err.textContent = e.message;
      okBtn.disabled = false; okBtn.textContent = '创建';
    }
  };
  okBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  showModal(card);
  setTimeout(() => input.focus(), 50);
}

// ── 会话菜单 / 删除(物理)与归档(隐藏) ──────────────────────────────

/** 探测 dsh-session-delete 插件的删除路由是否已注册(结果缓存)。 */
let deletePluginReady = null;
function checkDeletePlugin() {
  if (deletePluginReady !== null) return deletePluginReady;
  deletePluginReady = fetch('/plugins/session-delete', { method: 'GET' })
    .then((res) => res.status === 405 || res.status === 400)
    .catch(() => false);
  return deletePluginReady;
}

/** 调用 dsh-session-delete 的宿主路由做物理删除;返回 null=成功,否则错误文案。 */
async function deleteSessionNow(sessionId) {
  try {
    const res = await fetch('/plugins/session-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (res.ok && body && body.ok === true) return null;
    return (body && body.error && body.error.message) || `删除失败(HTTP ${res.status})`;
  } catch (e) {
    return '删除失败:' + e.message;
  }
}

/** 重命名会话(session.rename,与电脑版一致)。 */
function renameSession() {
  const sid = state.session;
  if (!sid) return;
  const s = state.sessions.find((x) => x.sessionId === sid);
  const card = el('div', 'login-card', `
    <h1>重命名会话</h1>
    <p>新标题会显示在会话列表与顶部。</p>
    <input type="text" data-role="name" value="${esc(sessionTitleOf(s))}" />
    <div class="error"></div>
    <button class="btn" type="button" data-role="ok">保存</button>
    <button class="btn btn-ghost" type="button" data-role="cancel">取消</button>`);
  const inp = card.querySelector('[data-role="name"]');
  const err = card.querySelector('.error');
  const okBtn = card.querySelector('[data-role="ok"]');
  card.querySelector('[data-role="cancel"]').onclick = hideModal;
  const submit = async () => {
    const t = (inp.value || '').trim();
    if (!t) { err.textContent = '标题不能为空'; return; }
    okBtn.disabled = true; okBtn.textContent = '保存中…';
    try {
      await rpc('session.rename', { sessionId: sid, title: t });
      hideModal();
      await loadSessions();
      refreshTitles();
      renderList();
      toast('已重命名');
    } catch (e) {
      err.textContent = e.message;
      okBtn.disabled = false; okBtn.textContent = '保存';
    }
  };
  okBtn.onclick = submit;
  inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  showModal(card);
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}

/** 触发上下文压缩(等效电脑版在输入框输入 /compact)。 */
async function compactNow() {
  const sid = state.session;
  if (!sid) return;
  const st = compactState(sid);
  st.running = true; st.done = false; st.summarized = false; st.reloaded = false; st.toasted = false;
  if (!st.startedAt) st.startedAt = Date.now();
  compactTimeout(sid);  // 超时兜底:6 分钟未完成自动隐藏并提示
  updateCompactBar();   // 立即显示顶栏下方的进度条
  rerenderChat();       // 重绘消息区(同时会同步进度条状态)
  try {
    await rpc('commands/execute', { args: { agentId: sid, line: '/compact', images: [] } });
    toast('已触发压缩,顶部会出现进度提示,完成后自动显示“上下文已压缩”标记');
  } catch (e) {
    st.running = false;
    rerenderChat();
    toast('压缩失败:' + e.message);
  }
}

/** 长按某条消息 → “从此分叉”(session.fork,atSeq=该消息 seq)。 */
/** 会话列表级分叉:从该会话末尾(最后一个完整回合)复制出新分支,原会话保持不变。 */
function forkList(sid) {
  if (!sid) return;
  const box = el('div', 'menu');
  box.appendChild(el('div', 'menu-title', '分叉会话'));
  box.appendChild(el('div', 'menu-hint', '从该会话末尾(最后一个完整回合)复制出一个新分支继续对话,原会话保持不变。'));
  const go = el('div', 'menu-item accent', '分叉为新会话');
  go.onclick = async () => {
    hideModal();
    try {
      const { sessionId } = await rpc('session.fork', { sessionId: sid });
      await loadSessions();
      await loadWorkspaces();
      renderList();
      await openSession(sessionId);
      toast('已分叉,可直接输入继续');
    } catch (e) {
      toast('分叉失败:' + e.message);
    }
  };
  box.appendChild(go);
  const cl = el('div', 'menu-item', '取消');
  cl.onclick = hideModal;
  box.appendChild(cl);
  showModal(box);
}

function chatMenu() {
  if (!state.session) return;
  const box = el('div', 'menu');
  box.appendChild(el('div', 'menu-title', '会话操作'));
  const s = state.sessions.find((x) => x.sessionId === state.session);
  box.appendChild(el('div', 'menu-item', `当前:${esc(sessionTitleOf(s))}<span class="m-sub">${isSubagentSession(s) ? '子代理会话' : '主会话'}</span>`));
  const ren = el('div', 'menu-item', '重命名会话');
  ren.onclick = () => { hideModal(); renameSession(); };
  box.appendChild(ren);
  const cmp = el('div', 'menu-item', '压缩上下文(等效 /compact)');
  cmp.onclick = () => { hideModal(); compactNow(); };
  box.appendChild(cmp);
  const del = el('div', 'menu-item accent', '删除会话记录(不可恢复)');
  del.onclick = () => { hideModal(); confirmDelete(); };
  box.appendChild(del);
  const arc = el('div', 'menu-item', '归档此会话(仅隐藏,数据保留)');
  arc.onclick = () => { hideModal(); confirmArchive(); };
  box.appendChild(arc);
  box.appendChild(el('div', 'menu-hint', '会话列表:向左滑动会话行 = 删除 / 分叉 / 归档。删除需电脑端 dsh-session-delete 插件;运行中的会话无法删除。'));
  showModal(box);
}

function confirmDelete(sid) {
  sid = sid || state.session;
  if (!sid) return;
  const card = el('div', 'login-card', `
    <h1>永久删除此会话?</h1>
    <p>删除后将从列表移除,其全部聊天记录(日志文件)将被<b>永久删除且不可恢复</b>。正在运行的会话无法删除。</p>
    <div class="error"></div>
    <button class="btn" type="button" data-role="ok">永久删除</button>
    <button class="btn btn-ghost" type="button" data-role="cancel">取消</button>`);
  const err = card.querySelector('.error');
  const okBtn = card.querySelector('[data-role="ok"]');
  card.querySelector('[data-role="cancel"]').onclick = hideModal;
  okBtn.onclick = async () => {
    okBtn.disabled = true; okBtn.textContent = '删除中…';
    const ready = await checkDeletePlugin();
    if (!ready) {
      err.textContent = '未检测到删除插件(dsh-session-delete),已改用归档。';
      okBtn.disabled = false; okBtn.textContent = '永久删除';
      setTimeout(() => { hideModal(); confirmArchive(); }, 900);
      return;
    }
    const failure = await deleteSessionNow(sid);
    if (failure) {
      err.textContent = failure;
      okBtn.disabled = false; okBtn.textContent = '永久删除';
      return;
    }
    hideModal();
    toast('已永久删除');
    try {
      await loadSessions();
      await loadWorkspaces();
    } catch { /* ignore */ }
    if (state.session === sid) backToList();
    else renderList();
  };
  showModal(card);
}

function confirmArchive(sid) {
  sid = sid || state.session;
  if (!sid) return;
  const card = el('div', 'login-card', `
    <h1>归档此会话?</h1>
    <p>归档后将从手机会话列表移除。数据仍保留在电脑端(可在电脑端管理)。子代理会话会随父会话一并归档。</p>
    <div class="error"></div>
    <button class="btn" type="button" data-role="ok">归档</button>
    <button class="btn btn-ghost" type="button" data-role="cancel">取消</button>`);
  const err = card.querySelector('.error');
  const okBtn = card.querySelector('[data-role="ok"]');
  card.querySelector('[data-role="cancel"]').onclick = hideModal;
  okBtn.onclick = async () => {
    okBtn.disabled = true; okBtn.textContent = '归档中…';
    try {
      const { archivedSessionIds } = await rpc('workspace.archiveSession', { sessionId: sid });
      state.archivedIds = new Set(archivedSessionIds || []);
      await loadSessions();
      hideModal();
      toast('已归档');
      if (state.session === sid) backToList();
      else renderList();
    } catch (e) {
      err.textContent = '归档失败:' + e.message;
      okBtn.disabled = false; okBtn.textContent = '归档';
    }
  };
  showModal(card);
}

// ── 工作区菜单 ─────────────────────────────────────────────────────

function workspaceMenu() {
  const box = el('div', 'menu');
  box.appendChild(el('div', 'menu-title', '工作区(新建会话的归属)'));
  if (!state.workspaces.length) box.appendChild(el('div', 'menu-hint', '暂无工作区,先创建一个:'));
  for (const w of state.workspaces) {
    const item = el('div', 'menu-item', `${esc(w.title || pathBase(w.path))}<span class="m-sub">${esc(w.path)} · ${(w.sessionIds || []).length} 个会话</span>`);
    item.onclick = () => {
      localStorage.setItem(LS_LAST_WS, w.workspaceId);
      hideModal();
      toast('已设为新建会话的默认工作区');
    };
    box.appendChild(item);
  }
  const create = el('div', 'menu-item accent', '+ 新建工作区(输入电脑上的路径)');
  create.onclick = () => { hideModal(); askPath(false); };
  box.appendChild(create);
  showModal(box);
}

// ── 聊天渲染 ───────────────────────────────────────────────────────

/** 去掉平台注入进用户消息正文的运行上下文快照(Current runtime context / DSH file policy /
 *  Approval policy 段)—— 这些不是用户真实发言,仅在本会话的发送端被拼进了消息文本。 */
function stripInjectedContext(text) {
  const paras = String(text).split(/\n{2,}/);
  const kept = paras.filter((p) => {
    const t = p.trim();
    return !/^Current runtime context\./.test(t) &&
           !/^Current DSH file policy:/.test(t) &&
           !/^Approval policy:/.test(t) &&
           !/^This snapshot supersedes earlier runtime-context snapshots/.test(t);
  });
  return kept.join('\n\n');
}
function sanitizeTextPart(p) {
  if (p && p.kind === 'text') return { ...p, text: stripInjectedContext(p.text) };
  return p;
}

function renderChatItem(it, sessionId, knownIds) {
  if (it.kind === 'msg') {
    let parts = it.parts;
    if (it.role === 'user') {
      // 平台注入的运行上下文快照逐段过滤;整条过滤后为空 → 不渲染空气泡
      parts = it.parts.map(sanitizeTextPart).filter((p) => !(p && p.kind === 'text' && !String(p.text).trim()));
      if (!parts.length) return null;
    }
    const wrap = el('div', `msg ${it.role}`);
    const bubble = el('div', 'bubble');
    bubble.innerHTML = partsHtml(parts, knownIds, sessionId, it.id);
    wrap.appendChild(bubble);
    return wrap;
  }
  if (it.kind === 'live') {
    const wrap = el('div', 'msg assistant');
    wrap.dataset.live = `${sessionId}:${it.key}`; // 供增量更新定位,避免整条重建
    const bubble = el('div', 'bubble');
    const html = [];
    // 纯思考阶段默认展开;用户手动收起/展开会被记住(重渲染不重置)
    if (it.reasoning) html.push(thinkHtml(it.reasoning, `${sessionId}|live:${it.key}`, !it.text));
    if (it.text) html.push(`<div class="md">${mdHtml(it.text)}</div>`);
    html.push('<span class="typing"></span>');
    bubble.innerHTML = html.join('\n');
    wrap.appendChild(bubble);
    return wrap;
  }
  if (it.kind === 'tool') {
    const wrap = el('div', 'msg tool');
    wrap.innerHTML = toolCardHtml(it);
    return wrap;
  }
  if (it.kind === 'compact') {
    // 压缩标记:不展示被压缩/摘要内容
    const bits = [];
    if (it.shadowed) bits.push(`${it.shadowed} 条历史记录`);
    if (it.tokens) bits.push(`约 ${fmtTokens(it.tokens)} tokens`);
    const detail = bits.length ? ' ' + esc(`(${bits.join(', ')})`) : '';
    const wrap = el('div', 'msg compact');
    wrap.innerHTML = `<div class="compact-marker"><span class="c-ic">${icon('fold')}</span><span>上下文已压缩${detail}</span></div>`;
    return wrap;
  }
  if (it.kind === 'pending') {
    const wrap = el('div', 'msg user');
    wrap.innerHTML = `<div class="bubble"><div class="md">${mdHtml(it.text)}</div><span class="typing"></span></div>`;
    return wrap;
  }
  if (it.kind === 'error') {
    return el('div', 'msg error-note', `<span class="e-ic">${icon('warn')}</span><span>${esc(it.message)}</span>`);
  }
  return null;
}

function rerenderChat() {
  const body = document.querySelector('[data-role="chat-body"]');
  if (!body || !state.session) return;
  const sid = state.session;
  const flow = state.flow.get(sid) || [];
  const knownIds = knownToolCallIds(sid);
  // 用户上翻阅读时重建:记录原滚动位置,重建后恢复(防止整表重建把阅读位置拽走/归零)
  const keepPos = (!stickBottom && body.scrollHeight > body.clientHeight && body.scrollTop > 0) ? body.scrollTop : 0;
  body.replaceChildren();
  updateCompactBar(); // 压缩进度条:固定在顶栏下方,不随消息滚动(旧实现放在滚动区顶部,长会话里根本看不到)
  for (const it of flow) {
    const node = renderChatItem(it, sid, knownIds);
    if (node) body.appendChild(node);
  }
  if (state.running.has(sid) && !flow.some((x) => x.kind === 'live' || x.kind === 'pending')) {
    body.appendChild(el('div', 'msg assistant', '<div class="bubble typing">思考中</div>'));
  }
  // 子代理会话入口(可多级,头部可收起)
  const kids = childrenOf(sid);
  if (kids.length) {
    const sec = el('div', 'child-section');
    const head = el('button', 'child-head',
      `<span class="child-ic">${icon('bot')}</span><span class="child-txt">子代理会话(${kids.length})</span>` +
      `<span class="child-caret">${icon('chevron')}</span>`);
    head.type = 'button';
    const list = el('div', 'child-list');
    for (const k of kids) {
      const item = el('div', 'child-item',
        `<span class="child-ic">${icon('bot')}</span><div><div>${esc(sessionTitleOf(k))}</div>` +
        `<div class="m-sub">${k.running ? '● 运行中 · ' : ''}${timeAgo(k.updatedAt)}</div></div>`);
      item.onclick = () => openSession(k.sessionId);
      list.appendChild(item);
    }
    sec.appendChild(head);
    sec.appendChild(list);
    body.appendChild(sec);
  }
  refreshTitles();
  // 贴底策略:仅当用户本来就停在底部(或刚打开/刚发送)时自动滚到最新;
  // 用户上翻后绝不拽回,并显式恢复原阅读位置
  if (stickBottom) {
    scrollBottomEl(body, false);
  } else if (keepPos) {
    body.scrollTop = Math.min(keepPos, body.scrollHeight - body.clientHeight);
  }
  maybeShowEndMarker(body, sid);
  syncChatUi(body);
  renderImagesAsync(sid, body);
}

/** 该会话是否有“正在跑”的回合(用于显示 ■ 停止按钮)。 */
function sessionBusy(sid) {
  if (state.running.has(sid)) return true;
  const flow = state.flow.get(sid) || [];
  return flow.some((x) => x.kind === 'pending' || x.kind === 'live');
}

/** 同步聊天页 UI:悬浮到底按钮显隐 + ■ 停止按钮显隐。 */
function syncChatUi(body) {
  const fab = document.querySelector('[data-act="goto-bottom"]');
  if (fab) fab.classList.toggle('show', !!body && !nearBottom(body));
  const cancel = document.querySelector('[data-act="cancel"]');
  if (cancel) cancel.classList.toggle('hidden', !(state.session && sessionBusy(state.session)));
}

async function renderImagesAsync(sessionId, root) {
  const imgs = root.querySelectorAll('.msg-image[data-attachment-id]');
  for (const holder of imgs) {
    if (holder.dataset.loaded) continue;
    holder.dataset.loaded = '1';
    const attachmentId = holder.dataset.attachmentId;
    if (!attachmentId) { holder.textContent = ''; continue; }
    try {
      const { attachment, data } = await rpc('session.attachment', { sessionId, attachmentId });
      holder.replaceChildren();
      const img = document.createElement('img');
      img.src = `data:${(attachment && attachment.mediaType) || 'image/jpeg'};base64,${data}`;
      img.style.maxWidth = '100%';
      img.style.borderRadius = '8px';
      holder.appendChild(img);
      // 图片加载后高度变化:仅当仍贴底时跟随
      if (stickBottom) { scrollBottomEl(root, false); syncChatUi(root); }
    } catch {
      holder.textContent = '图片加载失败';
    }
  }
  syncChatUi(root);
}

function focusComposer() {
  const input = document.querySelector('[data-role="composer-input"]');
  if (input) setTimeout(() => input.focus(), 100);
}

async function sendPrompt() {
  const input = document.querySelector('[data-role="composer-input"]');
  const text = (input.value || '').trim();
  if (!text || !state.session) return;
  input.value = '';
  input.style.height = ''; // 重置自动长高
  const sid = state.session;
  const flow = ensureFlow(sid);
  flow.push({ kind: 'pending', id: 'pend-' + uuid(), text, createdAt: Date.now() });
  state.running.add(sid);
  stickBottom = true;
  rerenderChat();
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    await rpc('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: tz,
    });
  } catch (e) {
    const idx = flow.findIndex((x) => x.kind === 'pending' && x.text === text);
    if (idx !== -1) flow.splice(idx, 1);
    state.running.delete(sid);
    rerenderChat();
    toast('发送失败:' + e.message);
  }
}

async function cancelRun() {
  if (!state.session) return;
  try { await rpc('session.cancel', { sessionId: state.session }); } catch { /* ignore */ }
}

// ── 弹层 / Toast ────────────────────────────────────────────────────

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', 'toast');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

function showModal(node) {
  const modal = document.querySelector('[data-role="modal"]');
  modal.replaceChildren(node);
  modal.classList.remove('hidden');
}

function hideModal() {
  document.querySelector('[data-role="modal"]').classList.add('hidden');
}

// ── 审批/选项卡片(投递到手机并回传) ─────────────────────────────────
// 电脑端 GUI 的“授权请求”与“提问卡片”会作为 mux 帧推送过来
// (approval/requested、question/requested,均为带 rpcId 的 server-request);
// 手机端应答 = POST /api/respond 发 client-response 并回显同一 rpcId,
// 与电脑端共享同一 pending 表:先答先生效,另一端的卡片随后自动消失。
const pendingApprovals = new Map(); // approvalId -> {rpcId, sessionId, approvalId, toolName, reason}
const pendingQuestions = new Map(); // rpcId -> {rpcId, sessionId, questions, sel}

function decisionTitleOf(sid) {
  const rows = state.sessions || [];
  const row = rows.find((x) => x.sessionId === sid);
  const t = row ? sessionTitleOf(row) : '';
  return t ? String(t) : ('会话 ' + String(sid).slice(0, 8));
}

/** 提交 client-response 到 /api/respond,返回 RpcReceipt。 */
async function respondMessage(message) {
  const res = await fetch('/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(message),
  });
  let receipt = null;
  try { receipt = await res.json(); } catch { /* 非 JSON 忽略 */ }
  return receipt;
}

function onApprovalRequested(rpcId, p) {
  if (pendingApprovals.has(p.approvalId)) return; // 重连重放等:幂等
  pendingApprovals.set(p.approvalId, {
    rpcId: rpcId,
    sessionId: p.sessionId,
    approvalId: p.approvalId,
    toolName: p.toolName || 'tool',
    reason: p.reason || '',
  });
  showDecisionCards('收到审批请求');
}

function onApprovalResolved(p) {
  const had = pendingApprovals.delete(p.approvalId);
  const label = { 'allowed-once': '已允许', rejected: '已拒绝', cancelled: '已取消', unavailable: '无应答者,已自动拒绝' }[p.outcome];
  if (had) showDecisionCards();
  if (label) toast('审批:' + label);
}

function onQuestionRequested(rpcId, p) {
  if (!rpcId || pendingQuestions.has(rpcId)) return; // 幂等
  const sel = new Map();
  for (const q of (p.questions || [])) sel.set(q.id, { chosen: new Set(), custom: '' });
  pendingQuestions.set(rpcId, { rpcId: rpcId, sessionId: p.sessionId, questions: p.questions || [], sel: sel });
  showDecisionCards('收到助手提问');
}

function onQuestionResolved(p) {
  if (pendingQuestions.delete(p.questionRpcId)) showDecisionCards();
  toast(p.outcome === 'answered' ? '提问已处理' : '提问已取消');
}

/** 汇总渲染当前所有待处理卡片;有真实变更(from 非空)时 toast 提示。 */
function showDecisionCards(from) {
  const total = pendingApprovals.size + pendingQuestions.size;
  if (from && total > 0) toast(`${from}(共 ${total} 项待处理)`);
  const modal = document.querySelector('[data-role="modal"]');
  if (!modal) return;
  if (total === 0) {
    if (!modal.classList.contains('hidden') && modal.firstElementChild &&
        modal.firstElementChild.classList.contains('decision-card')) {
      modal.classList.add('hidden');
    }
    return;
  }
  modal.replaceChildren(buildDecisionCards());
  modal.classList.remove('hidden');
}

function buildDecisionCards() {
  const card = el('div', 'menu decision-card');
  const approvals = [...pendingApprovals.values()];
  const questions = [...pendingQuestions.values()];

  if (approvals.length) {
    card.appendChild(el('div', 'dec-sec',
      `<span class="dec-ic">${icon('shield')}</span>需要授权(${approvals.length})` +
      `<span class="m-sub">${esc('允许仅针对这一次操作')}</span>`));
    for (const a of approvals) card.appendChild(approvalItemNode(a));
  }
  if (questions.length) {
    card.appendChild(el('div', 'dec-sec',
      `<span class="dec-ic">${icon('ask')}</span>助手提问(${questions.length})`));
    for (const en of questions) card.appendChild(questionItemNode(en));
  }

  const foot = el('div', 'dec-foot');
  const wait = el('button', 'btn-ghost dec-wait', '收起(稍后在电脑上处理也行)');
  wait.type = 'button';
  wait.onclick = hideModal;
  foot.appendChild(wait);
  card.appendChild(foot);
  return card;
}

function approvalItemNode(a) {
  const box = el('div', 'dec-item');
  box.appendChild(el('div', 'dec-who', esc('会话:' + decisionTitleOf(a.sessionId))));
  box.appendChild(el('div', 'dec-tool', esc(a.toolName)));
  if (a.reason) box.appendChild(el('div', 'dec-reason', esc(a.reason)));
  const btns = el('div', 'dec-btns');
  const allow = el('button', 'btn', '允许一次');
  allow.type = 'button';
  allow.onclick = () => answerApproval(a, 'allowed-once');
  const deny = el('button', 'btn ghost-danger', '拒绝');
  deny.type = 'button';
  deny.onclick = () => answerApproval(a, 'rejected');
  btns.appendChild(allow);
  btns.appendChild(deny);
  box.appendChild(btns);
  return box;
}

async function answerApproval(a, outcome) {
  try {
    const receipt = await respondMessage({
      type: 'client-response',
      rpcId: a.rpcId,
      result: { ok: true, value: { sessionId: a.sessionId, approvalId: a.approvalId, outcome: outcome } },
    });
    pendingApprovals.delete(a.approvalId);
    if (receipt && receipt.accepted === true) {
      toast(outcome === 'allowed-once' ? '已允许该操作' : '已拒绝该操作');
    } else {
      const why = receipt && receipt.reason ? receipt.reason : '未知';
      toast(why === 'not-pending' ? '该请求已在别处处理' : '应答未生效:' + why);
    }
  } catch (e) {
    toast('提交失败:' + e.message);
  }
  showDecisionCards();
}

function questionItemNode(en) {
  const box = el('div', 'dec-item');
  box.appendChild(el('div', 'dec-who', esc('会话:' + decisionTitleOf(en.sessionId))));
  const qs = en.questions;
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const st = en.sel.get(q.id) || { chosen: new Set(), custom: '' };
    const blk = el('div', 'q-block');
    if (q.header) blk.appendChild(el('div', 'q-head', esc(q.header)));
    blk.appendChild(el('div', 'q-txt', esc((qs.length > 1 ? `${i + 1}. ` : '') + q.question)));
    if (q.detail) blk.appendChild(el('div', 'q-detail', esc(q.detail)));
    const opts = q.options || [];
    const multi = q.multiSelect === true;
    if (opts.length === 0) {
      const ta = el('textarea', 'q-text', '');
      ta.placeholder = '输入回答…';
      ta.value = st.custom;
      ta.addEventListener('input', () => { st.custom = ta.value; });
      blk.appendChild(ta);
    } else {
      const wrap = el('div', 'q-opts');
      for (const opt of opts) {
        const selOn = st.chosen.has(opt.label);
        const row = el('div', 'q-opt' + (selOn ? ' sel' : ''));
        row.appendChild(el('span', multi ? 'q-box' : 'q-dot', ''));
        const lab = el('div', 'q-lbl');
        lab.appendChild(el('div', 'q-label', esc(opt.label)));
        if (opt.description) lab.appendChild(el('div', 'q-desc', esc(opt.description)));
        row.appendChild(lab);
        row.onclick = () => {
          if (multi) {
            if (st.chosen.has(opt.label)) st.chosen.delete(opt.label);
            else st.chosen.add(opt.label);
          } else {
            // 单选:点选项时清空已填的自定义文本(宿主校验:单选不能两者同时给)
            if ((st.custom || '').trim() !== '') {
              st.custom = '';
              const inp = blk.querySelector('.q-custom-in');
              if (inp) inp.value = '';
            }
            st.chosen.clear();
            st.chosen.add(opt.label);
          }
          showDecisionCards(); // 重绘卡片反映选中态
        };
        wrap.appendChild(row);
      }
      blk.appendChild(wrap);
      // 自定义回答:不想选固定选项时可直接输入;单选填自定义会自动取消选项,
      // 多选则允许“选若干项 + 自定义补充”并存
      const cu = el('textarea', 'q-text q-custom-in', '');
      cu.placeholder = '自定义回答(不想选上面选项时直接输入)…';
      cu.value = st.custom;
      cu.addEventListener('input', () => {
        st.custom = cu.value;
        if (!multi && st.chosen.size > 0) {
          st.chosen.clear();
          for (const r of blk.querySelectorAll('.q-opt.sel')) r.classList.remove('sel');
        }
      });
      blk.appendChild(cu);
    }
    box.appendChild(blk);
  }
  const ok = el('button', 'btn', '提交回答');
  ok.type = 'button';
  ok.style.marginTop = '10px';
  ok.onclick = () => submitQuestions(en);
  box.appendChild(ok);
  return box;
}

function questionsReady(en) {
  return en.questions.every((q) => {
    const st = en.sel.get(q.id);
    if (!st) return false;
    return st.chosen.size > 0 || (st.custom || '').trim() !== '';
  });
}

async function submitQuestions(en) {
  if (!questionsReady(en)) { toast('请先回答每个问题'); return; }
  const answers = en.questions.map((q) => {
    const st = en.sel.get(q.id) || { chosen: new Set(), custom: '' };
    const item = { id: q.id, selected: [...st.chosen] };
    const c = (st.custom || '').trim();
    if (c) item.custom = c;
    return item;
  });
  try {
    const receipt = await respondMessage({
      type: 'client-response',
      rpcId: en.rpcId,
      result: { ok: true, value: { sessionId: en.sessionId, answer: { answers: answers } } },
    });
    pendingQuestions.delete(en.rpcId);
    if (receipt && receipt.accepted === true) toast('回答已提交');
    else {
      const why = receipt && receipt.reason ? receipt.reason : '未知';
      toast(why === 'not-pending' ? '该提问已在别处处理' : '提交未生效:' + why);
    }
  } catch (e) {
    toast('提交失败:' + e.message);
  }
  showDecisionCards();
}

// ── 原生返回桥接(HarmonyOS ArkWeb)+ 浏览器历史导航 ────────────────
// 进入会话时 pushState 留痕(histStack 与浏览器历史同步),使返回键/侧滑能
// 逐级后退:子代理会话 → 父会话 → 会话列表 → 才退出本页(回连接设置页)。
// goWebBack 是统一“返回”入口(网页顶部返回按钮与 __dshMobileBack 共用):
//   1. 有弹窗 → 先关弹窗;
//   2. 在聊天页且有历史记录 → history.back(),由 popstate 驱动界面回退;
//   3. 在聊天页但无历史(旧入口/刷新后)→ 网页内部返回(父会话/列表);
//   4. 已在列表根部 → false,由鸿蒙壳退出页面。
const histStack = [];

function goWebBack() {
  try {
    const modal = document.querySelector('[data-role="modal"]');
    if (modal && !modal.classList.contains('hidden')) { hideModal(); return true; }
    const chat = document.querySelector('[data-view="chat"]');
    if (!chat || !chat.classList.contains('active')) return false; // 已不在聊天页
    if (histStack.length > 0) {
      try { history.back(); } catch (e) { backFromChat(); }
      return true;
    }
    backFromChat();
    return true;
  } catch (e) {
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.__dshMobileBack = goWebBack;

  window.addEventListener('popstate', () => {
    const s = history.state;
    if (s && s.v === 'chat' && typeof s.sid === 'string') {
      if (histStack.length > 0) histStack.pop();
      openSession(s.sid, true); // quiet:由浏览器历史驱动,不再 pushState
    } else {
      histStack.length = 0;
      backToList();
    }
  });
}

// ── 启动 ────────────────────────────────────────────────────────────

async function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement) { try { await d.exitFullscreen(); } catch { /* ignore */ } return; }
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    toast('已处于独立应用模式(无地址栏)');
    return;
  }
  try { await d.documentElement.requestFullscreen(); }
  catch {
    toast('浏览器不允许页面级全屏:请在浏览器菜单中“添加到主屏幕”,即可无地址栏全屏');
  }
}

// ── 会话列表下拉刷新 ────────────────────────────────────────────────
let ptrEl = null;
const ptrPull = { y: null, dist: 0, busy: false };
const PTR_OK = 56; // 达到该下拉距离触发刷新

function ensurePtrEl(body) {
  if (!ptrEl || !ptrEl.isConnected) {
    ptrEl = el('div', 'ptr');
    ptrEl.appendChild(el('span', 'ptr-txt', '下拉刷新'));
    if (body) body.appendChild(ptrEl);
  }
  return ptrEl;
}

function setPtrState(dist, text, spin) {
  if (!ptrEl) return;
  ptrEl.style.height = (dist > 0 ? dist : 0) + 'px';
  const t = ptrEl.querySelector('.ptr-txt');
  if (t) { t.textContent = text; }
  ptrEl.classList.toggle('spin', !!spin);
}

function bindPullRefresh() {
  const sc = document.querySelector('[data-role="list-body"]');
  if (!sc) return;
  ensurePtrEl(sc);
  sc.addEventListener('touchstart', (e) => {
    ptrPull.y = (ptrPull.busy || !e.touches || e.touches.length !== 1) ? null : e.touches[0].clientY;
  }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    if (ptrPull.busy || ptrPull.y === null || !e.touches) return;
    const dy = e.touches[0].clientY - ptrPull.y;
    if (sc.scrollTop > 0 || dy <= 0) {
      ptrPull.y = null; // 正常上滑/非顶部:交给原生滚动
      if (dy <= 0) setPtrState(0, '下拉刷新', false);
      return;
    }
    e.preventDefault(); // 顶部下拉:接管手势,阻止橡皮筋/原生滚动
    ptrPull.dist = Math.min(110, dy * 0.5);
    setPtrState(ptrPull.dist, ptrPull.dist >= PTR_OK ? '松开立即刷新' : '下拉刷新', false);
  }, { passive: false });
  const endPull = async () => {
    if (ptrPull.busy || ptrPull.y === null) return;
    ptrPull.y = null;
    const go = ptrPull.dist >= PTR_OK;
    ptrPull.dist = 0;
    if (go) {
      ptrPull.busy = true;
      setPtrState(46, '正在刷新…', true);
      try {
        await Promise.all([loadSessions(), loadWorkspaces()]);
        renderList();
        toast('会话列表已刷新');
      } catch (err) {
        toast('刷新失败,请检查网络');
      }
      ptrPull.busy = false;
    }
    setPtrState(0, '下拉刷新', false);
  };
  sc.addEventListener('touchend', endPull);
  sc.addEventListener('touchcancel', endPull);
}

function bindShell() {
  document.querySelector('[data-act="new-session"]').onclick = newSession;
  document.querySelector('[data-act="workspaces"]').onclick = workspaceMenu;
  document.querySelector('[data-act="bg"]').onclick = bgMenu;
  document.querySelector('[data-act="back"]').onclick = goWebBack;
  document.querySelector('[data-act="send"]').onclick = sendPrompt;
  document.querySelector('[data-act="cancel"]').onclick = cancelRun;
  document.querySelector('[data-act="chat-menu"]').onclick = chatMenu;
  document.querySelector('[data-act="fullscreen"]').onclick = toggleFullscreen;
  const input = document.querySelector('[data-role="composer-input"]');
  // 输入框随内容自动长高(上限 140px)
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  };
  input.addEventListener('input', autoGrow);
  // Enter 一律插入换行(中文输入法组合确认也不误发);发送请点右侧 ↑ 按钮,
  // 桌面键盘可用 Ctrl/Cmd+Enter 快捷发送。
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendPrompt();
    }
  };
  document.querySelector('[data-role="modal"]').onclick = (e) => {
    if (e.target === e.currentTarget) hideModal();
  };
  bindPullRefresh(); // 会话列表下拉刷新

  // 聊天滚动容器:跟踪贴底意图 + 一键到底悬浮按钮显隐
  const chatBody = document.querySelector('[data-role="chat-body"]');
  const onScroll = () => {
    if (!state.session) return;
    // 只有“几乎贴在底部”才跟随;用户一上滑(>48px)立即停止自动滚动,不再被拽回
    stickBottom = nearBottom(chatBody, 48);
    syncChatUi(chatBody);
    // 滚到顶部且还有更早记录 → 自动向前加载一页
    if (chatBody.scrollTop < 60 && !nearBottom(chatBody) && !loadingMore) loadOlder(state.session);
  };
  chatBody.addEventListener('scroll', onScroll, { passive: true });
  document.querySelector('[data-act="goto-bottom"]').onclick = () => {
    stickBottom = true;
    scrollBottomEl(chatBody, true);
    syncChatUi(chatBody);
  };

  // 折叠区事件委托(每次重渲染只重建内容,容器常驻):工具卡/思考/子代理区
  chatBody.addEventListener('click', (e) => {
    const toolHead = e.target.closest('.toolcard .t-head');
    if (toolHead) {
      const card = toolHead.closest('.toolcard');
      const callId = card.dataset.tool;
      const open = card.classList.toggle('open');
      if (callId) { if (open) openTools.add(callId); else openTools.delete(callId); }
      return;
    }
    const thinkHead = e.target.closest('.think .think-head');
    if (thinkHead) {
      const box = thinkHead.closest('.think');
      const k = box.dataset.think || '';
      const nowOpen = box.classList.contains('open');
      box.classList.toggle('open', !nowOpen);
      if (k) thinkOverrides.set(k, !nowOpen); // 记住手动状态,流式重渲染时不再复位
      return;
    }
    const childHead = e.target.closest('.child-head');
    if (childHead) { childHead.closest('.child-section').classList.toggle('closed'); }
  });

  // 会话列表行左滑:删除 / 分叉 / 归档(委托到列表容器,重渲染后仍有效)
  const SW_ACTION_W = 192; // 3 × 64px
  const listScroller = document.querySelector('[data-role="list-body"]');
  const applySwipeX = (sw, x) => {
    const fr = sw.querySelector('.swipe-front');
    const ac = sw.querySelector('.swipe-actions');
    if (fr) fr.style.transform = `translateX(${x}px)`;
    if (ac) ac.style.transform = `translateX(${SW_ACTION_W + x}px)`;
  };
  const resetSwipeX = (sw) => {
    const fr = sw.querySelector('.swipe-front');
    const ac = sw.querySelector('.swipe-actions');
    if (fr) fr.style.transform = '';
    if (ac) ac.style.transform = '';
  };
  const closeAllSwipes = () => {
    if (listScroller) for (const o of listScroller.querySelectorAll('.swipe.open')) o.classList.remove('open');
  };
  // 手势状态。灵敏度要点:
  //  - 方向判定前累计 ~14px 再裁决,容忍手指起始抖动,不再一有纵向分量就放弃;
  //  - 锁定横向后 setPointerCapture,手指滑出行/列表边界仍然持续跟手;
  //  - 配合 CSS 的 touch-action: pan-y,横向手势不会被系统滚动中途掐断;
  //  - 松开时若为快速甩动(<280ms 且横向位移≥34px)直接按方向吸附,
  //    不必拖过半程——解决“左滑划不出 / 右滑收不进”的生涩感。
  let drag = null;
  if (listScroller) {
    listScroller.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary) return;
      const sw = e.target.closest('.swipe');
      if (!sw || e.target.closest('.sw-act')) return;
      drag = {
        id: e.pointerId, sw: sw, x: e.clientX, y: e.clientY,
        dx: 0, flickDx: 0, lastT: performance.now(), moved: false,
        open: sw.classList.contains('open')
      };
    });
    listScroller.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 14) return;        // 起动容差:累计后再判方向
        if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // 纵向占优 → 交给原生滚动/下拉刷新
        drag.moved = true;
        drag.sw.classList.add('dragging');
        closeAllSwipes();
        try { listScroller.setPointerCapture(e.pointerId); } catch (err) { /* 内核不支持则忽略 */ }
      }
      drag.flickDx = dx; // 未裁剪的原始横向位移,供快速甩动判向
      drag.lastT = performance.now(); // 末次移动时刻:据此识别"甩动"(松开前一刻还在快速移动)
      const base = drag.open ? -SW_ACTION_W : 0;
      const nx = Math.max(-SW_ACTION_W, Math.min(0, base + dx));
      drag.dx = nx;
      applySwipeX(drag.sw, nx);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    // 双保险:横向拖动锁定后吞掉原生 touch 滚动(兼容不支持 touch-action 的老内核)
    listScroller.addEventListener('touchmove', (e) => {
      if (drag && drag.moved && e.cancelable) e.preventDefault();
    }, { passive: false });
    const finishSwipe = (e) => {
      if (!drag || (e.pointerId !== undefined && drag.id !== e.pointerId)) return;
      const sw = drag.sw;
      const moved = drag.moved;
      const nx = drag.dx;
      // 松开前 ~90ms 内仍在快速移动 → 视为甩动;慢速拖拽(松手前会自然停顿)走位移阈值
      const fast = performance.now() - drag.lastT < 90;
      const flick = drag.flickDx;
      sw.classList.remove('dragging');
      drag = null;
      if (!moved) return; // 轻点:交给 click 处理
      // 快速甩动 → 按甩动方向吸附;慢速拖拽 → 超过 45% 行宽才吸附
      const openIt = (fast && Math.abs(flick) >= 34) ? flick < 0 : nx < -SW_ACTION_W * 0.45;
      sw.classList.toggle('open', openIt);
      for (const o of listScroller.querySelectorAll('.swipe.open')) if (o !== sw) o.classList.remove('open');
      resetSwipeX(sw);
      sw.dataset.justSwiped = String(performance.now());
      clearTimeout(sw._swallowT);
      sw._swallowT = setTimeout(() => { delete sw.dataset.justSwiped; }, 320);
    };
    listScroller.addEventListener('pointerup', finishSwipe);
    listScroller.addEventListener('pointercancel', finishSwipe);
    // 捕获阶段:开着的行被点击(非按钮)→ 收起而不是打开会话;滑动刚结束 → 吞掉残留点击
    listScroller.addEventListener('click', (e) => {
      const sw = e.target.closest('.swipe');
      if (!sw) return;
      if (e.target.closest('.sw-act')) return; // 动作按钮自行处理
      const js = sw.dataset.justSwiped;
      if (js && performance.now() - Number(js) < 320) {
        delete sw.dataset.justSwiped;
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (sw.classList.contains('open')) {
        e.preventDefault(); e.stopPropagation();
        sw.classList.remove('open');
      } else {
        closeAllSwipes();
      }
    }, true);
  }
}

async function startApp() {
  const auth = await checkAuth();
  state.auth = auth;
  state.loggedIn = auth.auth === 'trusted' || (auth.auth === 'required' && auth.session === true);
  if (!state.loggedIn) {
    const wrap = el('div', 'view-login');
    wrap.appendChild(viewLogin(auth));
    $('#app').replaceChildren(wrap);
    return;
  }
  try {
    await loadWorkspaces();
    await loadSessions();
  } catch (e) {
    toast('数据加载失败:' + e.message);
  }
  $('#app').replaceChildren(el('div', 'app-shell', shellHtml()));
  bindShell();
  loadWsClosed();
  renderList();
  connectStreams();
  // 触屏设备:自动尝试页面全屏以隐藏浏览器地址栏(不支持则静默,可手动点 ⛶)
  const touchUI = ('ontouchstart' in window) ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  if (touchUI && !standalone) {
    setTimeout(async () => {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      } catch { /* 浏览器不支持/需手势,忽略 */ }
    }, 200);
  }
  const running = state.sessions.find((s) => s.running && !isSubagentSession(s));
  if (running) await openSession(running.sessionId);
}

(async function boot() {
  applyBg(loadBg()); // 一进页面就套上已保存的背景
  const app = $('#app');
  const auth = await checkAuth();
  state.auth = auth;
  state.loggedIn = auth.auth === 'trusted' || (auth.auth === 'required' && auth.session === true);
  if (state.loggedIn) {
    startApp();
  } else {
    const wrap = el('div', 'view-login');
    wrap.appendChild(viewLogin(auth));
    app.replaceChildren(wrap);
  }
})();
