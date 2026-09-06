/**
 * Integration/smoke test for the dsh-lan-gate host half (v0.2).
 *
 * Exercises the gate against a real node:http server over loopback plus
 * fabricated non-loopback (LAN) requests, and the live bind engine
 * (local / all / specific-IP with loopback twin) against a second real
 * server.
 *
 * Run:  node tools/gate-test.mjs
 */

import { createServer, request as httpRequest } from 'node:http'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { apply, internals } = await import('../lib/index.js')

let passed = 0
let failed = 0
function check(name, condition, extra) {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${extra === undefined ? '' : ` — ${extra}`}`)
  }
}

function fakeRes() {
  const out = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      out.status = status
      if (headers) Object.assign(out.headers, headers)
      out.headersSent = true
    },
    setHeader(name, value) {
      out.headers[name] = value
    },
    end(body) {
      out.body = body === undefined ? '' : String(body)
    }
  }
  return out
}

function fakeReq(over) {
  const req = new EventEmitter()
  req.url = '/'
  req.method = 'GET'
  req.headers = {}
  req.socket = { remoteAddress: '192.168.7.9' }
  req.body = (text) => {
    // Defer emission so the endpoint's readBody attaches its listeners first.
    setImmediate(() => {
      req.emit('data', Buffer.from(text, 'utf8'))
      req.emit('end')
    })
    return req
  }
  Object.assign(req, over)
  return req
}

function makeLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} }
}

const originalRootHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('root-ok')
}

// ── environment ─────────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'lan-gate-test-'))
process.env.DSH_HOME = home
console.log(`test home: ${home}`)

// ══ A. real gate over loopback ══════════════════════════════════════════════
console.log('\n[A. loopback via real gate]')
const server = createServer(originalRootHandler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = `http://127.0.0.1:${port}`

function raw(method, path, headers, body) {
  return new Promise((resolveRaw, rejectRaw) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolveRaw({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', rejectRaw)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const effects = []
const wsMock = {
  host: '127.0.0.1',
  get port() { return server.address() ? server.address().port : port },
  server
}
const ctx = {
  get(name) {
    if (name === 'webServer') return wsMock
    if (name === 'loader') return { await: () => Promise.resolve() }
    return undefined
  },
  effect(fn) {
    effects.push(fn())
  },
  logger: makeLogger()
}

apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 400))

{
  const res = await fetch(`${url}/`)
  check('A1 loopback GET / passes through (no password needed)', res.status === 200 && (await res.text()) === 'root-ok')
}
{
  const res = await fetch(`${url}/__lanauth/status`)
  const data = await res.json()
  check('A2 status: ok, local trusted, hasPassword=false', res.status === 200 && data.ok === true && data.local === true && data.hasPassword === false)
  check('A3 status: auth=trusted on loopback, mode=all default', data.auth === 'trusted' && data.mode === 'all' && data.lanEnabled === true)
  check('A4 status: detected list carries machine interfaces', Array.isArray(data.detected) && data.detected.length >= 1 && typeof data.detected[0].address === 'string')
  check('A5 status: lanUrls carries detected LAN IPs', Array.isArray(data.lanUrls) && data.lanUrls.length >= 1)
}
{
  const res = await fetch(`${url}/__lanauth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ current: '', next: 'secret123' })
  })
  const data = await res.json()
  check('A6 set initial password', res.status === 200 && data.ok === true && data.hasPassword === true)
}
{
  const rawText = readFileSync(join(home, 'lan-gate.json'), 'utf8')
  check('A7 password + bind persisted to $DSH_HOME/lan-gate.json', rawText.includes('"password"') && rawText.includes('"bind"'))
  check('A8 plaintext never stored', !rawText.includes('secret123'))
}
{
  const res = await raw('POST', '/__lanauth/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'password=wrong-password')
  check('A9 login with wrong password -> 401', res.status === 401)
}
{
  const res = await raw('POST', '/__lanauth/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'password=secret123')
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '')
  check('A10 login with correct password -> 303 + session cookie', res.status === 303 && setCookie.includes('dsh_lan_gate='))
  const token = /dsh_lan_gate=([^;]+)/.exec(setCookie)[1]
  const res2 = await raw('GET', '/', { cookie: `dsh_lan_gate=${token}` })
  check('A11 cookie-authenticated request passes', res2.status === 200 && res2.body === 'root-ok')
  const res3 = await raw('POST', '/__lanauth/password', { 'content-type': 'application/json' }, JSON.stringify({ current: 'secret123', next: 'new-secret-456' }))
  const data3 = JSON.parse(res3.body)
  check('A12 change password with correct current', res3.status === 200 && data3.ok === true)
  const res4 = await fetch(`${url}/__lanauth/status`)
  const data4 = await res4.json()
  check('A13 still has password after change', data4.hasPassword === true)
}

// ══ B. LAN branch via internals ═════════════════════════════════════════════
console.log('\n[B. LAN branch via internals]')
{
  const state = internals.createState()
  const lanCtx = {
    ...ctx,
    get: (n) => (n === 'webServer' ? wsMock : undefined)
  }
  const logger = makeLogger()

  // no password configured yet: LAN blocked
  const resNoPwd = fakeRes()
  internals.gateRequest({ ...lanCtx, logger }, state, fakeReq({ headers: { accept: 'text/html' } }), resNoPwd, [originalRootHandler])
  await new Promise((r) => setTimeout(r, 20))
  check('B1 LAN without password -> dead-end page (not the app)', resNoPwd.status === 200 && resNoPwd.body.includes('局域网访问尚未启用'))

  const resApi = fakeRes()
  internals.gateRequest({ ...lanCtx, logger }, state, fakeReq({ url: '/api/anything', headers: { accept: 'application/json' } }), resApi, [originalRootHandler])
  await new Promise((r) => setTimeout(r, 20))
  check('B2 LAN API without password -> 403 json no-password', resApi.status === 403 && resApi.body.includes('no-password'))

  // password configured: privileged endpoints are local-only
  state.password = internals.makeRecord('lan-pass-123')
  const resPwd = fakeRes()
  await internals.handleAuthEndpoint({ ...lanCtx, logger }, state, fakeReq({ url: '/__lanauth/password', method: 'POST', headers: { 'content-type': 'application/json' } }), resPwd, '192.168.7.9', false)
  check('B3 LAN cannot change password (local-only) -> 403', resPwd.status === 403 && resPwd.body.includes('local-only'))

  const resBind = fakeRes()
  await internals.handleAuthEndpoint({ ...lanCtx, logger }, state, fakeReq({ url: '/__lanauth/bind', method: 'POST', headers: { 'content-type': 'application/json' } }), resBind, '192.168.7.9', false)
  check('B4 LAN cannot switch bind mode (local-only) -> 403', resBind.status === 403 && resBind.body.includes('local-only'))

  // unauthenticated LAN browser -> login page, not the app
  const resLogin = fakeRes()
  internals.gateRequest({ ...lanCtx, logger }, state, fakeReq({ headers: { accept: 'text/html' } }), resLogin, [originalRootHandler])
  await new Promise((r) => setTimeout(r, 20))
  check('B5 LAN without cookie -> login page', resLogin.status === 200 && resLogin.body.includes('局域网访问需要密码'))

  // unauthenticated LAN api -> 401 json
  const resApi2 = fakeRes()
  internals.gateRequest({ ...lanCtx, logger }, state, fakeReq({ url: '/api/anything', headers: { accept: 'application/json' } }), resApi2, [originalRootHandler])
  await new Promise((r) => setTimeout(r, 20))
  check('B6 LAN API without cookie -> 401 unauthorized', resApi2.status === 401 && resApi2.body.includes('unauthorized'))

  // valid session cookie -> passthrough
  const token = internals.issueSession(state)
  const resOk = fakeRes()
  internals.gateRequest({ ...lanCtx, logger }, state, fakeReq({ headers: { cookie: `dsh_lan_gate=${token}`, accept: 'text/html' } }), resOk, [originalRootHandler])
  check('B7 LAN with valid cookie -> passthrough to app', resOk.status === 200 && resOk.body === 'root-ok')

  // LAN login through the endpoint
  const resLoginOk = fakeRes()
  await internals.handleAuthEndpoint({ ...lanCtx, logger }, state, fakeReq({ url: '/__lanauth/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).body('password=lan-pass-123'), resLoginOk, '192.168.7.9', false)
  check('B8 LAN login success sets cookie (303 for form caller)', resLoginOk.status === 303 && typeof resLoginOk.headers.location === 'string')

  for (let i = 0; i < 5; i++) {
    const r = fakeRes()
    await internals.handleAuthEndpoint({ ...lanCtx, logger }, state, fakeReq({ url: '/__lanauth/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).body('password=wrong-lan'), r, '192.168.7.9', false)
    void r
  }
  const badLogin = fakeRes()
  await internals.handleAuthEndpoint({ ...lanCtx, logger }, state, fakeReq({ url: '/__lanauth/login', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' } }).body('{"password":"wrong-lan"}'), badLogin, '192.168.7.9', false)
  check('B9 login rate limit kicks in after 5 failures', badLogin.status === 429 && badLogin.body.includes('rate-limited'))

  // upgrade gating
  let upgraded = false
  const sock = { end(data) { this.written = data }, written: '', destroy() {} }
  internals.gateUpgrade({ ...lanCtx, logger }, state, fakeReq({ headers: {} }), sock, Buffer.alloc(0), [(r, s) => { upgraded = true }])
  check('B10 LAN upgrade without cookie rejected', upgraded === false && typeof sock.written === 'string' && sock.written.includes('403'))
  const sock2 = { end() {}, destroy() {} }
  let upgraded2 = false
  internals.gateUpgrade({ ...lanCtx, logger }, state, fakeReq({ headers: { cookie: `dsh_lan_gate=${token}` } }), sock2, Buffer.alloc(0), [(r, s) => { upgraded2 = true }])
  check('B11 LAN upgrade with valid cookie accepted', upgraded2 === true)

  // removal blocks LAN again
  const resRemove = fakeRes()
  await internals.handleAuthEndpoint({ ...lanCtx, logger }, state, fakeReq({ url: '/__lanauth/password', method: 'POST', headers: { 'content-type': 'application/json' } }).body('{"current":"lan-pass-123","next":""}'), resRemove, '127.0.0.1', true)
  check('B12 remove password (local, correct current)', resRemove.status === 200 && resRemove.body.includes('"hasPassword":false'))
  const resAfterRemove = fakeRes()
  internals.gateRequest({ ...lanCtx, logger }, state, fakeReq({ headers: { accept: 'text/html' } }), resAfterRemove, [originalRootHandler])
  await new Promise((r) => setTimeout(r, 20))
  check('B13 LAN blocked again after password removal', resAfterRemove.body.includes('局域网访问尚未启用'))
}

// ══ C. bind engine ══════════════════════════════════════════════════════════
console.log('\n[C. bind engine (live rebind + loopback twin + fence)]')
{
  // A second real server plays the role of the webServer service.
  const server2 = createServer(originalRootHandler)
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
  const port2 = server2.address().port
  const detected = internals.detectAddrs()
  const specific = detected[0]?.address

  const fenceList = []
  const routeHandler = { handler: originalRootHandler }
  const ws2 = {
    host: '127.0.0.1',
    get port() { return server2.address() ? server2.address().port : port2 },
    server: server2,
    match: (p) => (p === '/' ? routeHandler : undefined),
    fallback: undefined,
    upgrades: new Map()
  }
  const ctx2 = {
    get(name) {
      if (name === 'webServer') return ws2
      if (name === 'connection') return { trustedHosts: fenceList }
      return undefined
    },
    effect() {},
    logger: makeLogger()
  }

  const state = internals.createState()
  state.bind = { mode: 'local' }
  state.boundHost = '127.0.0.1'

  // invalid ip rejected by the engine
  const invalid = await internals.applyBindMode(ctx2, state, 'ip', '203.0.113.9')
  check('C1 unknown mode ip rejected', invalid.ok === false && state.boundHost === '127.0.0.1')

  // mode: all
  const allOut = await internals.applyBindMode(ctx2, state, 'all')
  check('C2 bind all -> ok, boundHost 0.0.0.0, no twin', allOut.ok === true && state.boundHost === '0.0.0.0' && state.twin === undefined)
  check('C3 server actually listening on 0.0.0.0', String(server2.address().address) === '0.0.0.0')
  check('C4 fence carries every detected LAN IP in all mode',
    detected.every((d) => fenceList.includes(d.address)) && fenceList.length === detected.length)
  const localOut = await internals.applyBindMode(ctx2, state, 'local')
  check('C5 bind local -> ok, boundHost 127.0.0.1', localOut.ok === true && state.boundHost === '127.0.0.1' && state.twin === undefined)
  check('C6 fence emptied after switching to local', fenceList.length === 0)

  if (specific) {
    const ipOut = await internals.applyBindMode(ctx2, state, 'ip', specific)
    check('C7 bind specific IP -> ok, boundHost = ' + specific, ipOut.ok === true && state.boundHost === specific)
    check('C8 loopback twin started in specific mode', state.twin !== undefined && state.twin.server !== undefined)
    check('C9 fence carries exactly the specific IP', fenceList.length === 1 && fenceList[0] === specific)
    // twin serves 127.0.0.1 through the shared route table
    const twinRes = await fetch(`http://127.0.0.1:${port2}/`, { headers: { connection: 'close' } })
    check('C10 loopback twin serves the app on 127.0.0.1', twinRes.status === 200 && (await twinRes.text()) === 'root-ok')
    // the twin must carry the gate too, or the Settings page loses /__lanauth/*
    const twinStatus = await fetch(`http://127.0.0.1:${port2}/__lanauth/status`)
    const twinData = await twinStatus.json().catch(() => null)
    check('C10b twin serves /__lanauth/status (gate on twin)',
      twinStatus.status === 200 && twinData !== null && twinData.ok === true && twinData.mode === 'ip' && twinData.boundHost === specific && twinData.local === true)
    // bound host serves directly
    const directRes = await fetch(`http://${specific}:${port2}/`, { headers: { connection: 'close' } })
    check('C11 specific IP serves the app directly', directRes.status === 200 && (await directRes.text()) === 'root-ok')
    // switch away closes the twin
    await internals.applyBindMode(ctx2, state, 'all')
    check('C12 twin closed after leaving specific mode', state.twin === undefined)
    check('C13 fence resynced for all mode after twin teardown', fenceList.length === detected.length)
  } else {
    check('C7-C13 skipped (no non-internal IPv4 detected)', true)
  }

  console.log('  .. bind tail: switching to local')
  await internals.applyBindMode(ctx2, state, 'local')
  console.log('  .. bind tail: closing server2')
  try { server2.closeAllConnections?.() } catch {}
  await new Promise((resolve) => {
    const timer = setTimeout(() => { console.error('  .. WARN server2.close timed out'); resolve() }, 4000)
    try {
      server2.close(() => { clearTimeout(timer); resolve() })
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
  console.log('  .. bind tail: done')
}

// ══ D. dispose restores listeners ═══════════════════════════════════════════
console.log('\n[D. dispose restores listeners]')
{
  check('D1 server had exactly one request listener (the gate)', server.listeners('request').length === 1 && server.listeners('upgrade').length === 1)
  for (const cleanup of effects.splice(0)) cleanup()
  check('D2 dispose restores the original request listener', server.listeners('request').length === 1)
  const res = await fetch(`${url}/`)
  check('D3 server still serves after dispose', res.status === 200 && (await res.text()) === 'root-ok')
}

// ══ F. upgraded-socket (WebSocket) close regression ═════════════════════════
// server.closeAllConnections() skips upgraded sockets; without tracked-socket
// destruction a rebind would hang forever on a live WebSocket and kill the
// port. This reproduces that scenario and asserts closeServer still resolves.
console.log('\n[F. upgraded-socket close regression]')
{
  const server3 = createServer(originalRootHandler)
  let upgrades = 0
  server3.on('upgrade', (req, socket) => {
    upgrades += 1
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  await new Promise((resolve) => server3.listen(0, '127.0.0.1', resolve))
  const port3 = server3.address().port
  const tracked = new Set()
  const untrack = internals.trackServerSockets(server3, tracked)

  const client = net.connect(port3, '127.0.0.1')
  client.on('data', () => {}) // consume the 101 bytes so 'end'/'close' can fire
  await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  client.write('GET /api/events.mux HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  await new Promise((resolve) => setTimeout(resolve, 250))
  check('F1 upgrade accepted (websocket-like socket alive)', upgrades === 1 && tracked.size >= 1)

  const started = Date.now()
  await internals.closeServer(server3, tracked)
  const elapsed = Date.now() - started
  check('F2 closeServer with upgraded socket resolves quickly (<2s)', elapsed < 2000, `elapsed ${elapsed}ms`)
  const closedByServer = await Promise.race([
    new Promise((resolve) => client.once('close', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 1500))
  ])
  check('F3 client connection closed after server-side destroy', closedByServer === true)

  await internals.listenServer(server3, port3, '127.0.0.1')
  const resAfter = await fetch(`http://127.0.0.1:${port3}/`, { headers: { connection: 'close' } })
  check('F4 server accepts again after close+listen', resAfter.status === 200 && (await resAfter.text()) === 'root-ok')

  untrack()
  client.destroy()
  server3.closeAllConnections?.()
  await new Promise((resolve) => server3.close(resolve))
}

// ══ G. HTML polyfill injection (insecure-origin crypto.randomUUID) ══════════
// Browsers on plain http://LAN-IP sit in an *insecure context*, where the Web
// API crypto.randomUUID() is undefined; dsh client code mints RPC/message ids
// with it, so every /api call would throw and the GUI would show an empty
// session list ("crypto.randomUUID is not a function"). The gate rewrites
// passed-through text/html to seed the polyfill and leaves other content
// untouched.
console.log('\n[G. html polyfill injection]')
{
  const htmlUpstream = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><head><meta charset="utf-8"><title>gui</title></head><body>the-app</body></html>')
  }
  const jsonUpstream = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":1}')
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

  // Local (loopback) html passthrough gets rewritten.
  {
    const state = internals.createState()
    const out = fakeRes()
    internals.gateRequest({ ...ctx, logger: makeLogger() }, state, fakeReq({ socket: { remoteAddress: '127.0.0.1' } }), out, [htmlUpstream])
    await flush()
    check('G1 local html response carries the polyfill', out.status === 200 && out.body.includes('__LAN_GATE_POLYFILL__') && out.body.includes('randomUUID') && out.body.includes('the-app'))
    check('G2 polyfill sits before </head>', out.body.indexOf('__LAN_GATE_POLYFILL__') !== -1 && out.body.indexOf('__LAN_GATE_POLYFILL__') < out.body.indexOf('</head>'))
    check('G3 rewritten html still declares text/html', String(out.headers['content-type'] ?? '').includes('text/html'))
  }
  // Non-html content is never buffered/rewritten.
  {
    const state = internals.createState()
    const out = fakeRes()
    internals.gateRequest({ ...ctx, logger: makeLogger() }, state, fakeReq({ socket: { remoteAddress: '127.0.0.1' }, url: '/api/anything' }), out, [jsonUpstream])
    await flush()
    check('G4 non-html response untouched', out.status === 200 && out.body === '{"ok":1}' && !out.body.includes('__LAN_GATE_POLYFILL__'))
  }
  // The phone path: LAN-authenticated html also gets the polyfill.
  {
    const state = internals.createState()
    state.password = internals.makeRecord('lan-pw-123')
    const token = internals.issueSession(state)
    const out = fakeRes()
    internals.gateRequest({ ...ctx, logger: makeLogger() }, state, fakeReq({ headers: { cookie: `dsh_lan_gate=${token}` } }), out, [htmlUpstream])
    await flush()
    check('G5 LAN-authed html response carries the polyfill', out.body.includes('__LAN_GATE_POLYFILL__') && out.body.includes('the-app'))
  }
  // End-to-end through a real server with the gate installed.
  {
    const serverG = createServer((req, res) => {
      if (req.url === '/api/x') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":1}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>gui</title></head><body>the-app</body></html>')
    })
    await new Promise((resolve) => serverG.listen(0, '127.0.0.1', resolve))
    const portG = serverG.address().port
    const urlG = `http://127.0.0.1:${portG}`
    const wsG = {
      host: '127.0.0.1',
      get port() { return serverG.address() ? serverG.address().port : portG },
      server: serverG
    }
    const ctxG = {
      get(n) {
        if (n === 'webServer') return wsG
        return undefined
      },
      effect() {},
      logger: makeLogger()
    }
    const stateG = internals.createState()
    internals.installGate({ ...ctxG, logger: makeLogger() }, stateG)
    const htmlRes = await fetch(`${urlG}/`)
    const htmlText = await htmlRes.text()
    check('G6 real gate: html rewritten end-to-end', htmlRes.status === 200 && htmlText.includes('__LAN_GATE_POLYFILL__') && htmlText.includes('the-app'))
    check('G7 real gate: content-type preserved', (htmlRes.headers.get('content-type') ?? '').includes('text/html'))
    const jsonRes = await fetch(`${urlG}/api/x`)
    check('G8 real gate: json untouched', jsonRes.status === 200 && (await jsonRes.text()) === '{"ok":1}')
    serverG.closeAllConnections?.()
    await new Promise((resolve) => serverG.close(resolve))
  }
}

// ══ E. crypto / helpers ═════════════════════════════════════════════════════
console.log('\n[E. crypto / helpers]')
{
  const record = internals.makeRecord('hunter2')
  check('E1 verifyPassword accepts the right password', internals.verifyPassword('hunter2', record) === true)
  check('E2 verifyPassword rejects the wrong password', internals.verifyPassword('hunter3', record) === false)
  check('E3 verifyPassword rejects empty record', internals.verifyPassword('hunter2', null) === false)
  check('E4 normalizeRemote strips ::ffff:', internals.normalizeRemote('::ffff:127.0.0.1') === '127.0.0.1')
  check('E5 isLoopbackRemote covers 127.0.0.1 and ::1', internals.isLoopbackRemote('127.0.0.1') && internals.isLoopbackRemote('::1') && !internals.isLoopbackRemote('192.168.7.9'))
  const parsed = internals.parseCookies({ headers: { cookie: 'a=1; dsh_lan_gate=abc; x=2' } })
  check('E6 cookie parsing', parsed.get('dsh_lan_gate') === 'abc' && parsed.get('a') === '1')
  const state = internals.createState()
  state.password = record
  const token = internals.issueSession(state)
  check('E7 hasValidSession true for issued token', internals.hasValidSession(state, { headers: { cookie: `dsh_lan_gate=${token}` } }) === true)
  check('E8 hasValidSession false for bogus token', internals.hasValidSession(state, { headers: { cookie: 'dsh_lan_gate=nope' } }) === false)
  internals.revokeSessions(state)
  check('E9 revokeSessions invalidates issued tokens', internals.hasValidSession(state, { headers: { cookie: `dsh_lan_gate=${token}` } }) === false)
  const ownIp = internals.detectAddrs()[0]?.address
  if (ownIp) {
    check('E10 isTrustedLocal treats own machine IP as local', internals.isTrustedLocal(state, ownIp) === true)
    check('E11 isTrustedLocal treats foreign IP as remote', internals.isTrustedLocal(state, '192.168.7.9') === false)
  }
}

// ── cleanup ─────────────────────────────────────────────────────────────────
server.close()
rmSync(home, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
