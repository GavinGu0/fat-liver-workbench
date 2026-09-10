'use strict';
/** 一键全部已读（预警批量处理） */
const { defineHandler } = require('../_lib/handler');
const { readAllAlerts } = require('../_lib/clinic');
const { audit } = require('../_lib/services');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 10, windowSec: 60, byUser: true },
  fn: async ({ user }) => {
    await readAllAlerts(user.uid);
    await audit('alert.readAll', { operator: user.uid });
    return { ok: true };
  }
});
