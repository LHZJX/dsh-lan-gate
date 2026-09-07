/**
 * dsh-lan-gate — browser half (v0.2).
 *
 * Adds a "局域网访问" page under Settings (the `settings.section` slot):
 *
 *  - bind mode dropdown: 仅本机 (127.0.0.1) / 所有网卡 (0.0.0.0) / 本机探测到的
 *    每个网卡 IP（自动检测，含网卡名），选择后点「应用」即时切换、无需重启；
 *  - LAN URLs + 状态展示（手机/平板浏览时为只读）；
 *  - 访问密码设置/修改/移除 —— 仅当本浏览器跑在电脑（可信本机来源）上。
 *  - HTTPS(局域网加密,自签证书):开启/关闭开关 + 端口输入 + https:// 地址展示,
 *    证书由电脑端自动生成 —— 设置仅本机可改,手机/平板浏览时为只读。
 *
 * Plain JavaScript bundle evaluated by the client module system (no JSX, no
 * imports): `require("react")` is a platform seed word, `fetch` is a plain
 * same-origin call to the host routes served by lib/index.js.
 */
window.__ModuleLoader__.load({
  id: "dsh-lan-gate",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;

    // ── route contract (mirrors lib/index.js) ──────────────────────────────

    var STATUS_ENDPOINT = "/__lanauth/status";
    var PASSWORD_ENDPOINT = "/__lanauth/password";
    var BIND_ENDPOINT = "/__lanauth/bind";
    var TLS_ENDPOINT = "/__lanauth/tls";
    var HTTP_ENDPOINT = "/__lanauth/http";

    // ── look & feel ─────────────────────────────────────────────────────────
    //
    // Action accent. NOTE: do not use --dsw-alias-brand-primary for fills —
    // in this theme that token maps to a near-black neutral (#0f1115), which
    // made the primary buttons invisible on the dark card. The real action
    // color is --dsw-alias-button-info-fill (DeepSeek blue #4176e6). If you
    // want a different button color, change ACCENT / ACCENT_HOVER here.

    var ACCENT = "#4176e6";
    var ACCENT_HOVER = "#3663d0";

    var CSS = [
      ".dlg-wrap{max-width:640px;color:var(--dsw-alias-label-primary,#1d1f23);display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;}",
      ".dlg-intro{color:var(--dsw-alias-label-tertiary,#6b7280);margin:0;}",
      ".dlg-card{border:1px solid var(--dsw-alias-border-l2,#e4e6ea);background:var(--dsw-alias-bg-layer-3,#ffffff);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}",
      ".dlg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
      ".dlg-label{min-width:96px;color:var(--dsw-alias-label-secondary,#4b5563);}",
      ".dlg-chip{display:inline-flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-module-platform,#f0f2f5);border-radius:999px;padding:1px 10px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#4b5563);}",
      ".dlg-chipOk{background:rgba(46,160,67,.14);color:var(--dsw-alias-label-primary,#1d1f23);}",
      ".dlg-chipWarn{background:rgba(217,48,37,.12);color:var(--dsw-alias-danger-strong,#d93025);}",
      ".dlg-url{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-module-platform,#f0f2f5);padding:2px 8px;border-radius:6px;word-break:break-all;}",
      ".dlg-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#d0d3d9);color:var(--dsw-alias-label-primary,#1d1f23);background:transparent;border-radius:8px;padding:5px 12px;font-size:12px;line-height:1.5;}",
      ".dlg-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#9ca3af);}",
      ".dlg-btn:disabled{opacity:.55;cursor:default;}",
      ".dlg-btnPrimary{background:var(--dsw-alias-button-info-fill," + ACCENT + ");border-color:transparent;color:#fff;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.14);}",
      ".dlg-btnPrimary:hover:not(:disabled){background:" + ACCENT_HOVER + ";border-color:transparent;}",
      ".dlg-btnDanger{color:var(--dsw-alias-danger-strong,#d93025);border-color:transparent;}",
      ".dlg-select{border:1px solid var(--dsw-alias-border-l2,#d0d3d9);background:var(--dsw-alias-bg-layer-2,#fafafa);color:var(--dsw-alias-label-primary,#1d1f23);font:inherit;border-radius:8px;padding:7px 10px;font-size:13px;min-width:min(340px,100%);}",
      ".dlg-select:focus-visible{outline:2px solid " + ACCENT + ";border-color:transparent;}",
      ".dlg-field{display:flex;flex-direction:column;gap:4px;}",
      ".dlg-field label{font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563);}",
      ".dlg-field input{border:1px solid var(--dsw-alias-border-l2,#d0d3d9);background:var(--dsw-alias-bg-layer-2,#fafafa);color:var(--dsw-alias-label-primary,#1d1f23);font:inherit;border-radius:8px;padding:8px 10px;font-size:13px;}",
      ".dlg-field input:focus-visible{outline:2px solid " + ACCENT + ";border-color:transparent;}",
      ".dlg-hint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;margin:0;}",
      ".dlg-msg{border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.5;margin:0;}",
      ".dlg-msgOk{background:rgba(46,160,67,.12);color:var(--dsw-alias-label-primary,#1d1f23);}",
      ".dlg-msgErr{background:rgba(217,48,37,.12);color:var(--dsw-alias-danger-strong,#d93025);}",
      ".dlg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;}",
      ".dlg-note{border-left:3px solid var(--dsw-alias-border-l2,#e4e6ea);padding-left:10px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;margin:0;}",
      ".dlg-overlay{position:fixed;inset:0;background:rgba(9,11,16,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;}",
      ".dlg-dialog{background:var(--dsw-alias-bg-layer-3,#ffffff);color:var(--dsw-alias-label-primary,#1d1f23);border-radius:14px;max-width:460px;width:100%;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.28);}",
      ".dlg-dialogHead{padding:14px 16px 10px;display:flex;flex-direction:column;gap:4px;}",
      ".dlg-dialogHead h2{margin:0;font-size:15px;line-height:1.4;}",
      ".dlg-dialogBody{padding:2px 16px 14px;display:flex;flex-direction:column;gap:10px;}",
      ".dlg-dialogFoot{padding:10px 16px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--dsw-alias-border-l2,#e4e6ea);}",
      ".dlg-pathinput{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2,#d0d3d9);background:var(--dsw-alias-bg-layer-2,#fafafa);color:var(--dsw-alias-label-primary,#1d1f23);font:inherit;border-radius:8px;padding:10px;font-size:13px;}",
      ".dlg-pathinput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2b5ce6);border-color:transparent;}",
      "@media (prefers-color-scheme:dark){.dlg-card{background:var(--dsw-alias-bg-layer-3,#1e2126);}.dlg-select,.dlg-field input{background:var(--dsw-alias-bg-layer-2,#14161a);}.dlg-dialog{background:var(--dsw-alias-bg-layer-3,#1e2126);}.dlg-pathinput{background:var(--dsw-alias-bg-layer-2,#14161a);}}",
    ].join("");

    // ── helpers ─────────────────────────────────────────────────────────────

    function el(type, props) {
      var args = [type, props || null];
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
      return React.createElement.apply(React, args);
    }

    function fetchJson(url, options) {
      return fetch(url, options).then(function (response) {
        return response.json().catch(function () {
          return null;
        }).then(function (data) {
          return { status: response.status, data: data };
        });
      });
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          function () { return true; },
          function () { return false; }
        );
      }
      return Promise.resolve(false);
    }

    /** Decode a select value ("local" | "all" | "ip:1.2.3.4") to a bind request. */
    function bindRequestFor(value) {
      if (value === "local") return { mode: "local" };
      if (value === "all") return { mode: "all" };
      if (value.indexOf("ip:") === 0) return { mode: "ip", ip: value.slice(3) };
      return null;
    }

    // ── the settings section ────────────────────────────────────────────────

    function StatusRow(props) {
      return el(
        "div",
        { className: "dlg-row" },
        el("span", { className: "dlg-label" }, props.label),
        props.children
      );
    }

    function LanGateSection(props) {
      var ctx = props.ctx;

      var status = useState({ loading: true, data: null, error: null });
      var setStatus = status[1];
      var bindValue = useState("all");
      var setBindValue = bindValue[1];
      var binding = useState(false);
      var setBinding = binding[1];
      var currentPwd = useState("");
      var newPwd = useState("");
      var confirmPwd = useState("");
      var saving = useState(false);
      var setSaving = saving[1];
      var notice = useState(null);
      var setNotice = notice[1];
      var tlsBusy = useState(false);
      var setTlsBusy = tlsBusy[1];
      var tlsPortDraft = useState("");
      var setTlsPortDraft = tlsPortDraft[1];
      var httpBusy = useState(false);
      var setHttpBusy = httpBusy[1];

      var loadStatus = function () {
        setStatus({ loading: true, data: null, error: null });
        fetchJson(STATUS_ENDPOINT).then(function (out) {
          if (out.status === 200 && out.data && out.data.ok) {
            setStatus({ loading: false, data: out.data, error: null });
            // keep the dropdown in sync with the effective state
            var data = out.data;
            var effHost = data.lanHost || data.boundHost;
            setBindValue(data.mode === "ip" ? "ip:" + effHost : data.mode);
          } else {
            var message = (out.data && out.data.error && out.data.error.message) || ("状态获取失败（HTTP " + out.status + "）");
            setStatus({ loading: false, data: null, error: message });
          }
        }).catch(function (error) {
          setStatus({ loading: false, data: null, error: String(error && error.message ? error.message : error) });
        });
      };

      useEffect(function () {
        loadStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 状态就绪/刷新后,把服务端 TLS 端口同步进输入框
      useEffect(function () {
        var d = status[0].data;
        if (d && d.tls) setTlsPortDraft(String(d.tls.port));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [status[0]]);

      var showNotice = function (kind, text) {
        setNotice({ kind: kind, text: text });
      };

      var applyBind = function () {
        var request = bindRequestFor(bindValue[0]);
        if (!request || binding[0]) return;
        setBinding(true);
        setNotice(null);

        // Poll /__lanauth/status until the effective bind matches the request.
        // The switch tears down every connection (including this one), so the
        // apply request itself cannot carry the result back.
        var pollConfirm = function (attemptsLeft) {
          if (attemptsLeft <= 0) {
            setBinding(false);
            showNotice("err", "切换未能在预期时间内确认，请刷新本页查看当前状态。");
            loadStatus();
            return;
          }
          setTimeout(function () {
            fetchJson(STATUS_ENDPOINT).then(function (s) {
              if (s.status === 200 && s.data && s.data.ok) {
                var d = s.data;
                var effHost = d.lanHost || d.boundHost;
                var matched = request.mode === "local"
                  ? d.mode === "local"
                  : request.mode === "all"
                    ? d.mode === "all"
                    : d.mode === "ip" && effHost === request.ip;
                if (matched) {
                  setBindValue(d.mode === "ip" ? "ip:" + effHost : d.mode);
                  var httpOpen = !!(d.lanUrls && d.lanUrls.length);
                  var tlsOpen = !!(d.lanTlsUrls && d.lanTlsUrls.length);
                  showNotice("ok", httpOpen
                    ? "已应用：局域网 http 已开启（" + d.lanUrls.join("、") + "）。切换会断开旧连接，页面/手机如已断开请刷新重连。"
                    : tlsOpen
                      ? "已应用：明文 http 已关闭，手机请走 https（" + d.lanTlsUrls.join("、") + "）。"
                      : "已应用：仅本机 127.0.0.1，局域网访问已关闭。");
                  loadStatus();
                  setBinding(false);
                  return;
                }
              }
              pollConfirm(attemptsLeft - 1);
            }).catch(function () {
              pollConfirm(attemptsLeft - 1);
            });
          }, 700);
        };

        fetchJson(BIND_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }).then(function (out) {
          if (out.status === 200 && out.data && out.data.ok === true && out.data.accepted === true) {
            showNotice("ok", "正在切换绑定…（会短暂断开当前连接）");
            pollConfirm(20);
          } else {
            var message = (out.data && out.data.error && out.data.error.message) || ("应用失败（HTTP " + out.status + "）");
            setBinding(false);
            showNotice("err", message);
          }
        }).catch(function (error) {
          setBinding(false);
          showNotice("err", "应用失败：" + String(error && error.message ? error.message : error));
        });
      };

      var savePassword = function (remove) {
        if (saving[0]) return;
        var data = status[0].data;
        var current = currentPwd[0];
        var next = remove ? "" : newPwd[0];
        if (!remove) {
          if (next.length < 8) {
            showNotice("err", "新密码至少需要 8 个字符。");
            return;
          }
          if (next !== confirmPwd[0]) {
            showNotice("err", "两次输入的新密码不一致。");
            return;
          }
        }
        if (data && data.hasPassword && current.length === 0) {
          showNotice("err", "请先输入当前密码。");
          return;
        }
        var confirmed = true;
        if (remove) {
          confirmed = window.confirm("确定移除访问密码吗？移除后局域网访问会被立即阻止（本机不受影响）。");
        }
        if (!confirmed) return;
        setSaving(true);
        setNotice(null);
        fetchJson(PASSWORD_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ current: current, next: next }),
        }).then(function (out) {
          if (out.status === 200 && out.data && out.data.ok) {
            currentPwd[1]("");
            newPwd[1]("");
            confirmPwd[1]("");
            if (remove) {
              showNotice("ok", "访问密码已移除，局域网访问已阻止。");
            } else {
              showNotice("ok", "密码已保存并立即生效：局域网设备需要重新输入新密码登录。");
            }
            loadStatus();
          } else {
            var message = (out.data && out.data.error && out.data.error.message) || ("保存失败（HTTP " + out.status + "）");
            showNotice("err", message);
          }
        }).catch(function (error) {
          showNotice("err", "保存失败：" + String(error && error.message ? error.message : error));
        }).finally(function () {
          setSaving(false);
        });
      };

      var copyUrls = function () {
        var data = status[0].data;
        if (!data || !data.lanUrls.length) return;
        copyText(data.lanUrls.join("\n")).then(function (ok) {
          if (ok) showNotice("ok", "局域网地址已复制。");
          else showNotice("err", "复制失败，请手动选择地址。");
        });
      };

      var applyTls = function (enable) {
        if (tlsBusy[0]) return;
        var data = status[0].data;
        var tls = (data && data.tls) || { port: 3443 };
        var port = tls.port;
        if (enable) {
          port = parseInt(tlsPortDraft[0], 10);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            showNotice("err", "端口无效（1-65535）。");
            return;
          }
        }
        setTlsBusy(true);
        setNotice(null);
        fetchJson(TLS_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: enable, port: port }),
        }).then(function (out) {
          if (out.status === 200 && out.data && out.data.ok) {
            if (out.data.error) {
              showNotice("err", out.data.error);
            } else {
              showNotice("ok", enable
                ? "HTTPS 已开启（端口 " + port + "）。自签证书已生成在电脑 ~/.dsh/lan-gate-tls/，手机首次访问需“继续访问”或安装该 CA 证书。"
                : "HTTPS 已关闭；原 http 不受影响。");
            }
            loadStatus();
          } else {
            var message = (out.data && out.data.error && out.data.error.message) || ("操作失败（HTTP " + out.status + "）");
            showNotice("err", message);
            loadStatus();
          }
        }).catch(function (error) {
          showNotice("err", "操作失败：" + String(error && error.message ? error.message : error));
        }).finally(function () {
          setTlsBusy(false);
        });
      };

      var copyTlsUrls = function () {
        var data = status[0].data;
        if (!data || !data.lanTlsUrls || !data.lanTlsUrls.length) return;
        copyText(data.lanTlsUrls.join("\n")).then(function (ok) {
          if (ok) showNotice("ok", "HTTPS 地址已复制。");
          else showNotice("err", "复制失败，请手动选择地址。");
        });
      };

      var applyHttp = function (enable) {
        if (httpBusy[0]) return;
        setHttpBusy(true);
        setNotice(null);
        fetchJson(HTTP_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: enable }),
        }).then(function (out) {
          if (out.status === 200 && out.data && out.data.ok === true && out.data.accepted === true) {
            showNotice("ok", enable ? "正在开启局域网 HTTP…（会短暂断开当前连接）" : "正在关闭局域网 HTTP…（会短暂断开当前连接）");
            var pollHttp = function (left) {
              if (left <= 0) {
                setHttpBusy(false);
                showNotice("err", "切换未能在预期时间内确认，请刷新本页查看当前状态。");
                loadStatus();
                return;
              }
              setTimeout(function () {
                fetchJson(STATUS_ENDPOINT).then(function (s) {
                  if (s.status === 200 && s.data && s.data.ok && s.data.http && s.data.http.enabled === enable) {
                    var tlsUrls = s.data.lanTlsUrls || [];
                    showNotice("ok", enable
                      ? "局域网 HTTP 已开启：手机可用 " + ((s.data.lanUrls || []).join("、") || "http 地址") + "。"
                      : "局域网明文 HTTP 已关闭（电脑端 127.0.0.1 不受影响）" + (tlsUrls.length ? "；手机请走 https：" + tlsUrls.join("、") : "。"));
                    loadStatus();
                    setHttpBusy(false);
                    return;
                  }
                  pollHttp(left - 1);
                }).catch(function () {
                  pollHttp(left - 1);
                });
              }, 700);
            };
            pollHttp(20);
          } else {
            var message = (out.data && out.data.error && out.data.error.message) || ("操作失败（HTTP " + out.status + "）");
            setHttpBusy(false);
            showNotice("err", message);
          }
        }).catch(function (error) {
          setHttpBusy(false);
          showNotice("err", "操作失败：" + String(error && error.message ? error.message : error));
        });
      };

      // ── render ────────────────────────────────────────────────────────────

      var s = status[0];
      var rows = [];

      if (s.loading) {
        rows.push(el("div", { key: "loading", className: "dlg-intro" }, "正在读取状态…"));
      } else if (s.error) {
        rows.push(
          el("div", { key: "err", className: "dlg-card" },
            el("p", { className: "dlg-msg dlg-msgErr" }, s.error),
            el("button", { type: "button", className: "dlg-btn", onClick: loadStatus }, "重试")
          )
        );
      } else {
        var data = s.data;
        var local = !!data.local;
        var hasPassword = !!data.hasPassword;
        var lanEnabled = !!data.lanEnabled;
        var effHost = data.lanHost || data.boundHost;
        var currentModeLabel = data.mode === "local"
          ? "仅本机 127.0.0.1"
          : data.mode === "all"
            ? "所有网卡 0.0.0.0"
            : "指定网卡 " + effHost;

        // 1. intro
        rows.push(
          el("p", { key: "intro", className: "dlg-intro" },
            "让同一局域网内的手机 / 平板访问本界面：本机（127.0.0.1）始终免密码；局域网设备需访问密码。绑定模式与密码都在这里切换，立即生效。"
          )
        );

        // 2. bind mode card
        var bindCardChildren = [
          el(StatusRow, { key: "bound", label: "当前绑定" },
            el("span", { className: "dlg-chip " + ((lanEnabled || (data.tls && data.tls.active)) ? "dlg-chipOk" : "dlg-chipWarn") }, currentModeLabel),
            el("span", { className: "dlg-chip" }, "端口 " + String(data.port))
          )
        ];

        if (local) {
          var options = [
            el("option", { key: "local", value: "local" }, "仅本机 127.0.0.1（关闭局域网访问）"),
            el("option", { key: "all", value: "all" }, "所有网卡 0.0.0.0"),
          ];
          var detected = data.detected || [];
          detected.forEach(function (entry) {
            options.push(
              el("option", { key: "ip:" + entry.address, value: "ip:" + entry.address },
                "指定网卡：" + entry.address + "（" + entry.name + "）")
            );
          });
          bindCardChildren.push(
            el(StatusRow, { key: "mode", label: "绑定模式" },
              el("select", {
                className: "dlg-select",
                value: bindValue[0],
                disabled: binding[0],
                onChange: function (event) { setBindValue(event.target.value); },
                "aria-label": "局域网绑定模式",
              }, options),
              el("button", {
                type: "button",
                className: "dlg-btn dlg-btnPrimary",
                disabled: binding[0],
                onClick: applyBind,
              }, binding[0] ? "应用中…" : "应用")
            )
          );
          bindCardChildren.push(
            el("p", { key: "hint", className: "dlg-hint" },
              "「仅本机」关闭局域网访问；「指定网卡」只在所选地址监听，电脑端 127.0.0.1 仍可用。切换即时生效、无需重启 dsh。"
            )
          );
        } else {
          bindCardChildren.push(
            el("p", { key: "remoteHint", className: "dlg-note" },
              "你正通过局域网访问本页（只读）。绑定模式与密码只能在电脑端（127.0.0.1）修改。"
            )
          );
        }

        if (data.lanUrls && data.lanUrls.length) {
          bindCardChildren.push(
            el(StatusRow, { key: "urls", label: "局域网地址" },
              el("span", { className: "dlg-chip dlg-chipOk" }, "手机需与本机同一网络"),
              data.lanUrls.map(function (url) {
                return el("span", { key: url, className: "dlg-url" }, url);
              }),
              el("button", { type: "button", className: "dlg-btn", onClick: copyUrls }, "复制")
            )
          );
        } else {
          bindCardChildren.push(
            el(StatusRow, { key: "urls", label: "局域网地址" },
              el("span", { className: "dlg-chip dlg-chipWarn" }, "未开启（仅本机可访问）")
            )
          );
        }
        rows.push(el("div", { key: "bind", className: "dlg-card" }, bindCardChildren));

        // 2.25 HTTP（明文,核心端口）card —— 与 HTTPS 开关互不影响
        var httpOn = !!(data.http && data.http.enabled);
        var httpActive = !!data.http.active;
        var httpCardChildren = [
          el(StatusRow, { key: "httpState", label: "HTTP(明文)" },
            el("span", { className: "dlg-chip " + (httpActive ? "dlg-chipOk" : "dlg-chipWarn") },
              httpActive ? "已开启 · 局域网可访问" : httpOn ? "已开启 · 当前仅本机模式" : "已关闭 · 仅电脑本机可用"),
            el("span", { className: "dlg-chip" }, "端口 " + String(data.port))
          )
        ];
        if (data.lanUrls && data.lanUrls.length) {
          httpCardChildren.push(
            el(StatusRow, { key: "httpUrls", label: "HTTP 地址" },
              data.lanUrls.map(function (url) {
                return el("span", { key: url, className: "dlg-url" }, url);
              }),
              el("button", { type: "button", className: "dlg-btn", onClick: copyUrls }, "复制")
            )
          );
        } else {
          httpCardChildren.push(
            el(StatusRow, { key: "httpUrls", label: "HTTP 地址" },
              el("span", { className: "dlg-chip dlg-chipWarn" }, httpOn ? "仅 127.0.0.1 可访问（当前模式未暴露到局域网）" : "未开启")
            )
          );
        }
        if (local) {
          httpCardChildren.push(
            el(StatusRow, { key: "httpCtl", label: "设置" },
              el("button", {
                type: "button",
                className: "dlg-btn " + (httpOn ? "dlg-btnDanger" : "dlg-btnPrimary"),
                disabled: httpBusy[0],
                onClick: function () { applyHttp(!httpOn); },
              }, httpBusy[0] ? "处理中…" : httpOn ? "关闭局域网 HTTP" : "开启局域网 HTTP")
            )
          );
          httpCardChildren.push(
            el("p", { key: "httpHint", className: "dlg-hint" },
              httpOn
                ? "手机正通过明文 http 访问时，关掉它即可强制走 https；电脑端 127.0.0.1 始终可用，本开关不影响 HTTPS(3443)。"
                : "开启后手机可再次通过明文 http://<本机IP>:" + String(data.port) + "/mobile/ 访问（不加密）。建议仅在 https 不可用时开启。"
            )
          );
        } else {
          httpCardChildren.push(
            el("p", { key: "httpNote", className: "dlg-note" },
              "HTTP 设置只读：请在电脑端（127.0.0.1）修改。"
            )
          );
        }
        rows.push(el("div", { key: "http", className: "dlg-card" }, httpCardChildren));

        // 2.5 HTTPS card（局域网加密 / 自签证书）
        var tls = data.tls || { enabled: false, port: 3443, active: false };
        var tlsOn = !!tls.enabled;
        var tlsActive = !!tls.active;
        var tlsCardChildren = [
          el(StatusRow, { key: "tlsState", label: "HTTPS 加密" },
            el("span", { className: "dlg-chip " + (tlsActive ? "dlg-chipOk" : "dlg-chipWarn") },
              tlsActive ? "已开启 · 监听中" : tlsOn ? "已开启 · 未监听（需局域网模式）" : "未开启"),
            el("span", { className: "dlg-chip" }, "端口 " + String(tls.port))
          )
        ];
        if (data.lanTlsUrls && data.lanTlsUrls.length) {
          tlsCardChildren.push(
            el(StatusRow, { key: "tlsUrls", label: "HTTPS 地址" },
              data.lanTlsUrls.map(function (url) {
                return el("span", { key: url, className: "dlg-url" }, url);
              }),
              el("button", { type: "button", className: "dlg-btn", onClick: copyTlsUrls }, "复制")
            )
          );
        } else {
          tlsCardChildren.push(
            el(StatusRow, { key: "tlsUrls", label: "HTTPS 地址" },
              el("span", { className: "dlg-chip dlg-chipWarn" }, tlsOn ? "当前绑定模式下未监听（仅本机时不会开启）" : "未开启")
            )
          );
        }
        if (local) {
          tlsCardChildren.push(
            el(StatusRow, { key: "tlsCtl", label: "设置" },
              el("input", {
                className: "dlg-select",
                style: { width: 110, minWidth: 110 },
                type: "number",
                min: 1,
                max: 65535,
                value: tlsPortDraft[0],
                disabled: tlsBusy[0],
                onChange: function (event) { setTlsPortDraft(event.target.value); },
                "aria-label": "HTTPS 端口",
              }),
              el("button", {
                type: "button",
                className: "dlg-btn dlg-btnPrimary",
                disabled: tlsBusy[0],
                onClick: function () { applyTls(!tlsOn); },
              }, tlsBusy[0] ? "处理中…" : tlsOn ? "关闭 HTTPS" : "开启 HTTPS")
            )
          );
          tlsCardChildren.push(
            el("p", { key: "tlsHint", className: "dlg-hint" },
              "开启后手机访问 https://<本机IP>:" + String(tls.port) + "/mobile/（数据加密传输）。证书由电脑自动生成（~/.dsh/lan-gate-tls/，含 cert.pem 公钥证书），手机首次访问需信任：浏览器选“高级 → 继续访问”，或把 cert.pem 装入手机 CA 信任区后无警告。开启 HTTPS 不影响原 http 访问。"
            )
          );
        } else {
          tlsCardChildren.push(
            el("p", { key: "tlsNote", className: "dlg-note" },
              "HTTPS 设置只读：请在电脑端（127.0.0.1）的设置页开启/关闭。"
            )
          );
        }
        rows.push(el("div", { key: "tls", className: "dlg-card" }, tlsCardChildren));

        // 3. password card
        if (local) {
          var pwdRows = [
            el(StatusRow, { key: "pwdState", label: "访问密码" },
              el("span", { className: "dlg-chip " + (hasPassword ? "dlg-chipOk" : "dlg-chipWarn") },
                hasPassword ? "已设置" : "未设置" + (lanEnabled ? " · 局域网访问已被阻止" : "")
              )
            )
          ];
          var formRows = [];
          if (hasPassword) {
            formRows.push(
              el("div", { key: "cur", className: "dlg-field" },
                el("label", { htmlFor: "dlg-current" }, "当前密码"),
                el("input", {
                  id: "dlg-current", type: "password", autoComplete: "current-password",
                  value: currentPwd[0], disabled: saving[0],
                  onChange: function (event) { currentPwd[1](event.target.value); },
                })
              )
            );
          }
          formRows.push(
            el("div", { key: "new", className: "dlg-field" },
              el("label", { htmlFor: "dlg-new" }, hasPassword ? "新密码" : "设置访问密码"),
              el("input", {
                id: "dlg-new", type: "password", autoComplete: "new-password",
                placeholder: "至少 8 个字符",
                value: newPwd[0], disabled: saving[0],
                onChange: function (event) { newPwd[1](event.target.value); },
              })
            ),
            el("div", { key: "confirm", className: "dlg-field" },
              el("label", { htmlFor: "dlg-confirm" }, "确认新密码"),
              el("input", {
                id: "dlg-confirm", type: "password", autoComplete: "new-password",
                value: confirmPwd[0], disabled: saving[0],
                onChange: function (event) { confirmPwd[1](event.target.value); },
              })
            )
          );
          formRows.push(
            el("div", { key: "actions", className: "dlg-row" },
              el("button", {
                type: "button", className: "dlg-btn dlg-btnPrimary", disabled: saving[0],
                onClick: function () { savePassword(false); },
              }, saving[0] ? "保存中…" : hasPassword ? "保存新密码" : "设置密码"),
              hasPassword
                ? el("button", {
                    type: "button", className: "dlg-btn dlg-btnDanger", disabled: saving[0],
                    onClick: function () { savePassword(true); },
                  }, "移除密码（阻止局域网访问）")
                : null
            )
          );
          pwdRows.push(
            el("div", { key: "fields", className: "dlg-grid" }, formRows),
            el("p", { key: "pwdHint", className: "dlg-hint" },
              "密码以加盐 scrypt 保存在本机；修改立即生效，已登录的局域网设备需重新登录。"
            )
          );
          rows.push(el("div", { key: "password", className: "dlg-card" }, pwdRows));
        }
      }

      if (notice[0]) {
        rows.push(
          el("p", {
            key: "notice",
            className: "dlg-msg " + (notice[0].kind === "ok" ? "dlg-msgOk" : "dlg-msgErr"),
            role: "status",
          }, notice[0].text)
        );
      }

      return el("div", { className: "dlg-wrap" }, rows);
    }

    // ── remote directory picker (non-loopback pages) ─────────────────────────
    // DSH's native workspace-directory picker calls host.pickDirectory, which
    // the /api fence pins to loopback — phones (and the computer's own LAN-IP
    // URL) get HTTP 403. Creating a workspace itself only needs
    // workspace.create({ path }), which LAN clients may call, so remote pages
    // get a small path-entry dialog instead. It registers into the two
    // "directory flow" holes ONLY when the page is not loopback; on the
    // computer (127.0.0.1) the native picker stays untouched.

    function DirectoryDialog(props) {
      var onPicked = props.onPicked;
      var onCancel = props.onCancel;
      var busy = props.busy === true;
      var draftState = React.useState("");
      var draft = draftState[0];

      // Escape closes.
      React.useEffect(function () {
        function onKey(event) {
          if (event.key === "Escape") onCancel();
        }
        window.addEventListener("keydown", onKey);
        return function () {
          window.removeEventListener("keydown", onKey);
        };
      }, [onCancel]);

      var trimmed = draft.replace(/^\s+|\s+$/g, "");
      var canConfirm = !busy && trimmed.length > 0;

      return el("div", { className: "dlg-overlay" },
        el("div", { className: "dlg-dialog", role: "dialog", "aria-modal": "true" },
          el("div", { className: "dlg-dialogHead" },
            el("h2", null, "新建工作区"),
            el("p", { className: "dlg-hint" }, "工作区是电脑上的一个文件夹。手机端无法弹出电脑的目录选择框，请输入电脑上要作为工作区的文件夹完整路径。")
          ),
          el("div", { className: "dlg-dialogBody" },
            el("input", {
              className: "dlg-pathinput",
              value: draft,
              autoFocus: true,
              spellCheck: false,
              placeholder: "例如：C:\\work\\project 或 /home/user/project",
              onChange: function (event) { draftState[1](event.target.value); },
              onKeyDown: function (event) {
                if (event.key === "Enter" && canConfirm) onPicked(trimmed);
              },
            }),
            el("p", { className: "dlg-note" },
              "文件夹需已存在于电脑（或电脑可访问的网络位置），且电脑端有权限读写。填错会在创建时提示，可返回重试；也建议优先在电脑端新建，手机端只做简单录入。"
            )
          ),
          el("div", { className: "dlg-dialogFoot" },
            el("button", { type: "button", className: "dlg-btn", onClick: onCancel }, "取消"),
            el("button", {
              type: "button",
              className: "dlg-btn dlg-btnPrimary",
              disabled: !canConfirm,
              onClick: function () { onPicked(trimmed); },
            }, busy ? "创建中…" : "选择此文件夹")
          )
        )
      );
    }

    function RemoteDirectoryFlow(props) {
      var open = props.open;
      var shownState = React.useState(false);
      var shown = shownState[0];
      var setShown = shownState[1];
      var armed = React.useRef(false);

      React.useEffect(function () {
        if (!open) {
          armed.current = false;
          setShown(false);
          return;
        }
        if (armed.current) return;
        armed.current = true;
        setShown(true);
      }, [open]);

      if (!shown) return null;
      return el(DirectoryDialog, {
        busy: props.busy === true,
        onPicked: props.onPicked,
        onCancel: props.onCancel,
      });
    }

    // ── plugin entry ─────────────────────────────────────────────────────────

    function apply(ctx) {
      // 1. styles — inserted once per fiber, removed on unload
      ctx.effect(
        function () {
          var tag = document.createElement("style");
          tag.dataset.plugin = "dsh-lan-gate";
          tag.dataset.pluginCss = "dsh-lan-gate/section";
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () {
            tag.remove();
          };
        },
        "lan-gate: styles"
      );

      // 2. the section lives in Settings (sidebar gear → Settings)
      var slots = ctx.get("slots");
      if (slots === void 0) return;
      slots.inject("settings.section", function () {
        return slots.register(
          {
            name: "settings.section",
            id: "lan-gate",
            order: 20,
            label: function () {
              return "局域网访问";
            },
          },
          function () {
            return React.createElement(LanGateSection, { ctx: ctx });
          }
        );
      });

      // 3. remote (non-loopback) pages: take the workspace directory-flow holes
      //    with a path-entry dialog. The native occupant (host dialog via
      //    host.pickDirectory) is loopback-only and 403s from a phone; the flow
      //    only needs workspace.create({ path }) afterwards, which LAN clients
      //    may call. Single seats key on an explicit `priority` (lowest renders;
      //    an absent priority defaults to 0 and would collide with the native
      //    occupant's 0, failing the whole client boot), so register at -1 to
      //    shadow it. On 127.0.0.1 the guard keeps the native picker in charge.
      var connection = ctx.get("connection");
      if (connection && connection.isLoopback === false) {
        slots.inject("conversation.hero.workspace.directoryFlow", function () {
          return slots.inject("sidebar.workspaces.directoryFlow", function* () {
            yield slots.register(
              {
                name: "conversation.hero.workspace.directoryFlow",
                id: "lan-gate-remote-dirflow",
                priority: -1,
              },
              RemoteDirectoryFlow
            );
            yield slots.register(
              {
                name: "sidebar.workspaces.directoryFlow",
                id: "lan-gate-remote-dirflow",
                priority: -1,
              },
              RemoteDirectoryFlow
            );
          });
        });
      }
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
