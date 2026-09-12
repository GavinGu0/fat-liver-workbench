'use strict';
/**
 * 登录/注册：mode = password（账号+密码）| sms（手机+验证码）| register（患者注册并自动建档）
 * 密码前端已做 sha256+盐，服务端 bcrypt 校验；注册即自动建立健康档案（PRD 3.1.1）
 */
const { randomUUID } = require('node:crypto');
const { defineHandler } = require('../_lib/handler');
const { ApiError } = require('../_lib/response');
const { getDb, K, dateStr } = require('../_lib/storage');
const { signAccess, issueRefresh, verifyPassword, ACCESS_TTL_SEC } = require('../_lib/auth');
const { pushMsg, track, audit, updatePatient } = require('../_lib/services');
const { matchPatient, indexPatient } = require('../_lib/patient-match');
const { parse, loginSchema } = require('../_lib/validate');
const { clientMeta, recordLogin, assertNotLocked, registerFailure, clearFailures, MAX_FAIL, LOCK_MIN } = require('../_lib/login-security');
const { calcBmi } = require('@flwb/shared');
const logger = require('../_lib/logger');

const DEFAULT_DOC_ID = 'u_doc_gbmz';
const DEFAULT_NURSE_ID = 'u_nurse_01';

async function findUserByIdentifier(db, { username, phone }) {
  let uid = null;
  if (username) uid = await db.get(K.usernameIdx(username));
  if (!uid && phone) uid = await db.get(K.phoneIdx(phone));
  if (!uid) return null;
  const u = await db.hgetall(K.user(uid));
  return u && u.id ? u : null;
}

async function registerPatient(db, { phone, passwordHash, profile }) {
  // 手机号唯一性（用户维度）
  const exist = await db.get(K.phoneIdx(phone));
  if (exist) throw new ApiError(409, 40901, '该手机号已注册，请直接登录');

  const uid = 'u_p_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const { bcryptHash } = await prepareHash(passwordHash);

  await db.hset(K.user(uid), {
    id: uid, username: phone, phone, role: 'patient', name: profile.name,
    title: '', dept: '', patientId: '', passwordHash: bcryptHash, createdAt: String(Date.now())
  });
  await db.set(K.phoneIdx(phone), uid);
  await db.set(K.usernameIdx(phone), uid);

  const bmi = calcBmi(profile.weight, profile.height);

  /* 患者维度唯一标识匹配：医生已建同手机号档案 → 绑定既有档案（数据一致性） */
  const { matched, dimension } = await matchPatient(db, { phone });
  if (matched) {
    if (matched.userId) {
      // 极端并发场景：档案刚被其他账号绑定
      throw new ApiError(409, 40901, '该手机号已注册，请直接登录');
    }
    const patient = await updatePatient(matched.id, (p) => {
      p.userId = uid;
      p.name = profile.name;
      p.gender = profile.gender;
      p.age = profile.age;
      if (profile.height) p.height = profile.height;
      if (profile.weight) { p.weight = profile.weight; p.lastWeight = profile.weight; }
      if (bmi != null) p.bmi = bmi;
      if (!p.mainDiagnosis) p.mainDiagnosis = '脂肪肝（待门诊确诊分型）';
      if (!p.nextFollowupDate) p.nextFollowupDate = dateStr(7);
    }, null);
    await db.hset(K.user(uid), { patientId: matched.id });
    await pushMsg(uid, {
      type: 'education',
      title: '欢迎加入脂肪肝管理计划',
      content: `<p>已为您关联主管医生建立的健康档案（匹配依据：${dimension === 'phone' ? '手机号' : dimension}）！请坚持每日记录<b>饮食、运动和随访指标</b>，您的医生将实时了解您的院外情况并给予专业指导。</p>`,
      from: '系统'
    });
    await track('patient_register', { user_id: uid, matched: true });
    await audit('patient.register', { uid, patientId: matched.id, operator: uid, matched: true });
    logger.info('patient.register.bind', { uid, patientId: matched.id, dimension });
    return { user: pubUser({ id: uid, role: 'patient', name: profile.name, patientId: matched.id }), patient, matched: true };
  }

  /* 未命中 → 新建档案 */
  const patientId = 'p_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const patient = {
    id: patientId,
    userId: uid,
    name: profile.name,
    gender: profile.gender,
    age: profile.age,
    height: profile.height,
    weight: profile.weight,
    bmi,
    risk: bmi >= 28 ? 'high' : bmi >= 24 ? 'mid' : 'low',
    phone,
    docId: DEFAULT_DOC_ID, // 演示环境自动分配主管医生
    nurseId: DEFAULT_NURSE_ID,
    mainDiagnosis: '脂肪肝（待门诊确诊分型）',
    chiefComplaint: '新注册患者，待门诊评估',
    pastHistory: '',
    nextFollowupDate: dateStr(7),
    lastFollowupAt: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastWeight: profile.weight,
    version: 1
  };
  await db.set(K.patient(patientId), JSON.stringify(patient));
  await db.zadd(K.docPatients(patient.docId), Date.now(), patientId);
  await db.zadd(K.allPatients, Date.now(), patientId);
  await db.zadd(K.patientCreated(patient.docId), Date.now(), patientId);
  await indexPatient(db, patient); // 唯一标识索引（手机号 → patientId）

  await pushMsg(uid, {
    type: 'education',
    title: '欢迎加入脂肪肝管理计划',
    content: '<p>您已成功建立健康档案！请坚持每日记录<b>饮食、运动和随访指标</b>，您的医生将实时了解您的院外情况并给予专业指导。</p>',
    from: '系统'
  });
  await track('patient_register', { user_id: uid });
  await audit('patient.register', { uid, patientId, operator: uid });
  logger.info('patient.register', { uid, patientId });

  return { user: pubUser({ id: uid, role: 'patient', name: profile.name, patientId }), patient, matched: false };
}

