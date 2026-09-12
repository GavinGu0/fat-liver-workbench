<template>
  <div v-loading="!isNew && loadingRecord && !patient.id" element-loading-text="正在加载患者档案…">
    <!-- 顶部：返回 + 模式/患者概要 -->
    <div class="page-card mb-12">
      <div class="top-row">
        <el-button text type="primary" @click="$router.push('/registry')">
          <el-icon style="margin-right:4px"><ArrowLeft /></el-icon>档案列表
        </el-button>
        <template v-if="isNew">
          <el-tag effect="light">一站式新建</el-tag>
          <span class="top-hint">为患者完成专病建档并开通院外自助记录账号，保存后自动按风险周期排期随访</span>
        </template>
        <template v-else-if="loadingRecord && !patient.id">
          <span class="top-hint">正在加载患者档案…</span>
        </template>
        <template v-else-if="patient.id">
          <RiskTag :risk="patient.risk" />
          <el-tag v-if="record" size="small" type="success">已建档 v{{ record.version }}</el-tag>
          <el-tag v-else size="small" type="info">未建档</el-tag>
          <span v-if="record" class="top-hint">更新于 {{ fmtTime(record.updatedAt) }} · 建档医生 {{ record.createdByName }}</span>
        </template>
      </div>
      <el-descriptions v-if="!isNew && patient.id" :column="4" size="small" style="margin-top:10px">
        <el-descriptions-item label="姓名">{{ patient.name }}</el-descriptions-item>
        <el-descriptions-item label="性别/年龄">{{ patient.gender === 'male' ? '男' : '女' }} / {{ patient.age }}岁</el-descriptions-item>
        <el-descriptions-item label="身高/体重">{{ patient.height || '-' }}cm / {{ patient.weight || '-' }}kg</el-descriptions-item>
        <el-descriptions-item label="BMI">{{ patient.bmi ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="联系电话">{{ patient.phone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="主管医生">{{ patient.docId === auth.user?.uid ? '本人' : (patient.docId || '-') }}</el-descriptions-item>
        <el-descriptions-item label="下次随访">{{ patient.nextFollowupDate || '未排期' }}</el-descriptions-item>
        <el-descriptions-item label="主诊断">{{ patient.mainDiagnosis || '-' }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <!-- 建档表单 -->
    <template v-if="showForm">
      <!-- 模型建议条（新模式下有输入后才展示） -->
      <el-alert v-if="!isNew || hasInput" type="info" :closable="false" class="mb-12">
        <div class="suggest-row">
          <span>模型建议：<b>{{ riskLabel(modelSuggestion.risk) }}</b>（评分 {{ modelSuggestion.score }}）</span>
          <el-button size="small" type="primary" plain @click="applySuggestion">采用模型建议</el-button>
          <span class="top-hint">{{ modelSuggestion.reasons.slice(0, 4).join('；') }}</span>
        </div>
      </el-alert>

      <div class="body-row">
        <!-- 左侧锚点导航（分节完成度） -->
        <div class="anchor-nav">
          <div class="anchor-title">建档目录</div>
          <div
            v-for="sec in anchorList" :key="sec.key"
            class="anchor-item" :class="{ current: currentSection === sec.key }"
            @click="scrollTo(sec.key)"
          >
            <span class="dot" :class="dotClass(sec)" />
            <span class="anchor-text">{{ shortTitle(sec) }}</span>
          </div>
        </div>

        <!-- 表单主体 -->
        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="form-main" @submit.prevent>
          <!-- 一站式：开通患者登录账号 -->
          <div v-if="isNew" :ref="el => setSectionRef('account', el)" class="page-card mb-12 sec-card">
            <h4 class="sec-title">开通患者登录账号</h4>
            <el-alert type="info" :closable="false" style="margin-bottom:12px">
              建档同时为患者开通院外自助记录账号（饮食/运动/指标填报），初始密码仅保存时可见，请交付患者。
            </el-alert>
            <div class="form-grid">
              <div class="form-field">
                <el-form-item prop="username" label="登录用户名">
                  <el-input v-model="form.username" maxlength="30" placeholder="3-30位，字母/数字/下划线/@/." />
                </el-form-item>
              </div>
              <div class="form-field">
                <el-form-item prop="initialPassword" label="初始密码">
                  <el-input v-model="form.initialPassword" :type="showPwd ? 'text' : 'password'" maxlength="64" placeholder="至少8位">
                    <template #append>
                      <span class="pwd-actions">
                        <el-button @click="genPassword">随机生成</el-button>
                        <el-button @click="showPwd = !showPwd">{{ showPwd ? '隐藏' : '显示' }}</el-button>
                      </span>
                    </template>
                  </el-input>
                </el-form-item>
              </div>
            </div>
          </div>

          <!-- 七大病历分区 -->
          <div
            v-for="sec in MEDICAL_RECORD_SECTIONS" :key="sec.key"
            :ref="el => setSectionRef(sec.key, el)" class="page-card mb-12 sec-card"
          >
            <h4 class="sec-title">{{ sec.title }}</h4>
            <div class="form-grid">
              <template v-for="f in sec.fields" :key="f.key">
                <div v-if="!f.group" class="form-field" :class="{ 'span-2': f.type === 'textarea' }">
                  <el-form-item :prop="f.key">
                    <template #label>
                      <span class="field-label">{{ f.label }}</span>
                      <span v-if="f.auto" class="auto-tag">自动计算</span>
                      <span v-if="f.key === 'birthDate' && agePreview != null" class="age-tag">{{ agePreview }}岁</span>
                    </template>

                    <!-- 只读自动字段（BMI） -->
                    <el-input v-if="f.type === 'number' && f.auto" :model-value="bmiPreview ?? ''" readonly placeholder="填写身高体重后自动计算" />

                    <!-- 数字（医学范围硬校验） -->
                    <el-input-number
                      v-else-if="f.type === 'number'"
                      v-model="form[f.key]"
                      :min="rangeOf(f).min" :max="rangeOf(f).max" :step="stepOf(f)"
                      controls-position="right" placeholder="未测" style="width:100%"
                    />

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
                    <el-input v-else v-model="form[f.key]" :maxlength="f.maxLen" :placeholder="f.key === 'idCard' ? '填写后自动带出出生日期与性别' : ''" />
                  </el-form-item>
                </div>
              </template>
            </div>

            <!-- 辅助检查：检验 14 项按 group 分组 -->
            <template v-for="(g, gi) in labGroupsOf(sec)" :key="gi">
              <div class="lab-group-title">{{ g.group }}</div>
              <div class="form-grid">
                <div v-for="f in g.fields" :key="f.key" class="form-field">
                  <el-form-item :prop="f.key">
                    <template #label>
                      <span class="field-label">{{ f.label }}</span>
                      <span v-if="isAbnormal(f)" class="abnormal-tag">超出参考</span>
                    </template>
                    <el-input-number
                      v-model="form[f.key]" :min="rangeOf(f).min" :max="rangeOf(f).max" :step="stepOf(f)"
                      controls-position="right" placeholder="未测" style="width:100%" :class="{ 'is-abnormal': isAbnormal(f) }"
                    />
                    <div class="range-hint">参考 {{ refOf(f)[0] }}–{{ refOf(f)[1] }} · 合理 {{ rangeOf(f).min }}–{{ rangeOf(f).max }}</div>
                  </el-form-item>
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
            <span v-if="dirty" class="dirty-hint">有未保存的修改</span>
            <el-button @click="resetForm">清空重填</el-button>
            <el-button type="primary" size="large" :loading="saving" @click="save">
              {{ isNew ? '保存并完成建档' : '保存专病档案' }}
            </el-button>
          </div>
        </el-form>
      </div>
    </template>

    <!-- 一站式建档成功弹窗 -->
    <el-dialog v-model="createdVisible" title="建档成功" width="480px" :close-on-click-modal="false">
      <el-result icon="success" :title="`已为 ${createdInfo.name} 建立专病档案`"
        :sub-title="`${riskLabel(createdInfo.riskLevel)}（评分 ${createdInfo.riskScore}）· 已自动排期随访 ${createdInfo.nextFollowupDate}`" />
      <div class="cred-card">
        <div class="cred-row"><span>登录用户名</span><b>{{ createdInfo.username }}</b></div>
        <div class="cred-row"><span>初始密码</span><b class="cred-pwd">{{ createdInfo.password }}</b></div>
        <div class="cred-tip">仅此一次显示，请立即复制并交付患者；建议患者首次登录后修改密码。</div>
        <el-button size="small" type="primary" plain @click="copyCreated">复制账号信息</el-button>
      </div>
      <template #footer>
        <el-button @click="createdVisible = false">留在本页</el-button>
        <el-button type="primary" @click="$router.push(`/patients/${createdInfo.patientId}`)">进入患者详情</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onActivated, onBeforeUnmount } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft } from '@element-plus/icons-vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmtTime, todayStr } from '../utils/format';
import { hashPassword } from '../utils/crypto';
import RiskTag from '../components/RiskTag.vue';
import {
  MEDICAL_RECORD_SECTIONS, MED_RANGES, LAB_FIELDS_BY_KEY, calcBmi,
  riskStratify, RISK_LABELS, validateIdCard, parseIdCard, calcAge
} from '@flwb/shared';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const pid = ref(route.query.patientId || '');
const patient = reactive({ id: '' });
const record = ref(null);
const serverSuggestion = ref(null);
const saving = ref(false);
const loadingRecord = ref(false);
const formRef = ref(null);
const showPwd = ref(false);
const currentSection = ref('');
const createdVisible = ref(false);
const createdInfo = ref({ patientId: '', username: '', password: '', name: '', riskLevel: '', riskScore: 0, nextFollowupDate: '' });

const isNew = computed(() => route.query.mode === 'new');
const showForm = computed(() => isNew.value || !!patient.id);
const riskLabel = (r) => RISK_LABELS[r] || '未评估';

/* 表单值容器（白名单 key + 一站式账号字段） */
const form = reactive({});
function initForm() {
  for (const sec of MEDICAL_RECORD_SECTIONS) {
    for (const f of sec.fields) form[f.key] = f.type === 'number' ? undefined : '';
  }
  form.username = '';
  form.initialPassword = '';
}
initForm();

/* 未保存离开提醒：快照对比 */
let snapshot = '';
const dirty = computed(() => snapshot !== JSON.stringify(form));
function takeSnapshot() { snapshot = JSON.stringify(form); }

/* 锚点导航 */
const anchorList = computed(() => {
  const base = [{ key: 'account', title: '开通患者登录账号' }];
  return isNew.value ? [...base, ...MEDICAL_RECORD_SECTIONS] : [...MEDICAL_RECORD_SECTIONS];
});
const sectionRefs = {};
function setSectionRef(key, el) { if (el) sectionRefs[key] = el; }
function scrollTo(key) {
  currentSection.value = key;
  sectionRefs[key] && sectionRefs[key].scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function shortTitle(sec) {
  const idx = sec.title.match(/^[一二三四五六七]、/);
  return idx ? sec.title.replace(/^[一二三四五六七]、/, '') : sec.title;
}
function hasVal(v) { return v !== undefined && v !== null && v !== ''; }
function sectionDone(sec) {
  if (sec.key === 'account') {
    return hasVal(form.username) && hasVal(form.initialPassword) ? 'done' : (hasVal(form.username) || hasVal(form.initialPassword)) ? 'half' : 'todo';
  }
  let reqTotal = 0, reqFilled = 0, filled = 0;
  for (const f of sec.fields) {
    if (hasVal(form[f.key])) filled++;
    if (f.required) { reqTotal++; if (hasVal(form[f.key])) reqFilled++; }
  }
  if (reqTotal > 0 && reqFilled < reqTotal) return filled > 0 ? 'half' : 'todo';
  return filled > 0 ? 'done' : 'todo';
}
function dotClass(sec) { return { done: 'dot-done', half: 'dot-half', todo: 'dot-todo' }[sectionDone(sec)]; }

/* 滚动高亮当前分节 */
function onScroll() {
  let cur = '';
  for (const sec of anchorList.value) {
    const el = sectionRefs[sec.key];
    if (el && el.getBoundingClientRect().top < 120) cur = sec.key;
  }
  if (cur) currentSection.value = cur;
}

/* 校验规则：由 MEDICAL_RECORD_SECTIONS 派生 + 身份证/手机号/账号专项 */
const rules = computed(() => {
  const r = {};
  const triggerOf = (t) => ['select', 'yesno', 'date'].includes(t) ? 'change' : 'blur';
  for (const sec of MEDICAL_RECORD_SECTIONS) {
    for (const f of sec.fields) {
      if (f.required) r[f.key] = [{ required: true, message: `请填写${f.label.split('（')[0]}`, trigger: triggerOf(f.type) }];
    }
  }
  r.idCard = [{
    validator: (ru, v, cb) => { if (!v) return cb(); const res = validateIdCard(v); return res.ok ? cb() : cb(new Error(res.msg)); },
    trigger: 'blur'
  }];
  r.phone = [{ pattern: /^1\d{10}$/, message: '联系电话格式不正确', trigger: 'blur' }];
  if (isNew.value) {
    r.username = [
      { required: true, message: '请填写登录用户名', trigger: 'blur' },
      { pattern: /^[A-Za-z0-9_@.]{3,30}$/, message: '3-30位，仅字母/数字/下划线/@/.', trigger: 'blur' }
    ];
    r.initialPassword = [
      { required: true, message: '请填写初始密码', trigger: 'blur' },
      { min: 8, message: '初始密码至少8位', trigger: 'blur' }
    ];
  }
  return r;
});

/* 身份证智能填充：合法 18 位 → 自动带出出生日期与性别（仅填充空字段） */
watch(() => form.idCard, (v) => {
  const s = String(v || '').trim();
  if (s.length < 15 || !validateIdCard(s).ok) return;
  const parsed = parseIdCard(s);
  if (!parsed) return;
  const filled = [];
  if (!form.birthDate) { form.birthDate = parsed.birthDate; filled.push('出生日期'); }
  if (!form.gender) { form.gender = parsed.gender; filled.push('性别'); }
  if (filled.length) ElMessage.success(`已根据身份证号自动带出${filled.join('、')}`);
});

/* 年龄自动计算预览 */
const agePreview = computed(() => calcAge(form.birthDate));

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

/* 随机初始密码（含大小写数字，去除易混淆字符） */
function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(10);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 0xffffffff);
  let pwd = '';
  for (let i = 0; i < 10; i++) pwd += chars[arr[i] % chars.length];
  form.initialPassword = pwd;
  showPwd.value = true;
}

/* 载入指定患者档案（编辑上下文只能由列表页路由带入，不再提供患者下拉选择） */
async function loadFor(val) {
  if (!val) return;
  loadingRecord.value = true;
  try {
    const d = await api.medicalRecord(val);
    Object.keys(patient).forEach(k => delete patient[k]);
    Object.assign(patient, d.patient || {});
    patient.id = val;
    record.value = d.record;
    serverSuggestion.value = d.suggestion;
    fillForm();
  } catch (e) {
    ElMessage.error(e.message || '档案加载失败');
    router.replace('/registry');
  } finally {
    loadingRecord.value = false;
  }
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
  takeSnapshot();
}

/* 一站式新建初始化：就诊/检验日期默认今天 */
function initForNew() {
  initForm();
  form.visitDate = todayStr();
  form.labExamDate = todayStr();
  Object.keys(patient).forEach(k => delete patient[k]);
  patient.id = '';
  record.value = null;
  serverSuggestion.value = null;
  takeSnapshot();
}

function resetForm() {
  ElMessageBox.confirm('确认清空当前填写内容？', '提示', { type: 'warning' })
    .then(() => { isNew.value ? initForNew() : fillForm(); })
    .catch(() => {});
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); ElMessage.success('已复制到剪贴板'); }
  catch { ElMessage.warning('复制失败，请手动选择复制'); }
}
function copyCreated() {
  copyText(`脂肪肝专病管理平台\n登录用户名：${createdInfo.value.username}\n初始密码：${createdInfo.value.password}`);
}

