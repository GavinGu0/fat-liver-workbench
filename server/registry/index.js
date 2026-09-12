'use strict';
/**
 * 专病建档 · 档案中心（信息化平台 · 模块2，参考专病平台 registry 一站式流程）
 * GET  /api/registry  专病档案列表：聚合患者档案 + 专病病历，支持 keyword/risk/status 筛选、分页、统计
 *                     医生仅见本人管理患者；护士全量只读
 * POST /api/registry  一站式建档（仅医生）：开通患者登录账号（用户名/初始密码）+ 建患者档案
 *                     + 写专病病历 + 风险分层 + 按风险周期自动排期随访 + 高危自动 MDT 预警
 */
const { randomUUID } = require('node:crypto');
const { defineHandler } = require('../_lib/handler');
const { getDb, K, dateStr } = require('../_lib/storage');
const { requireRole, hashPassword } = require('../_lib/auth');
const { getPatient, updatePatient, addArchiveEntry, audit, track, pushMsg } = require('../_lib/services');
const { parse, registryCreateSchema } = require('../_lib/validate');
const { calcBmi, riskStratify, suggestFollowupDate, MEDICAL_RECORD_KEYS, calcAge, parseIdCard, recordCompleteness, followupStatusOf, FOLLOWUP_STATUS_LABELS } = require('@flwb/shared');
const { raiseAlert } = require('../_lib/clinic');
const { matchPatient, indexPatient, reindexPatient } = require('../_lib/patient-match');
const { ApiError } = require('../_lib/response');
const logger = require('../_lib/logger');

const RISK_KEYS = ['high', 'mid', 'low'];

/* ==================== GET：专病档案列表 ==================== */
async function listArchives({ query, user }) {
  requireRole(user, 'staff');
  const db = await getDb();

  const pids = user.role === 'doctor'
    ? await db.zrevrange(K.docPatients(user.uid), 0, -1)
    : await db.zrevrange(K.allPatients, 0, -1);
  const patients = await Promise.all(pids.map(pid => getPatient(pid)));

  const today = dateStr();
  const all = [];
  for (const p of patients.filter(Boolean)) {
    const raw = await db.get(K.medrec(p.id));
    let rec = null;
    if (raw) { try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { rec = null; } }
    const comp = recordCompleteness(rec);
    const fst = followupStatusOf(p.nextFollowupDate, today, p.lostAt);
    all.push({
      patientId: p.id,
      name: p.name,
      gender: p.gender,
      age: (rec && rec.birthDate ? calcAge(rec.birthDate) : null) ?? p.age ?? null,
      phone: p.phone || '',
      mainDiagnosis: (rec && rec.riskLevel ? '脂肪肝' : '') || p.mainDiagnosis || '',
      visitNumber: (rec && rec.visitNumber) || p.visitNumber || '',
      inpatientNumber: (rec && rec.inpatientNumber) || p.inpatientNumber || '',
      insuranceType: (rec && rec.insuranceType) || p.insuranceType || '',
      bmi: (rec && rec.bmi) ?? p.bmi ?? null,
      risk: (rec && rec.riskLevel) || p.risk || null,
      riskScore: (rec && rec.riskScore) ?? null,
      archived: !!rec,
      incomplete: !!rec && !comp.complete,
      missingItems: rec ? comp.missing.map(m => m.label) : [],
      version: rec ? rec.version : null,
      createdByName: rec ? rec.createdByName : '',
      archivedAt: rec ? rec.createdAt : null,
      updatedAt: rec ? rec.updatedAt : (p.archivedAt || null),
      createdAt: p.createdAt,
      nextFollowupDate: p.nextFollowupDate || null,
      followupStatus: fst.status || 'none',
      followupStatusLabel: fst.status ? FOLLOWUP_STATUS_LABELS[fst.status] : '暂无随访',
      followupDaysLeft: fst.daysLeft
    });
  }

  const stats = {
    archived: all.filter(r => r.archived).length,
    pending: all.filter(r => !r.archived).length,
    incomplete: all.filter(r => r.incomplete).length,
    high: all.filter(r => r.archived && r.risk === 'high').length,
    mid: all.filter(r => r.archived && r.risk === 'mid').length,
    low: all.filter(r => r.archived && r.risk === 'low').length
  };

  let items = all;
  const kw = String(query.keyword || '').trim().toLowerCase();
  if (kw) {
    items = items.filter(r => [r.name, r.phone, r.visitNumber, r.inpatientNumber].filter(Boolean).some(v => String(v).toLowerCase().includes(kw)));
  }
  if (query.risk && RISK_KEYS.includes(query.risk)) items = items.filter(r => r.risk === query.risk);
  const status = query.status || 'archived';
  if (status === 'archived') items = items.filter(r => r.archived);
  else if (status === 'pending') items = items.filter(r => !r.archived);
  else if (status === 'incomplete') items = items.filter(r => r.incomplete);

  items.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(query.size, 10) || 20));
  const total = items.length;

  return { total, page, size, stats, items: items.slice((page - 1) * size, page * size) };
}

