// plugin/client.jsx —— dsh-bib Client 半区（动态 Cordis 插件）
// tool.view.cordis（key self）对话内嵌卡片：tab 条 + 工具条 + 帧视口 + 状态区 + 配对引导。
// 约束：无 document/window/fetch；React.createElement 风格；DOM 几何访问全部 try/catch 防御。

return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;

    styles.insert(`
.dshbib-card { box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, #3f3f46); border-radius: 22px; overflow: hidden; font-size: 12px; line-height: 1.4; background: var(--dsw-specific-input-major, #18181b); color: var(--dsw-alias-label-primary, #e4e4e7); box-shadow: var(--dsw-shadow-lv2, none); }
.dshbib-float { position: sticky; top: 8px; width: 360px; max-width: 40vw; z-index: 1000; border: 1px solid var(--dsw-alias-border-l2, #3f3f46); border-radius: 10px; overflow: hidden; font-size: 12px; line-height: 1.4; background: var(--dsw-alias-bg-layer-2, #18181b); color: var(--dsw-alias-label-primary, #e4e4e7); box-shadow: 0 8px 28px rgba(0,0,0,.35); pointer-events: auto; }
.dshbib-float-collapsed { cursor: pointer; }
.dshbib-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-separator-primary, #3f3f46); cursor: pointer; background: transparent; }
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
.dshbib-tab-new { flex: none; padding: 2px 8px; border-radius: 6px; background: transparent; border: 1px dashed var(--dsw-alias-border-l2, #3f3f46); cursor: pointer; color: var(--dsw-alias-label-secondary, #a1a1aa); }
.dshbib-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-separator-primary, #3f3f46); }
.dshbib-btn { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #3f3f46); background: var(--dsw-alias-interactive-bg-hover, #27272a); cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary, #e4e4e7); }
.dshbib-url { flex: 1; min-width: 0; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #3f3f46); background: transparent; color: var(--dsw-alias-label-primary, #e4e4e7); font-size: 12px; }
.dshbib-viewport { position: relative; background: conic-gradient(#16161a 25%, #1c1c21 0 50%, #16161a 0 75%, #1c1c21 0); }
.dshbib-img { display: block; width: 100%; max-height: 58vh; object-fit: contain; user-select: none; }
.dshbib-placeholder { padding: 40px 12px; text-align: center; color: var(--dsw-alias-label-tertiary, #a1a1aa); }
.dshbib-foot { padding: 4px 10px; border-top: 1px solid var(--dsw-alias-separator-primary, #3f3f46); color: var(--dsw-alias-label-secondary, #a1a1aa); font-size: 11px; }
.dshbib-code { padding: 8px 10px; border-top: 1px solid var(--dsw-alias-separator-primary, #3f3f46); font-size: 11px; color: var(--dsw-alias-label-secondary, #a1a1aa); }
.dshbib-code input { width: 100%; box-sizing: border-box; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #3f3f46); background: transparent; color: var(--dsw-alias-label-primary, #e4e4e7); font-family: monospace; }
.dshbib-error { color: var(--dsw-alias-state-error-primary, #f87171); }
`);

    const el = React.createElement;

    function BibCard(props) {
      const [st, setSt] = React.useState({
        state: 'stopped', url: '', title: '', seq: -1, data: '',
        width: 0, height: 0, tabs: [], activeTab: null,
        code: null, lastError: '',
      });
      const [expanded, setExpanded] = React.useState(!!(props && props.initialExpanded));
      const [showCode, setShowCode] = React.useState(false);
      const [urlInput, setUrlInput] = React.useState('');
      const lastSeq = React.useRef(-1);
      // 用户手动收起标记：手动收起后，帧更新不再自动展开（避免「缩回去又冒出来」）
      const userCollapsed = React.useRef(false);

      React.useEffect(() => ctx.interval(async () => {
        try {
          const r = await host.call('bib/poll', {});
          setSt((prev) => {
            const next = Object.assign({}, prev, r);
            // 仅当用户未手动收起时才随新帧自动展开
            if (r.seq > lastSeq.current && r.seq >= 0 && !userCollapsed.current) {
              lastSeq.current = r.seq;
              setExpanded(true);
            }
            return next;
          });
        } catch { /* host 重连中 */ }
      }, 500), []);

      React.useEffect(() => {
        host.call('bib/status', {}).then((r) => {
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
        } catch { /* 沙箱无 DOM 几何：退化 */ }
        return { x: e.clientX, y: e.clientY };
      }

      function onViewportClick(e) {
        const p = viewportPoint(e);
        host.call('bib/input', { type: 'click', x: Math.round(p.x), y: Math.round(p.y) }).catch(() => {});
      }

      function onViewportWheel(e) {
        try { e.preventDefault(); } catch { /* ignore */ }
        const p = viewportPoint(e);
        host.call('bib/input', {
          type: 'scroll', x: Math.round(p.x), y: Math.round(p.y),
          dx: Math.round(e.deltaX), dy: Math.round(e.deltaY),
        }).catch(() => {});
      }

      function goUrl() {
        let u = urlInput.trim();
        if (!u) return;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
        host.call('bib/navigate', { url: u }).catch(() => {});
      }

      function switchTab(tabId) { host.call('bib/switch', { tabId }).catch(() => {}); }
      function activateEdge() { host.call('bib/activate', {}).catch(() => {}); }
      const [confirmStop, setConfirmStop] = React.useState(false);
      function stopAll() {
        if (!confirmStop) { setConfirmStop(true); return; }
        setConfirmStop(false);
        host.call('bib/stop', {}).catch(() => {});
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
        el('button', { className: 'dshbib-btn', onClick: () => host.call('bib/navigate', { action: 'go', direction: 'back' }) }, '◀'),
        el('button', { className: 'dshbib-btn', onClick: () => host.call('bib/navigate', { action: 'go', direction: 'forward' }) }, '▶'),
        el('button', { className: 'dshbib-btn', onClick: () => host.call('bib/navigate', { action: 'reload' }) }, '⟳'),
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

    // ---------------- overlay 浮动条（操作时固定在会话上方） ----------------
    function BibOverlay() {
      const [st, setSt] = React.useState({
        state: 'stopped', url: '', title: '', seq: -1, data: '',
        width: 0, height: 0, lastError: '',
      });
      const [expanded, setExpanded] = React.useState(false);
      const hideTimer = React.useRef(null);
      const lastSeq = React.useRef(-1);

      const scheduleHide = React.useCallback(() => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setExpanded(false), 10000);
      }, []);

      React.useEffect(() => ctx.interval(async () => {
        try {
          const r = await host.call('bib/poll', {});
          setSt((prev) => {
            const next = Object.assign({}, prev, r);
            if (r.seq > lastSeq.current && r.seq >= 0) {
              lastSeq.current = r.seq;
              setExpanded(true);
              scheduleHide();
            }
            return next;
          });
        } catch { /* host 重连中 */ }
      }, 500), []);

      React.useEffect(() => () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
      }, []);

      function viewportPoint(e) {
        try {
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect && st.width > 0 && st.height > 0 && rect.width > 0) {
            return {
              x: (e.clientX - rect.left) * (st.width / rect.width),
              y: (e.clientY - rect.top) * (st.height / rect.height),
            };
          }
        } catch { /* 沙箱无 DOM 几何：退化 */ }
        return { x: e.clientX, y: e.clientY };
      }

      function onViewportClick(e) {
        const p = viewportPoint(e);
        host.call('bib/input', { type: 'click', x: Math.round(p.x), y: Math.round(p.y) }).catch(() => {});
      }

      function onViewportWheel(e) {
        try { e.preventDefault(); } catch { /* ignore */ }
        const p = viewportPoint(e);
        host.call('bib/input', {
          type: 'scroll', x: Math.round(p.x), y: Math.round(p.y),
          dx: Math.round(e.deltaX), dy: Math.round(e.deltaY),
        }).catch(() => {});
      }

      const head = el('div', { className: 'dshbib-head', onClick: () => setExpanded(!expanded) },
        el('span', { className: 'dshbib-dot ' + st.state }),
        el('span', { className: 'dshbib-title' }, 'dsh-bib 内嵌浏览器'),
        el('span', { style: { color: 'var(--dsw-alias-label-secondary, #a1a1aa)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          st.url || (st.state === 'stopped' ? '未启动' : '…')),
        el('span', {}, expanded ? '▼' : '▲'),
      );

      let body = null;
      if (expanded) {
        if (st.state === 'stopped') {
          body = el('div', { className: 'dshbib-placeholder' }, '浏览器未启动：让模型调用 browser_open');
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
          body = el('div', { className: 'dshbib-placeholder' }, '暂无帧（扩展离线？）');
        }
      }

      const floatStyle = {
        position: 'fixed', right: 16, bottom: 16, width: 360, maxWidth: '40vw',
        zIndex: 1000, border: '1px solid var(--dsw-alias-border-l2, #3f3f46)',
        borderRadius: 10, overflow: 'hidden', fontSize: 12, lineHeight: 1.4,
        background: 'var(--dsw-alias-bg-layer-2, #18181b)',
        color: 'var(--dsw-alias-label-primary, #e4e4e7)',
        boxShadow: '0 8px 28px rgba(0,0,0,.35)', pointerEvents: 'auto',
      };
      return el('div', { className: 'dshbib-float', style: floatStyle },
        head,
        body,
      );
    }

    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => el(BibCard),
    ));

    // 会话内常驻浏览器窗口：composer 上方全宽行（不随聊天滚动，保留对话/轨迹视图切换）
    // 宽度精确对齐输入框卡片：输入框卡片外层 .uV2eYG_root 有 padding 0 16px（左右各 16px），
    // 故卡片实际宽 = min(容器-32, --dsh-composer-card-max-width)。dock 行无该留白，
    // 窗口宽 = min(容器-32, 卡片maxWidth) 才能与输入框完全对齐。
    // 32px = 2 × 16px（--dsh-composer-side-clearance，实测确认；硬编码避免 var 在 dock 作用域失效）。
    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'dshbib-window', order: 0 },
      () => el('div', {
        style: {
          width: 'calc(100% - 32px)',
          maxWidth: 'var(--dsh-composer-card-max-width)',
          margin: '0 auto',
        },
      }, el(BibCard, { initialExpanded: true })),
    ));
  },
};
