/**
 * dsh-lan-gate — host half (v0.2).
 *
 * Makes the DeepSeek Harness Web GUI reachable from phones/other machines on
 * the same LAN, behind a password, with a **bind mode switchable at runtime**:
 *
 *  模式（设置 → 局域网访问 里切换，即时生效、无需重启）：
 *    local  —— 仅本机 127.0.0.1（局域网关闭）
 *    all    —— 所有网卡 0.0.0.0（手机可用任一局域网 IP 访问）
 *    ip     —— 指定一个本机网卡 IP：只在那个地址上监听；同时在
 *               127.0.0.1 上保留一个“副本监听”，电脑端地址永远不变
 *
 * 实现要点：
 *  - 插件不再覆盖 webserver 行的绑定（服务以 127.0.0.1 启动）；本文件在
 *    loader 树稳定后按持久化的模式把 DSH 自带的 node:http 服务**实时重绑**
 *    （close 后在同一 server 对象上 listen 新地址；我们挂的网关监听器不受影响）。
 *  - 网关判定“本机可信来源”= 回环地址 ∪ 本机所有非内网接口 IP：
 *    从电脑自己发出的连接（包括通过它自己的局域网 IP 访问）一律免密码；
 *    其余（手机等）必须通过密码校验。
 *  - /api 信任围栏（client-connection 的 trustedHosts）在绑定时同步：
 *    确保当前模式暴露的地址字面量被围栏接受（回环钉住的敏感方法不受影响）。
 *  - 局域网（及任何非回环 http:// 源）在浏览器里是“非安全上下文”：
 *    crypto.randomUUID 不存在，而 DSH 前端 RPC 会直接调用它。网关放行的
 *    text/html 响应会被改写，注入 getRandomValues 版 UUID v4 polyfill（仅当
 *    缺失时生效）——否则手机端会话列表空白、新建/工作区报
 *    "crypto.randomUUID is not a function"。
 *
 * Endpoints（同源，/__lanauth 前缀）：
 *   GET  /__lanauth/status   状态 + 探测到的网卡列表（任何来源可读，无害）
 *   POST /__lanauth/login    校验密码 → 签发会话 Cookie（局域网设备用）
 *   POST /__lanauth/logout   注销本设备会话
 *   POST /__lanauth/password 设置/修改/移除访问密码 —— 仅本机
 *   POST /__lanauth/bind     切换绑定模式（local|all|ip）—— 仅本机
 *
 * 密码以加盐 scrypt 存于 `$DSH_HOME/lan-gate.json`（含绑定模式），
 * 改密/改绑定立即生效；改密会吊销所有已签发会话。
 */

import { createServer } from 'node:http'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

/** Cordis plugin name. */
export const name = 'lan-gate'

/**
 * Services this plugin needs before it applies: none.
 *
 * Deliberately NOT `inject: ['webServer']` here. All webServer use happens
 * after the loader tree settles (boot), where the service is guaranteed to
 * exist in the web profile — and a module-level inject would make Cordis
 * stall this entry forever in any profile that never provides webServer,
 * rather than letting boot() no-op cleanly. The availability check therefore
 * lives inside boot(), after the settle, where "webServer missing" genuinely
 * means "this profile has no web server".
 */
export const inject = []

/** Path prefix owning every endpoint of this plugin. */
export const LAN_AUTH_PREFIX = '/__lanauth'

/** Session cookie name. */
export const COOKIE_NAME = 'dsh_lan_gate'

/** Session lifetime (ms) — 30 days, sliding (refreshed on each valid use). */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Login/change-password lockout: 5 failures per address locks for 60 s. */
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 60 * 1000

/** Password rules. */
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 256

/** scrypt cost for the stored verifier. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

/** Cache lifetime for the detected/own-IP lists. */
const IP_CACHE_MS = 10 * 1000

// ── tiny helpers ────────────────────────────────────────────────────────────

/** Resolve the DSH home directory (mirrors @deepseek-ai/dsh-home-paths). */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** Absolute path of this plugin's state file. */
function stateFilePath() {
  return join(dshHome(), 'lan-gate.json')
}

/** Normalize a socket remote address: strip the IPv4-in-IPv6 prefix. */
function normalizeRemote(address) {
  if (typeof address !== 'string') return ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/** Whether a socket remote address is the pure loopback. */
function isLoopbackRemote(address) {
  const remote = normalizeRemote(address)
  return remote === '127.0.0.1' || remote === '::1'
}

/** Request pathname. */
function pathOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://dsh.internal').pathname
  } catch {
    return '/'
  }
}

/** Parse the request Cookie header into a plain map. */
function parseCookies(req) {
  const header = req.headers.cookie
  if (!header) return new Map()
  const map = new Map()
  for (const part of String(header).split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    map.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return map
}

/** Whether the caller looks like an API/fetch client rather than a browser navigation. */
function apiish(req) {
  const accept = String(req.headers.accept ?? '')
  if (accept.includes('application/json')) return true
  const mode = String(req.headers['sec-fetch-mode'] ?? '')
  if (mode !== '' && mode !== 'navigate') return true
  if (req.headers['x-requested-with'] !== undefined) return true
  return false
}

/** Read a small request body. */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let received = 0
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > limit) {
        rejectBody(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  } catch {
    /* connection already gone */
  }
}