/* ==================== POST：一站式建档（开通账号 + 专病档案） ==================== */
async function createRegistry({ body, user }) {
  requireRole(user, 'doctor');
  const input = parse(registryCreateSchema, body);
  const db = await getDb();

  /* 0. 患者唯一标识匹配：身份证 > 手机号（命中则关联既有档案，杜绝同一自然人重复建档） */
  const { matched, dimension } = await matchPatient(db, { idCard: input.idCard, phone: input.phone });
  if (matched) {
    if (matched.docId && matched.docId !== user.uid) {
      throw new ApiError(409, 40902, `该患者已由其他医生建档管理（匹配依据：${dimension === 'idCard' ? '身份证号' : '手机号'}）。如需转介管理，请联系管理员处理`);
    }
    return bindExistingPatient({ db, input, user, matched, dimension });
  }

  /* 1. 账号唯一性（用户名 / 手机号） */
  const uname = input.username;
  const existUid = await db.get(K.usernameIdx(uname));
  if (existUid) throw new ApiError(409, 40901, '登录用户名已存在，请更换');
  if (input.phone) {
    const existPhone = await db.get(K.phoneIdx(input.phone));
    if (existPhone) throw new ApiError(409, 40901, '该手机号已注册，请核对后更换');
  }

  /* 2. 开通患者登录账号（密码与患者自注册同构：前端 sha256+盐 → 服务端 bcrypt） */
  const uid = 'u_p_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const patientId = 'p_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const passwordHash = await hashPassword(input.initialPasswordHash);
  await db.hset(K.user(uid), {
    id: uid, username: uname, phone: input.phone || '', role: 'patient', name: input.name,
    title: '', dept: '', patientId, passwordHash, createdAt: String(Date.now())
  });
  await db.set(K.usernameIdx(uname), uid);
  if (input.phone) await db.set(K.phoneIdx(input.phone), uid);

  /* 3. 建患者档案（基本信息 + 体格字段落档；性别缺省时由身份证解析补全） */
  const fromIdCard = input.idCard ? parseIdCard(input.idCard) : null;
  const birthDate = input.birthDate || (fromIdCard && fromIdCard.birthDate) || null;
  const gender = input.gender || (fromIdCard && fromIdCard.gender) || null; // schema 已保证性别/身份证必有其一
  const bmi = calcBmi(input.weight, input.height);
  const patient = {
    id: patientId,
    userId: uid,
    name: input.name,
    gender,
    age: calcAge(birthDate),
    birthDate,
    idCard: input.idCard || '',
    height: input.height ?? null,
    weight: input.weight ?? null,
    bmi,
    risk: input.riskLevel,
    phone: input.phone || '',
    docId: user.uid,
    nurseId: null,
    mainDiagnosis: '脂肪肝（专病建档）',
    chiefComplaint: input.chiefComplaint || '',
    visitNumber: input.visitNumber || '',
    inpatientNumber: input.inpatientNumber || '',
    visitDept: input.visitDept || '',
    insuranceType: input.insuranceType || '',
    pastHistory: '',
    nextFollowupDate: null,
    lastFollowupAt: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastWeight: input.weight ?? null,
    version: 1
  };
  await db.set(K.patient(patientId), JSON.stringify(patient));
  await db.zadd(K.docPatients(user.uid), Date.now(), patientId);
  await db.zadd(K.allPatients, Date.now(), patientId);
  await db.zadd(K.patientCreated(user.uid), Date.now(), patientId);
  await indexPatient(db, patient); // 唯一标识索引（身份证/手机号 → patientId）

  /* 4. 写专病病历（白名单字段）+ 风险分层（医生确认为准，评分与依据附注） */
  const record = await upsertMedicalRecord(db, { input, user, patientId, gender, bmi });

  /* 5. 按风险周期自动排期随访（低6-12/中3-6/高1-3月） */
  const nextFollowupDate = suggestFollowupDate(record.riskLevel, dateStr());
  await updatePatient(patientId, (p) => {
    p.nextFollowupDate = nextFollowupDate;
    p.medicalRecordId = patientId;
    p.archivedAt = Date.now();
  }, null);
  await db.sadd(K.followupDue(nextFollowupDate), patientId);

  /* 6. 高风险 → MDT 预警 */
  await maybeRaiseMdt(user, patient, record);

  /* 7. 站内信告知患者账号已开通（不回传密码，初始密码由医生线下交付） */
  await pushMsg(uid, {
    type: 'education',
    title: '您的健康管理账号已开通',
    content: `<p>医生已为您完成脂肪肝专病建档。登录账号：<b>${uname}</b>，请使用初始密码登录后及时修改，并坚持每日记录饮食、运动与随访指标。</p>`,
    from: '系统'
  });

  await addArchiveEntry(patientId, {
    kind: 'archive', type: 'medical_record',
    title: `脂肪肝专病建档（v${record.version} · 一站式新建）`,
    summary: `风险分层：${record.riskLevel === 'high' ? '高' : record.riskLevel === 'mid' ? '中' : '低'}风险（评分${record.riskScore}）；建档医生：${user.name}`,
    by: user.name
  });
  await audit('registry.create', { operator: user.uid, patient_id: patientId, uid, risk: record.riskLevel });
  await track('registry_create', { doc_id: user.uid, patient_id: patientId, risk: record.riskLevel });
  logger.info('registry.create', { uid, patientId, docId: user.uid, risk: record.riskLevel });

  return {
    patientId,
    userId: uid,
    username: uname,
    version: record.version,
    riskLevel: record.riskLevel,
    riskScore: stratOf(record).score,
    nextFollowupDate,
    followupAutoSet: true,
    completeness: recordCompleteness(record),
    modelSuggestion: stratOf(record),
    matched: false
  };
}

