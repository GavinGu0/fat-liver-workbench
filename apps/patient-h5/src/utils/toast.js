/**
 * 极简轻量 Toast —— 患者端用于替代原生 alert()
 * 不依赖任何 UI 库，用 DOM + CSS transition 实现
 */
let _host = null;
function ensureHost() {
  if (_host && document.body.contains(_host)) return _host;
  _host = document.createElement('div');
  _host.id = 'flwb-toast-host';
  _host.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
  document.body.appendChild(_host);
  return _host;
}

function show(message, type = 'info', duration = 2400) {
  const host = ensureHost();
  const el = document.createElement('div');
  const bg = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' }[type] || '#3b82f6';
  el.style.cssText = `pointer-events:auto;padding:12px 20px;border-radius:10px;background:${bg};color:#fff;font-size:14px;line-height:1.5;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:90vw;text-align:center;opacity:0;transform:translateY(-8px);transition:opacity .2s ease, transform .2s ease;`;
  el.textContent = message;
  host.appendChild(el);
  // 触发重排后加 transition
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  const cleanup = () => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 220);
  };
  if (duration > 0) setTimeout(cleanup, duration);
  return { close: cleanup };
}

export const toast = {
  success: (msg, d) => show(msg, 'success', d),
  error: (msg, d) => show(msg, 'error', d),
  warning: (msg, d) => show(msg, 'warning', d),
  info: (msg, d) => show(msg, 'info', d),
  show
};
export default toast;