// bcrypt 是异步的，这里包一层避免在非 async 调用点阻塞
const bcrypt = require('bcryptjs');
async function prepareHash(clientHash) {
  return { bcryptHash: await bcrypt.hash(clientHash, 10) };
}

function pubUser(u) {
  return { uid: u.id, role: u.role, name: u.name, patientId: u.patientId || null, title: u.title || '', dept: u.dept || '' };
}

module.exports = defineHandler({
  auth: 'public',
  limit: { scope: 'login', max: 10, windowSec: 60, byIp: true },
  fn: async ({ body, req }) => {
    const input = parse(loginSchema, body);
    const db = await getDb();
    const meta = clientMeta(req);

    if (input.mode === 'register') {
      if (!input.phone || !input.passwordHash || !input.profile) {
        throw new ApiError(422, 42201, '注册信息不完整');
      }
      // 注册同样需要短信验证码（演示模式下 code=123456）
      const codeKey = K.sms(input.phone);
      const saved = await db.get(codeKey);
      if (!saved || String(saved) !== String(input.code)) {
        throw new ApiError(422, 42202, '验证码错误或已过期');
      }
      await db.del(codeKey);
      const { user, patient } = await registerPatient(db, input);
      return finalize(user, { ...meta, account: input.phone, mode: 'register' });
    }

    if (input.mode === 'sms') {
      if (!input.phone || !input.code) throw new ApiError(422, 42201, '请输入手机号与验证码');
      const saved = await db.get(K.sms(input.phone));
      if (!saved || String(saved) !== String(input.code)) {
        await recordLogin(db, { account: input.phone, mode: 'sms', status: 'fail', reason: '验证码错误或已过期', ...meta });
        throw new ApiError(422, 42202, '验证码错误或已过期');
      }
      await db.del(K.sms(input.phone));
      const user = await findUserByIdentifier(db, { phone: input.phone });
      if (!user) {
        await recordLogin(db, { account: input.phone, mode: 'sms', status: 'fail', reason: '尚未注册', ...meta });
        throw new ApiError(404, 40401, '该手机号尚未注册，请先完成注册建档');
      }
      // 短信验证码登录不受密码锁定影响（自助解锁路径），但成功后清除失败计数
      await clearFailures(db, String(input.phone).toLowerCase());
      return finalize(pubUser(user), { ...meta, account: input.phone, mode: 'sms' });
    }

    // password 模式：锁定拦截 → 账号存在性 → 状态 → 密码校验（失败计数 + 锁定）
    if (!input.username || !input.passwordHash) throw new ApiError(422, 42201, '请输入账号与密码');
    const lockKey = String(input.username).trim().toLowerCase();
    await assertNotLocked(db, lockKey);

    const user = await findUserByIdentifier(db, { username: input.username });
    if (!user) {
      await recordLogin(db, { account: input.username, mode: 'password', status: 'fail', reason: '账号不存在', ...meta });
      throw new ApiError(404, 40401, '账号不存在，请核对后重试，或先注册建档');
    }
    if (user.status === 'disabled') {
      await recordLogin(db, { uid: user.id, role: user.role, account: input.username, mode: 'password', status: 'fail', reason: '账户已停用', ...meta });
      throw new ApiError(403, 40301, '该账户已被停用，请联系管理员处理');
    }
    if (!(await verifyPassword(input.passwordHash, user.passwordHash))) {
      const r = await registerFailure(db, lockKey, { uid: user.id, account: input.username, ip: meta.ip });
      await recordLogin(db, {
        uid: user.id, role: user.role, account: input.username, mode: 'password',
        status: r.justLocked ? 'lock' : 'fail',
        reason: r.justLocked ? `密码连续错误 ${r.count} 次，账号锁定 ${LOCK_MIN} 分钟` : '密码错误',
        ...meta
      });
      throw new ApiError(401, r.justLocked ? 40103 : 40102, r.justLocked
        ? `密码连续错误 ${r.count} 次，账号已锁定 ${LOCK_MIN} 分钟；您可改用短信验证码登录，或重置密码立即解锁`
        : `密码错误，还可尝试 ${MAX_FAIL - r.count} 次（超出后账号将临时锁定）`);
    }
    await clearFailures(db, lockKey);
    return finalize(pubUser(user), { ...meta, account: input.username, mode: 'password' });
  }
});

async function finalize(user, meta = {}) {
  const accessToken = signAccess(user);
  const refreshToken = await issueRefresh(user);
  await audit('auth.login', { uid: user.uid, role: user.role, mode: meta.mode || '-' });
  const db = await getDb();
  await recordLogin(db, {
    uid: user.uid, role: user.role, account: meta.account || '',
    mode: meta.mode || '', status: 'success', reason: '',
    ip: meta.ip || '', ua: meta.ua || ''
  });
  return { user, accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC };
}
