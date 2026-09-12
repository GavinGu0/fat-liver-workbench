'use strict';
/**
 * 密码重置（手机号 + 短信验证码）：验证手机归属 → 改密 → 立即解锁 → 吊销全部会话 → 自动登录
 * 流程：先调 /auth/sms 向注册手机号发送验证码 → 携验证码提交本接口（验证码一次性使用）。
 * 安全：新旧密码不得相同；重置成功后该用户所有 Refresh Token 立即失效（Access Token 15 分钟内自然过期），
 *       并向账号推送安全通知、写入审计与登录日志。
 */
const { defineHandler } = require('../_lib/handler');
const { ApiError } = require('../_lib/response');
const { getDb, K } = require('../_lib/storage');
const {
  signAccess, issueRefresh, hashPassword, verifyPassword, revokeUserSessions, ACCESS_TTL_SEC
} = require('../_lib/auth');
const { parse, resetPasswordSchema } = require('../_lib/validate');
const { pushMsg, audit } = require('../_lib/services');
const { clientMeta, recordLogin, unlock } = require('../_lib/login-security');
const logger = require('../_lib/logger');

function shanghaiTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
}

module.exports = defineHandler({
  auth: 'public',
  limit: { scope: 'reset-pwd', max: 5, windowSec: 60, byIp: true },
  fn: async ({ body, req }) => {
    const input = parse(resetPasswordSchema, body);
    const db = await getDb();
    const meta = clientMeta(req);

    // 1. 校验短信验证码（校验全部通过后才消费，避免无效提交烧掉验证码）
    const saved = await db.get(K.sms(input.phone));
    if (!saved || String(saved) !== String(input.code)) {
      await recordLogin(db, { account: input.phone, mode: 'reset', status: 'fail', reason: '验证码错误或已过期', ...meta });
      throw new ApiError(422, 42202, '验证码错误或已过期，请重新获取');
    }

    // 2. 按手机号定位账号
    const uid = await db.get(K.phoneIdx(input.phone));
    const user = uid ? await db.hgetall(K.user(uid)) : null;
    if (!user || !user.id) {
      await recordLogin(db, { account: input.phone, mode: 'reset', status: 'fail', reason: '尚未注册', ...meta });
      throw new ApiError(404, 40401, '该手机号尚未注册，请先完成注册建档');
    }

    // 3. 新旧密码不得相同（避免无意义重置）
    if (await verifyPassword(input.newPasswordHash, user.passwordHash)) {
      throw new ApiError(422, 42203, '新密码不能与原密码相同');
    }
    await db.del(K.sms(input.phone));

    // 4. 改密 + 立即解锁（清除失败计数与锁定标记）
    const bcryptHash = await hashPassword(input.newPasswordHash);
    await db.hset(K.user(user.id), { passwordHash: bcryptHash, pwdUpdatedAt: String(Date.now()) });
    await unlock(db, String(input.phone).toLowerCase());
    if (user.username) await unlock(db, String(user.username).toLowerCase());

    // 5. 吊销该用户全部会话（旧 Refresh Token 立即失效）
    const revokedSessions = await revokeUserSessions(user.id);

    // 6. 安全通知 + 审计 + 登录日志
    await pushMsg(user.id, {
      type: 'system',
      title: '密码重置成功',
      content: `<p>您的账号密码已于 ${shanghaiTime()} 通过手机验证码重置${revokedSessions ? '，其他设备已全部退出登录' : ''}。如非本人操作，请立即联系管理员。</p>`,
      from: '系统'
    });
    await audit('auth.reset_password', { uid: user.id, role: user.role, ip: meta.ip, revokedSessions });
    logger.warn('auth.reset_password', { uid: user.id, role: user.role, ip: meta.ip, revokedSessions });
    await recordLogin(db, {
      uid: user.id, role: user.role, account: input.phone,
      mode: 'reset', status: 'reset', reason: '密码重置成功', ...meta
    });

    // 7. 自动登录（短信验证码已证明手机归属，免去二次输入）
    const pub = {
      uid: user.id, role: user.role, name: user.name,
      patientId: user.patientId || null, title: user.title || '', dept: user.dept || ''
    };
    return {
      reset: true,
      revokedSessions,
      user: pub,
      accessToken: signAccess(pub),
      refreshToken: await issueRefresh(pub),
      expiresIn: ACCESS_TTL_SEC
    };
  }
});
