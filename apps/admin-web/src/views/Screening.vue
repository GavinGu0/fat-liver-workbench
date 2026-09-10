<template>
  <div>
    <!-- 统计 + 操作 -->
    <el-row :gutter="12" class="mb-12">
      <el-col :span="4" v-for="s in statCards" :key="s.label">
        <div class="page-card metric">
          <div class="metric-num" :class="{ 'metric-warn': s.warn }">{{ s.value }}</div>
          <div class="metric-label">{{ s.label }}</div>
        </div>
      </el-col>
      <el-col :span="4">
        <div class="page-card metric" style="display:flex;flex-direction:column;gap:6px;justify-content:center">
          <el-button type="primary" size="small" :loading="running" @click="runScreening">执行自动筛查</el-button>
          <el-button size="small" @click="manualVisible = true">手工登记</el-button>
        </div>
      </el-col>
    </el-row>

    <!-- 列表 -->
    <div class="page-card">
      <div class="filters mb-12">
        <el-radio-group v-model="q.status" @change="load">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="pending">待处理</el-radio-button>
          <el-radio-button value="accepted">已纳入</el-radio-button>
          <el-radio-button value="rejected">已排除</el-radio-button>
        </el-radio-group>
        <el-input v-model="q.keyword" placeholder="搜索姓名/手机号" style="width:200px" clearable @keyup.enter="load" @clear="load">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>

      <el-empty v-if="!rows.length && !loading" description="暂无筛查案例" :image-size="80" />
      <div v-for="c in rows" :key="c.id" class="case-card">
        <div class="case-head">
          <span style="cursor:pointer" @click="$router.push(`/patients/${c.patientId}`)">
            <b style="font-size:15px">{{ c.patientName }}</b>
            <span style="color:#86909c;font-size:12px;margin-left:8px">ID:{{ c.patientId }}</span>
          </span>
          <span style="display:flex;gap:8px;align-items:center">
            <el-tag size="small" type="info">{{ sourceLabel(c.source) }}</el-tag>
            <el-tag size="small" :type="c.suggestedRisk === 'high' ? 'danger' : c.suggestedRisk === 'mid' ? 'warning' : 'success'">
              建议风险：{{ riskLabel(c.suggestedRisk) }}
            </el-tag>
            <el-tag size="small" :type="c.status === 'pending' ? 'primary' : c.status === 'accepted' ? 'success' : 'info'">
              {{ statusLabel(c.status) }}
            </el-tag>
            <el-button v-if="c.status === 'pending'" size="small" type="success" @click="openDecide(c, 'accept')">纳入管理</el-button>
            <el-button v-if="c.status === 'pending'" size="small" type="danger" plain @click="openDecide(c, 'reject')">排除</el-button>
          </span>
        </div>
        <div class="evidence">
          <div v-for="(e, i) in c.evidence" :key="i" class="evidence-item">
            <el-tag size="small" :type="e.source === 'lis' ? 'danger' : e.source === 'pacs' ? 'warning' : 'primary'" effect="plain">{{ sourceLabel(e.source) }}</el-tag>
            <b style="margin:0 6px">{{ e.rule }}</b>
            <span style="color:#4e5969">{{ e.detail }}</span>
          </div>
          <div v-if="!c.evidence.length" style="color:#86909c;font-size:12px">无规则命中证据（手工登记）</div>
        </div>
        <div class="case-foot">
          <span>登记时间：{{ fmtTime(c.ts) }}</span>
          <span v-if="c.decisionNote">处理说明：{{ c.decisionNote }}（{{ c.decidedBy }}）</span>
        </div>
      </div>
    </div>

    <!-- 手工登记 -->
    <el-dialog v-model="manualVisible" title="手工登记筛查案例" width="480px">
      <el-form label-width="90px">
        <el-form-item label="患者" required>
          <el-select v-model="manualForm.patientId" filterable placeholder="搜索选择患者" style="width:100%">
            <el-option v-for="p in patientOptions" :key="p.id" :value="p.id" :label="`${p.name}（${p.gender === 'male' ? '男' : '女'} / ${p.age}岁）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源">
          <el-radio-group v-model="manualForm.source">
            <el-radio-button value="manual">手工</el-radio-button>
            <el-radio-button value="lis">检验</el-radio-button>
            <el-radio-button value="pacs">影像</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="超声描述">
          <el-input v-model="manualForm.ultrasoundText" type="textarea" :rows="2" placeholder="如：轻度脂肪肝（选填，命中关键词自动生成证据）" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="manualForm.note" type="textarea" :rows="2" placeholder="登记依据说明（未命中规则时必填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="manualVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveManual">登记</el-button>
      </template>
    </el-dialog>

    <!-- 决策 -->
    <el-dialog v-model="decideVisible" :title="decideForm.decision === 'accept' ? '纳入管理' : '排除病例'" width="440px">
      <template v-if="decideForm.decision === 'accept'">
        <el-form-item label="风险分层" label-width="90px">
          <el-radio-group v-model="decideForm.risk">
            <el-radio-button value="high">高风险</el-radio-button>
            <el-radio-button value="mid">中风险</el-radio-button>
            <el-radio-button value="low">低风险</el-radio-button>
          </el-radio-group>
          <div style="color:#86909c;font-size:12px;margin-top:4px">默认取筛查建议，纳入后按风险周期自动排随访</div>
        </el-form-item>
      </template>
      <el-input v-model="decideForm.reason" type="textarea" :rows="3" :placeholder="decideForm.decision === 'accept' ? '纳入依据，如：超声+肝酶异常，符合纳入标准' : '排除理由，如：既往已确诊，走专病门诊路径'" />
      <template #footer>
        <el-button @click="decideVisible = false">取消</el-button>
        <el-button :type="decideForm.decision === 'accept' ? 'success' : 'danger'" :loading="saving" @click="saveDecide">
          {{ decideForm.decision === 'accept' ? '确认纳入' : '确认排除' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { fmtTime } from '../utils/format';
import { RISK_LABELS } from '@flwb/shared';

const q = reactive({ status: '', keyword: '' });
const rows = ref([]);
const stats = reactive({ total: 0, pending: 0, accepted: 0, rejected: 0, highRisk: 0 });
const loading = ref(false);
const running = ref(false);
const saving = ref(false);

const manualVisible = ref(false);
const manualForm = reactive({ patientId: '', source: 'manual', ultrasoundText: '', note: '' });
const patientOptions = ref([]);

const decideVisible = ref(false);
const decideForm = reactive({ id: '', decision: 'accept', risk: 'mid', reason: '' });

const riskLabel = (r) => RISK_LABELS[r] || '未评估';
const statusLabel = (s) => ({ pending: '待处理', accepted: '已纳入', rejected: '已排除' }[s] || s);
const sourceLabel = (s) => ({ lis: '检验', pacs: '影像', bmi: '体格', manual: '手工', scan: '自动筛查' }[s] || s);

const statCards = computed(() => [
  { label: '筛查总数', value: stats.total },
  { label: '待处理', value: stats.pending, warn: stats.pending > 0 },
  { label: '已纳入管理', value: stats.accepted },
  { label: '已排除', value: stats.rejected },
  { label: '高危建议', value: stats.highRisk, warn: stats.highRisk > 0 }
]);

async function load() {
  loading.value = true;
  try {
    const d = await api.screeningList({ status: q.status || undefined, keyword: q.keyword || undefined });
    rows.value = d.items;
    Object.assign(stats, d.stats);
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

async function runScreening() {
  running.value = true;
  try {
    const d = await api.screeningRun();
    ElMessage.success(`筛查完成：扫描 ${d.scanned} 名患者，新增 ${d.newCases} 例，更新 ${d.updatedCases} 例`);
    load();
  } catch (e) { ElMessage.error(e.message); } finally { running.value = false; }
}

async function openManual() {
  manualVisible.value = true;
  if (!patientOptions.value.length) {
    try {
      const d = await api.patients({ page: 1, size: 100 });
      patientOptions.value = d.items;
    } catch { /* 忽略 */ }
  }
}
function saveManual() {
  if (!manualForm.patientId) return ElMessage.warning('请选择患者');
  saving.value = true;
  api.screeningManual({ action: 'manual', ...manualForm })
    .then((d) => {
      ElMessage.success(d.created ? '筛查案例已登记' : '已追加证据到该患者现有案例');
      manualVisible.value = false;
      manualForm.patientId = ''; manualForm.ultrasoundText = ''; manualForm.note = '';
      load();
    })
    .catch((e) => ElMessage.error(e.message))
    .finally(() => { saving.value = false; });
}

function openDecide(c, decision) {
  decideForm.id = c.id;
  decideForm.decision = decision;
  decideForm.risk = c.suggestedRisk || 'mid';
  decideForm.reason = '';
  decideVisible.value = true;
}
function saveDecide() {
  if (decideForm.reason.trim().length < 2) return ElMessage.warning('请填写处理说明');
  saving.value = true;
  api.screeningDecision(decideForm.id, { decision: decideForm.decision, reason: decideForm.reason, risk: decideForm.decision === 'accept' ? decideForm.risk : undefined })
    .then((d) => {
      ElMessage.success(d.status === 'accepted'
        ? `已纳入管理（${riskLabel(d.riskApplied)}），随访已排期 ${d.nextFollowupDate}`
        : '已排除该病例');
      decideVisible.value = false;
      load();
    })
    .catch((e) => ElMessage.error(e.message))
    .finally(() => { saving.value = false; });
}

onMounted(load);
onActivated(load);
</script>

<style scoped>
.metric { text-align: center; padding: 18px 8px; }
.metric-warn { color: #f56c6c; }
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.case-card { border: 1px solid #e5e6eb; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
.case-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.evidence { margin: 10px 0 6px; display: flex; flex-direction: column; gap: 4px; }
.evidence-item { font-size: 13px; display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
.case-foot { display: flex; gap: 16px; color: #86909c; font-size: 12px; flex-wrap: wrap; }
</style>
