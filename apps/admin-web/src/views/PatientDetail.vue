<template>
  <div v-if="p.id">
    <!-- 头部信息卡 -->
    <div class="page-card mb-12">
      <div class="head">
        <el-avatar :size="52" style="background:#1668dc;font-size:20px">{{ p.name.slice(0, 1) }}</el-avatar>
        <div class="head-info">
          <div class="head-line">
            <b style="font-size:18px">{{ p.name }}</b>
            <span>{{ p.gender === 'male' ? '男' : '女' }} · {{ p.age }}岁 · ID:{{ p.id }}</span>
            <RiskTag :risk="p.risk" />
          </div>
          <div class="head-line sub">
            <span>主诊断：{{ p.mainDiagnosis }}</span>
            <span>身高 {{ p.height }}cm · 体重 {{ p.weight }}kg · BMI {{ p.bmi }}</span>
            <span v-if="p.phone">电话 {{ maskPhone(p.phone) }}</span>
          </div>
        </div>
        <div style="flex:1"></div>
        <div class="actions" v-if="auth.isDoctor">
          <el-button type="primary" plain @click="fuVisible = true"><el-icon><Calendar /></el-icon>&nbsp;设置随访</el-button>
          <el-button type="success" plain @click="rvVisible = true"><el-icon><AlarmClock /></el-icon>&nbsp;复诊计划</el-button>
          <el-button type="danger" plain @click="mdtVisible = true"><el-icon><Connection /></el-icon>&nbsp;发起MDT</el-button>
          <el-button plain @click="labVisible = true"><el-icon><DataLine /></el-icon>&nbsp;录入检验</el-button>
        </div>
        <div class="actions" v-else-if="auth.isNurse">
          <el-button type="primary" plain @click="$router.push('/education')"><el-icon><Reading /></el-icon>&nbsp;推送宣教</el-button>
          <el-button plain @click="$router.push({ path: '/guidance', query: { patientId: p.id } })">个案指导</el-button>
        </div>
      </div>
      <el-descriptions :column="3" size="small" style="margin-top:10px">
        <el-descriptions-item label="主诉">{{ p.chiefComplaint || '-' }}</el-descriptions-item>
        <el-descriptions-item label="既往史">{{ p.pastHistory || '-' }}</el-descriptions-item>
        <el-descriptions-item label="下次随访">{{ p.nextFollowupDate || '未设置' }} {{ p.followupNote || '' }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <!-- 复诊计划条 -->
    <el-alert v-if="revisit" type="warning" :closable="false" class="mb-12">
      📅 复诊计划：{{ revisit.date }} @ {{ revisit.place }}（{{ revisit.notes || '无特殊注意' }}）
      <el-button v-if="auth.isDoctor" size="small" style="margin-left:8px" @click="sendRemind">发送提醒</el-button>
    </el-alert>

    <!-- 三个Tab -->
    <div class="page-card">
      <el-tabs v-model="tab">
        <el-tab-pane label="基本信息" name="basic">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="患者ID">{{ p.id }}</el-descriptions-item>
            <el-descriptions-item label="建档时间">{{ fmtDate(p.createdAt) }}</el-descriptions-item>
            <el-descriptions-item label="最近随访">{{ fmtTime(p.lastFollowupAt) }}</el-descriptions-item>
            <el-descriptions-item label="最近活动">{{ fmtTime(p.lastActivityAt) }}</el-descriptions-item>
            <el-descriptions-item label="饮食记录">{{ counts.diet }} 条</el-descriptions-item>
            <el-descriptions-item label="运动记录">{{ counts.exercise }} 条</el-descriptions-item>
            <el-descriptions-item label="指标记录">{{ counts.vitals }} 次</el-descriptions-item>
            <el-descriptions-item label="档案版本">v{{ p.version }}（乐观锁）</el-descriptions-item>
          </el-descriptions>

          <h4>📁 健康档案（MDT归档等）</h4>
          <el-empty v-if="!archive.length" description="暂无归档记录" :image-size="60" />
          <el-timeline v-else>
            <el-timeline-item v-for="(a, i) in archive" :key="i" :timestamp="fmtTime(a.ts)" :type="a.kind === 'mdt' ? 'primary' : 'success'">
              <b>{{ a.title }}</b>
              <p style="margin:4px 0 0;color:#4e5969">{{ a.summary }}</p>
              <p style="margin:2px 0 0;color:#86909c;font-size:12px">记录人：{{ a.by }}</p>
            </el-timeline-item>
          </el-timeline>
        </el-tab-pane>

        <el-tab-pane label="自填数据" name="records">
          <div class="mb-12" style="display:flex;gap:8px">
            <el-radio-group v-model="recType" size="small" @change="reloadRecords">
              <el-radio-button v-for="t in typeOptions" :key="t.value" :value="t.value">{{ t.label }}</el-radio-button>
            </el-radio-group>
            <el-button size="small" :disabled="!recNext" @click="loadRecords(true)">加载更多</el-button>
          </div>
          <el-empty v-if="!records.length" description="暂无数据" :image-size="60" />
          <el-timeline v-else>
            <el-timeline-item v-for="(r, i) in records" :key="i" :timestamp="fmtTime(r.ts)" :type="typeColor(r.type)">
              <b>{{ typeLabel(r.type) }}</b>
              <span v-if="renderRecord(r)" style="color:#4e5969"> · {{ renderRecord(r) }}</span>
              <img v-if="r.photoUrl" :src="r.photoUrl" style="display:block;margin-top:6px;max-width:180px;border-radius:6px" />
              <p v-if="r.note" style="margin:4px 0 0;color:#86909c;font-size:12px">{{ r.note }}</p>
            </el-timeline-item>
          </el-timeline>
        </el-tab-pane>

        <el-tab-pane label="趋势分析" name="trend">
          <div class="mb-12" style="display:flex;gap:8px;align-items:center">
            <span>时间范围</span>
            <el-radio-group v-model="trendDays" size="small" @change="loadTrend">
              <el-radio-button :value="30">近30天</el-radio-button>
              <el-radio-button :value="90">近90天</el-radio-button>
              <el-radio-button :value="180">近180天</el-radio-button>
            </el-radio-group>
            <span style="color:#86909c;font-size:12px">共 {{ trend.counts.vitals }} 次指标 / {{ trend.counts.labs }} 次检验</span>
          </div>
          <el-row :gutter="12">
            <el-col :span="12"><h5>体重 / BMI</h5><TrendChart :series="chartWeight" /></el-col>
            <el-col :span="12"><h5>血压 (mmHg)</h5><TrendChart :series="chartBp" /></el-col>
            <el-col :span="12"><h5>空腹血糖 (mmol/L)</h5><TrendChart :series="chartGlucose" /></el-col>
            <el-col :span="12"><h5>肝功能 (U/L)</h5><TrendChart :series="chartLabs" /></el-col>
          </el-row>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 设置随访 -->
    <el-dialog v-model="fuVisible" title="设置随访日期" width="380px">
      <el-date-picker v-model="fuDate" type="date" value-format="YYYY-MM-DD" placeholder="随访日期" style="width:100%" />
      <el-input v-model="fuNote" placeholder="随访备注（选填）" style="margin-top:10px" />
      <template #footer>
        <el-button @click="fuVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveFollowup">保存</el-button>
      </template>
    </el-dialog>

    <!-- 复诊计划 -->
    <el-dialog v-model="rvVisible" title="设置复诊计划" width="420px">
      <el-date-picker v-model="rvForm.date" type="date" value-format="YYYY-MM-DD" placeholder="复诊日期" style="width:100%" />
      <el-input v-model="rvForm.place" placeholder="复诊地点，如：门诊楼3楼肝病诊室" style="margin-top:10px" />
      <el-input v-model="rvForm.notes" type="textarea" placeholder="注意事项，如：空腹前来" style="margin-top:10px" />
      <template #footer>
        <el-button @click="rvVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveRevisit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 发起MDT -->
    <el-dialog v-model="mdtVisible" title="发起MDT多学科会诊" width="480px">
      <el-form label-width="80px">
        <el-form-item label="会诊原因">
          <el-input v-model="mdtForm.reason" type="textarea" :rows="3" placeholder="如：进展性脂肪肝合并2型糖尿病，血糖控制不佳，请内分泌科协助" />
        </el-form-item>
        <el-form-item label="邀请专家">
          <el-checkbox-group v-model="mdtForm.specialists">
            <div v-for="e in experts" :key="e.id" style="display:block;margin-bottom:4px">
              <el-checkbox :value="e.id">{{ e.dept }} · {{ e.name }}</el-checkbox>
            </div>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mdtVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="initiateMdt">发起会诊</el-button>
      </template>
    </el-dialog>

    <!-- 录入检验 -->
    <el-dialog v-model="labVisible" title="录入肝功能检验" width="420px">
      <el-date-picker v-model="labForm.examDate" type="date" value-format="YYYY-MM-DD" placeholder="检验日期" style="width:100%" />
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
        <el-input-number v-model="labForm.alt" :min="0" :max="5000" placeholder="ALT" controls-position="right" style="width:100%" />
        <el-input-number v-model="labForm.ast" :min="0" :max="5000" placeholder="AST" controls-position="right" style="width:100%" />
        <el-input-number v-model="labForm.ggt" :min="0" :max="5000" placeholder="GGT" controls-position="right" style="width:100%" />
        <el-input-number v-model="labForm.tg" :min="0" :max="100" :step="0.1" placeholder="甘油三酯" controls-position="right" style="width:100%" />
      </div>
      <template #footer>
        <el-button @click="labVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveLab">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmtTime, fmtDate, todayStr } from '../utils/format';
