'use strict';
/**
 * @flwb/shared — 前后端共享常量与医学数值校验规则
 * 单一数据源：前端表单提示、服务端 zod 校验均引用本包，保证契约一致。
 * UMD 双模式：CJS require（Serverless API）与 ESM import（Vite 前端）共用本文件。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const api = factory();
    module.exports = api;
    root.FLWB_SHARED = api; // 同时挂载，供 Node ESM 场景直读
  } else {
    root.FLWB_SHARED = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * 辅助检查（检验）字段定义 —— 单一数据源（结构化电子病历「六、辅助检查」）。
   * min/max 为医学合理范围（硬校验，超出即阻断提交）；
   * ref 为参考范围 [下限, 上限]，用于异常标记（超出参考范围不阻断，仅红标提示）。
   * group 用于前端分组渲染（肝功能/血糖/血脂/其他）。
   */
  const LAB_FIELDS = [
    { key: 'alt', label: 'ALT', fullName: '丙氨酸氨基转移酶', unit: 'U/L', group: '肝功能', min: 0, max: 5000, ref: [7, 40] },
    { key: 'ast', label: 'AST', fullName: '天冬氨酸氨基转移酶', unit: 'U/L', group: '肝功能', min: 0, max: 5000, ref: [13, 40] },
    { key: 'ggt', label: 'GGT', fullName: 'γ-谷氨酰转移酶', unit: 'U/L', group: '肝功能', min: 0, max: 5000, ref: [7, 50] },
    { key: 'alp', label: 'ALP', fullName: '碱性磷酸酶', unit: 'U/L', group: '肝功能', min: 0, max: 3000, ref: [35, 100] },
    { key: 'tbil', label: '总胆红素', fullName: '总胆红素', unit: 'μmol/L', group: '肝功能', min: 0, max: 500, ref: [3.4, 17.1] },
    { key: 'alb', label: '白蛋白', fullName: '白蛋白', unit: 'g/L', group: '肝功能', min: 0, max: 100, ref: [40, 55] },
    { key: 'fpg', label: '空腹血糖', fullName: '空腹血糖', unit: 'mmol/L', group: '血糖', min: 1, max: 40, ref: [3.9, 6.1] },
    { key: 'hba1c', label: '糖化血红蛋白', fullName: '糖化血红蛋白', unit: '%', group: '血糖', min: 3, max: 20, ref: [4.0, 6.0] },
    { key: 'tg', label: '甘油三酯', fullName: '甘油三酯', unit: 'mmol/L', group: '血脂', min: 0, max: 100, ref: [0.45, 1.7] },
    { key: 'tc', label: '总胆固醇', fullName: '总胆固醇', unit: 'mmol/L', group: '血脂', min: 0, max: 30, ref: [2.8, 5.2] },
    { key: 'ldl', label: 'LDL-C', fullName: '低密度脂蛋白胆固醇', unit: 'mmol/L', group: '血脂', min: 0, max: 30, ref: [0, 3.4] },
    { key: 'hdl', label: 'HDL-C', fullName: '高密度脂蛋白胆固醇', unit: 'mmol/L', group: '血脂', min: 0, max: 10, ref: [1.0, 1.6] },
    { key: 'ua', label: '尿酸', fullName: '尿酸', unit: 'μmol/L', group: '其他', min: 0, max: 2000, ref: [155, 428] },
    { key: 'plt', label: '血小板', fullName: '血小板计数', unit: '×10⁹/L', group: '其他', min: 0, max: 3000, ref: [125, 350] }
  ];
  const LAB_FIELDS_BY_KEY = Object.fromEntries(LAB_FIELDS.map(f => [f.key, f]));

  /** 医学合理范围（硬校验：超出即阻断提交）。检验部分 min/max 由 LAB_FIELDS 派生，保证单一数据源。 */
  const MED_RANGES = {
    weight: { min: 20, max: 300, unit: 'kg', label: '体重' },
    height: { min: 50, max: 250, unit: 'cm', label: '身高' },
    waist: { min: 30, max: 200, unit: 'cm', label: '腹围' },
    sbp: { min: 50, max: 300, unit: 'mmHg', label: '收缩压' },
    dbp: { min: 30, max: 200, unit: 'mmHg', label: '舒张压' },
    glucose: { min: 1, max: 40, unit: 'mmol/L', label: '空腹血糖' }
  };
  for (const f of LAB_FIELDS) {
    MED_RANGES[f.key] = { min: f.min, max: f.max, unit: f.unit, label: f.label };
  }

  /** 检验记录异常项：返回超出参考范围的字段 key 列表（前后端共用） */
  function labAbnormalKeys(record) {
    const out = [];
    for (const f of LAB_FIELDS) {
      const v = record[f.key];
      if (v === null || v === undefined || v === '') continue;
      const [lo, hi] = f.ref;
      if (Number(v) < lo || Number(v) > hi) out.push(f.key);
    }
    return out;
  }

  /** 建议关注阈值（软提醒：数据仍入库，仅提示医生/患者注意） */
  const ADVISORY = {
    sbp: { threshold: 140, label: '收缩压偏高' },
    dbp: { threshold: 90, label: '舒张压偏高' },
    glucose: { threshold: 6.1, label: '空腹血糖偏高' },
    bmi: { threshold: 28, label: 'BMI 达到肥胖标准' }
  };

  const ROLES = { PATIENT: 'patient', DOCTOR: 'doctor', NURSE: 'nurse' };
  const RISK_LEVELS = [
    { value: 'high', label: '高风险', color: '#f56c6c' },
    { value: 'mid', label: '中风险', color: '#e6a23c' },
    { value: 'low', label: '低风险', color: '#67c23a' }
  ];
  const RISK_LABELS = { high: '高风险', mid: '中风险', low: '低风险' };

  const MEALS = [
    { value: 'breakfast', label: '早餐' },
    { value: 'lunch', label: '午餐' },
    { value: 'dinner', label: '晚餐' },
    { value: 'snack', label: '加餐' }
  ];
  const MEAL_LABELS = Object.fromEntries(MEALS.map(m => [m.value, m.label]));

  const EXERCISE_TYPES = ['散步', '慢跑', '游泳', '骑行', '瑜伽', '力量训练', '球类运动', '其他'];
  const INTENSITIES = [
    { value: 'low', label: '低强度' },
    { value: 'mid', label: '中强度' },
    { value: 'high', label: '高强度' }
  ];
  const INTENSITY_LABELS = Object.fromEntries(INTENSITIES.map(i => [i.value, i.label]));

  const GUIDANCE_METHODS = ['电话', '面谈', '微信'];
  const GUIDANCE_CATEGORIES = ['饮食指导', '运动指导', '用药提醒', '心理支持', '复查督促'];
  const MDT_DEPTS = ['营养科', '内分泌科', '消化内科', '心内科', '康复科'];
  const MDT_STATUS = { PENDING: 'pending', FEEDBACK: 'feedback', DONE: 'done' };
  const MDT_STATUS_LABELS = { pending: '待专家反馈', feedback: '已反馈待归档', done: '已归档' };

  const MESSAGE_TYPES = {
    REVISIT: 'revisit_reminder',
    EDUCATION: 'education',
    FOLLOWUP: 'followup_remind'
  };

  /** 前端密码传输盐：sha256(password + '::' + CLIENT_SALT) 后传输，服务端再 bcrypt 存储 */
  const CLIENT_SALT = 'flwb::v1';

  function calcBmi(weightKg, heightCm) {
    if (!weightKg || !heightCm) return null;
    const h = heightCm / 100;
    return Math.round((weightKg / (h * h)) * 10) / 10;
  }

  /** 硬校验单个指标 @returns {{ ok: boolean, msg?: string }} */
  function checkMedicalRange(key, value) {
    const r = MED_RANGES[key];
    if (!r || value === null || value === undefined || value === '') return { ok: true };
    const v = Number(value);
    if (Number.isNaN(v)) return { ok: false, msg: `${r.label}必须为数字` };
    if (v < r.min || v > r.max) return { ok: false, msg: `${r.label}超出合理范围(${r.min}-${r.max}${r.unit})` };
    return { ok: true };
  }

  /** 软提醒（返回异常提示数组） */
  function checkAdvisory(vitals) {
    const warns = [];
    if (vitals.sbp != null && Number(vitals.sbp) >= ADVISORY.sbp.threshold) warns.push(ADVISORY.sbp.label);
    if (vitals.dbp != null && Number(vitals.dbp) >= ADVISORY.dbp.threshold) warns.push(ADVISORY.dbp.label);
    if (vitals.glucose != null && Number(vitals.glucose) >= ADVISORY.glucose.threshold) warns.push(ADVISORY.glucose.label);
    if (vitals.bmi != null && Number(vitals.bmi) >= ADVISORY.bmi.threshold) warns.push(ADVISORY.bmi.label);
    return warns;
  }

  return {
    MED_RANGES,
    LAB_FIELDS,
    LAB_FIELDS_BY_KEY,
    labAbnormalKeys,
    ADVISORY,
    ROLES,
    RISK_LEVELS,
    RISK_LABELS,
    MEALS,
    MEAL_LABELS,
    EXERCISE_TYPES,
    INTENSITIES,
    INTENSITY_LABELS,
    GUIDANCE_METHODS,
    GUIDANCE_CATEGORIES,
    MDT_DEPTS,
    MDT_STATUS,
    MDT_STATUS_LABELS,
    MESSAGE_TYPES,
    CLIENT_SALT,
    calcBmi,
    checkMedicalRange,
    checkAdvisory
  };
});
