'use strict';
/** 处理单条预警（标记已处理 + 处理备注），仅医生本人（docId 数据隔离） */
const { defineHandler } = require('../../_lib/handler');
const { parse, alertHandleSchema } = require('../../_lib/validate');
const { handleAlert } = require('../../_lib/clinic');
const { ApiError } = require('../../_lib/response');
const { audit } = require('../../_lib/services');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 60, windowSec: 60, byUser: true },
  fn: async ({ params, body, user }) => {
    const input = parse(alertHandleSchema, body);
    const a = await handleAlert(user.uid, params.id, { note: input.note, handlerName: user.name });
    if (!a) throw new ApiError(404, 40400, '预警不存在或无权处理');
    await audit('alert.handle', { operator: user.uid, alert_id: a.id, patient_id: a.patientId, type: a.type });
    return { id: a.id, status: a.status, handledAt: a.handledAt };
  }
});