/** Raw-response rejection for unauthorized WebSocket upgrades. */
function rejectUpgrade(socket, status, body) {
  const text = body ?? 'forbidden'
  socket.end([
    `HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Forbidden'}`,
    'Connection: close',
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Length: ${Buffer.byteLength(text)}`,
    '',
    text
  ].join('\r\n'))
}

// ── network detection ───────────────────────────────────────────────────────

/** Detect this machine's non-internal IPv4 interfaces: [{ name, address }]. */
function detectAddrs() {
  const seen = new Set()
  const out = []
  for (const [name, ifaces] of Object.entries(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface || iface.family !== 'IPv4' || iface.internal) continue
      if (seen.has(iface.address)) continue
      seen.add(iface.address)
      out.push({ name, address: iface.address })
    }
  }
  return out
}

/** Refresh the "own machine addresses" cache used by the trust decision. */
function refreshOwnIps(state, force) {
  const now = Date.now()
  if (!force && state.ownIpsAt !== 0 && now - state.ownIpsAt < IP_CACHE_MS) return state.ownIps
  state.ownIps = new Set(detectAddrs().map((entry) => entry.address))
  state.ownIpsAt = now
  return state.ownIps
}

/** Whether a remote address is a trusted local source (this machine). */
function isTrustedLocal(state, address) {
  if (isLoopbackRemote(address)) return true
  return refreshOwnIps(state, false).has(normalizeRemote(address))
}

// ── password verifier ───────────────────────────────────────────────────────

/** Derive the scrypt key for one password attempt. */
function derive(password, salt, params) {
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024
  })
}

/** Timing-safe check of one candidate against the stored record. */
function verifyPassword(candidate, record) {
  if (!record || typeof candidate !== 'string') return false
  const salt = Buffer.from(record.salt, 'base64')
  const expected = Buffer.from(record.hash, 'base64')
  const actual = derive(candidate, salt, record)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Build a fresh record for a new password. */
function makeRecord(password) {
  const salt = randomBytes(16)
  const hash = derive(password, salt, SCRYPT)
  return {
    algo: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen
  }
}

// ── state persistence (password + bind mode) ────────────────────────────────

/** Fresh mutable state for one plugin instance. */
function createState() {
  return {
    password: null,
    passwordSetAt: undefined,
    bind: { mode: 'all' }, // { mode: 'local'|'all'|'ip', ip?: string }
    boundHost: '127.0.0.1',
    twin: undefined, // { server, close }
    chain: Promise.resolve(), // serializes bind switches
    sessions: new Map(), // token -> expiresAt
    attempts: new Map(), // `${scope}:${ip}` -> { count, lockedUntil }
    addedTrusted: new Set(), // authorities this plugin pushed into the /api fence
    ownIps: new Set(),
    ownIpsAt: 0,
    socketSets: new Map(), // server -> Set<socket> (all connections incl. upgraded)
    socketTrackers: new Map(), // server -> disposer of its connection tracker
    installed: false,
    restore: undefined
  }
}

/** Stop tracking a server's sockets and drop its registry entries. */
function releaseServerSockets(state, server) {
  const untrack = state.socketTrackers.get(server)
  if (untrack) {
    try {
      untrack()
    } catch {
      /* ignore */
    }
  }
  state.socketTrackers.delete(server)
  state.socketSets.delete(server)
}

/** Load persisted state (missing file / bad shape => defaults). */
async function loadStateFile() {
  const fallback = { record: null, setAt: undefined, bind: { mode: 'all' } }
  try {
    const raw = await readFile(stateFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    const record = parsed?.password
    const password = record && typeof record === 'object' && typeof record.salt === 'string' && typeof record.hash === 'string'
      ? record
      : null
    let bind = { mode: 'all' }
    const storedBind = parsed?.bind
    if (storedBind && typeof storedBind === 'object') {
      const mode = storedBind.mode
      if (mode === 'local' || mode === 'all' || (mode === 'ip' && typeof storedBind.ip === 'string')) {
        bind = mode === 'ip' ? { mode, ip: storedBind.ip } : { mode }
      }
    }
    return {
      record: password,
      setAt: typeof parsed.passwordSetAt === 'number' ? parsed.passwordSetAt : undefined,
      bind
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return fallback
}

/** Atomically persist password + bind. */
async function saveStateFile(state) {
  const file = stateFilePath()
  await mkdir(resolve(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const payload = {
    version: 2,
    password: state.password,
    passwordSetAt: state.passwordSetAt,
    bind: state.bind
  }
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
  await rename(tmp, file)
}

// ── attempt / session tracking ──────────────────────────────────────────────

/** Attempt tracking: returns { locked: remainingMs } or null, records failure, clears on success. */
function attemptGuard(state, scope, ip, kind) {
  const key = `${scope}:${ip}`
  const entry = state.attempts.get(key)
  const now = Date.now()
  if (entry && entry.lockedUntil > now) return { lockedMs: entry.lockedUntil - now }
  if (kind === 'success') {
    state.attempts.delete(key)
    return null
  }
  if (kind === 'fail') {
    const count = (entry?.count ?? 0) + 1
    state.attempts.set(key, count >= MAX_ATTEMPTS
      ? { count: 0, lockedUntil: now + LOCKOUT_MS }
      : { count, lockedUntil: 0 })
  }
  return null
}

/** Issue a fresh session token and record it. */
function issueSession(state) {
  const token = randomBytes(24).toString('hex')
  state.sessions.set(token, Date.now() + SESSION_TTL_MS)
  return token
}

/** Whether the request carries a live session cookie (sliding expiry). */
function hasValidSession(state, req) {
  const token = parseCookies(req).get(COOKIE_NAME)
  if (!token) return false
  const expiresAt = state.sessions.get(token)
  if (expiresAt === undefined) return false
  const now = Date.now()
  if (expiresAt <= now) {
    state.sessions.delete(token)
    return false
  }
  state.sessions.set(token, now + SESSION_TTL_MS)
  return true
}

/** Revoke every issued session (password change / removal). */
function revokeSessions(state) {
  state.sessions.clear()
}

// ── bind engine ─────────────────────────────────────────────────────────────

/**
 * Track every connection a server accepts, including ones that later upgrade
 * to WebSocket. `server.closeAllConnections()` deliberately skips upgraded
 * sockets, which would make `server.close()` wait forever and block a rebind —
 * so we keep our own registry and destroy them explicitly.
 * @param server - node:http server to watch.
 * @param set - Set the accepted sockets are recorded into.
 * @returns a disposer that stops tracking (sockets themselves are untouched).
 */
function trackServerSockets(server, set) {
  const onConnection = (socket) => {
    set.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => {
      set.delete(socket)
    })
  }
  server.on('connection', onConnection)
  return () => {
    server.off('connection', onConnection)
  }
}

/**
 * Close a server's listening socket (idempotent) without hanging on upgraded
 * (WebSocket) connections: destroy every tracked socket first, then close.
 * A safety timeout guarantees the promise settles even if something lingers.
 * @param server - node:http server to stop listening on.
 * @param sockets - optional Set of sockets to destroy first (see trackServerSockets).
 */
function closeServer(server, sockets) {
  return new Promise((resolveClose) => {
    if (!server) {
      resolveClose()
      return
    }
    if (sockets) {
      for (const socket of [...sockets]) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
      sockets.clear()
    }
    if (!server.listening) {
      resolveClose()
      return
    }
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolveClose()
    }
    try {
      server.closeAllConnections?.()
    } catch {
      /* ignore */
    }
    try {
      server.close(done)
    } catch {
      done()
    }
    // Never let a lingering handle stall a rebind.
    const timer = setTimeout(done, 2500)
    timer.unref?.()
  })
}

/** Listen on one server; resolves on 'listening', rejects on error. */
function listenServer(server, port, host) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (err) => {
      server.off('listening', onListening)
      rejectListen(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port, host)
    } catch (err) {
      server.off('error', onError)
      server.off('listening', onListening)
      rejectListen(err)
    }
  })
}

/**
 * Request/upgrade dispatch for the loopback twin server — mirrors what the
 * webServer's own createServer callback does, using its public registries.
 */
function twinRequestHandler(ws, logger) {
  return async (req, res) => {
    try {
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = ws.match(rawPath)
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      const fallback = ws.fallback
      if (fallback === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      await fallback(req, res)
    } catch (error) {
      logger.warn(error instanceof Error ? error : new Error(String(error)))
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(400)
      res.end()
    }
  }
}

/** Upgrade dispatch for the loopback twin server. */
function twinUpgradeHandler(ws, logger) {
  return (req, socket, head) => {
    const onError = (error) => {
      logger.warn(error instanceof Error ? error : new Error(String(error)))
      socket.destroy()
    }
    socket.on('error', onError)
    socket.once('close', () => {
      socket.off('error', onError)
    })
    let route
    try {
      route = ws.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      socket.destroy()
      return
    }
    if (route === undefined) {
      socket.destroy()
      return
    }
    try {
      Promise.resolve(route.handler(req, socket, head)).catch((error) => {
        logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      })
    } catch (error) {
      logger.warn(error instanceof Error ? error : new Error(String(error)))
      socket.destroy()
    }
  }
}

/** Which authorities the current mode exposes (for the /api trust fence). */
function fenceTargets(state) {
  if (state.bind.mode === 'all') return detectAddrs().map((entry) => entry.address)
  if (state.bind.mode === 'ip' && typeof state.bind.ip === 'string') return [state.bind.ip]
  return []
}

/**
 * Keep the client-connection /api trust fence in sync with the actual bind:
 * add the authorities the current mode exposes, drop ones we added that are
 * no longer exposed. Other entries (user --trusted-host) are never touched.
 */
function syncFence(ctx, state) {
  const connection = ctx.get('connection')
  const list = connection && Array.isArray(connection.trustedHosts) ? connection.trustedHosts : undefined
  if (list === undefined) return
  const wanted = fenceTargets(state)
  for (const entry of [...state.addedTrusted]) {
    if (wanted.includes(entry)) continue
    const at = list.indexOf(entry)
    if (at !== -1) list.splice(at, 1)
    state.addedTrusted.delete(entry)
  }
  for (const entry of wanted) {
    if (list.includes(entry) || state.addedTrusted.has(entry)) continue
    list.push(entry)
    state.addedTrusted.add(entry)
  }
}

/**
 * Apply one bind mode to the live web server. Serialized through state.chain;
 * safe to call repeatedly (rapid switches queue).
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function applyBindMode(ctx, state, mode, ip) {
  const run = async () => {
    const ws = ctx.get('webServer')
    if (!ws?.server) return { ok: false, error: 'webServer 不可用' }
    const server = ws.server
    const port = ws.port ?? server.address()?.port
    if (!port) return { ok: false, error: '无法确定监听端口' }

    let target
    if (mode === 'local') target = '127.0.0.1'
    else if (mode === 'all') target = '0.0.0.0'
    else if (mode === 'ip') {
      if (typeof ip !== 'string' || ip === '127.0.0.1' || ip === '0.0.0.0' || !detectAddrs().some((entry) => entry.address === ip)) {
        // The chosen address is gone (DHCP change, adapter disabled): fall
        // back to loopback-only and persist it so the UI shows the truth.
        state.bind = { mode: 'local' }
        state.boundHost = '127.0.0.1'
        if (state.twin) {
          await state.twin.close()
          state.twin = undefined
        }
        try {
          await saveStateFile(state)
        } catch (saveError) {
          ctx.logger.warn(`lan-gate: failed to persist fallback bind: ${String(saveError)}`)
        }
        return { ok: false, error: '所选 IP 已不在本机网卡列表中，已回退为仅本机（127.0.0.1）' }
      }
      target = ip
    } else {
      return { ok: false, error: '未知模式' }
    }

    const wasBound = state.boundHost

    // 1. Tear down whatever the previous mode had (twin first). Every close
    //    destroys tracked sockets first (incl. WebSockets) so it can never
    //    hang on an upgraded connection.
    if (state.twin) {
      await state.twin.close()
      state.twin = undefined
    }

    // 2. Rebind the core server (our gate listeners survive close/re-listen).
    try {
      if (server.listening) await closeServer(server, state.socketSets.get(server))
      await listenServer(server, port, target)
    } catch (error) {
      // Roll back to loopback so the GUI never goes fully dark.
      try {
        if (server.listening) await closeServer(server, state.socketSets.get(server))
        await listenServer(server, port, '127.0.0.1')
      } catch (rollbackError) {
        ctx.logger.error(`lan-gate: rollback to 127.0.0.1 failed: ${String(rollbackError)}`)
      }
      state.boundHost = '127.0.0.1'
      ctx.logger.warn(`lan-gate: bind to ${target} failed (${String(error?.message ?? error)}); staying on 127.0.0.1`)
      return { ok: false, error: `绑定 ${target} 失败：${String(error?.message ?? error)}` }
    }
    state.boundHost = target

    // 3. A specific-IP bind gets a loopback twin so 127.0.0.1 keeps working.
    //    The twin carries the SAME gate as the core (endpoints + passthrough
    //    for loopback), otherwise the Settings page on 127.0.0.1 would lose
    //    /__lanauth/* in specific-IP mode.
    if (target !== '0.0.0.0' && target !== '127.0.0.1') {
      try {
        const twin = createServer(twinRequestHandler(ws, ctx.logger))
        twin.on('upgrade', twinUpgradeHandler(ws, ctx.logger))
        installGateOnServer(ctx, state, twin, null)
        await listenServer(twin, port, '127.0.0.1')
        state.twin = {
          server: twin,
          close: async () => {
            await closeServer(twin, state.socketSets.get(twin))
            releaseServerSockets(state, twin)
          }
        }
      } catch (error) {
        releaseServerSockets(state, twin)
        ctx.logger.warn(`lan-gate: loopback twin for ${target} failed: ${String(error?.message ?? error)}`)
      }
    }

    state.bind = mode === 'ip' ? { mode, ip: target } : { mode }
    refreshOwnIps(state, true)
    syncFence(ctx, state)
    try {
      await saveStateFile(state)
    } catch (error) {
      ctx.logger.warn(`lan-gate: failed to persist bind state: ${String(error)}`)
    }
    ctx.logger.info(`lan-gate: bind switched ${wasBound} -> ${target} (mode=${mode})`)
    return { ok: true }
  }
  state.chain = state.chain.then(run, run)
  return state.chain
}

/** Human-facing LAN URLs for the current bind (used by status/UI). */
function lanUrlsFor(state, port) {
  if (state.boundHost === '0.0.0.0') return detectAddrs().map((entry) => `http://${entry.address}:${String(port)}`)
  if (state.boundHost === '127.0.0.1') return []
  return [`http://${state.boundHost}:${String(port)}`]
}

// ── HTML pages (login / dead-end) ───────────────────────────────────────────

/** Render the shared login page shell. */
function loginPageHtml({ mode, error, lockedMs, port }) {
  const errorLine = error
    ? `<p class="msg msg-error">${error}</p>`
    : lockedMs !== undefined
      ? `<p class="msg msg-error">尝试次数过多，请在 ${Math.ceil(lockedMs / 1000)} 秒后重试。</p>`
      : `<p class="msg">请输入访问密码。密码与允许访问的网卡由电脑端在「设置 → 局域网访问」中管理。</p>`
  const body = mode === 'nopassword'
    ? `<div class="card">
         <div class="brand">DeepSeek Harness</div>
         <h1>局域网访问尚未启用</h1>
         <p class="msg msg-warn">服务器还没有设置访问密码，因此拒绝了来自局域网的请求。</p>
         <p class="msg">请先在电脑上打开
           <code>http://127.0.0.1:${port ?? 3080}</code>
           的设置 → 局域网访问，设置密码后刷新本页即可登录。</p>
       </div>`
    : `<div class="card">
         <div class="brand">DeepSeek Harness</div>
         <h1>局域网访问需要密码</h1>
         ${errorLine}
         <form method="post" action="/__lanauth/login">
           <label for="password">访问密码</label>
           <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
           <button type="submit">登录</button>
         </form>
       </div>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>DeepSeek Harness · 局域网访问</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f4f5f7; color: #1d1f23;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #14161a; color: #e9eaee; }
  }
  .card {
    width: min(92vw, 380px); padding: 28px 26px; border-radius: 14px;
    background: #ffffff; box-shadow: 0 10px 34px rgba(0,0,0,.10);
    border: 1px solid #e4e6ea;
  }
  @media (prefers-color-scheme: dark) {
    .card { background: #1e2126; border-color: #32363d; }
  }
  .brand { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; opacity: .55; }
  h1 { font-size: 18px; margin: 10px 0 14px; line-height: 1.4; }
  .msg { font-size: 13px; line-height: 1.6; margin: 0 0 14px; opacity: .9; }
  .msg-error { color: #d93025; opacity: 1; }
  .msg-warn { color: #b45309; }
  @media (prefers-color-scheme: dark) { .msg-error { color: #ff8a80; } .msg-warn { color: #fbbf24; } }
  form { display: flex; flex-direction: column; gap: 8px; }
  label { font-size: 13px; opacity: .8; }
  input {
    font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #d0d3d9;
    background: transparent; color: inherit;
  }
  input:focus-visible { outline: 2px solid #3b82f6; border-color: transparent; }
  @media (prefers-color-scheme: dark) { input { border-color: #4a4f57; } }
  button {
    margin-top: 8px; font: inherit; font-weight: 600; color: #fff; cursor: pointer;
    background: #4176e6; border: 0; border-radius: 8px; padding: 10px 12px;
  }
  button:hover { background: #3663d0; }
  code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px;
         background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>${body}</body>
</html>`
}

// ── gate logic ──────────────────────────────────────────────────────────────

/** Handle one /__lanauth/* endpoint request. `local` = this-machine source. */
async function handleAuthEndpoint(ctx, state, req, res, remote, local) {
  const method = String(req.method ?? 'GET').toUpperCase()
  const path = pathOf(req)

  if (path === `${LAN_AUTH_PREFIX}/status` && method === 'GET') {
    const ws = ctx.get('webServer')
    const port = ws?.port ?? null
    sendJson(res, 200, {
      ok: true,
      local,
      auth: local ? 'trusted' : state.password !== null ? 'required' : 'blocked',
      mode: state.bind.mode,
      boundHost: state.boundHost,
      port,
      hasPassword: state.password !== null,
      detected: detectAddrs(),
      lanEnabled: state.boundHost !== '127.0.0.1',
      lanUrls: lanUrlsFor(state, port)
    })
    return
  }

  if (path === `${LAN_AUTH_PREFIX}/login` && method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '无法读取请求体' } })
    }
    const contentType = String(req.headers['content-type'] ?? '')
    let password = ''
    try {
      if (contentType.includes('application/json')) {
        password = String(JSON.parse(body)?.password ?? '')
      } else {
        password = String(new URLSearchParams(body).get('password') ?? '')
      }
    } catch {
      password = ''
    }
    if (state.password === null) {
      return sendJson(res, 403, { ok: false, error: { code: 'no-password', message: '尚未设置访问密码' } })
    }
    const locked = attemptGuard(state, 'login', remote, 'check')
    if (locked) {
      return sendJson(res, 429, { ok: false, error: { code: 'rate-limited', message: '尝试次数过多，请稍后再试' } })
    }
    if (!verifyPassword(password, state.password)) {
      attemptGuard(state, 'login', remote, 'fail')
      if (apiish(req)) return sendJson(res, 401, { ok: false, error: { code: 'wrong-password', message: '密码错误' } })
      const html = loginPageHtml({ mode: 'login', error: '密码错误，请重试。' })
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    attemptGuard(state, 'login', remote, 'success')
    const token = issueSession(state)
    res.setHeader('set-cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
    if (apiish(req)) return sendJson(res, 200, { ok: true, redirect: '/' })
    res.writeHead(303, { location: '/' })
    res.end()
    return
  }

  if (path === `${LAN_AUTH_PREFIX}/logout` && method === 'POST') {
    const token = parseCookies(req).get(COOKIE_NAME)
    if (token) state.sessions.delete(token)
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    if (apiish(req)) return sendJson(res, 200, { ok: true })
    res.writeHead(303, { location: '/' })
    res.end()
    return
  }

  if (path === `${LAN_AUTH_PREFIX}/password` && method === 'POST') {
    if (!local) {
      return sendJson(res, 403, { ok: false, error: { code: 'local-only', message: '修改密码只能在电脑端进行' } })
    }
    let body
    try {
      body = await readBody(req)
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '无法读取请求体' } })
    }
    let current = ''
    let next = ''
    try {
      const parsed = JSON.parse(body)
      current = typeof parsed.current === 'string' ? parsed.current : ''
      next = typeof parsed.next === 'string' ? parsed.next : ''
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求体不是合法 JSON' } })
    }
    const locked = attemptGuard(state, 'password', remote, 'check')
    if (locked) {
      return sendJson(res, 429, { ok: false, error: { code: 'rate-limited', message: '尝试次数过多，请稍后再试' } })
    }
    // Changing or removing requires the current password when one is set.
    if (state.password !== null && !verifyPassword(current, state.password)) {
      attemptGuard(state, 'password', remote, 'fail')
      return sendJson(res, 401, { ok: false, error: { code: 'wrong-current-password', message: '当前密码不正确' } })
    }
    if (next.length !== 0 && (next.length < MIN_PASSWORD_LENGTH || next.length > MAX_PASSWORD_LENGTH)) {
      return sendJson(res, 400, { ok: false, error: { code: 'invalid-password', message: `密码长度需为 ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 个字符` } })
    }
    attemptGuard(state, 'password', remote, 'success')
    const removing = next.length === 0
    const previousRecord = state.password
    const record = removing ? null : makeRecord(next)
    state.password = record
    state.passwordSetAt = Date.now()
    revokeSessions(state)
    try {
      await saveStateFile(state)
    } catch (error) {
      // Persistence failed: roll the live verifier back so memory and disk agree.
      state.password = previousRecord
      ctx.logger.warn(`lan-gate: failed to persist password state: ${String(error)}`)
      return sendJson(res, 500, { ok: false, error: { code: 'internal', message: '密码保存失败：' + String(error) } })
    }
    ctx.logger.info(removing
      ? 'lan-gate: LAN access password removed; LAN access is now blocked'
      : 'lan-gate: LAN access password changed and persisted; all sessions revoked')
    return sendJson(res, 200, { ok: true, hasPassword: !removing })
  }

  if (path === `${LAN_AUTH_PREFIX}/bind` && method === 'POST') {
    if (!local) {
      return sendJson(res, 403, { ok: false, error: { code: 'local-only', message: '切换绑定只能在电脑端进行' } })
    }
    let body
    try {
      body = await readBody(req)
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '无法读取请求体' } })
    }
    let mode
    let ip
    try {
      const parsed = JSON.parse(body)
      mode = parsed?.mode
      ip = typeof parsed?.ip === 'string' ? parsed.ip : undefined
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求体不是合法 JSON' } })
    }
    if (mode === 'ip') {
      if (!ip || !detectAddrs().some((entry) => entry.address === ip)) {
        return sendJson(res, 400, { ok: false, error: { code: 'invalid-ip', message: '所选 IP 不在本机网卡列表中' } })
      }
    } else if (mode !== 'local' && mode !== 'all') {
      return sendJson(res, 400, { ok: false, error: { code: 'invalid-mode', message: '未知模式' } })
    }

    // Reply FIRST, then switch in the background. The switch tears down every
    // connection (including this very request's socket) so the server can
    // rebind; a synchronous switch would destroy the response mid-flight and
    // the browser would report "Failed to fetch" even on success. The client
    // confirms the outcome by polling /__lanauth/status.
    const previous = state.boundHost
    sendJson(res, 200, { ok: true, accepted: true, switching: true, requestedMode: mode, requestedIp: ip, boundHost: previous })
    setTimeout(() => {
      applyBindMode(ctx, state, mode, ip).then((outcome) => {
        if (!outcome.ok) ctx.logger.warn(`lan-gate: bind switch to ${mode}${ip ? ` ${ip}` : ''} failed: ${outcome.error ?? 'unknown'}`)
      }).catch((error) => {
        ctx.logger.warn(`lan-gate: bind switch to ${mode} threw: ${String(error)}`)
      })
    }, 80)
    return
  }

  sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown endpoint' } })
}

