'use strict';
/**
 * 统一 API 入口（单函数架构）
 * 背景：Vercel Hobby 计划单次部署最多 12 个函数，原 api/ 下 31 个路由文件会超限。
 * 方案：全部路由实现迁移至 server/（保持目录结构，内部相对引用不变），
 *       vercel.json 将 /api/* 与 /api/v1/* 统一 rewrite 到本函数，
 *       路径经 __path 查询参数传入，本文件按路径分发到对应 handler，对外路由不变。
 * 注意：必须使用静态 require（字面量路径），否则 Vercel 文件追踪无法打包依赖。
 */

/**
 * 路由表：pattern 中 [name] 为动态段（注入 req.query，模拟 Vercel 动态路由行为）。
 * 匹配时按静态段数量降序，保证 /patients/followup-batch 优先于 /patients/[id]。
 */
const ROUTES = [
  ['health', require('../server/health.js')],
  ['docs', require('../server/docs.js')],
  ['openapi', require('../server/openapi.js')],
  ['config', require('../server/config.js')],
  ['dashboard', require('../server/dashboard.js')],
  ['auth/login', require('../server/auth/login.js')],
  ['auth/sms', require('../server/auth/sms.js')],
  ['auth/refresh', require('../server/auth/refresh.js')],
  ['auth/logout', require('../server/auth/logout.js')],
  ['patients/followup-batch', require('../server/patients/followup-batch.js')],
  ['patients', require('../server/patients/index.js')],
  ['patients/[id]', require('../server/patients/[id]/index.js')],
  ['patients/[id]/records', require('../server/patients/[id]/records.js')],
  ['patients/[id]/followup', require('../server/patients/[id]/followup.js')],
  ['patients/[id]/revisit', require('../server/patients/[id]/revisit.js')],
  ['patients/[id]/trend', require('../server/patients/[id]/trend.js')],
  ['patients/[id]/labs', require('../server/patients/[id]/labs.js')],
  ['patients/[id]/mdt', require('../server/patients/[id]/mdt.js')],
  ['records/vitals', require('../server/records/vitals.js')],
  ['records/diet', require('../server/records/diet.js')],
  ['records/exercise', require('../server/records/exercise.js')],
  ['records/upload', require('../server/records/upload.js')],
  ['messages/read-all', require('../server/messages/read-all.js')],
  ['messages', require('../server/messages/index.js')],
  ['messages/[id]/read', require('../server/messages/[id]/read.js')],
  ['nurse/templates', require('../server/nurse/templates.js')],
  ['nurse/education', require('../server/nurse/education.js')],
  ['nurse/guidance', require('../server/nurse/guidance.js')],
  ['mdt', require('../server/mdt/index.js')],
  ['medical-records', require('../server/medical-records.js')],
  ['screening/[id]/decision', require('../server/screening/[id]/decision.js')],
  ['screening', require('../server/screening/index.js')],
  ['alerts/read-all', require('../server/alerts/read-all.js')],
  ['alerts/[id]/handle', require('../server/alerts/[id]/handle.js')],
  ['alerts', require('../server/alerts/index.js')],
  ['followups/remind', require('../server/followups/remind.js')],
  ['followups/[id]/execute', require('../server/followups/[id]/execute.js')],
  ['followups/[id]/lost', require('../server/followups/[id]/lost.js')],
  ['followups', require('../server/followups/index.js')],
  ['quality', require('../server/quality.js')],
  ['reports/[id]', require('../server/reports/[id]/index.js')],
  ['cron/followup-remind', require('../server/cron/followup-remind.js')]
];

const COMPILED = ROUTES.map(([pattern, handler]) => {
  const segs = pattern.split('/');
  const staticCount = segs.filter(s => !s.startsWith('[')).length;
  return { pattern, segs, staticCount, handler };
}).sort((a, b) => b.staticCount - a.staticCount || b.segs.length - a.segs.length);

function matchRoute(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  for (const r of COMPILED) {
    if (r.segs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const p = r.segs[i];
      if (p.startsWith('[')) {
        params[p.slice(1, -1)] = decodeURIComponent(segs[i]);
      } else if (p !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

module.exports = async function handler(req, res) {
  // 优先取 rewrite 传入的 __path（已剥离 /api 或 /api/v1 前缀），否则从 req.url 解析
  let pathname = '';
  if (req.query && typeof req.query.__path === 'string' && req.query.__path) {
    pathname = req.query.__path;
  } else {
    pathname = (req.url || '/').split('?')[0].replace(/^\/api(\/v1)?/, '');
  }
  pathname = pathname.replace(/^\/+|\/+$/g, '');

  const hit = matchRoute(pathname);
  if (!hit) {
    res.status(404).json({ code: 40404, message: `接口不存在: ${req.method} /${pathname}` });
    return;
  }

  // 注入动态参数（handler 内 defineHandler 会从 req.query 提取字符串值作为 params）
  req.query = { ...req.query, ...hit.params };
  delete req.query.__path; // 内部路由参数，避免污染业务 params

  return hit.handler(req, res);
};
