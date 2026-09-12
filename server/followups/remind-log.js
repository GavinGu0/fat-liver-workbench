'use strict';
/**
 * 随访提醒发送日志（医护端）：
 * GET  ?date=YYYY-MM-DD&status=&page=&size= 按日查询发送记录（含成功/失败/重试统计）
 *     同时顺带处理到期的重试队列（幂等、单次上限50条），保证医护查看日志时失败项得到及时补发
 * POST { notifyId } 手动重发一条失败通知（补救通道）
 */
const { defineHandler } = require('../_lib/handler');
const { requireRole } = require('../_lib/auth');
const { listNotifyLogs, getNotifyItem, resendNotify, processRetryQueue } = require('../_lib/notify');
const { parse } = require('../_lib/validate');
const { z } = require('zod');
const { ApiError } = require('../_lib/response');

const resendSchema = z.object({ notifyId: z.string().min(6).max(64) });

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, query, body, user }) => {
    requireRole(user, 'staff');

    if (req.method === 'GET') {
      const data = await listNotifyLogs(query);
      // 机会式重试：查看日志时补发到期失败项（幂等，上限50条/次）
      let retry = null;
      try { retry = await processRetryQueue(); } catch { /* 非关键路径 */ }
      return { ...data, retry };
    }

    if (req.method === 'POST') {
      const input = parse(resendSchema, body);
      const item = await getNotifyItem(input.notifyId);
      if (!item) throw new ApiError(404, 40400, '发送记录不存在或已过期');
      const r = await resendNotify(input.notifyId);
      if (!r || !r.notifyId) throw new ApiError(500, 50001, '重发失败，请稍后重试或电话随访');
      return { resent: true, notifyId: r.notifyId, status: r.status };
    }

    throw new ApiError(405, 40500, '不支持的请求方法');
  }
});
