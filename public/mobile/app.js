/* DSH 手机版 —— 独立移动端前端(v4)。
 *
 * v4 界面改造:
 *   1) 会话列表工作区改为手风琴分组:点分组标题展开/收起(状态持久化);
 *   2) 满屏布局(100dvh + 安全区),支持页面全屏切换与 PWA 添加到主屏幕;
 *   3) 打开会话自动定位最底部,滚动离开底部时出现“一键到底”悬浮按钮;
 *   4) 工具调用/思考过程默认收起(点击展开),默认只呈现用户与主 agent 文本;
 *   5) 对话文本支持 Markdown(标题/列表/表格/引用/行内样式),代码块保留;
 *   6) 顶部字符按钮全部换成 SVG 图标;“■ 停止”仅在有任务运行/流式输出时显示;
 *      原黑色方块按钮即为“停止”(session.cancel),未运行时不显示。
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

async function httpJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
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

async function rpc(method, payload = {}) {
  const rpcId = uuid();
  const response = await httpJson('/api/' + method, { type: 'client-request', rpcId, method, payload });
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

async function loadHistory(sessionId) {
  const { events } = await rpc('session.history', { sessionId, maxMessages: 50 });
  const flow = ensureFlow(sessionId);
  flow.length = 0;
  const chunkAcc = new Map();
  const committed = new Set();
  let maxSeq = -1;

  for (const { event } of events || []) {
    if (!event) continue;
    if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq;
    const type = event.type;
    const data = event.data || {};
    if (type === 'user/message' || type === 'assistant/message') {
      const rawMsg = data.message || data;
      const msg = normalizeMessage(rawMsg);
      if (msg) { flow.push(msg); committed.add(`${data.turn}:${data.step}`); }
    } else if (type === 'assistant/chunk') {
      const key = `${data.turn}:${data.step}`;
      let acc = chunkAcc.get(key);
      if (!acc) { acc = { text: '', reasoning: '' }; chunkAcc.set(key, acc); }
      const ch = data.chunk || {};
      if (ch.type === 'text-delta') acc.text += ch.text || '';
      else if (ch.type === 'reasoning-delta') acc.reasoning += ch.text || '';
    } else if (type === 'tool/call') {
      flow.push({ kind: 'tool', id: 'tool-' + data.callId, callId: data.callId, name: data.name || 'tool', argsRaw: data.arguments || '', state: 'running', startedAt: event.time });
    } else if (type === 'tool/result') {
      const callId = toolResultCallId(data);
      const item = flow.find((x) => x.kind === 'tool' && x.callId === callId);
      if (item) {
        const err = !!(data.error || isErrorResult(data));
        item.state = err ? 'error' : 'ok';
        item.finishedAt = event.time;
        item.output = blocksToText((data.message && data.message.content) || []);
        item.errorMsg = data.error && (data.error.message || data.error.code);
      }
    } else if (type === 'turn/end' && data.reason && data.reason.kind === 'error') {
      flow.push({ kind: 'error', id: 'err-' + event.seq, message: (data.reason.error && data.reason.error.message) || '回合出错' });
    }
  }
  for (const [key, acc] of chunkAcc) {
    if (!committed.has(key) && (acc.text || acc.reasoning)) {
      flow.push({ kind: 'live', id: 'live-' + key, key, text: acc.text, reasoning: acc.reasoning, createdAt: Date.now() });
    }
  }
  state.seqBySession.set(sessionId, maxSeq);
  if (state.session === sessionId) rerenderChat();
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
    if (ch.type === 'text-delta') { it.text += ch.text || ''; changed = true; }
    else if (ch.type === 'reasoning-delta') { it.reasoning += ch.text || ''; changed = true; }
  } else if (type === 'tool/call') {
    const callId = data.callId;
    if (!flow.some((x) => x.kind === 'tool' && x.callId === callId)) {
      flow.push({ kind: 'tool', id: 'tool-' + callId, callId, name: data.name || 'tool', argsRaw: data.arguments || '', state: 'running', startedAt: event.time });
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
  if (changed && sessionId === state.session) scheduleRerender();
  return changed;
}

// ── 事件流 ──────────────────────────────────────────────────────────

function onFrame(frame) {
  const payload = frame.payload || frame;
  const type = payload.type;
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
    try { ws = new WebSocket(`ws://${location.host}${path}`); } catch { return null; }
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
let wsClosed = new Set(); // group key 集合:已收起的组
let stickBottom = false; // 聊天是否应保持贴底(自动滚到最新)

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

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
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

function partsHtml(parts, knownToolCallIds) {
  const rows = [];
  for (const p of parts) {
    if (p.kind === 'text') rows.push(`<div class="md">${mdHtml(p.text)}</div>`);
    else if (p.kind === 'reasoning') rows.push(thinkHtml(p.text));
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

function thinkHtml(text, forceOpen) {
  return `<div class="think${forceOpen ? ' open' : ''}"><button type="button" class="think-head"><span class="think-ic">${icon('zap')}</span>` +
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

function shellHtml() {
  return `
    <div class="view view-list active" data-view="list">
      <div class="topbar">
        <span class="title" data-role="list-title">会话</span>
        <button class="iconbtn" data-act="new-session" title="新会话">${icon('plus')}</button>
        <button class="iconbtn" data-act="workspaces" title="工作区">${icon('folder')}</button>
        <button class="iconbtn" data-act="logout" title="退出登录">${icon('logout')}</button>
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
      <div class="chat-scroll" data-role="chat-body"></div>
      <button class="fab" data-act="goto-bottom" title="回到底部">${icon('down')}</button>
      <div class="composer">
        <textarea data-role="composer-input" placeholder="发消息…" rows="1"></textarea>
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
  body.replaceChildren();
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
      const row = el('div', 'sess-item', `
        <div class="s-title">${esc(sessionTitleOf(s))}</div>
        <div class="s-meta">${s.running ? '<span class="s-dot">● 运行中</span>' : ''}<span>${timeAgo(s.updatedAt)}</span></div>
      `);
      row.onclick = () => openSession(s.sessionId);
      bodyWrap.appendChild(row);
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

async function openSession(sessionId) {
  if (state.session !== sessionId) state.navStack.push(sessionId);
  state.session = sessionId;
  stickBottom = true; // 进入会话总是从最新(底部)开始
  document.querySelector('[data-view="list"]').classList.remove('active');
  document.querySelector('[data-view="chat"]').classList.add('active');
  const input = document.querySelector('[data-role="composer-input"]');
  if (input) input.value = '';
  await loadHistory(sessionId);
  refreshTitles();
  rerenderChat();
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

function chatMenu() {
  if (!state.session) return;
  const box = el('div', 'menu');
  box.appendChild(el('div', 'menu-title', '会话操作'));
  const s = state.sessions.find((x) => x.sessionId === state.session);
  box.appendChild(el('div', 'menu-item', `当前:${esc(sessionTitleOf(s))}<span class="m-sub">${isSubagentSession(s) ? '子代理会话' : '主会话'}</span>`));
  const del = el('div', 'menu-item accent', '删除会话记录(不可恢复)');
  del.onclick = () => { hideModal(); confirmDelete(); };
  box.appendChild(del);
  const arc = el('div', 'menu-item', '归档此会话(仅隐藏,数据保留)');
  arc.onclick = () => { hideModal(); confirmArchive(); };
  box.appendChild(arc);
  box.appendChild(el('div', 'menu-hint', '删除 = 物理删除聊天记录日志,需电脑端已安装 dsh-session-delete 插件;运行中的任务会被拒绝。'));
  showModal(box);
}

function confirmDelete() {
  const sid = state.session;
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
    backToList();
  };
  showModal(card);
}

function confirmArchive() {
  const sid = state.session;
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
      backToList();
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

function renderChatItem(it, sessionId, knownIds) {
  if (it.kind === 'msg') {
    const wrap = el('div', `msg ${it.role}`);
    const bubble = el('div', 'bubble');
    bubble.innerHTML = partsHtml(it.parts, knownIds);
    wrap.appendChild(bubble);
    return wrap;
  }
  if (it.kind === 'live') {
    const wrap = el('div', 'msg assistant');
    const bubble = el('div', 'bubble');
    const html = [];
    if (it.reasoning) html.push(thinkHtml(it.reasoning, !it.text)); // 纯思考阶段自动展开,出正文后收起
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
  body.replaceChildren();
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
  // 贴底策略:打开时/本来就在底部时自动滚到最新;用户上翻时不再打扰
  if (stickBottom || nearBottom(body)) { scrollBottomEl(body, false); stickBottom = true; }
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
      // 图片加载后高度变化:仍贴底时跟随滚到最新
      if (stickBottom || nearBottom(root)) { scrollBottomEl(root, false); syncChatUi(root); }
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

function bindShell() {
  document.querySelector('[data-act="new-session"]').onclick = newSession;
  document.querySelector('[data-act="workspaces"]').onclick = workspaceMenu;
  document.querySelector('[data-act="back"]').onclick = backFromChat;
  document.querySelector('[data-act="send"]').onclick = sendPrompt;
  document.querySelector('[data-act="cancel"]').onclick = cancelRun;
  document.querySelector('[data-act="chat-menu"]').onclick = chatMenu;
  document.querySelector('[data-act="fullscreen"]').onclick = toggleFullscreen;
  const input = document.querySelector('[data-role="composer-input"]');
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  };
  document.querySelector('[data-act="logout"]').onclick = async () => {
    await doLogout();
    location.reload();
  };
  document.querySelector('[data-role="modal"]').onclick = (e) => {
    if (e.target === e.currentTarget) hideModal();
  };

  // 聊天滚动容器:跟踪贴底意图 + 一键到底悬浮按钮显隐
  const chatBody = document.querySelector('[data-role="chat-body"]');
  const onScroll = () => {
    if (!state.session) return;
    if (chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 150) stickBottom = true;
    else stickBottom = false;
    syncChatUi(chatBody);
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
    if (thinkHead) { thinkHead.closest('.think').classList.toggle('open'); return; }
    const childHead = e.target.closest('.child-head');
    if (childHead) { childHead.closest('.child-section').classList.toggle('closed'); }
  });
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