import RiskTag from '../components/RiskTag.vue';
import TrendChart from '../components/TrendChart.vue';
import { MEAL_LABELS, INTENSITY_LABELS } from '@flwb/shared';

const route = useRoute();
const auth = useAuthStore();
const pid = route.params.id;

const p = reactive({ id: '' });
const revisit = ref(null);
const archive = ref([]);
const counts = reactive({ diet: 0, exercise: 0, vitals: 0 });
const tab = ref('basic');
const saving = ref(false);

/* 自填数据 */
const typeOptions = [
  { value: 'all', label: '全部' }, { value: 'diet', label: '饮食' }, { value: 'exercise', label: '运动' },
  { value: 'vitals', label: '指标' }, { value: 'guidance', label: '指导' }, { value: 'education', label: '宣教' },
  { value: 'assessment', label: '评估' }, { value: 'labs', label: '检验' }
];
const records = ref([]);
const recNext = ref(null);
const recType = ref('all');

/* 趋势 */
const trendDays = ref(90);
const trend = reactive({ points: [], labs: [], counts: { vitals: 0, labs: 0 } });

/* 弹窗 */
const fuVisible = ref(false);
const fuDate = ref(todayStr(7));
const fuNote = ref('');
const rvVisible = ref(false);
const rvForm = reactive({ date: '', place: '', notes: '' });
const mdtVisible = ref(false);
const mdtForm = reactive({ reason: '', specialists: [] });
const experts = ref([]);
const labVisible = ref(false);
const labForm = reactive({ examDate: todayStr(), alt: undefined, ast: undefined, ggt: undefined, tg: undefined });