/* 保存后完整度提醒：缺少关键信息或检验时提示医生（不阻断，档案已生效） */
function warnIncomplete(completeness) {
  if (!completeness || completeness.complete) return;
  ElMessage({
    message: `档案已保存，但缺少关键信息或检验：${completeness.missing.map(m => m.label).join('、')}`,
    type: 'warning',
    duration: 6000,
    showClose: true
  });
}

async function save() {
  let valid = true;
  try { await formRef.value.validate(); } catch { valid = false; }
  if (!valid) {
    ElMessage.warning('请先完善标红的必填/错误字段');
    await nextTick();
    document.querySelector('.el-form-item.is-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  saving.value = true;
  try {
    if (isNew.value) {
      const payload = { ...form, username: form.username.trim(), initialPasswordHash: await hashPassword(form.initialPassword) };
      delete payload.initialPassword;
      const d = await api.createRegistry(payload);
      createdInfo.value = {
        patientId: d.patientId, username: d.username, password: form.initialPassword,
        name: form.name, riskLevel: d.riskLevel, riskScore: d.riskScore, nextFollowupDate: d.nextFollowupDate
      };
      createdVisible.value = true;
      // 切换到编辑模式（更新 URL，防止刷新重复提交），路由监听会自动加载新档案
      router.replace({ path: '/medical-records', query: { patientId: d.patientId } });
      ElMessage.success(`建档完成，已按风险周期自动排期随访：${d.nextFollowupDate}`);
      warnIncomplete(d.completeness);
    } else {
      const payload = { ...form, patientId: pid.value, version: record.value ? record.value.version : undefined };
      const d = await api.saveMedicalRecord(payload);
      ElMessage.success(`档案已保存（v${d.version}）${d.followupAutoSet ? `，已按风险周期自动排期随访：${d.nextFollowupDate}` : ''}`);
      warnIncomplete(d.completeness);
      await loadFor(pid.value);
    }
  } catch (e) {
    if (e.code === 40903) {
      ElMessageBox.confirm('档案已被他人修改，是否加载最新版本？（您填写的内容将丢失）', '版本冲突', { type: 'warning' })
        .then(() => loadFor(pid.value))
        .catch(() => {});
    } else if (e.code === 40901) {
      ElMessage.error(e.message);
    } else ElMessage.error(e.message);
  } finally { saving.value = false; }
}

/* 路由与生命周期 */
watch(() => route.query.mode, (v) => { if (v === 'new') initForNew(); });
watch(() => route.query.patientId, (v) => {
  if (v && v !== pid.value) { pid.value = v; loadFor(v); }
  else if (!v && !isNew.value) router.replace('/registry'); // 同路由裸访问兜底：无患者上下文回列表页
});

onBeforeRouteLeave(async (to, from) => {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('当前建档内容尚未保存，离开后填写内容将丢失。', '未保存提醒', {
      type: 'warning', confirmButtonText: '仍要离开', cancelButtonText: '继续填写'
    });
    return true;
  } catch { return false; }
});

function onBeforeUnload(e) {
  if (dirty.value) { e.preventDefault(); e.returnValue = ''; }
}
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('scroll', onScroll, true);
  if (isNew.value) initForNew();
  else if (pid.value) loadFor(pid.value);
  else router.replace('/registry'); // 组件级兜底：无新建/患者上下文时回列表页（双保险，路由守卫之外）
});
onActivated(() => {
  if (!isNew.value && pid.value && !record.value) loadFor(pid.value);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('scroll', onScroll, true);
});
</script>

