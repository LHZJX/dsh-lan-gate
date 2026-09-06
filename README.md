# dsh-lan-gate

让手机 / 平板在**同一局域网**下访问你电脑上的 DeepSeek Harness Web 界面，并加一道**访问密码**：

- 电脑端访问（`127.0.0.1` / `localhost`，或电脑通过自己的局域网 IP 访问）**始终免密码**；
- 局域网设备（手机、另一台电脑等）访问必须输入密码；
- 绑定模式与密码都在**电脑端 UI**（设置 → 局域网访问）里管理，**即时生效、无需重启 dsh**：
  - **仅本机 `127.0.0.1`** —— 关闭局域网访问；
  - **所有网卡 `0.0.0.0`** —— 手机可用任一局域网 IP 访问；
  - **指定网卡 IP** —— 自动探测本机所有网卡（含网卡名）做成下拉列表，选一个地址只在它上面监听；同时保留 `127.0.0.1` 的副本监听，电脑端地址不变；
- 密码以**加盐 scrypt** 的形式存在 `$DSH_HOME/lan-gate.json`（`C:\Users\<你>\.dsh\lan-gate.json`，同文件里保存绑定模式），绝不保存明文；
- 未设置密码时，局域网访问**默认被阻止**（安全默认值），不会裸奔暴露；
- 改密 / 改绑定**立即生效**：改密会吊销所有已登录设备（需要重新登录）。

## 工作原理

DSH 出于安全，Web 服务默认只监听 `127.0.0.1`（CLI 也拒绝 `--host 0.0.0.0`）。本插件（v0.2）**不修改核心配置**，而是：

1. **host 半边**（`lib/index.js`）在启动完成后读取 `$DSH_HOME/lan-gate.json` 里保存的绑定模式，把 DSH 自带的 node:http 服务**实时重绑**到所选地址（close 后在同一 server 对象上 listen 新地址，插件挂的网关监听器不受影响）：
   - `local` → `127.0.0.1`；`all` → `0.0.0.0`；`ip` → 所选地址 + 一个 `127.0.0.1` 副本监听（twin），电脑端永远可用 `127.0.0.1`；
   - 切换失败自动回滚到 `127.0.0.1`，GUI 不会失联；
2. 同一网关处理所有进入的请求 / WebSocket 升级：
   - “本机可信来源” = 回环地址 ∪ 本机所有网卡 IP（从电脑自己发出的连接一律放行）；
   - 其余（手机等）必须通过 `dsh_lan_gate` 会话 Cookie，否则得到一张**独立登录页**（内联页面，微信内置浏览器也能用）或 401 JSON；
   - 登录失败按 IP 限速（5 次失败锁 60 秒）；
3. 每次切换绑定都会**同步 `/api` 信任围栏**（`client-connection.trustedHosts`）：把当前暴露的地址字面量加进去、撤下不再暴露的；回环钉住的敏感方法（settings/credentials 等）保持只对本机开放。

浏览器端（`lib/client.js`）在 **设置 → 局域网访问** 注册一页：显示当前绑定与局域网地址，提供**绑定模式下拉（含自动探测的每个网卡 IP）+ 应用按钮**，以及改密表单。

### 端点一览（同源）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__lanauth/status` | 状态：local/可信来源、当前模式与绑定地址、是否已设密码、探测到的网卡列表、局域网地址（任何来源可读，无害） |
| POST | `/__lanauth/login` | 提交密码 → 签发会话 Cookie（表单或 JSON 均可） |
| POST | `/__lanauth/logout` | 注销本设备 |
| POST | `/__lanauth/password` | 设置/修改/移除密码 —— **仅本机（回环/本机网卡 IP）可调用** |
| POST | `/__lanauth/bind` | 切换绑定模式 `{mode:'local'\|'all'\|'ip', ip?}` —— **仅本机可调用** |

> 网关是 `/api` 信任围栏**之前**的一层整体拦截：未登录的局域网客户端连 SPA 和 `/api` 都到不了。

## 安装

把包装进 `web` profile（与其它 dsh 插件一致）：