const TYPE_MAP = {
  diet: '饮食记录', exercise: '运动记录', vitals: '随访指标', guidance: '个案指导',
  education: '健康宣教', assessment: '专病评估', labs: '肝功能检验'
};
const typeLabel = (t) => TYPE_MAP[t] || t;
const typeColor = (t) => ({ diet: 'success', exercise: 'warning', vitals: 'primary', guidance: 'danger', education: 'info', assessment: 'primary', labs: 'danger' }[t] || 'info');

function renderRecord(r) {
  switch (r.type) {
    case 'diet': return `${MEAL_LABELS[r.meal] || r.meal}：${(r.foods || []).map((f) => `${f.name}${f.grams}g`).join('、')}`;
    case 'exercise': return `${r.exType || ''} ${r.minutes ?? ''}分钟（${INTENSITY_LABELS[r.intensity] || r.intensity || ''}）`;
    case 'vitals': {
      const parts = [];
      if (r.weight != null) parts.push(`体重 ${r.weight}kg`);
      if (r.waist != null) parts.push(`腹围 ${r.waist}cm`);
      if (r.sbp != null) parts.push(`血压 ${r.sbp}/${r.dbp}`);
      if (r.glucose != null) parts.push(`血糖 ${r.glucose}`);
      if (r.bmi != null) parts.push(`BMI ${r.bmi}`);
      return parts.join('，');
    }
    case 'guidance': return `${r.category}（${r.method}）：${(r.content || '').slice(0, 40)}…`;
    case 'education': return r.title || r.materialTitle || '宣教内容';
    case 'assessment': return r.title || '评估报告';
    case 'labs': {
      const parts = [];
      if (r.alt != null) parts.push(`ALT ${r.alt}`);
      if (r.ast != null) parts.push(`AST ${r.ast}`);
      if (r.ggt != null) parts.push(`GGT ${r.ggt}`);
      if (r.tg != null) parts.push(`TG ${r.tg}`);
      return parts.join('，');
    }
    default: return '';
  }
}

function maskPhone(s) { return s ? String(s).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '-'; }

async function loadDetail() {
  const d = await api.patientDetail(pid);
  Object.assign(p, d.profile);
  revisit.value = d.revisit;
  archive.value = d.archive;
  counts.diet = d.counts.diet;
  counts.exercise = d.counts.exercise;
  counts.vitals = d.counts.vitals;
  rvForm.date = d.revisit && d.revisit.date;
  rvForm.place = d.revisit && d.revisit.place;
  rvForm.notes = d.revisit && d.revisit.notes;
}

