'use strict';
/**
 * 预警风险提醒（信息化平台 · 模块3）
 * GET 预警列表（level/status 筛选 + 未读数）；来源：筛查阳性/检验异常/高风险未会诊/随访逾期/指标异常
 */
const { defineHandler } = require('../_lib/handler');
const { parse, alertsQuerySchema } = require('../_lib/validate');
const { listAlerts } = require('../_lib/clinic');

module.exports = defineHandler({
  auth: 'doctor',
  fn: async ({ query, user }) => {
    const input = parse(alertsQuerySchema, query);
    const { items, unread, counts } = await listAlerts(user.uid, {
      level: input.level,
      status: input.status,
      limit: 100
    });
    const stats = {
      total: items.length,
      open: counts.open,
      highOpen: counts.highOpen,
      unread
    };
    return { items, stats, unread };
  }
});
