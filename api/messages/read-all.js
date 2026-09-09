'use strict';
/** 全部标记已读 */
const { defineHandler } = require('../_lib/handler');
const { markAllMsgsRead } = require('../_lib/services');

module.exports = defineHandler({
  auth: 'any',
  fn: async ({ user }) => ({ done: await markAllMsgsRead(user.uid) })
});
