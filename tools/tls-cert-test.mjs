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

// 5) IPv6:任意字面量可进证书 SAN;展开/URL 规范化正确
//    注:Node 打印 SAN 的 IPv6 是大写且不补零(FD00:0:0:0:0:0:1234:ABCD),
//    expandIpv6 会把两边统一成小写补零形式做漂移比较。
const v6expandOk =
  internals.expandIpv6('::1') === '0000:0000:0000:0000:0000:0000:0000:0001' &&
  internals.expandIpv6('fd00::1234:abcd') === 'fd00:0000:0000:0000:0000:0000:1234:abcd' &&
  internals.expandIpv6('fd00:0:0:0:0:0:1234:abcd') === 'fd00:0000:0000:0000:0000:0000:1234:abcd' &&
  internals.expandIpv6('not-an-ip') === null
const v6urlOk =
  internals.urlHost('240e::1') === '[240e::1]' && internals.urlHost('192.168.3.5') === '192.168.3.5'
const v6cert = internals.buildSelfSignedCert(['localhost', '127.0.0.1', '::1', 'fd00::1234:abcd'])
const v6sanText = new X509Certificate(v6cert.cert).subjectAltName ?? ''
const v6sanOk = /fd00/i.test(v6sanText) && v6sanText.includes('1234') && /abcd/i.test(v6sanText)
console.log('IPv6 展开规范化:', v6expandOk)
console.log('IPv6 URL 方括号:', v6urlOk)
console.log('证书 SAN 含 fd00::1234:abcd:', v6sanOk, '(' + (v6sanText.match(/IP Address:[^,]*fd00[^,]*/i) || ['n/a'])[0] + ')')
if (!v6expandOk || !v6urlOk || !v6sanOk) {
  console.error('FAIL: IPv6 SAN/规范化异常')
  process.exit(1)
}

// 6) IPv6 SAN 漂移:旧证书缺 v6 → 自动重建;重建后 canonical 一致,二次复用不再重建
const tmpHome3 = mkdtempSync(join(tmpdir(), 'dsh-tls-v6-'))
const dir3 = join(tmpHome3, 'lan-gate-tls')
mkdirSync(dir3, { recursive: true })
const stale6 = internals.buildSelfSignedCert(['localhost', '127.0.0.1', '::1']) // 旧证书:无 v6 网卡条目
writeFileSync(join(dir3, 'cert.pem'), stale6.cert)
writeFileSync(join(dir3, 'key.pem'), stale6.key)
process.env.DSH_HOME = tmpHome3
const s3 = internals.createState()
s3.boundHost = 'fd00::1234:abcd'
const v6a = await internals.ensureTlsCert(s3)
const v6b = await internals.ensureTlsCert(s3)
const v6rebuiltSan = (new X509Certificate(v6a.cert).subjectAltName ?? '')
const v6rebuiltOk = v6a.changed === true && /fd00/i.test(v6rebuiltSan) && /abcd/i.test(v6rebuiltSan)
console.log('v6 SAN 漂移后自动重建:', v6rebuiltOk)
console.log('v6 重建后二次复用(changed=false):', v6b.changed === false)
if (!v6rebuiltOk || v6b.changed !== false) {
  console.error('FAIL: IPv6 漂移/复用异常')
  process.exit(1)
}
console.log('tls-cert-test: PASS')