/** Pass a request to the original server listeners. */
function passThrough(logger, originals, req, res) {
  if (originals.length === 0) {
    try {
      res.writeHead(503)
      res.end()
    } catch {
      /* ignore */
    }
    return
  }
  for (const listener of originals) {
    try {
      listener(req, res)
    } catch (error) {
      logger.warn(`lan-gate: upstream request listener failed: ${String(error)}`)
    }
  }
}

// ── HTML polyfill injection ─────────────────────────────────────────────────
//
// Browsers treat `http://<LAN-IP>:port` as an **insecure context**, where the
// Web API `crypto.randomUUID()` is undefined (loopback 127.0.0.1/localhost and
// https are secure contexts, which is why the GUI works on the computer but
// breaks on the phone). dsh-client-connection's client half calls
// `crypto.randomUUID()` directly when minting RPC ids and message ids, so on
// an insecure origin EVERY /api call throws "crypto.randomUUID is not a
// function": the session list stays empty and creating a session/workspace
// fails. The gate therefore rewrites every text/html response it passes
// through, seeding a getRandomValues-backed UUID v4 fallback before any app
// module runs. The guard makes it a no-op in secure contexts (and idempotent
// if the response is ever rewritten twice).

/** Polyfill injected into served HTML (ASCII only, no external deps). */
const POLYFILL_SCRIPT =
  '<script>/*lan-gate polyfill*/' +
  'if(window.crypto&&!window.crypto.randomUUID&&window.crypto.getRandomValues&&!window.__LAN_GATE_POLYFILL__){' +
  'window.__LAN_GATE_POLYFILL__=1;' +
  'var __lgUuid=function(){var b=window.crypto.getRandomValues(new Uint8Array(16));' +
  'b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;' +
  'var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);if(x.length<2)h+="0";h+=x}' +
  'return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)};' +
  'try{Object.defineProperty(window.crypto,"randomUUID",{value:__lgUuid,configurable:true,writable:true})}' +
  'catch(e){window.crypto.randomUUID=__lgUuid}}' +
  '</script>'

