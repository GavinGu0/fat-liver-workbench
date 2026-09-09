'use strict';
/** 全局配置下发：MDT 专家库 / 宣教素材元信息 / 评估模板定义 / 运动类型等 */
const { defineHandler } = require('./_lib/handler');
const { getConfig } = require('./_lib/services');
const { DEFAULT_CONFIGS } = require('./_lib/seed');
const { EXERCISE_TYPES, MED_RANGES, MDT_DEPTS, GUIDANCE_METHODS, GUIDANCE_CATEGORIES } = require('@flwb/shared');

module.exports = defineHandler({
  auth: 'any',
  fn: async () => {
    const [experts, materials, assessmentTemplate] = await Promise.all([
      getConfig('experts', DEFAULT_CONFIGS.experts),
      getConfig('materials', DEFAULT_CONFIGS.materials),
      getConfig('assessmentTemplate', DEFAULT_CONFIGS.assessmentTemplate)
    ]);
    return {
      experts,
      mdtDepts: MDT_DEPTS,
      materials: materials.map(m => ({ id: m.id, title: m.title, summary: m.summary })),
      assessmentTemplate,
      exerciseTypes: EXERCISE_TYPES,
      guidanceMethods: GUIDANCE_METHODS,
      guidanceCategories: GUIDANCE_CATEGORIES,
      medRanges: MED_RANGES
    };
  }
});
