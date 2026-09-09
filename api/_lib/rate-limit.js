'use strict';
/** 基于 KV 计数器的固定窗口限流：登录 10次/分/IP；填报 30次/分/用户；默认 120次/分/用户 */
const { getDb, K } = require('./storage');
const { ApiError } = require('./response');

const DEFAULT_MAX = 120;

function minuteBucket() {
  return Math.floor(Date.now() / 60000);
}

/**
 * @param {object} opts { scope, max, windowSec, byUser, byIp }
 */
async function rateLimit(req, user, opts) {
  if (!opts) return;
  const db = await getDb();
  const windowSec = opts.windowSec || 60;
  const max = opts.max || DEFAULT_MAX;
  let id = 'anon';
  if (opts.byUser && user && user.uid) id = user.uid;
  else if (opts.byIp) {
    const xf = req.headers['x-forwarded-for'];
    id = (typeof xf === 'string' ? xf.split(',')[0].trim() : '') || (req.socket && req.socket.remoteAddress) || 'ip';
  }
  const key = K.lock(`rl:${opts.scope}:${id}:${minuteBucket()}`);
  const n = await db.incr(key);
  if (n === 1) await db.expire(key, windowSec + 5);
  if (n > max) {
    throw new ApiError(429, 42900, '请求过于频繁，请稍后再试');
  }
}

module.exports = { rateLimit };