/**
 * Wrap one outgoing response so a text/html body can be rewritten (polyfill
 * injection) before it reaches the wire. Node http handlers announce headers
 * first, so the content-type decision is made in writeHead; non-HTML
 * responses stream through untouched with zero buffering.
 * @param res - the real node:http ServerResponse.
 * @param scriptTag - script to insert before </head>.
 * @returns a proxy that behaves like `res` for every other use.
 */
function htmlInjectPassThrough(res, scriptTag) {
  let mode = 'direct' // 'direct' | 'buffering'
  let status = 200
  let statusMessage
  let headers
  let chunks = []

  const patch = {
    writeHead(nextStatus, ...rest) {
      if (mode === 'direct') {
        const maybe = rest.length > 0 ? rest[rest.length - 1] : undefined
        if (maybe !== undefined && maybe !== null && typeof maybe === 'object' && !Array.isArray(maybe)) {
          const ct = String(maybe['content-type'] ?? maybe['Content-Type'] ?? '').toLowerCase()
          if (ct.includes('text/html')) {
            mode = 'buffering'
            status = nextStatus
            if (rest.length > 1 && typeof rest[0] === 'string') {
              statusMessage = rest[0]
            }
            headers = { ...maybe }
            return res
          }
        }
      }
      return res.writeHead(nextStatus, ...rest)
    },
    write(chunk, ...rest) {
      if (mode === 'buffering') {
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        }
        return true
      }
      return res.write(chunk, ...rest)
    },
    end(chunk, ...rest) {
      if (mode === 'buffering') {
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        }
        let body = Buffer.concat(chunks).toString('utf8')
        if (!body.includes('__LAN_GATE_POLYFILL__')) {
          const headClose = /<\/head>/i.exec(body)
          if (headClose !== null) {
            body = `${body.slice(0, headClose.index)}${scriptTag}${body.slice(headClose.index)}`
          }
        }
        const out = Buffer.from(body, 'utf8')
        const finalHeaders = { ...headers }
        delete finalHeaders['content-length']
        delete finalHeaders['Content-Length']
        delete finalHeaders['transfer-encoding']
        delete finalHeaders['Transfer-Encoding']
        finalHeaders['content-length'] = String(out.length)
        if (statusMessage !== undefined) {
          res.writeHead(status, statusMessage, finalHeaders)
        } else {
          res.writeHead(status, finalHeaders)
        }
        res.end(out)
        return res
      }
      return res.end(chunk, ...rest)
    },
    setHeader(name, value) {
      if (mode === 'buffering') {
        headers[name] = value
        return res
      }
      return res.setHeader(name, value)
    },
    getHeader(name) {
      if (mode === 'buffering') return headers[name]
      return res.getHeader(name)
    }
  }
  return new Proxy(res, {
    get(target, prop, receiver) {
      if (prop in patch) return patch[prop]
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/**
 * Pass a request through to the upstream listeners, rewriting any text/html
 * response to seed the insecure-origin polyfill (see htmlInjectPassThrough).
 */
function gatePassThrough(ctx, originals, req, res) {
  passThrough(ctx.logger, originals, req, htmlInjectPassThrough(res, POLYFILL_SCRIPT))
}

/** Serve the login / blocked page to a LAN browser. */
function serveLanPage(ctx, res, state, error, lockedMs) {
  const mode = state.password === null ? 'nopassword' : 'login'
  const port = ctx.get('webServer')?.port
  const html = loginPageHtml({ mode, error, lockedMs, port })
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

/** Gate one regular HTTP request. */
function gateRequest(ctx, state, req, res, originals) {
  const remote = normalizeRemote(req.socket?.remoteAddress)
  const local = isTrustedLocal(state, remote)
  const path = pathOf(req)

  if (path === LAN_AUTH_PREFIX || path.startsWith(`${LAN_AUTH_PREFIX}/`)) {
    handleAuthEndpoint(ctx, state, req, res, remote, local).catch((error) => {
      ctx.logger.warn(`lan-gate: endpoint ${path} failed: ${String(error)}`)
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error) } })
      } catch {
        /* ignore */
      }
    })
    return
  }

  if (local) {
    gatePassThrough(ctx, originals, req, res)
    return
  }

  // LAN client: password gate.
  if (state.password === null) {
    if (apiish(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'no-password', message: '尚未设置访问密码，局域网访问被拒绝' } })
    } else {
      serveLanPage(ctx, res, state)
    }
    return
  }
  if (!hasValidSession(state, req)) {
    if (apiish(req)) {
      sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '需要登录' } })
    } else {
      serveLanPage(ctx, res, state)
    }
    return
  }
  gatePassThrough(ctx, originals, req, res)
}

