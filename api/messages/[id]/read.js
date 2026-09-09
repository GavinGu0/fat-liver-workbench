'use strict';
/** 标记单条消息已读 */
const { defineHandler } = require('../../_lib/handler');
const { markMsgRead } = require('../../_lib/services');

module.exports = defineHandler({
  auth: 'any',
  fn: async ({ params, user }) => {
    const okd = await markMsgRead(user.uid, params.id);
    return { read: !!okd };
  }
});
