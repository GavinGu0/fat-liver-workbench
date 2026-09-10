<template>
  <div>
    <!-- 患者选择 + 概要 -->
    <div class="page-card mb-12">
      <div class="picker-row">
        <el-select v-model="pid" filterable placeholder="搜索选择患者进行建档" style="width:280px" @change="loadFor">
          <el-option v-for="p in patientOptions" :key="p.id" :value="p.id" :label="`${p.name}（${p.gender === 'male' ? '男' : '女'} / ${p.age}岁 / ${p.bmi ?? '-'} BMI）`" />
        </el-select>
        <template v-if="patient.id">
          <RiskTag :risk="patient.risk" />
          <el-tag v-if="record" size="small" type="success">已建档 v{{ record.version }}</el-tag>
          <el-tag v-else size="small" type="info">未建档</el-tag>
          <span v-if="record" style="color:#86909c;font-size:12px">更新于 {{ fmtTime(record.updatedAt) }} · 建档医生 {{ record.createdByName }}</span>
        </template>
      </div>
      <el-descriptions v-if="patient.id" :column="4" size="small" style="margin-top:10px">
        <el-descriptions-item label="姓名">{{ patient.name }}</el-descriptions-item>
        <el-descriptions-item label="性别/年龄">{{ patient.gender === 'male' ? '男' : '女' }} / {{ patient.age }}岁</el-descriptions-item>
        <el-descriptions-item label="身高/体重">{{ patient.height || '-' }}cm / {{ patient.weight || '-' }}kg</el-descriptions-item>
        <el-descriptions-item label="BMI">{{ patient.bmi ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="联系电话">{{ patient.phone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="主管医生">{{ patient.docId === auth.user?.uid ? '本人' : (patient.docId || '-') }}</el-descriptions-item>
        <el-descriptions-item label="下次随访">{{ patient.nextFollowupDate || '未排期' }}</el-descriptions-item>
        <el-descriptions-item label="主诊断">{{ patient.mainDiagnosis || '-' }}</el-descriptions-item>
      </el-descriptions>
      <el-empty v-else description="请先选择患者" :image-size="70" />
    </div>

    <!-- 建档表单 -->
    <template v-if="patient.id">
      <!-- 模型建议条 -->
      <el-alert type="info" :closable="false" class="mb-12">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span>模型建议：<b>{{ riskLabel(modelSuggestion.risk) }}</b>（评分 {{ modelSuggestion.score }}）</span>
          <el-button size="small" type="primary" plain @click="applySuggestion">采用模型建议</el-button>
          <span style="color:#86909c;font-size:12px">{{ modelSuggestion.reasons.slice(0, 4).join('；') }}</span>
        </div>
      </el-alert>

      <div v-for="sec in MEDICAL_RECORD_SECTIONS" :key="sec.key" class="page-card mb-12">
        <h4 class="sec-title">{{ sec.title }}</h4>
        <div class="form-grid">
          <template v-for="f in sec.fields" :key="f.key">
            <div v-if="!f.group" class="form-field" :class="{ 'span-2': f.type === 'textarea' }">
              <div class="field-label">
                {{ f.label }}
                <span v-if="f.required" class="req">*</span>
                <span v-if="f.auto" class="auto-tag">自动计算</span>
              </div>

              <!-- 只读自动字段（BMI） -->
              <el-input v-if="f.type === 'number' && f.auto" :model-value="bmiPreview ?? ''" readonly placeholder="填写身高体重后自动计算" />

              <!-- 数字（医学范围硬校验） -->
              <el-input-number
                v-else-if="f.type === 'number'"
                v-model="form[f.key]"
                :min="rangeOf(f).min" :max="rangeOf(f).max" :step="stepOf(f)"
                controls-position="right" placeholder="未测" style="width:100%"
              />
              <div v-else-if="f.type === 'number'" class="range-hint">合理范围 {{ rangeOf(f).min }}–{{ rangeOf(f).max }}{{ rangeUnit(f) }}</div>

              <!-- 日期 -->
              <el-date-picker v-else-if="f.type === 'date'" v-model="form[f.key]" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width:100%" />

              <!-- 下拉 -->
              <el-select v-else-if="f.type === 'select'" v-model="form[f.key]" :placeholder="f.required ? '必填' : '未选择'" clearable style="width:100%">
                <el-option v-for="(o, i) in f.options" :key="o" :value="o" :label="(f.optionLabels && f.optionLabels[i]) || o" />
              </el-select>

              <!-- 是/否 -->
              <el-radio-group v-else-if="f.type === 'yesno'" v-model="form[f.key]">
                <el-radio-button value="是">是</el-radio-button>
                <el-radio-button value="否">否</el-radio-button>
              </el-radio-group>

              <!-- 多行文本 -->
              <el-input v-else-if="f.type === 'textarea'" v-model="form[f.key]" type="textarea" :rows="2" :maxlength="f.maxLen" show-word-limit />

              <!-- 单行文本 -->
              <el-input v-else v-model="form[f.key]" :maxlength="f.maxLen" />
            </div>
          </template>
        </div>

        <!-- 辅助检查：检验 14 项按 group 分组 -->
        <template v-for="(g, gi) in labGroupsOf(sec)" :key="gi">
          <div class="lab-group-title">{{ g.group }}</div>
          <div class="form-grid">
            <div v-for="f in g.fields" :key="f.key" class="form-field">
              <div class="field-label">
                {{ f.label }}
                <span v-if="isAbnormal(f)" class="abnormal-tag">超出参考</span>
              </div>
              <el-input-number v-model="form[f.key]" :min="rangeOf(f).min" :max="rangeOf(f).max" :step="stepOf(f)" controls-position="right" placeholder="未测" style="width:100%" :class="{ 'is-abnormal': isAbnormal(f) }" />
              <div class="range-hint">参考 {{ refOf(f)[0] }}–{{ refOf(f)[1] }} · 合理 {{ rangeOf(f).min }}–{{ rangeOf(f).max }}</div>
            </div>
          </div>
        </template>

        <!-- 分层风险评估：内嵌建议 -->
        <template v-if="sec.key === 'assessment'">
          <el-alert v-if="form.riskLevel" :type="form.riskLevel === 'high' ? 'error' : form.riskLevel === 'mid' ? 'warning' : 'success'" :closable="false" style="margin-top:10px">
            已选择{{ riskLabel(form.riskLevel) }}。保存后：风险分层同步患者档案，并按周期自动排期随访{{ form.riskLevel === 'high' ? '，高风险将触发 MDT 会诊提醒' : '' }}。
          </el-alert>
        </template>
      </div>

      <div class="save-bar">
        <el-button @click="resetForm">清空重填</el-button>
        <el-button type="primary" size="large" :loading="saving" @click="save">保存专病档案</el-button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onActivated } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmtTime } from '../utils/format';
import RiskTag from '../components/RiskTag.vue';
import {
  MEDICAL_RECORD_SECTIONS, MED_RANGES, LAB_FIELDS_BY_KEY, calcBmi,
  riskStratify, RISK_LABELS
} from '@flwb/shared';

const route = useRoute();
const auth = useAuthStore();

const pid = ref(route.query.patientId || '');
const patientOptions = ref([]);
const patient = reactive({ id: '' });
const record = ref(null);
const serverSuggestion = ref(null);
const saving = ref(false);

/* 表单值容器（白名单 key） */
const form = reactive({});
function initForm() {
  for (const sec of MEDICAL_RECORD_SECTIONS) {
    for (const f of sec.fields) {
      form[f.key] = f.type === 'number' && !f.auto ? undefined : (f.type === 'number' ? undefined : '');
    }
  }
}
initForm();

const riskLabel = (r) => RISK_LABELS[r] || '未评估';

/* BMI 预览（自动计算只读） */
const bmiPreview = computed(() => calcBmi(form.weight, form.height));

const hasInput = computed(() => ['weight', 'waist', 'alt', 'ast', 'ggt', 'fpg', 'hba1c', 'tg', 'ultrasound', 'fibroScanE'].some(k => form[k] != null && form[k] !== '')
  || ['t2dm', 'hypertension', 'dyslipidemia', 'metabolicSyndrome'].some(k => form[k] === '是'));

/* 模型建议：医生有输入时本地实时重算；否则展示服务端基于存量档案的建议 */
const modelSuggestion = computed(() => {
  const local = riskStratify({ ...form, gender: form.gender || patient.gender });
  return hasInput.value ? local : (serverSuggestion.value || local);
});

function applySuggestion() {
  form.riskLevel = modelSuggestion.value.risk;
  form.riskReason = `模型评分 ${modelSuggestion.value.score} 分：${modelSuggestion.value.reasons.slice(0, 3).join('；')}`;
}

/* 数字字段范围/步长/参考 */
function rangeOf(f) {
  if (f.range && MED_RANGES[f.range]) return { min: MED_RANGES[f.range].min, max: MED_RANGES[f.range].max };
  return { min: f.min ?? 0, max: f.max ?? 9999 };
}
function rangeUnit(f) { return (f.range && MED_RANGES[f.range] && MED_RANGES[f.range].unit) || ''; }
function stepOf(f) {
  const r = rangeOf(f);
  return Number.isInteger(r.min) && Number.isInteger(r.max) ? 1 : 0.1;
}
function refOf(f) { return (LAB_FIELDS_BY_KEY[f.key] && LAB_FIELDS_BY_KEY[f.key].ref) || [0, 9999]; }
function isAbnormal(f) {
  const v = form[f.key];
  if (v == null || v === '') return false;
  const [lo, hi] = refOf(f);
  return Number(v) < lo || Number(v) > hi;
}
function labGroupsOf(sec) {
  if (sec.key !== 'auxiliary') return [];
  const map = new Map();
  for (const f of sec.fields) {
    if (!f.group) continue;
    if (!map.has(f.group)) map.set(f.group, []);
    map.get(f.group).push(f);
  }
  return [...map.entries()].map(([group, fields]) => ({ group, fields }));
}

/* 载入患者选项与档案 */
async function loadPatients() {
  if (patientOptions.value.length) return;
  try {
    const d = await api.patients({ page: 1, size: 100 });
    patientOptions.value = d.items;
  } catch { /* 忽略 */ }
}

async function loadFor(val) {
  if (!val) return;
  try {
    const d = await api.medicalRecord(val);
    Object.keys(patient).forEach(k => delete patient[k]);
    Object.assign(patient, d.patient || {});
    patient.id = val;
    record.value = d.record;
    serverSuggestion.value = d.suggestion;
    fillForm();
  } catch (e) { ElMessage.error(e.message); }
}

/* 预填：优先存量档案 → 患者基础信息 */
function fillForm() {
  initForm();
  const src = record.value || {};
  for (const sec of MEDICAL_RECORD_SECTIONS) {
    for (const f of sec.fields) {
      const v = src[f.key];
      if (v !== undefined && v !== null) form[f.key] = v;
    }
  }
  // 患者档案补齐（仅空字段）
  const hints = { name: patient.name, gender: patient.gender, phone: patient.phone, height: patient.height, weight: patient.weight };
  for (const [k, v] of Object.entries(hints)) {
    if ((form[k] === '' || form[k] === undefined || form[k] === null) && v != null) form[k] = v;
  }
}

function resetForm() {
  ElMessageBox.confirm('确认清空当前填写内容？', '提示', { type: 'warning' }).then(() => { fillForm(); }).catch(() => {});
}

async function save() {
  if (!form.name) return ElMessage.warning('姓名不能为空');
  if (!form.riskLevel) return ElMessage.warning('请选择风险分层（可参考模型建议）');
  const payload = { ...form, patientId: pid.value, version: record.value ? record.value.version : undefined };
  saving.value = true;
  try {
    const d = await api.saveMedicalRecord(payload);
    ElMessage.success(`档案已保存（v${d.version}）${d.followupAutoSet ? `，已按风险周期自动排期随访：${d.nextFollowupDate}` : ''}`);
    await loadFor(pid.value);
  } catch (e) {
    if (e.code === 40903) {
      ElMessageBox.confirm('档案已被他人修改，是否加载最新版本？（您填写的内容将丢失）', '版本冲突', { type: 'warning' })
        .then(() => loadFor(pid.value))
        .catch(() => {});
    } else ElMessage.error(e.message);
  } finally { saving.value = false; }
}

/* 从患者详情带 patientId 跳转 / keep-alive 回来时刷新 */
watch(() => route.query.patientId, (v) => { if (v && v !== pid.value) { pid.value = v; loadFor(v); } });
onMounted(() => { loadPatients(); if (pid.value) loadFor(pid.value); });
onActivated(() => { loadPatients(); if (pid.value && !record.value) loadFor(pid.value); });
</script>

<style scoped>
.picker-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sec-title { margin: 0 0 12px; padding-left: 8px; border-left: 3px solid #1668dc; }
.form-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px 16px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-field.span-2 { grid-column: span 2; }
.field-label { font-size: 13px; color: #4e5969; }
.req { color: #f56c6c; margin-left: 2px; }
.auto-tag { color: #86909c; font-size: 11px; margin-left: 6px; }
.abnormal-tag { color: #f56c6c; font-size: 11px; margin-left: 6px; }
.range-hint { font-size: 11px; color: #86909c; }
.lab-group-title { font-size: 13px; font-weight: 600; color: #1d2129; margin: 14px 0 8px; }
.form-field :deep(.el-input-number.is-abnormal .el-input__wrapper) { box-shadow: 0 0 0 1px #f56c6c inset; }
.form-field :deep(.el-input-number.is-abnormal .el-input__inner) { color: #f56c6c; }
.save-bar { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; padding: 12px; background: #fff; border-top: 1px solid #e5e6eb; border-radius: 8px; }
@media (max-width: 1200px) { .form-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