/** Gate one WebSocket/upgrade request. */
function gateUpgrade(ctx, state, req, socket, head, originals) {
  const remote = normalizeRemote(req.socket?.remoteAddress)
  if (isTrustedLocal(state, remote) || (state.password !== null && hasValidSession(state, req))) {
    for (const listener of originals) {
      try {
        listener(req, socket, head)
      } catch (error) {
        ctx.logger.warn(`lan-gate: upstream upgrade listener failed: ${String(error)}`)
      }
    }
    return
  }
  if (state.password === null) {
    rejectUpgrade(socket, 403, 'lan access requires a configured password')
  } else {
    rejectUpgrade(socket, 403, 'forbidden')
  }
}

/**
 * Wrap ONE server's request/upgrade listeners with the gate, replacing its
 * current listeners (the ones the caller captured as "originals"). Also
 * starts socket tracking so rebinds can destroy upgraded connections.
 * @param ctx - plugin context (logger, services).
 * @param state - gate state.
 * @param server - node:http server to gate.
 * @param logLine - message logged once the gate is live.
 * @returns a disposer that restores the original listeners.
 */
function installGateOnServer(ctx, state, server, logLine) {
  const requestOriginals = server.listeners('request')
  const upgradeOriginals = server.listeners('upgrade')
  server.removeAllListeners('request')
  server.removeAllListeners('upgrade')
  server.on('request', (req, res) => gateRequest(ctx, state, req, res, requestOriginals))
  server.on('upgrade', (req, socket, head) => gateUpgrade(ctx, state, req, socket, head, upgradeOriginals))

  // Track every accepted socket (including ones upgraded to WebSocket) so a
  // later rebind can destroy them and never hang on server.close().
  const sockets = new Set()
  state.socketSets.set(server, sockets)
  state.socketTrackers.set(server, trackServerSockets(server, sockets))

  if (logLine) ctx.logger.info(logLine)
  return () => {
    server.removeAllListeners('request')
    server.removeAllListeners('upgrade')
    for (const listener of requestOriginals) server.on('request', listener)
    for (const listener of upgradeOriginals) server.on('upgrade', listener)
    releaseServerSockets(state, server)
  }
}

