'use strict';
/**
 * 宣教推送模板管理（医护端）：
 * GET    模板列表（固定模板 + 自定义模板，含禁用项与版本数，供管理页使用）
 * POST   新建自定义模板 { title, summary, html, category, tags }
 * PUT    编辑模板 { id, ...fields } → 版本号+1 并归档历史版本；{ id, action:'toggle' } 启停切换
 * DELETE 删除自定义模板 { id }（固定模板不可删）
 * 推送统一入口仍为 /nurse/education（固定 + 已启用自定义模板合并后校验）
 */
const { randomUUID } = require('node:crypto');
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { requireRole } = require('../_lib/auth');
const { audit, track, getConfig, setConfig } = require('../_lib/services');
const { parse, MATERIAL_CATEGORIES, materialCreateSchema, materialUpdateSchema, materialDeleteSchema } = require('../_lib/validate');
const { DEFAULT_CONFIGS } = require('../_lib/seed');
const { ApiError } = require('../_lib/response');

const MAX_VERSIONS = 10;              // 每模板保留最近 10 个历史版本
const CUSTOM_KEY = 'customMaterials'; // config 存储键

const zparse = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

/** 固定模板标准化（追加管理元数据，不落库） */
function fixedMaterials() {
  return DEFAULT_CONFIGS.materials.map((m, i) => ({
    ...m,
    category: ['饮食宣教', '运动指导', '戒酒限酒'][i] || '其他',
    tags: [],
    isCustom: false,
    enabled: true,
    version: 1,
    versionCount: 1,
    updatedAt: null,
    updatedBy: null
  }));
}

async function loadCustom(db) {
  const arr = await getConfig(CUSTOM_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

async function saveCustom(db, list) {
  await setConfig(CUSTOM_KEY, list);
}

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, body, user }) => {
    requireRole(user, 'staff');
    const db = await getDb();

    /* ---------- GET：模板列表（管理视图） ---------- */
    if (req.method === 'GET') {
      const custom = await loadCustom(db);
      const materials = [...fixedMaterials(), ...custom];
      const categories = [...new Set([...MATERIAL_CATEGORIES, ...custom.map(m => m.category).filter(Boolean)])];
      const stats = {
        total: materials.length,
        custom: custom.length,
        enabled: materials.filter(m => m.enabled !== false).length,
        disabled: materials.filter(m => m.enabled === false).length
      };
      return { materials, categories, stats };
    }

    /* ---------- POST：新建 ---------- */
    if (req.method === 'POST') {
      const input = parse(materialCreateSchema, body);
      const custom = await loadCustom(db);
      if (custom.some(m => m.title === input.title)) {
        throw new ApiError(409, 40901, '已存在同名模板，请更换标题');
      }
      const now = Date.now();
      const material = {
        id: 'mat_c_' + randomUUID().replace(/-/g, '').slice(0, 12),
        title: input.title,
        summary: input.summary || '',
        html: input.html,
        category: input.category || '其他',
        tags: input.tags || [],
        isCustom: true,
        enabled: true,
        version: 1,
        versionCount: 1,
        versions: [],
        createdBy: user.uid,
        createdByName: user.name,
        createdAt: now,
        updatedAt: now,
        updatedBy: user.name
      };
      custom.unshift(material);
      await saveCustom(db, custom);
      await audit('material.create', { operator: user.uid, id: material.id, title: material.title });
      await track('material_create', { staff_id: user.uid });
      return { id: material.id, version: 1 };
    }

    /* ---------- PUT：编辑（版本+1）或启停 ---------- */
    if (req.method === 'PUT') {
      const input = parse(materialUpdateSchema, body);
      const custom = await loadCustom(db);
      const idx = custom.findIndex(m => m.id === input.id);
      if (idx < 0) throw new ApiError(404, 40400, '自定义模板不存在（固定模板不可编辑）');

      const m = custom[idx];

      // 启停切换
      if (input.action === 'toggle') {
        m.enabled = m.enabled === false;
        m.updatedAt = Date.now();
        m.updatedBy = user.name;
        custom[idx] = m;
        await saveCustom(db, custom);
        await audit('material.toggle', { operator: user.uid, id: m.id, enabled: m.enabled });
        return { id: m.id, enabled: m.enabled };
      }

      // 字段编辑：归档当前版本 → 应用新内容 → 版本号+1
      if (input.title !== m.title && custom.some(x => x.id !== m.id && x.title === input.title)) {
        throw new ApiError(409, 40901, '已存在同名模板，请更换标题');
      }
      m.versions = [
        { version: m.version, title: m.title, summary: m.summary, html: m.html, category: m.category, tags: m.tags, updatedAt: m.updatedAt, updatedBy: m.updatedBy },
        ...(m.versions || [])
      ].slice(0, MAX_VERSIONS);
      m.title = input.title;
      m.summary = input.summary || '';
      m.html = input.html;
      m.category = input.category || '其他';
      m.tags = input.tags || [];
      m.version = (m.version || 1) + 1;
      m.versionCount = m.version;
      m.updatedAt = Date.now();
      m.updatedBy = user.name;
      custom[idx] = m;
      await saveCustom(db, custom);
      await audit('material.update', { operator: user.uid, id: m.id, version: m.version });
      return { id: m.id, version: m.version, versionCount: m.version };
    }

    /* ---------- DELETE：删除（仅自定义） ---------- */
    if (req.method === 'DELETE') {
      const input = parse(materialDeleteSchema, body);
      const custom = await loadCustom(db);
      const idx = custom.findIndex(m => m.id === input.id);
      if (idx < 0) throw new ApiError(404, 40400, '自定义模板不存在（固定模板不可删除）');
      const [removed] = custom.splice(idx, 1);
      await saveCustom(db, custom);
      await audit('material.delete', { operator: user.uid, id: removed.id, title: removed.title });
      return { deleted: true, id: removed.id };
    }

    throw new ApiError(405, 40500, '不支持的请求方法');
  }
});