/**
 * 命中既有档案时的一站式建档：绑定/复用账号 + 更新档案与病历（不重复创建患者）
 * 场景：医生建档时患者已自注册，或此前建档未开账号
 */
async function bindExistingPatient({ db, input, user, matched, dimension }) {
  const patientId = matched.id;
  let uid = matched.userId;
  let uname = null;
  let accountExisted = false;

  /* 1. 账号处理：已有账号直接复用；无账号则开通（用户名唯一性校验） */
  if (uid) {
    accountExisted = true;
    const raw = await db.hgetall(K.user(uid));
    if (raw && raw.username) uname = raw.username;
  } else {
    uname = input.username;
    const existUid = await db.get(K.usernameIdx(uname));
    if (existUid) throw new ApiError(409, 40901, '登录用户名已存在，请更换');
    if (input.phone) {
      const existPhone = await db.get(K.phoneIdx(input.phone));
      if (existPhone && existPhone !== uid) throw new ApiError(409, 40901, '该手机号已注册其他账号，请核对后更换');
    }
    uid = 'u_p_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const passwordHash = await hashPassword(input.initialPasswordHash);
    await db.hset(K.user(uid), {
      id: uid, username: uname, phone: input.phone || matched.phone || '', role: 'patient', name: input.name,
      title: '', dept: '', patientId, passwordHash, createdAt: String(Date.now())
    });
    await db.set(K.usernameIdx(uname), uid);
    if (input.phone) await db.set(K.phoneIdx(input.phone), uid);
  }

  /* 2. 更新患者档案（保留既有管理字段，补齐建档信息；userId 绑定） */
  const fromIdCard = input.idCard ? parseIdCard(input.idCard) : null;
  const birthDate = input.birthDate || (fromIdCard && fromIdCard.birthDate) || matched.birthDate || null;
  const gender = input.gender || (fromIdCard && fromIdCard.gender) || matched.gender || null;
  const bmi = calcBmi(input.weight, input.height);
  const updated = await updatePatient(patientId, (p) => {
    p.userId = uid;
    p.name = input.name;
    p.gender = gender;
    p.age = calcAge(birthDate);
    p.birthDate = birthDate;
    if (input.idCard) p.idCard = input.idCard;
    if (input.phone) p.phone = input.phone;
    if (input.height != null) p.height = input.height;
    if (input.weight != null) { p.weight = input.weight; p.lastWeight = input.weight; }
    if (bmi != null) p.bmi = bmi;
    p.risk = input.riskLevel;
    p.mainDiagnosis = p.mainDiagnosis || '脂肪肝（专病建档）';
    if (input.chiefComplaint) p.chiefComplaint = input.chiefComplaint;
    if (input.visitNumber) p.visitNumber = input.visitNumber;
    if (input.inpatientNumber) p.inpatientNumber = input.inpatientNumber;
    if (input.visitDept) p.visitDept = input.visitDept;
    if (input.insuranceType) p.insuranceType = input.insuranceType;
  }, null);
  await reindexPatient(db, updated, matched);
  await db.zadd(K.docPatients(user.uid), Date.now(), patientId);
  await db.zadd(K.allPatients, Date.now(), patientId);

  /* 3. 写/更新专病病历（已有病历则版本+1） */
  const record = await upsertMedicalRecord(db, { input, user, patientId, gender, bmi });

  /* 4. 随访排期 + MDT 预警 */
  const prevDate = updated.nextFollowupDate;
  const nextFollowupDate = suggestFollowupDate(record.riskLevel, dateStr());
  await updatePatient(patientId, (p) => {
    p.medicalRecordId = patientId;
    p.archivedAt = Date.now();
    if (!p.nextFollowupDate) p.nextFollowupDate = nextFollowupDate;
  }, null);
  const nowDate = (await getPatient(patientId)).nextFollowupDate;
  if (prevDate && nowDate !== prevDate) await db.srem(K.followupDue(prevDate), patientId);
  await db.sadd(K.followupDue(nowDate), patientId);

  await maybeRaiseMdt(user, updated, record);

  /* 5. 新开通账号 → 站内信告知 */
  if (!accountExisted) {
    await pushMsg(uid, {
      type: 'education',
      title: '您的健康管理账号已开通',
      content: `<p>医生已为您完成脂肪肝专病建档（关联既有健康档案）。登录账号：<b>${uname}</b>，请使用初始密码登录后及时修改。</p>`,
      from: '系统'
    });
  }

  await addArchiveEntry(patientId, {
    kind: 'archive', type: 'medical_record',
    title: `脂肪肝专病建档（v${record.version} · 关联${dimension === 'idCard' ? '身份证' : '手机号'}匹配档案）`,
    summary: `风险分层：${record.riskLevel === 'high' ? '高' : record.riskLevel === 'mid' ? '中' : '低'}风险（评分${record.riskScore}）；建档医生：${user.name}；${accountExisted ? '复用既有账号' : '新开通登录账号'}`,
    by: user.name
  });
  await audit('registry.bind', { operator: user.uid, patient_id: patientId, dimension, accountExisted, risk: record.riskLevel });
  await track('registry_create', { doc_id: user.uid, patient_id: patientId, risk: record.riskLevel, matched: true });
  logger.info('registry.bind', { patientId, dimension, accountExisted, docId: user.uid });

  return {
    patientId,
    userId: uid,
    username: uname,
    accountExisted,
    version: record.version,
    riskLevel: record.riskLevel,
    riskScore: stratOf(record).score,
    nextFollowupDate: nowDate,
    followupAutoSet: !prevDate,
    completeness: recordCompleteness(record),
    modelSuggestion: stratOf(record),
    matched: true,
    matchedBy: dimension
  };
}