<style scoped>
.top-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.top-hint { color: #86909c; font-size: 12px; }
.suggest-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.body-row { display: flex; gap: 12px; align-items: flex-start; }

/* 锚点导航 */
.anchor-nav {
  width: 172px; flex-shrink: 0; position: sticky; top: 12px;
  background: #fff; border-radius: 8px; padding: 10px 8px;
}
.anchor-title { font-size: 12px; color: #86909c; padding: 2px 10px 8px; }
.anchor-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-radius: 6px; cursor: pointer; font-size: 13px; color: #4e5969; line-height: 1.35;
}
.anchor-item:hover { background: #f7f8fa; }
.anchor-item.current { background: #e8f1fd; color: #1668dc; font-weight: 600; }
.anchor-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot-done { background: #67c23a; }
.dot-half { background: #e6a23c; }
.dot-todo { background: #e5e6eb; }

/* 表单 */
.form-main { flex: 1; min-width: 0; }
.sec-card { scroll-margin-top: 12px; }
.sec-title { margin: 0 0 12px; padding-left: 8px; border-left: 3px solid #1668dc; }
.form-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 16px; }
.form-field { display: flex; flex-direction: column; }
.form-field.span-2 { grid-column: span 2; }
.form-field :deep(.el-form-item) { margin-bottom: 10px; width: 100%; }
.form-field :deep(.el-form-item__label) { padding-bottom: 2px; line-height: 1.4; }
.field-label { font-size: 13px; color: #4e5969; }
.auto-tag { color: #86909c; font-size: 11px; margin-left: 6px; }
.age-tag { color: #1668dc; font-size: 11px; margin-left: 6px; }
.abnormal-tag { color: #f56c6c; font-size: 11px; margin-left: 6px; }
.range-hint { font-size: 11px; color: #86909c; width: 100%; }
.lab-group-title { font-size: 13px; font-weight: 600; color: #1d2129; margin: 14px 0 8px; }
.form-field :deep(.el-input-number.is-abnormal .el-input__wrapper) { box-shadow: 0 0 0 1px #f56c6c inset; }
.form-field :deep(.el-input-number.is-abnormal .el-input__inner) { color: #f56c6c; }

/* 密码框 append 双按钮：覆盖 EP 默认 flex:1 / margin:0 -20px，避免两按钮相互重叠 */
.pwd-actions { display: inline-flex; align-items: center; }
.pwd-actions :deep(.el-button) { flex: none; margin: 0; }
.pwd-actions :deep(.el-button + .el-button) { margin-left: 8px; }

.save-bar {
  position: sticky; bottom: 0; display: flex; justify-content: flex-end; align-items: center; gap: 10px;
  padding: 12px; background: #fff; border-top: 1px solid #e5e6eb; border-radius: 8px; z-index: 5;
}
.dirty-hint { margin-right: auto; color: #e6a23c; font-size: 12px; }

/* 建档成功弹窗 */
.cred-card {
  margin: -12px 24px 8px; padding: 14px; border-radius: 8px;
  background: #f7f8fa; border: 1px dashed #e5e6eb;
}
.cred-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 14px; }
.cred-row span { color: #86909c; }
.cred-pwd { letter-spacing: 1px; }
.cred-tip { font-size: 12px; color: #e6a23c; margin: 6px 0 10px; }

@media (max-width: 1200px) {
  .form-grid { grid-template-columns: repeat(2, 1fr); }
  .anchor-nav { display: none; }
}
</style>
