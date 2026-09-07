// lan-gate TLS 自检:生成自签证书 → 校验 → 真实 TLS 握手(信任/不信任/放行三种情形)
import { X509Certificate } from 'node:crypto'
import { createServer } from 'node:https'
import { request } from 'node:https'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { internals } from '../lib/index.js'

const { cert, key } = internals.buildSelfSignedCert(['localhost', '127.0.0.1', '::1', '192.168.3.5'])

// 1) X.509 结构
const x = new X509Certificate(cert)
console.log('subject:', x.subject)
console.log('issuer :', x.issuer)
console.log('valid  :', x.validFrom, '->', x.validTo)
console.log('self-verify:', x.verify(x.publicKey))
if (!x.subject.includes('CN=dsh-lan-gate') || !x.verify(x.publicKey)) {
  console.error('FAIL: 证书结构/自签名校验不过')
  process.exit(1)
}

// 2) 真实握手
const server = createServer({ key, cert }, (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const doGet = (opts) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', ca: opts.ca, rejectUnauthorized: opts.rejectUnauthorized }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })

const untrusted = await doGet({ rejectUnauthorized: true }).then(() => 'OK(意外成功!)', (e) => `拒绝(预期): ${e.code}`)
const trusted = await doGet({ ca: cert })
const bypass = await doGet({ rejectUnauthorized: false })

console.log('不受信任(默认):', untrusted)
console.log('以该证书为 CA:', trusted.status, trusted.body)
console.log('显式放行(rejectUnauthorized=false):', bypass.status, bypass.body)

server.closeAllConnections?.()
await new Promise((r) => server.close(r))

if (trusted.status !== 200 || bypass.status !== 200) {
  console.error('FAIL: TLS 握手结果不对')
  process.exit(1)
}

// 3) ensureTlsCert 幂等性(写入临时 DSH_HOME,第二次应直接复用不重建)
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-tls-'))
process.env.DSH_HOME = tmpHome
const s = internals.createState()
const first = await internals.ensureTlsCert(s)
const t0 = Date.now()
const second = await internals.ensureTlsCert(s)
const reused = Date.now() - t0 < 500 // 复用现有文件时不做 RSA 生成,应当很快
const onDisk = await readFile(join(tmpHome, 'lan-gate-tls', 'cert.pem'), 'utf8')
const onDiskOk = onDisk.includes('-----BEGIN CERTIFICATE-----') && new X509Certificate(onDisk).subject.includes('CN=dsh-lan-gate')
console.log('ensureTlsCert 首次生成:', first.cert.startsWith('-----BEGIN CERTIFICATE-----'))
console.log('ensureTlsCert 二次复用(快):', reused, `(${Date.now() - t0}ms)`)
console.log('磁盘证书可解析且 CN 正确:', onDiskOk)
console.log('tlsDesired:', internals.tlsDesired({ tls: { enabled: true, port: 3443 }, boundHost: '192.168.3.5' }),
  '/', internals.tlsDesired({ tls: { enabled: true, port: 3443 }, boundHost: '127.0.0.1' }),
  '/', internals.tlsDesired({ tls: { enabled: false, port: 3443 }, boundHost: '0.0.0.0' }))

if (!first.cert.startsWith('-----BEGIN CERTIFICATE-----') || !reused || !onDiskOk) {
  console.error('FAIL: ensureTlsCert 异常')
  process.exit(1)
}

// 4) SAN 漂移自动重建(如 Tailscale 等新网卡上线后旧证书缺该 IP → 应重建并热返回新证书)
const tmpHome2 = mkdtempSync(join(tmpdir(), 'dsh-tls-drift-'))
const dir2 = join(tmpHome2, 'lan-gate-tls')
mkdirSync(dir2, { recursive: true })
const stale = internals.buildSelfSignedCert(['localhost', '127.0.0.1', '::1', '192.168.3.5']) // 旧证书:无 Tailscale IP
writeFileSync(join(dir2, 'cert.pem'), stale.cert)
writeFileSync(join(dir2, 'key.pem'), stale.key)
process.env.DSH_HOME = tmpHome2
const s2 = internals.createState()
s2.boundHost = '100.83.142.119'
const drift1 = await internals.ensureTlsCert(s2)
const drift2 = await internals.ensureTlsCert(s2)
const driftCert = new X509Certificate(drift1.cert)
const hasTailscale = (driftCert.subjectAltName ?? driftCert.subjectaltname ?? '').includes('100.83.142.119')
console.log('SAN 漂移后自动重建:', drift1.changed === true)
console.log('重建后二次复用(changed=false):', drift2.changed === false)
console.log('新证书 SAN 含 Tailscale IP(100.83.142.119):', hasTailscale)
if (drift1.changed !== true || drift2.changed !== false || !hasTailscale) {
  console.error('FAIL: SAN 漂移未自动重建')
  process.exit(1)
}
console.log('tls-cert-test: PASS')
