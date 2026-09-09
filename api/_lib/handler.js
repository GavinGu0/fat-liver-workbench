'use strict';
/**
 * 请求编排中间件（原生 Vercel Handler，无 Express 依赖，冷启动最小化）
 * 职责：requestId / CORS / JSON body 解析 / 种子数据 / JWT RBAC / 限流 / 幂等 / 统一响应 / 错误兜底
 */
const { makeReqId, ok, fail, ApiError } = require('./response');
const logger = require('./logger');
const { authFromReq, requireRole } = require('./auth');
const { rateLimit } = require('./rate-limit');
const { setNxEx, K } = require('./storage');
const { ensureSeed } = require('./seed');

const BODY_LIMIT = 6 * 1024 * 1024; // 6MB

async function readBody(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 40004, '请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new ApiError(400, 40001, 'JSON 格式错误'); }
}

function parseQuery(req) {
  const url = new URL(req.url || '/', 'http://local');
  const q = {};
  for (const [k, v] of url.searchParams.entries()) q[k] = v;
  return q;
}

/**
 * @param {object} opts
 * @param {'public'|'doctor'|'nurse'|'patient'|'staff'|'any'} [opts.auth='public']
 * @param {{scope:string, max?:number, windowSec?:number, byUser?:boolean, byIp?:boolean}} [opts.limit]
 * @param {(ctx: object) => Promise<any>} opts.fn 业务函数，返回值即统一响应的 data
 */
function defineHandler(opts) {
  return async function handler(req, res) {
    const reqId = makeReqId();
    res.setHeader('X-Request-Id', reqId);
    const origin = req.headers && req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'false');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    const startedAt = Date.now();
    let user = null;
    try {
      await ensureSeed();

      const body = await readBody(req);
      const query = parseQuery(req);
      const params = {};
      if (req.query) {
        for (const [k, v] of Object.entries(req.query)) {
          if (typeof v === 'string') params[k] = v;
        }
      }

      const needAuth = opts.auth && opts.auth !== 'public';
      if (needAuth) {
        user = authFromReq(req);
        requireRole(user, opts.auth);
      }

      await rateLimit(req, user, opts.limit);

      // 幂等键：写操作防重复提交（PRD 网络异常重试场景）
      const idemKey = req.headers && req.headers['x-idempotency-key'];
      if (idemKey && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const first = await setNxEx(K.idem(String(idemKey).slice(0, 64)), '1', 86400);
        if (!first) throw new ApiError(409, 40901, '重复提交的请求，请勿重复操作');
      }

      const data = await opts.fn({ req, res, body, query, params, user, reqId });
      logger.info('api.ok', {
        requestId: reqId,
        method: req.method,
        path: (req.url || '').split('?')[0],
        uid: user && user.uid,
        role: user && user.role,
        durationMs: Date.now() - startedAt
      });
      if (!res.writableEnded) ok(res, data, reqId);
      return;
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      if (e instanceof ApiError) {
        logger.warn('api.biz-error', { requestId: reqId, path: req.url, code: e.bizCode, message: e.message, durationMs });
        fail(res, e.httpStatus, e.bizCode, e.message, reqId);
        return;
      }
      logger.error('api.crash', {
        requestId: reqId,
        path: req.url,
        message: e.message,
        stack: (e.stack || '').split('\n').slice(0, 4).join(' | '),
        durationMs
      });
      fail(res, 500, 50000, '服务开小差了，请稍后重试', reqId);
    }
  };
}

module.exports = { defineHandler };