/** Install the gate on the live (core) web server. */
function installGate(ctx, state) {
  const ws = ctx.get('webServer')
  if (!ws?.server) return false
  if (state.installed) return true

  state.restore = installGateOnServer(ctx, state, ws.server, 'lan-gate: gate installed on web server — LAN requests now require the access password, local passes freely')
  state.installed = true
  return true
}

/** Test hooks for the gate internals; production never mutates them. */
export const internals = {
  createState,
  installGate,
  gateRequest,
  gateUpgrade,
  handleAuthEndpoint,
  applyBindMode,
  syncFence,
  fenceTargets,
  verifyPassword,
  makeRecord,
  loadStateFile,
  saveStateFile,
  loginPageHtml,
  detectAddrs,
  refreshOwnIps,
  isTrustedLocal,
  isLoopbackRemote,
  normalizeRemote,
  parseCookies,
  hasValidSession,
  revokeSessions,
  attemptGuard,
  issueSession,
  closeServer,
  listenServer,
  trackServerSockets,
  releaseServerSockets,
  htmlInjectPassThrough,
  stateFilePath
}

/**
 * Mount the plugin: load persisted state (password + bind mode), install the
 * gate once the loader tree has settled, then apply the stored bind mode so
 * the server ends up on the interface the user chose.
 *
 * `inject: ['webServer']` guarantees the service exists here; the loader
 * settle wait further guarantees every route/fallback is registered before
 * the gate replaces the server's request listeners.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const state = createState()

  let retryTimer
  let retries = 0
  const tryInstall = () => {
    if (state.installed) return
    if (installGate(ctx, state)) return
    // webServer service present but its server not bound yet — retry briefly.
    retries += 1
    if (retries > 100) {
      ctx.logger.warn('lan-gate: webServer never became ready; gate not installed')
      return
    }
    retryTimer = setTimeout(() => tryInstall(), 300)
  }

  const boot = async () => {
    // Post-settle availability check: in the web profile webServer always
    // exists by now; anywhere else this is a genuine "not applicable" and we
    // no-op instead of crashing or stalling.
    if (!ctx.get('webServer')) {
      ctx.logger.debug('lan-gate: webServer unavailable; gate not installed')
      return
    }
    try {
      const loaded = await loadStateFile()
      state.password = loaded.record
      state.passwordSetAt = loaded.setAt
      if (loaded.bind) state.bind = loaded.bind
    } catch (error) {
      ctx.logger.warn(`lan-gate: could not read ${stateFilePath()}: ${String(error)}`)
    }
    tryInstall()
    refreshOwnIps(state, true)
    // Apply the persisted bind mode (default: all interfaces).
    const outcome = await applyBindMode(ctx, state, state.bind.mode, state.bind.ip)
    if (!outcome.ok) ctx.logger.warn(`lan-gate: initial bind failed: ${outcome.error ?? 'unknown'}`)
  }

  const loader = ctx.get('loader')
  const settle = loader?.await ? loader.await() : Promise.resolve()
  settle.then(boot, boot)

  ctx.effect(() => () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    if (state.twin) {
      // Destroys sockets synchronously inside closeServer's executor.
      closeServer(state.twin.server, state.socketSets.get(state.twin.server))
      releaseServerSockets(state, state.twin.server)
      state.twin = undefined
    }
    if (state.restore) state.restore()
  }, 'lan-gate: gate lifecycle')
}
