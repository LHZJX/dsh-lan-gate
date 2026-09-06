/**
 * Quick smoke check for the /mobile static route (no test framework).
 * Starts a plain http server whose request listener is wrapped exactly like
 * installGateOnServer does, then asserts the mobile assets are served and
 * traversal attempts never leak plugin sources.
 *
 * Run: node tools/mobile-route-check.mjs
 */
import { createServer } from 'node:http'
import http from 'node:http'
import { internals } from '../lib/index.js'

const state = internals.createState()
const ctx = {
  logger: { warn() {}, info() {}, debug() {}, error() {} },
  get: () => undefined
}

const upstream = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><head></head><body>upstream</body></html>')
})

const originals = upstream.listeners('request')
upstream.removeAllListeners('request')
upstream.on('request', (req, res) => internals.gateRequest(ctx, state, req, res, originals))

// Raw request helper (keeps the literal path; no pooled keep-alive sockets).
const rawGet = (path) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: upstream.address().port, path }, (res) => {
    let text = ''
    res.on('data', (c) => { text += c })
    res.on('end', () => resolve({ status: res.statusCode, text }))
  })
  req.on('error', () => resolve({ status: 0, text: '' }))
  req.end()
})

upstream.listen(0, '127.0.0.1', async () => {
  let failed = 0
  const check = async (path, expectStatus, expectIncludes) => {
    const { status, text } = await rawGet(path)
    const okStatus = status === expectStatus
    const okBody = expectIncludes === null || text.includes(expectIncludes)
    console.log(`${okStatus && okBody ? 'ok  ' : 'FAIL'} GET ${path} -> ${status}${okBody ? '' : ' (body missing marker)'}`)
    if (!okStatus || !okBody) failed += 1
  }
  await check('/mobile', 200, 'DSH 手机版')
  await check('/mobile/', 200, 'DSH 手机版')
  await check('/mobile/index.html', 200, 'viewport')
  await check('/mobile/app.js', 200, 'checkAuth')
  await check('/mobile/style.css', 200, '--accent')
  await check('/mobile/secret.js', 404, null)
  await check('/', 200, 'upstream')
  // traversal attempts must never leak plugin sources (URL parsing in pathOf
  // normalizes both forms away from /mobile, so upstream handles them).
  const t1 = await rawGet('/mobile/../lib/index.js')
  const okT1 = t1.status === 200 && t1.text.includes('upstream') && !t1.text.includes('LAN_AUTH_PREFIX')
  console.log(`${okT1 ? 'ok  ' : 'FAIL'} RAW GET /mobile/../lib/index.js -> no source leak`)
  if (!okT1) failed += 1
  const t2 = await rawGet('/mobile/%2e%2e/lib/index.js')
  const okT2 = t2.status === 200 && t2.text.includes('upstream') && !t2.text.includes('LAN_AUTH_PREFIX')
  console.log(`${okT2 ? 'ok  ' : 'FAIL'} RAW GET /mobile/%2e%2e/lib/index.js -> no source leak`)
  if (!okT2) failed += 1
  console.log(failed === 0 ? 'mobile-route-check: PASS' : `mobile-route-check: ${failed} FAILED`)
  upstream.close(() => process.exit(failed === 0 ? 0 : 1))
})