```powershell
# 1) 在 profile 的 plugins 目录放一个 junction（保持工作区为唯一真源），
#    或直接把文件夹复制过去：
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\plugins\dsh-lan-gate" -Target "E:\my_code\dshChats\dsh-lan-gate"

# 2) 安装进 profile（注意用 ./ 相对路径或绝对 link:，避免被 pnpm 当成 GitHub 仓库简写）：
dsh plugin --profile web add ./plugins/dsh-lan-gate
#    若 PowerShell 执行策略拦截 dsh，改用 dsh.cmd / cmd，或先：
#    Set-ExecutionPolicy -Scope Process Bypass
```

**首次安装后重启一次 `dsh web` 生效**（bundle 元数据启动时缓存；此后切换模式无需再重启）。

验证组合配置：

```sh
dsh --profile web --dump-config   # 应看到 lan-gate 行；webserver 行保持默认 127.0.0.1（由插件运行时接管）
```

## 使用

1. 重启后，在电脑上打开 `http://127.0.0.1:3080` → 侧栏设置（齿轮）→ **局域网访问**；
2. 绑定模式默认“所有网卡”，选好模式（或某个具体网卡 IP）后点**应用**，即时生效；
   **切换会断开当前所有连接**（含正在浏览的页面 / 手机），页面会提示并自动确认结果，如已断开刷新即可；
3. 设置一个至少 8 位的访问密码（改密、切绑定都只在电脑端可见/可写）；
4. 手机连**同一个 Wi-Fi**，浏览器打开页面里列出的 `http://<电脑局域网IP>:3080` → 输入密码即可使用；
5. 想收窄暴露面：下拉里选某个**指定网卡**（如 Wi-Fi 那个 IP），其它网卡（VPN / 虚拟机等）将不再监听；想完全关闭：选“仅本机”。

## 注意

- **Windows 防火墙**：首次以 `0.0.0.0` 或具体网卡监听时可能弹出防火墙提示，需要允许 node.exe 在专用/家庭网络上入站，否则手机连不上。
- 局域网流量走明文 HTTP，密码校验本身是安全的（scrypt + 随机会话 Token），但同一网络上其他人仍可能嗅探会话 Cookie——适合可信的家庭/办公 Wi-Fi，勿在公共 Wi-Fi 上开启。
- 指定网卡模式下 `127.0.0.1` 仍可用（插件会自动保留副本监听）；如果所选网卡（如 Wi-Fi）之后换了 IP（DHCP 重租），需要回到本页重新选择。
- 修改密码 / 移除密码：仍走电脑端设置页，保存后**立即生效**；移除密码会立刻阻止所有局域网访问（本机不受影响）。
- 手机等设备经 `http://<局域网IP>:3080` 访问时，浏览器处于**非安全上下文**：Web API `crypto.randomUUID` 不存在，而 DSH 前端 RPC 会直接调用它（否则会话列表空白、新建/工作区报 `crypto.randomUUID is not a function`）。插件会在网关放行的 HTML 里自动注入一个基于 `getRandomValues` 的 UUID v4 polyfill（仅当缺失时生效，电脑端 127.0.0.1 不受影响），无需额外配置。
- **在手机上新建工作区**：DSH 的目录选择器（`host.pickDirectory`）被官方钉死在仅回环，手机调用必然 403（`transport failure for /api/host.pickDirectory: HTTP 403`）；`host.listDirectory` 浏览能力也未在当前 profile 组合。因此手机端的"新建工作区"会改走插件提供的**路径输入对话框**（直接调用非特权的 `workspace.create({path})`）：输入电脑上已存在的文件夹完整路径即可创建。更精细的目录选择仍建议在电脑端完成。
- 卸载：`dsh plugin --profile web remove dsh-lan-gate` 并重启；删除 junction 可选。卸载后服务恢复只监听 `127.0.0.1`，`lan-gate.json` 会留在 DSH home 里。

## 开发与测试

```sh
node tools/gate-test.mjs   # host 网关 + 绑定引擎集成测试（真实 http 服务与真实网卡绑定）
```

host / client 均为零构建步骤的纯 JS，改动后重启 `dsh web` 生效。