async function loadRecords(more) {
  const types = recType.value === 'all' ? undefined : recType.value;
  const params = { types, limit: 20 };
  if (more && recNext.value) params.before = recNext.value;
  const d = await api.patientRecords(pid, params);
  records.value = more ? [...records.value, ...d.items] : d.items;
  recNext.value = d.nextBefore;
}
function reloadRecords() { loadRecords(false); }

async function loadTrend() {
  const d = await api.patientTrend(pid, { days: trendDays.value });
  trend.points = d.points;
  trend.labs = d.labs;
  trend.counts = d.counts;
}

const chartWeight = computed(() => [
  { name: '体重(kg)', data: trend.points.filter((x) => x.weight != null).map((x) => [x.ts, x.weight]) },
  { name: 'BMI', data: trend.points.filter((x) => x.bmi != null).map((x) => [x.ts, x.bmi]) }
]);
const chartBp = computed(() => [
  { name: '收缩压', data: trend.points.filter((x) => x.sbp != null).map((x) => [x.ts, x.sbp]) },
  { name: '舒张压', data: trend.points.filter((x) => x.dbp != null).map((x) => [x.ts, x.dbp]) }
]);
const chartGlucose = computed(() => [
  { name: '空腹血糖', data: trend.points.filter((x) => x.glucose != null).map((x) => [x.ts, x.glucose]) }
]);
const chartLabs = computed(() => [
  { name: 'ALT', data: trend.labs.filter((x) => x.alt != null).map((x) => [x.ts, x.alt]) },
  { name: 'AST', data: trend.labs.filter((x) => x.ast != null).map((x) => [x.ts, x.ast]) },
  { name: 'GGT', data: trend.labs.filter((x) => x.ggt != null).map((x) => [x.ts, x.ggt]) }
]);

async function saveFollowup() {
  if (!fuDate.value) return ElMessage.warning('请选择日期');
  saving.value = true;
  try {
    await api.setFollowup(pid, { date: fuDate.value, note: fuNote.value, version: p.version });
    ElMessage.success('随访日期已更新');
    fuVisible.value = false;
    await loadDetail();
  } catch (e) {
    if (e.code === 40903) {
      ElMessageBox.confirm('数据已被他人修改，是否刷新后重试？', '版本冲突', { type: 'warning' }).then(() => { loadDetail(); fuVisible.value = false; });
    } else ElMessage.error(e.message);
  } finally { saving.value = false; }
}

async function saveRevisit() {
  if (!rvForm.date || !rvForm.place) return ElMessage.warning('请填写复诊日期与地点');
  saving.value = true;
  try {
    await api.setRevisit(pid, { ...rvForm });
    ElMessage.success('复诊计划已保存，可点击"发送提醒"通知患者');
    rvVisible.value = false;
    await loadDetail();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}

async function sendRemind() {
  try {
    await api.sendRevisitReminder(pid);
    ElMessage.success('复诊提醒已推送到患者消息中心');
  } catch (e) { ElMessage.error(e.message); }
}

async function initiateMdt() {
  if (!mdtForm.reason.trim()) return ElMessage.warning('请填写会诊原因');
  if (!mdtForm.specialists.length) return ElMessage.warning('请选择受邀专家');
  saving.value = true;
  try {
    await api.mdtAction(pid, {
      action: 'initiate',
      reason: mdtForm.reason,
      specialists: mdtForm.specialists.map((id) => experts.value.find((e) => e.id === id)).filter(Boolean)
    });
    ElMessage.success('MDT会诊已发起');
    mdtVisible.value = false;
    mdtForm.reason = '';
    mdtForm.specialists = [];
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}

async function saveLab() {
  saving.value = true;
  try {
    await api.addLab(pid, { ...labForm });
    ElMessage.success('检验结果已录入');
    labVisible.value = false;
    loadTrend();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}

onMounted(async () => {
  await loadDetail();
  loadRecords(false);
  loadTrend();
  try {
    const c = await api.config();
    experts.value = c.experts;
  } catch { /* 忽略 */ }
});
</script>

<style scoped>
.head { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.head-info { display: flex; flex-direction: column; gap: 6px; }
.head-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head-line.sub { color: #86909c; font-size: 13px; }
.actions { display: flex; gap: 4px; flex-wrap: wrap; }
h4, h5 { margin: 12px 0 8px; }
</style>
