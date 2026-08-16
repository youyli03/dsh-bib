// dsh-bib 静态客户端半区（打包为 ModuleLoader bundle）
// dock 窗口注入 conversation.input.dock；Host RPC 走 /dsh-bib/* HTTP 路由（同源 fetch）。
// 仅移植最终接受的 dock 布局：宽度对齐输入框卡片、圆角 22px、单标签隐藏标签行、
// 手动收起不再自动展开（userCollapsed）。不注入 tool.view.cordis（会话记录卡片不动）。
window.__ModuleLoader__.load({
  id: "dsh-bib",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    const DOCK_CSS = `
.dshbib-card { box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1, #3f3f46); border-radius: 12px; overflow: hidden; font-size: 12px; line-height: 1.4; background: var(--dsw-specific-tip, #18181b); color: var(--dsw-alias-label-primary, #e4e4e7); box-shadow: var(--dsw-shadow-lv2, none); }
.dshbib-head { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--dsw-alias-separator-primary, #3f3f46); cursor: pointer; background: transparent; }
.dshbib-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #71717a); flex: none; }
.dshbib-dot.stopped { background: var(--dsw-alias-label-tertiary, #71717a); }
.dshbib-dot.starting { background: var(--dsw-alias-state-warn-primary, #facc15); animation: dshbib-blink 0.8s infinite; }
.dshbib-dot.running { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dshbib-dot.degraded { background: var(--dsw-alias-state-warn-primary, #f97316); }
.dshbib-dot.error { background: var(--dsw-alias-state-error-primary, #ef4444); }
@keyframes dshbib-blink { 50% { opacity: 0.3; } }
.dshbib-title { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-primary, #fafafa); }
.dshbib-tabs { display: flex; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-separator-primary, #3f3f46); overflow-x: auto; }
.dshbib-tab { display: inline-flex; align-items: center; gap: 4px; max-width: 140px; padding: 2px 8px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover, #27272a); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: var(--dsw-alias-label-secondary, #a1a1aa); }
.dshbib-tab.active { outline: 1px solid var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-brand-text, #93c5fd); }
.dshbib-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-separator-primary, #3f3f46); }
.dshbib-btn { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #3f3f46); background: var(--dsw-alias-interactive-bg-hover, #27272a); cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary, #e4e4e7); }
.dshbib-url { flex: 1; min-width: 0; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #3f3f46); background: transparent; color: var(--dsw-alias-label-primary, #e4e4e7); font-size: 12px; }
.dshbib-viewport { position: relative; background: conic-gradient(#16161a 25%, #1c1c21 0 50%, #16161a 0 75%, #1c1c21 0); }
.dshbib-img { display: block; width: 100%; max-height: clamp(160px, calc(100vh - 480px), 58vh); object-fit: contain; user-select: none; }
.dshbib-placeholder { padding: 40px 12px; text-align: center; color: var(--dsw-alias-label-tertiary, #a1a1aa); }
.dshbib-foot { padding: 4px 10px; border-top: 1px solid var(--dsw-alias-separator-primary, #3f3f46); color: var(--dsw-alias-label-secondary, #a1a1aa); font-size: 11px; }
.dshbib-code { padding: 8px 10px; border-top: 1px solid var(--dsw-alias-separator-primary, #3f3f46); font-size: 11px; color: var(--dsw-alias-label-secondary, #a1a1aa); }
.dshbib-code input { width: 100%; box-sizing: border-box; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #3f3f46); background: transparent; color: var(--dsw-alias-label-primary, #e4e4e7); font-family: monospace; }
.dshbib-error { color: var(--dsw-alias-state-error-primary, #f87171); }
`;

    /** Host RPC：同源 fetch 到 /dsh-bib/<name>?<query>，返回 JSON。自动携带当前会话 sessionId。 */
    function makeRpc(sessionId) {
      return async function rpc(name, params) {
        let qs = '';
        const all = Object.assign({}, params || {}, { sessionId: sessionId || '' });
        const sp = new URLSearchParams();
        for (const k of Object.keys(all)) {
          const v = all[k];
          if (v !== undefined && v !== null) sp.set(k, String(v));
        }
        qs = '?' + sp.toString();
        const res = await fetch('/dsh-bib/' + name + qs, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('bib/' + name + ' HTTP ' + res.status);
        return res.json();
      };
    }

    const inject = ["slots"];

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots) return;

      // 注入样式（ModuleLoader 按 data-plugin 认领 <style>，随插件卸载清理）
      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-bib');
        styleEl.textContent = DOCK_CSS;
        document.head.appendChild(styleEl);
        return () => {
          try { styleEl.remove(); } catch { /* ignore */ }
        };
      }, 'dsh-bib: dock styles');

      const el = React.createElement;

      // 错误边界：捕获 BibCard 渲染异常，避免整个 dock 崩溃（abdicated）
      class BibErrorBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error: String((error && error.message) || error) };
        }
        componentDidCatch(error, info) {
          try { console.error('[dsh-bib] dock render error:', error, info); } catch { /* ignore */ }
        }
        render() {
          if (this.state.error) {
            return el('div', { className: 'dshbib-card', style: { padding: '8px 12px' } },
              el('span', { className: 'dshbib-title' }, 'dsh-bib 渲染错误'),
              el('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, String(this.state.error)),
            );
          }
          return this.props.children;
        }
      }

      function BibCard(props) {
        const [st, setSt] = React.useState({
          state: 'stopped', url: '', title: '', seq: -1, data: '',
          width: 0, height: 0, tabs: [], activeTab: null,
          code: null, lastError: '',
        });
        const [expanded, setExpanded] = React.useState(false);
        const [showCode, setShowCode] = React.useState(false);
        const [urlInput, setUrlInput] = React.useState('');
        const lastSeq = React.useRef(-1);
        // 用户手动收起标记：手动收起后，帧更新不再自动展开（避免「缩回去又冒出来」）
        const userCollapsed = React.useRef(false);
        // 是否曾因浏览器活动出现过：初始（从未出现）时完全隐藏；出现后收起为小横幅
        const shownRef = React.useRef(false);
        // 轨迹视图隐藏：切到轨迹/瀑布视图时整个窗口不渲染（含已展开状态），回对话视图恢复
        const [trajectory, setTrajectory] = React.useState(false);
        // 会话绑定的 rpc（注入 sessionId）
        const rpcRef = React.useRef(null);
        if (!rpcRef.current) rpcRef.current = makeRpc(props.sessionId || '');

        // 轨迹视图感知：切到轨迹/瀑布视图时隐藏窗口（回对话视图恢复）。
        // 检测当前 view tab：对话视图 tab 有 wSkVaW_tabActive（或 aria-selected=true）
        // 且文本为「轨迹/瀑布/trajectory/waterfall」。class 检测优先（布局稳定），
        // aria 兜底；两者都失败则用 view 区域内的活跃 tab 文本。
        React.useEffect(() => {
          const detect = () => {
            try {
              const isTraj = (t) => {
                const cls = (t.className || '') + '';
                const text = (t.textContent || '').trim();
                const activeByClass = cls.includes('tabActive') || t.getAttribute('aria-selected') === 'true';
                return activeByClass && /轨迹|瀑布|trajectory|waterfall/i.test(text);
              };
              // 优先：header 的 view tab 行（.wSkVaW_tabs 内）
              let tabs = Array.prototype.slice.call(document.querySelectorAll('.wSkVaW_tab'));
              if (tabs.some(isTraj)) { setTrajectory(true); return; }
              // 兜底：会话区域内 aria-selected=true 的 tab
              const viewArea = document.querySelector('[data-slot="conversation.session"], [data-slot="conversation\\.session"]');
              if (viewArea) {
                const at = viewArea.querySelector('[aria-selected="true"]');
                if (at && /轨迹|瀑布|trajectory|waterfall/i.test((at.textContent || '').trim())) {
                  setTrajectory(true);
                  return;
                }
              }
              setTrajectory(false);
            } catch { /* ignore */ }
          };
          detect();
          const t = window.setInterval(detect, 800);
          return () => window.clearInterval(t);
        }, []);

        React.useEffect(() => {
          const timer = window.setInterval(async () => {
            try {
              const r = await rpcRef.current('poll', {});
              setSt((prev) => {
                const next = Object.assign({}, prev, r);
                const wasStopped = prev.state === 'stopped';
                const nowActive = r.state === 'running' || r.state === 'starting' || r.state === 'degraded';
                const nowStopped = r.state === 'stopped';
                if (wasStopped && nowActive) {
                  // 新一轮启动（stopped → running/starting/degraded）：清除手动收起标记并出现+展开
                  userCollapsed.current = false;
                  shownRef.current = true;
                  setExpanded(true);
                } else if (!wasStopped && nowStopped) {
                  // 浏览器停止：恢复初始隐藏（不置 userCollapsed，下次启动仍会再现）
                  shownRef.current = false;
                  setExpanded(false);
                } else if (r.seq > lastSeq.current && r.seq >= 0 && !userCollapsed.current) {
                  // 仅当用户未手动收起时才随新帧自动展开
                  lastSeq.current = r.seq;
                  shownRef.current = true;
                  setExpanded(true);
                }
                return next;
              });
            } catch { /* host 未就绪 */ }
          }, 500);
          return () => window.clearInterval(timer);
        }, []);

        React.useEffect(() => {
          rpcRef.current('status', {}).then((r) => {
            if (r) setSt((prev) => Object.assign({}, prev, {
              tabs: r.tabs || [], activeTab: r.activeTab, code: r.code, lastError: r.lastError || '',
            }));
          }).catch(() => {});
        }, [expanded]);

        function viewportPoint(e) {
          try {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect && st.width > 0 && st.height > 0 && rect.width > 0) {
              return {
                x: (e.clientX - rect.left) * (st.width / rect.width),
                y: (e.clientY - rect.top) * (st.height / rect.height),
              };
            }
          } catch { /* DOM 几何不可用：退化 */ }
          return { x: e.clientX, y: e.clientY };
        }

        function onViewportClick(e) {
          const p = viewportPoint(e);
          rpcRef.current('input', { type: 'click', x: Math.round(p.x), y: Math.round(p.y) }).catch(() => {});
        }

        function onViewportWheel(e) {
          try { e.preventDefault(); } catch { /* ignore */ }
          const p = viewportPoint(e);
          rpcRef.current('input', {
            type: 'scroll', x: Math.round(p.x), y: Math.round(p.y),
            dx: Math.round(e.deltaX), dy: Math.round(e.deltaY),
          }).catch(() => {});
        }

        function goUrl() {
          let u = urlInput.trim();
          if (!u) return;
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
          rpcRef.current('navigate', { url: u }).catch(() => {});
        }

        function switchTab(tabId) { rpcRef.current('switch', { tabId }).catch(() => {}); }
        function activateEdge() { rpcRef.current('activate', {}).catch(() => {}); }
        const [confirmStop, setConfirmStop] = React.useState(false);
        function stopAll() {
          if (!confirmStop) { setConfirmStop(true); return; }
          setConfirmStop(false);
          rpcRef.current('stop', {}).catch(() => {});
        }

        const dot = el('span', { className: 'dshbib-dot ' + st.state });
        const head = el('div', { className: 'dshbib-head', onClick: () => {
          if (expanded) {
            // 收起：记录用户手动收起，帧更新不再自动展开
            userCollapsed.current = true;
            setExpanded(false);
          } else {
            // 展开：清除收起标记，恢复随帧自动展开
            userCollapsed.current = false;
            setExpanded(true);
          }
        } },
          dot,
          el('span', { className: 'dshbib-title' }, 'dsh-bib 内嵌浏览器'),
          el('span', {}, st.state),
          el('button', { className: 'dshbib-btn', onClick: (e) => { e.stopPropagation(); setShowCode(!showCode); } }, '配对'),
          el('button', { className: 'dshbib-btn', onClick: (e) => { e.stopPropagation(); stopAll(); } }, confirmStop ? '确认停止？' : '停止'),
        );

        const tabEls = (st.tabs || []).map((t) =>
          el('span', {
            key: String(t.tabId),
            className: 'dshbib-tab' + (t.active ? ' active' : ''),
            onClick: () => switchTab(t.tabId),
            title: t.url,
          }, (t.title || t.url || ('tab ' + t.tabId)).slice(0, 20)));

        const bar = el('div', { className: 'dshbib-bar' },
          el('button', { className: 'dshbib-btn', onClick: () => rpcRef.current('navigate', { action: 'go', direction: 'back' }).catch(() => {}) }, '◀'),
          el('button', { className: 'dshbib-btn', onClick: () => rpcRef.current('navigate', { action: 'go', direction: 'forward' }).catch(() => {}) }, '▶'),
          el('button', { className: 'dshbib-btn', onClick: () => rpcRef.current('navigate', { action: 'reload' }).catch(() => {}) }, '⟳'),
          el('input', {
            className: 'dshbib-url', value: urlInput, placeholder: st.url || 'https://…',
            onChange: (e) => setUrlInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') goUrl(); },
          }),
          el('button', { className: 'dshbib-btn', onClick: goUrl }, '前往'),
          el('button', { className: 'dshbib-btn', onClick: activateEdge }, '切到Edge'),
        );

        let body;
        if (st.state === 'stopped') {
          body = el('div', { className: 'dshbib-placeholder' }, '浏览器未启动：在对话中让模型调用 browser_open，或点「配对」连接扩展');
        } else if (st.data) {
          body = el('img', {
            className: 'dshbib-img',
            src: 'data:image/jpeg;base64,' + st.data,
            draggable: false,
            onClick: onViewportClick,
            onWheel: onViewportWheel,
            alt: 'browser viewport',
          });
        } else if (st.state === 'starting') {
          body = el('div', { className: 'dshbib-placeholder' }, '正在启动…');
        } else {
          body = el('div', { className: 'dshbib-placeholder' }, '暂无帧：等待页面渲染（扩展离线？检查 Edge 中的 dsh-bib 扩展）');
        }

        const codeArea = showCode ? el('div', { className: 'dshbib-code' },
          el('div', {}, '① 在 Edge 打开 dsh-bib 扩展 ② 粘贴连接码（一次性）：'),
          el('input', { readOnly: true, value: st.code || '（需先启动）', onFocus: (e) => { try { e.target.select(); } catch { /* ignore */ } } }),
        ) : null;

        const footText = st.url + (st.title ? '  ·  ' + st.title : '') +
          (st.state === 'degraded' ? '  ·  扩展离线：请在 Edge 打开扩展并 attach（专用窗口勿最小化）' : '') +
          (st.lastError ? '  ·  ' + st.lastError : '');

        // 轨迹视图隐藏：切到轨迹/瀑布视图时整个窗口不渲染（含已展开状态），回对话视图恢复
        if (trajectory) return null;

        // 初始（从未因活动出现）时完全隐藏；出现后收起为小横幅（仅头栏，可点击再展开）
        if (!expanded && !shownRef.current) return null;

        return el('div', { className: 'dshbib-card' },
          head,
          expanded ? el('div', {},
            (st.tabs || []).length > 1 ? el('div', { className: 'dshbib-tabs' }, ...tabEls) : null,
            bar,
            body,
            codeArea,
            el('div', { className: 'dshbib-foot' }, footText),
          ) : null,
        );
      }

      // 会话内常驻浏览器窗口：composer 上方全宽行（不随聊天滚动，保留对话/轨迹视图切换）
      // 初始（从未出现）完全隐藏；浏览器开始活动（stopped→running 或新帧）才出现并展开；
      // 手动收起后变成小横幅（仅头栏，可点击再展开），新帧不会把它重新撑开；
      // 浏览器停止后恢复初始隐藏。
      // 尺寸对齐任务条（TodoPanel .lXshSW_root 同规范）：
      //   border-radius:12px / border:1px solid border-l1 / background: dsw-specific-tip
      //   width: calc(100% - 2*side-clearance - 4*dock-inset)（= calc(100% - 64px)）
      //   max-width: calc(card-max-width - 4*dock-inset)（= 748px） margin: 0 auto
      // 会话绑定：slot ownerProps 注入 sessionId，rpc 带该 id 走 Host 会话隔离状态。
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'dshbib-window', order: 0 },
        (props) => {
          const sid = (props && props.sessionId) || (props && props.session && props.session.id) || '';
          return el('div', {
            style: {
              boxSizing: 'border-box',
              width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px))',
              maxWidth: 'calc(var(--dsh-composer-card-max-width, 780px) - 4 * var(--dsh-composer-dock-inset, 8px))',
              margin: '0 auto',
            },
          }, el(BibErrorBoundary, null, el(BibCard, { sessionId: sid })));
        },
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
