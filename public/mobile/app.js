/* DSH 手机版 —— 独立移动端前端(v2:流式 + 工具卡片 + 实时状态)。
 *
 * 协议(与电脑端 Web 同一后端):
 *   unary  : POST /api/<method>,body {type:'client-request',rpcId,method,payload}
 *   应答    : {type:'server-response',rpcId,result:{ok,value|error}}
 *   实时    : 只下行 WebSocket(/api/events.mux 会话流、/api/events.host 宿主流),
 *             每帧 = server-request 信封,payload 即 mux/host 帧。
 *   鉴权    : lan-gate 会话 Cookie(同源自动携带);Host 头由同源满足围栏。
 *
 * 渲染模型:每会话一条"流"(flow)按事件顺序追加:
 *   msg   —— 定型消息(user/message、assistant/message 的最终 content)
 *   live  —— 进行中的助手流(assistant/chunk 的 text/reasoning delta 累积)
 *   tool  —— 工具卡(tool/call 创建,running → tool/result 落定 ok/error)
 *   pending —— 刚发送、等服务端 user/message 回显
 *   error —— 回合级错误(turn/end reason.kind==='error')
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
  session: null,             // 当前会话 id
  sessions: [],              // session.list 行
  workspaces: [],
  flow: new Map(),           // sessionId -> Item[]
  seqBySession: new Map(),
  running: new Set(),
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
    if (t === 'text' && typeof b.text === 'string' && b.text) pushTextParts(parts, b.text);
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

function pushTextParts(parts, text) {
  const segs = String(text).split(/```/);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '') continue;
    if (i % 2 === 0) {
      if (seg.trim()) parts.push({ kind: 'text', text: seg });
    } else {
      const nl = seg.indexOf('\n');
      const lang = nl === -1 ? '' : seg.slice(0, nl).trim();
      const code = nl === -1 ? seg : seg.slice(nl + 1);
      parts.push({ kind: 'code', lang, text: code });
    }
  }
}

// ── 数据加载 ────────────────────────────────────────────────────────

async function loadSessions() {
  const { items } = await rpc('session.list');
  state.sessions = items || [];
}

async function loadWorkspaces() {
  const { items } = await rpc('workspace.list');
  state.workspaces = items || [];
}

async function loadHistory(sessionId) {
  const { events } = await rpc('session.history', { sessionId, maxMessages: 50 });
  const flow = ensureFlow(sessionId);
  flow.length = 0;
  const chunkAcc = new Map(); // key turn:step -> {text, reasoning}
  const committed = new Set();
  let maxSeq = -1;

  for (const { event } of events || []) {
    if (!event || typeof event.seq === 'number') {
      if (event && typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq;
    }
    if (!event) continue;
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
      flow.push({ kind: 'tool', id: 'tool-' + data.callId, callId: data.callId, name: data.name || 'tool', argsRaw: data.arguments || '', state: 'running', time: event.time, startedAt: event.time });
      if (typeof event.seq === 'number') maxSeq = Math.max(maxSeq, event.seq);
    } else if (type === 'tool/result') {
      const callId = toolResultCallId(data);
      const item = flow.find((x) => x.kind === 'tool' && x.callId === callId);
      if (item) {
        item.state = data.error ? 'error' : 'error-state';
        item.finishedAt = event.time;
        item.output = blocksToText((data.message && data.message.content) || []);
        item.errorMsg = data.error && (data.error.message || data.error.code);
        if (!data.error && !isErrorResult(data)) item.state = 'ok';
        if (isErrorResult(data)) { item.state = 'error'; item.errorMsg = item.errorMsg || '工具执行失败'; }
      }
      if (typeof event.seq === 'number') maxSeq = Math.max(maxSeq, event.seq);
    } else if (type === 'turn/end' && data.reason && data.reason.kind === 'error') {
      flow.push({ kind: 'error', id: 'err-' + event.seq, message: (data.reason.error && data.reason.error.message) || '回合出错' });
    }
  }
  // 未定型的 chunk → 兜底一条 live(会话中途打开、流尚未收尾时)
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
    // 助手定型:替换同 turn:step 的 live;再按 id 去重
    const key = `${data.turn}:${data.step}`;
    const li = flow.findIndex((x) => x.kind === 'live' && x.key === key);
    if (li !== -1) flow.splice(li, 1);
    const idx = flow.findIndex((x) => x.kind === 'msg' && x.id === rawMsg.id);
    const node = normalizeMessage(rawMsg);
    if (!node) return false;
    if (idx === -1) flow.push(node); else flow[idx] = node;
    // 用户回显:清掉对应的 pending 占位
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
    const exists = flow.some((x) => x.kind === 'tool' && x.callId === callId);
    if (!exists) {
      flow.push({ kind: 'tool', id: 'tool-' + callId, callId, name: data.name || 'tool', argsRaw: data.arguments || '', state: 'running', time: event.time, startedAt: event.time });
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
      // 有空洞:保守重拉一次历史(去重当前 seq 之后的 live 由重放覆盖)
      if (sessionId === state.session) {
        loadHistory(sessionId);
        return changed;
      }
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
  if (type === 'host/session-added' || type === 'host/session-removed' || type === 'host/workspace-changed' || type === 'host/workspace-removed') {
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
      ws = new WebSocket(`ws://${location.host}${path}`);
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
    if (p.kind === 'text') rows.push(esc(p.text));
    else if (p.kind === 'reasoning') rows.push(`<div class="think">${esc(p.text)}</div>`);
    else if (p.kind === 'code') rows.push(`<pre>${esc(p.lang ? p.lang + '\n' : '')}${esc(p.text)}</pre>`);
    else if (p.kind === 'image') rows.push(`<div class="msg-image" data-attachment-id="${esc((p.attachment && p.attachment.attachmentId) || '')}">图片…</div>`);
    else if (p.kind === 'tool') {
      if (knownToolCallIds && knownToolCallIds.has(p.callId)) continue; // 已有独立工具卡,跳过正文里的调用块
      rows.push(`<div class="toolcard"><div class="t-head"><span class="t-name">${esc(p.name || 'tool')}</span>` +
        `<span class="t-status ${p.state === 'error' ? 't-err' : ''}">${p.state === 'error' ? '✕' : '…'}</span></div>` +
        (p.argsRaw ? `<pre>${esc(p.argsRaw)}</pre>` : '') + `</div>`);
    }
  }
  return rows.join('\n');
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
  const statusIcon = t.state === 'error' ? '✕' : t.state === 'ok' ? '✓' : '…';
  const statusCls = t.state === 'error' ? 't-err' : t.state === 'ok' ? 't-ok' : '';
  let body = '';
  if (t.argsRaw && t.state !== 'ok') body += `<pre>${esc(t.argsRaw)}</pre>`;
  if (t.output) body += `<pre>${esc(t.output)}</pre>`;
  if (t.errorMsg) body += `<pre class="t-err">${esc(t.errorMsg)}</pre>`;
  return `<div class="toolcard"><div class="t-head"><span class="t-name">${esc(t.name)}</span>` +
    `<span class="t-status ${statusCls}">${statusIcon}</span>${duration ? `<span class="t-status">${duration}</span>` : ''}</div>${body}</div>`;
}

// ── 界面 ────────────────────────────────────────────────────────────

function shellHtml() {
  return `
    <div class="view view-list active" data-view="list">
      <div class="topbar">
        <span class="title" data-role="list-title">会话</span>
        <button class="iconbtn" data-act="new-session" title="新会话">＋</button>
        <button class="iconbtn" data-act="workspaces" title="工作区">≡</button>
        <button class="iconbtn" data-act="logout" title="退出登录">⎋</button>
      </div>
      <div class="list-scroll" data-role="list-body"></div>
    </div>
    <div class="view view-chat" data-view="chat">
      <div class="topbar">
        <button class="iconbtn" data-act="back" title="返回">←</button>
        <span class="title" data-role="chat-title"></span>
        <button class="iconbtn" data-act="cancel" title="停止">■</button>
      </div>
      <div class="chat-scroll" data-role="chat-body"></div>
      <div class="composer">
        <textarea data-role="composer-input" placeholder="发消息…" rows="1"></textarea>
        <button class="send" data-act="send" title="发送">↑</button>
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

function sessionTitleOf(s) {
  const t = s && s.projections && s.projections.values && s.projections.values.title;
  if (t) return t;
  if (s && s.blank) return '新会话';
  return '会话';
}

function renderList() {
  const body = document.querySelector('[data-role="list-body"]');
  if (!body) return;
  body.replaceChildren();
  const items = state.sessions;
  if (!items.length) {
    body.appendChild(el('div', 'placeholder', '暂无会话。点右上角 ＋ 新建。'));
    return;
  }
  for (const s of items) {
    const row = el('div', 'sess-item', `
      <div class="s-title">${esc(sessionTitleOf(s))}</div>
      <div class="s-meta">${s.running ? '<span class="s-dot">● 运行中</span>' : ''}<span>${timeAgo(s.updatedAt)}</span></div>
    `);
    row.onclick = () => openSession(s.sessionId);
    body.appendChild(row);
  }
}

function refreshTitles() {
  const t = document.querySelector('[data-role="chat-title"]');
  if (t && state.session) {
    const s = state.sessions.find((x) => x.sessionId === state.session);
    t.textContent = sessionTitleOf(s);
  }
}

async function openSession(sessionId) {
  state.session = sessionId;
  document.querySelector('[data-view="list"]').classList.remove('active');
  document.querySelector('[data-view="chat"]').classList.add('active');
  document.querySelector('[data-role="composer-input"]').value = '';
  await loadHistory(sessionId);
  refreshTitles();
  rerenderChat();
}

async function newSession() {
  try {
    if (!state.workspaces.length) {
      toast('请先在“≡ 工作区”里创建/选择一个工作区');
      return;
    }
    const ws = state.workspaces[0];
    const { sessionId } = await rpc('session.create', { workspaceId: ws.workspaceId });
    await loadSessions();
    renderList();
    await openSession(sessionId);
    state.flow.set(sessionId, []);
    focusComposer();
  } catch (e) {
    toast('新建失败:' + e.message);
  }
}

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
    if (it.reasoning) html.push(`<div class="think">${esc(it.reasoning)}</div>`);
    if (it.text) html.push(esc(it.text));
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
    wrap.innerHTML = `<div class="bubble">${esc(it.text)}<span class="typing"></span></div>`;
    return wrap;
  }
  if (it.kind === 'error') {
    return el('div', 'msg error-note', `⚠ ${esc(it.message)}`);
  }
  return null;
}

function rerenderChat() {
  const body = document.querySelector('[data-role="chat-body"]');
  if (!body || !state.session) return;
  const sid = state.session;
  const flow = state.flow.get(sid) || [];
  const knownIds = knownToolCallIds(sid);
  const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.replaceChildren();
  for (const it of flow) {
    const node = renderChatItem(it, sid, knownIds);
    if (node) body.appendChild(node);
  }
  if (state.running.has(sid) && !flow.some((x) => x.kind === 'live')) {
    // 运行中但暂无流:兜底“思考中”
    body.appendChild(el('div', 'msg assistant', '<div class="bubble typing">思考中</div>'));
  }
  refreshTitles();
  if (wasAtBottom || true) body.scrollTop = body.scrollHeight;
  renderImagesAsync(sid, body);
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
    } catch {
      holder.textContent = '图片加载失败';
    }
  }
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

function backToList() {
  state.session = null;
  document.querySelector('[data-view="chat"]').classList.remove('active');
  document.querySelector('[data-view="list"]').classList.add('active');
  renderList();
}

// ── 弹层 / 菜单 ─────────────────────────────────────────────────────

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

function workspaceMenu() {
  const box = el('div', 'menu');
  box.appendChild(el('div', 'menu-title', '工作区'));
  if (!state.workspaces.length) box.appendChild(el('div', 'menu-hint', '暂无工作区,先创建一个(输入电脑上已存在的路径):'));
  for (const w of state.workspaces) {
    box.appendChild(el('div', 'menu-item', `${esc(w.title || w.path)}<span class="m-sub">${esc(w.path)}</span>`));
  }
  const create = el('div', 'menu-item accent', '＋ 新建工作区');
  create.onclick = () => { hideModal(); askPath(); };
  box.appendChild(create);
  showModal(box);
}

function askPath() {
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
      await rpc('workspace.create', { path });
      hideModal();
      await loadWorkspaces();
      toast('已创建工作区');
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

// ── 启动 ────────────────────────────────────────────────────────────

function bindShell() {
  document.querySelector('[data-act="new-session"]').onclick = newSession;
  document.querySelector('[data-act="workspaces"]').onclick = workspaceMenu;
  document.querySelector('[data-act="back"]').onclick = backToList;
  document.querySelector('[data-act="send"]').onclick = sendPrompt;
  document.querySelector('[data-act="cancel"]').onclick = cancelRun;
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
  renderList();
  connectStreams();
  const running = state.sessions.find((s) => s.running);
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