/** 写/更新专病病历（新建 v1；已有则白名单覆盖 + 版本+1） */
async function upsertMedicalRecord(db, { input, user, patientId, gender, bmi }) {
  const prevRaw = await db.get(K.medrec(patientId));
  let prev = null;
  if (prevRaw) { try { prev = typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw; } catch { prev = null; } }

  const record = {
    patientId, createdBy: prev ? prev.createdBy : user.uid, createdByName: prev ? prev.createdByName : user.name,
    createdAt: prev ? prev.createdAt : Date.now(), updatedAt: Date.now(), version: prev ? (Number(prev.version) || 0) + 1 : 1
  };
  for (const key of MEDICAL_RECORD_KEYS) {
    if (input[key] !== undefined) record[key] = input[key];
  }
  record.gender = gender; // 输入缺失时由身份证解析补全
  record.bmi = bmi;
  const strat = riskStratify(record);
  record.riskLevel = input.riskLevel;
  record.riskScore = strat.score;
  record.riskModelReasons = strat.reasons;
  record.riskStratifiedAt = Date.now();
  record.riskStratifiedBy = user.name;
  await db.set(K.medrec(patientId), JSON.stringify(record));
  return record;
}

function stratOf(record) {
  return { risk: record.riskLevel, score: record.riskScore, reasons: record.riskModelReasons || [] };
}

/** 高风险 → MDT 预警（幂等） */
async function maybeRaiseMdt(user, patient, record) {
  if (record.riskLevel !== 'high') return;
  await raiseAlert({
    docId: user.uid,
    patientId: patient.id,
    patientName: patient.name,
    level: 'high',
    type: 'high_risk_no_mdt',
    title: `高风险患者建议 MDT 会诊：${patient.name}`,
    content: `一站式建档风险分层为高危（评分 ${record.riskScore}）。建议发起营养科/内分泌科多学科会诊。依据：${(record.riskReason || (record.riskModelReasons || []).join('；')).slice(0, 150)}`,
    link: `/patients/${patient.id}`
  });
}

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async (ctx) => {
    if (ctx.req.method === 'GET') return listArchives(ctx);
    if (ctx.req.method === 'POST') return createRegistry(ctx);
    throw new ApiError(405, 40500, '不支持的请求方法');
  }
});
