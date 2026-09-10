'use strict';
/** zod 全量白名单校验 + 医学范围校验映射为 422 */
const { z } = require('zod');
const { ApiError } = require('./response');
const {
  MEALS, EXERCISE_TYPES, INTENSITIES, GUIDANCE_METHODS, GUIDANCE_CATEGORIES, MED_RANGES, LAB_FIELDS
} = require('@flwb/shared');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm');

const numInRange = (key) => {
  const r = MED_RANGES[key];
  return z.number({ invalid_type_error: `${r.label}必须为数字` })
    .min(r.min, `${r.label}超出合理范围(${r.min}-${r.max}${r.unit})`)
    .max(r.max, `${r.label}超出合理范围(${r.min}-${r.max}${r.unit})`);
};

const dietSchema = z.object({
  meal: z.enum(MEALS.map(m => m.value), { errorMap: () => ({ message: '用餐时段不合法' }) }),
  recordDate: dateStr,
  recordTime: timeStr.optional(),
  foods: z.array(z.object({
    name: z.string().trim().min(1, '食物名称不能为空').max(50),
    grams: z.number({ invalid_type_error: '估算量必须为数字' }).min(1, '估算量至少1克').max(5000, '估算量不能超过5000克')
  })).min(1, '至少记录一种食物').max(20),
  photoUrl: z.string().max(1024 * 1024).optional().nullable(),
  note: z.string().max(200).optional().nullable()
});

const exerciseSchema = z.object({
  type: z.string().refine(v => EXERCISE_TYPES.includes(v), '运动类型不合法'),
  recordDate: dateStr,
  recordTime: timeStr.optional(),
  minutes: z.number({ invalid_type_error: '时长必须为数字' }).int('时长必须为整数').min(1, '时长至少1分钟').max(600, '单次时长不能超过600分钟'),
  intensity: z.enum(INTENSITIES.map(i => i.value), { errorMap: () => ({ message: '强度不合法' }) }),
  note: z.string().max(200).optional().nullable()
});

const vitalsSchema = z.object({
  recordDate: dateStr,
  weight: numInRange('weight').optional().nullable(),
  height: numInRange('height').optional().nullable(),
  waist: numInRange('waist').optional().nullable(),
  sbp: numInRange('sbp').optional().nullable(),
  dbp: numInRange('dbp').optional().nullable(),
  glucose: numInRange('glucose').optional().nullable()
}).superRefine((val, ctx) => {
  const hasAny = ['weight', 'height', 'waist', 'sbp', 'dbp', 'glucose'].some(k => val[k] !== null && val[k] !== undefined);
  if (!hasAny) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少填写一项指标' });
  if (val.sbp != null && val.dbp != null && Number(val.sbp) <= Number(val.dbp)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '收缩压应大于舒张压' });
  }
});

/**
 * 辅助检查（检验）录入：14项检验指标（LAB_FIELDS 派生）+ 检查日期 + 备注。
 * superRefine 保证至少填写一项；各指标硬校验医学合理范围（MED_RANGES）。
 */
const labsShape = { examDate: dateStr, note: z.string().max(200).optional().nullable() };
for (const f of LAB_FIELDS) {
  labsShape[f.key] = numInRange(f.key).optional().nullable();
}
const labsSchema = z.object(labsShape).superRefine((val, ctx) => {
  const hasAny = LAB_FIELDS.some(f => val[f.key] !== null && val[f.key] !== undefined);
  if (!hasAny) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少填写一项检验指标' });
});

const followupSchema = z.object({
  date: dateStr,
  note: z.string().max(200).optional().nullable(),
  version: z.number().int().optional()
});

const batchFollowupSchema = z.object({
  patientIds: z.array(z.string()).min(1, '请选择患者').max(100),
  date: dateStr,
  note: z.string().max(200).optional().nullable()
});

const revisitSchema = z.object({
  date: dateStr,
  place: z.string().trim().min(1, '请填写复诊地点').max(100),
  notes: z.string().max(300).optional().nullable(),
  version: z.number().int().optional()
});

const mdtInitiateSchema = z.object({
  action: z.literal('initiate'),
  reason: z.string().trim().min(5, '会诊理由至少5个字').max(500),
  specialists: z.array(z.object({
    dept: z.string().min(1).max(20),
    expert: z.string().min(1).max(30)
  })).min(1, '请至少邀请一位专家').max(5)
});
const mdtFeedbackSchema = z.object({
  action: z.literal('feedback'),
  mdtId: z.string().min(1),
  dept: z.string().min(1).max(20),
  expert: z.string().min(1).max(30),
  opinion: z.string().trim().min(5, '反馈意见至少5个字').max(2000)
});
const mdtArchiveSchema = z.object({
  action: z.literal('archive'),
  mdtId: z.string().min(1),
  conclusion: z.string().trim().min(5, '会诊结论至少5个字').max(2000)
});
const mdtSchema = z.discriminatedUnion('action', [mdtInitiateSchema, mdtFeedbackSchema, mdtArchiveSchema]);

const educationPushSchema = z.object({
  patientIds: z.array(z.string()).min(1, '请选择患者').max(50),
  materialId: z.string().min(1, '请选择宣教素材'),
  note: z.string().max(200).optional().nullable()
});

const guidanceSchema = z.object({
  patientId: z.string().min(1, '请选择患者'),
  method: z.enum(GUIDANCE_METHODS, { errorMap: () => ({ message: '指导方式不合法' }) }),
  category: z.enum(GUIDANCE_CATEGORIES, { errorMap: () => ({ message: '指导分类不合法' }) }),
  content: z.string().trim().min(5, '指导内容至少5个字').max(1000),
  feedback: z.string().max(500).optional().nullable()
});

const assessmentSubmitSchema = z.object({
  patientId: z.string().min(1, '请选择患者'),
  templateId: z.string().min(1).optional(),
  answers: z.record(z.any())
});

const uploadSchema = z.object({
  filename: z.string().min(1).max(200),
  dataUrl: z.string().min(20).max(7 * 1024 * 1024, '文件过大（最大5MB）')
});

const loginSchema = z.object({
  mode: z.enum(['password', 'sms', 'register']),
  username: z.string().max(50).optional(),
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确').optional(),
  passwordHash: z.string().min(32).max(128).optional(),
  code: z.string().min(4).max(6).optional(),
  profile: z.object({
    name: z.string().trim().min(1, '请填写姓名').max(20),
    gender: z.enum(['male', 'female']),
    age: z.number({ invalid_type_error: '年龄必须为数字' }).int().min(1).max(120),
    height: numInRange('height'),
    weight: numInRange('weight')
  }).optional()
});

const smsSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确')
});

/** 执行校验，失败抛 422（医学校验不通过） */
function parse(schema, data) {
  const r = schema.safeParse(data || {});
  if (!r.success) {
    const first = r.error.issues && r.error.issues[0];
    throw new ApiError(422, 42200, first ? first.message : '参数校验不通过');
  }
  return r.data;
}

module.exports = {
  parse,
  dietSchema,
  exerciseSchema,
  vitalsSchema,
  labsSchema,
  followupSchema,
  batchFollowupSchema,
  revisitSchema,
  mdtSchema,
  educationPushSchema,
  guidanceSchema,
  assessmentSubmitSchema,
  uploadSchema,
  loginSchema,
  smsSchema
};
