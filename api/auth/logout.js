'use strict';
/** 退出登录：吊销 Refresh Token（Access Token 15 分钟自然过期，实现简单且够用的服务端吊销） */
const { defineHandler } = require('../_lib/handler');
const { revokeRefresh } = require('../_lib/auth');
const { audit } = require('../_lib/services');

module.exports = defineHandler({
  auth: 'any',
  fn: async ({ body, user }) => {
    await revokeRefresh(body && body.refreshToken);
    await audit('auth.logout', { uid: user.uid, role: user.role });
    return { bye: true };
  }
});
