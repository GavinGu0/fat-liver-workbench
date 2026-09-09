'use strict';
/** 刷新访问令牌：Refresh Token 轮换（旧 token 立即失效，可吊销） */
const { defineHandler } = require('../_lib/handler');
const { ApiError } = require('../_lib/response');
const { getDb, K } = require('../_lib/storage');
const { rotateRefresh, signAccess, ACCESS_TTL_SEC } = require('../_lib/auth');

module.exports = defineHandler({
  auth: 'public',
  limit: { scope: 'refresh', max: 30, windowSec: 60, byIp: true },
  fn: async ({ body }) => {
    const { refreshToken } = body || {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new ApiError(401, 40100, '会话已失效，请重新登录');
    }
    const { info, token } = await rotateRefresh(refreshToken);
    const db = await getDb();
    const u = await db.hgetall(K.user(info.uid));
    if (!u || !u.id) throw new ApiError(401, 40100, '账号不存在');
    const user = { uid: u.id, role: u.role, name: u.name, patientId: u.patientId || null, title: u.title || '', dept: u.dept || '' };
    return { user, accessToken: signAccess(user), refreshToken: token, expiresIn: ACCESS_TTL_SEC };
  }
});
