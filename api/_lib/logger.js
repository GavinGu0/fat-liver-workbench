'use strict';
/** 结构化 JSON 日志：由 Vercel Logs 聚合；敏感字段自动脱敏 */

const SENSITIVE = ['password', 'passwordHash', 'code', 'token', 'refreshToken', 'phone', 'idCard'];

function maskValue(v) {
  const s = String(v);
  if (s.length <= 4) return '****';
  if (s.length <= 7) return s.slice(0, 3) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

function mask(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.includes(k)) out[k] = maskValue(v);
    else if (v && typeof v === 'object') out[k] = mask(v);
    else out[k] = v;
  }
  return out;
}

function write(level, action, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    action,
    ...(data ? mask(data) : {})
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  info: (action, data) => write('info', action, data),
  warn: (action, data) => write('warn', action, data),
  error: (action, data) => write('error', action, data),
  mask
};
