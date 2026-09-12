'use strict';
/**
 * 认证与授权：JWT 无状态鉴权（契合 Serverless）+ 可吊销 Refresh Token（存 KV）
 * 密码策略：前端 sha256(password + '::flwb::v1') 传输 → 服务端 bcrypt 存储
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createHash, randomBytes } = require('node:crypto');
const { ApiError } = require('./response');
const { getDb, K } = require('./storage');

const JWT_SECRET = process.env.JWT_SECRET || 'flwb-dev-secret-change-me-in-production';
const ACCESS_TTL_SEC = 15 * 60;          // 15min
const REFRESH_TTL_SEC = 7 * 24 * 3600;   // 7d
const CLIENT_SALT = 'flwb::v1';
const ROLE_CN = { patient: '患者', doctor: '医生', nurse: '护士' };

function clientHashOf(rawPassword) {
  return createHash('sha256').update(`${rawPassword}::${CLIENT_SALT}`).digest('hex');
}

async function hashPassword(clientHash) {
  return bcrypt.hash(clientHash, 10);
}

async function verifyPassword(clientHash, hash) {
  return bcrypt.compare(clientHash, hash);
}

function signAccess(user) {
  return jwt.sign(
    { uid: user.uid || user.id, role: user.role, name: user.name, patientId: user.patientId || null },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL_SEC }
  );
}

function verifyAccess(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    throw new ApiError(401, 40100, e.name === 'TokenExpiredError' ? '登录已过期' : '未登录或凭证无效');
  }
}

function getBearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

/** 从请求解析登录态（不校验角色） */
function authFromReq(req) {
  const token = getBearerToken(req);
  if (!token) throw new ApiError(401, 40100, '未登录');
  return verifyAccess(token);
}

const ROLE_SETS = {
  doctor: ['doctor'],
  nurse: ['nurse'],
  patient: ['patient'],
  staff: ['doctor', 'nurse'],
  // staff_or_self：登录即可通过，资源级归属在 patient-access 内强校验
  staff_or_self: ['doctor', 'nurse', 'patient'],
  any: ['doctor', 'nurse', 'patient']
};

/** RBAC 校验 */
function requireRole(user, roleKey) {
  const allowed = ROLE_SETS[roleKey] || ROLE_SETS.any;
  if (!user || !allowed.includes(user.role)) {
    throw new ApiError(403, 40300, '无权访问该资源');
  }
}

/* ---------------- Refresh Token（存 KV 可吊销 + 轮换 + 按用户索引批量吊销） ---------------- */
async function issueRefresh(user) {
  const db = await getDb();
  const uid = user.uid || user.id;
  const token = randomBytes(32).toString('hex');
  await db.set(K.refresh(token), JSON.stringify({ uid, role: user.role }), { ex: REFRESH_TTL_SEC });
  try { await db.sadd(K.refreshIdxUid(uid), token); } catch { /* 索引失败不阻塞登录 */ }
  return token;
}

async function rotateRefresh(oldToken) {
  const db = await getDb();
  const raw = await db.get(K.refresh(oldToken));
  if (!raw) throw new ApiError(401, 40100, '会话已失效，请重新登录');
  await db.del(K.refresh(oldToken));
  const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const token = randomBytes(32).toString('hex');
  await db.set(K.refresh(token), JSON.stringify(info), { ex: REFRESH_TTL_SEC });
  try {
    await db.srem(K.refreshIdxUid(info.uid), oldToken);
    await db.sadd(K.refreshIdxUid(info.uid), token);
  } catch { /* 索引维护失败不阻塞刷新 */ }
  return { info, token };
}

async function revokeRefresh(token) {
  if (!token) return;
  const db = await getDb();
  try {
    const raw = await db.get(K.refresh(token));
    if (raw) {
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (info && info.uid) await db.srem(K.refreshIdxUid(info.uid), token);
    }
  } catch { /* fallthrough */ }
  await db.del(K.refresh(token));
}

/** 批量吊销用户全部会话（密码重置后调用）：所有 Refresh Token 立即失效，Access Token 15 分钟内自然过期 */
async function revokeUserSessions(uid) {
  if (!uid) return 0;
  const db = await getDb();
  const tokens = await db.smembers(K.refreshIdxUid(uid));
  for (const t of tokens) {
    try { await db.del(K.refresh(t)); } catch { /* 继续吊销其余 */ }
  }
  await db.del(K.refreshIdxUid(uid));
  return tokens.length;
}

module.exports = {
  JWT_SECRET,
  ACCESS_TTL_SEC,
  CLIENT_SALT,
  clientHashOf,
  hashPassword,
  verifyPassword,
  signAccess,
  verifyAccess,
  getBearerToken,
  authFromReq,
  requireRole,
  issueRefresh,
  rotateRefresh,
  revokeRefresh,
  revokeUserSessions
};
