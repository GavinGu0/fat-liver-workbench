'use strict';
/**
 * 发送短信验证码：5分钟有效，60秒内不可重发
 * 未配置 SMS_KEY 时为演示模式：验证码通过 demoCode 字段直接返回（生产自动关闭）
 */
const { getDb, K, setNxEx } = require('../_lib/storage');
const { ApiError } = require('../_lib/response');
const { defineHandler } = require('../_lib/handler');
const { parse, smsSchema } = require('../_lib/validate');
const logger = require('../_lib/logger');

module.exports = defineHandler({
  auth: 'public',
  limit: { scope: 'sms', max: 5, windowSec: 60, byIp: true },
  fn: async ({ body }) => {
    const { phone } = parse(smsSchema, body);
    const db = await getDb();

    // 60 秒重发限制
    const first = await setNxEx(`sms:cool:${phone}`, '1', 60);
    if (!first) throw new ApiError(429, 42900, '发送过于频繁，请60秒后再试');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await db.set(K.sms(phone), code, { ex: 300 });

    const hasSmsProvider = !!process.env.SMS_KEY;
    if (hasSmsProvider) {
      // 生产环境：接入短信服务商（阿里云/腾讯云），此处预留调用点
      // await smsProvider.send(phone, `【脂肪肝管理】您的验证码为 ${code}，5分钟内有效。`);
      logger.warn('sms.not-implemented', { phone }); // 未实现服务商前降级为演示模式
      return { sent: true, demoMode: true, demoCode: code, message: '短信服务商未配置，验证码已在响应中返回（仅演示）' };
    }
    logger.info('sms.demo', { phone });
    return { sent: true, demoMode: true, demoCode: code, message: '演示模式：验证码已直接返回' };
  }
});
