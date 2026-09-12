'use strict';
/**
 * 登录日志查询（staff）：按日查询登录成功/失败/锁定/重置记录 + 异常统计
 * 异常检测口径：失败集中账号（疑似暴力破解）、多账号同 IP（疑似撞库），供管理员巡查告警。
 */
const { defineHandler } = require('../_lib/handler');
const { ApiError } = require('../_lib/response');
const { requireRole } = require('../_lib/auth');
const { listLoginLogs } = require('../_lib/login-security');

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'read', max: 60, windowSec: 60, byUser: true },
  fn: async ({ req, query, user }) => {
    requireRole(user, 'staff');
    if (req.method !== 'GET') throw new ApiError(405, 40500, '不支持的请求方法');
    return listLoginLogs(query);
  }
});
