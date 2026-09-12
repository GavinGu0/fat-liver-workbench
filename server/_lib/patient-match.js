'use strict';
/**
 * 患者唯一标识匹配服务：专病建档（医护端）与患者注册（H5端）双向数据一致
 *
 * 匹配算法（多维度优先级）：
 * 1. 身份证号（精确，18位校验码已在 schema 层验证）→ patient:index:idcard:{ID}
 * 2. 手机号（精确）→ patient:index:phone:{P}
 * 3. 姓名 + 出生日期（弱匹配，仅提示人工确认，不自动合并）
 *
 * 索引维护：建档/注册创建患者时写入；匹配命中时复用既有 patientId，
 * 避免同一自然人在系统内产生多条档案（数据一致性根因）。
 */
const { getDb, K } = require('./storage');

/** 按身份证号精确匹配（索引优先，兜底全量扫描兼容存量数据） */
async function findByIdCard(db, idCard) {
  if (!idCard) return null;
  const upper = String(idCard).toUpperCase();
  let pid = await db.get(K.patientIdxIdCard(upper));
  if (!pid) pid = await scanIndex(db, (p) => p.idCard && String(p.idCard).toUpperCase() === upper);
  if (!pid) return null;
  return loadPatient(db, pid);
}

/** 按手机号精确匹配（索引优先，兜底全量扫描兼容存量数据） */
async function findByPhone(db, phone) {
  if (!phone) return null;
  let pid = await db.get(K.patientIdxPhone(phone));
  if (!pid) pid = await scanIndex(db, (p) => p.phone === phone);
  if (!pid) return null;
  return loadPatient(db, pid);
}

/** 兜底扫描：索引缺失时遍历患者档案（上限1000条，命中即回填索引） */
async function scanIndex(db, predicate) {
  const pids = await db.zrevrange(K.allPatients, 0, 999);
  for (const pid of pids) {
    const p = await loadPatient(db, pid);
    if (p && predicate(p)) {
      try { await indexPatient(db, p); } catch { /* 回填失败不影响匹配 */ }
      return pid;
    }
  }
  return null;
}

/** 姓名+出生日期弱匹配（返回候选列表供人工确认） */
async function findCandidates(db, { name, birthDate }, limit = 5) {
  if (!name) return [];
  const pids = await db.zrevrange(K.allPatients, 0, 500);
  const out = [];
  for (const pid of pids) {
    const p = await loadPatient(db, pid);
    if (!p) continue;
    if (p.name === name && (!birthDate || !p.birthDate || p.birthDate === birthDate)) {
      out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * 多维度匹配主入口：身份证 > 手机号 > （可选）姓名+出生日期候选
 * @returns {{ matched: object|null, dimension: string|null, candidates: object[] }}
 */
async function matchPatient(db, { idCard, phone, name, birthDate, includeWeak = false }) {
  if (idCard) {
    const p = await findByIdCard(db, idCard);
    if (p) return { matched: p, dimension: 'idCard', candidates: [] };
  }
  if (phone) {
    const p = await findByPhone(db, phone);
    if (p) return { matched: p, dimension: 'phone', candidates: [] };
  }
  const candidates = includeWeak ? await findCandidates(db, { name, birthDate }) : [];
  return { matched: null, dimension: null, candidates };
}

async function loadPatient(db, pid) {
  const raw = await db.get(K.patient(pid));
  if (!raw) return null; // 索引悬空（档案已删除）视为未命中
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

/** 写入唯一标识索引（建档/注册/补齐时调用） */
async function indexPatient(db, patient) {
  if (patient.idCard) await db.set(K.patientIdxIdCard(patient.idCard), patient.id);
  if (patient.phone) await db.set(K.patientIdxPhone(patient.phone), patient.id);
}

/** 变更手机号/身份证时同步索引（旧的清除） */
async function reindexPatient(db, patient, prev = {}) {
  if (prev.phone && prev.phone !== patient.phone) await db.del(K.patientIdxPhone(prev.phone));
  if (prev.idCard && prev.idCard !== patient.idCard) await db.del(K.patientIdxIdCard(prev.idCard));
  await indexPatient(db, patient);
}

module.exports = { matchPatient, indexPatient, reindexPatient, findByIdCard, findByPhone };
