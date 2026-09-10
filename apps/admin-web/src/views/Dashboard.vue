<template>
  <div>
    <!-- 随访提醒弹窗：今日/3日内/逾期（后端 cron 3日预提醒 + 工作台轮询双触发） -->
    <el-dialog v-model="remindVisible" title="⏰ 随访提醒" width="480px" append-to-body>
      <p style="margin-top:0">以下患者需要随访关注：</p>
      <div v-for="p in remindList" :key="p.id" class="todo-item">
        <span style="cursor:pointer" @click="remindVisible = false; $router.push(`/patients/${p.id}`)">
          <b>{{ p.name }}</b>（{{ riskLabel(p.risk) }}）
        </span>
        <span style="display:flex;gap:6px;align-items:center">
          <el-tag size="small" :type="popupTagType(p.status)">{{ popupTagText(p) }}</el-tag>
          <el-button size="small" text type="primary" @click="remindOne(p)">发提醒</el-button>
        </span>
      </div>
      <template #footer>
        <el-button @click="snooze">稍后处理</el-button>
        <el-button type="primary" @click="remindVisible = false; $router.push('/followup')">去随访管理</el-button>
      </template>
    </el-dialog>

    <!-- 指标卡 -->
    <el-row :gutter="12" class="mb-12">
      <el-col :span="6" v-for="m in metricCards" :key="m.label">
        <div class="page-card metric" :class="{ 'metric-click': m.to }" @click="m.to && $router.push(m.to)">
          <div class="metric-num" :class="{ 'metric-warn': m.warn }">{{ m.value }}</div>
          <div class="metric-label">{{ m.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="12" v-if="auth.isDoctor">
      <el-col :span="14">
        <div class="page-card mb-12">
          <h4 style="margin-top:0">📋 待办任务</h4>
          <el-tabs v-model="todoTab">
            <el-tab-pane :label="`逾期随访 ${d.todos.overdueFollowups.length}`" name="overdue">
              <div v-if="!d.todos.overdueFollowups.length" class="empty">无逾期随访 👍</div>
              <div v-for="p in d.todos.overdueFollowups" :key="p.id" class="todo-item" @click="goDetail(p.id)">
                <span><b>{{ p.name }}</b></span>
                <el-tag size="small" type="danger">逾期 {{ p.daysLeft != null ? -p.daysLeft + ' 天' : '' }}</el-tag>
              </div>
            </el-tab-pane>
            <el-tab-pane :label="`今日随访 ${d.todos.todayFollowups.length}`" name="today">
              <div v-if="!d.todos.todayFollowups.length" class="empty">今日暂无随访任务 🎉</div>
              <div v-for="p in d.todos.todayFollowups" :key="p.id" class="todo-item" @click="goDetail(p.id)">
                <span><b>{{ p.name }}</b> · {{ p.age }}岁</span><RiskTag :risk="p.risk" />
              </div>
            </el-tab-pane>
            <el-tab-pane :label="`3日内随访 ${d.todos.soonFollowups.length}`" name="soon">
              <div v-if="!d.todos.soonFollowups.length" class="empty">未来3日无随访安排</div>
              <div v-for="p in d.todos.soonFollowups" :key="p.id" class="todo-item" @click="goDetail(p.id)">
                <span><b>{{ p.name }}</b></span><el-tag size="small" type="warning">{{ p.date }}</el-tag>
              </div>
            </el-tab-pane>
            <el-tab-pane :label="`复诊队列 ${d.todos.revisitQueue.length}`" name="revisit">
              <div v-if="!d.todos.revisitQueue.length" class="empty">暂无复诊安排</div>
              <div v-for="p in d.todos.revisitQueue" :key="p.id" class="todo-item" @click="goDetail(p.id)">
                <span><b>{{ p.name }}</b> · {{ p.place }}</span><el-tag size="small">{{ p.date }}</el-tag>
              </div>
            </el-tab-pane>
            <el-tab-pane :label="`MDT进行中 ${d.todos.mdtPending.length}`" name="mdt">
              <div v-if="!d.todos.mdtPending.length" class="empty">暂无进行中的MDT会诊</div>
              <div v-for="m in d.todos.mdtPending" :key="m.id" class="todo-item" @click="$router.push('/mdt')">
                <span><b>{{ m.patientName }}</b> · {{ m.reason.slice(0, 18) }}…</span>
                <el-tag size="small" type="danger">待反馈</el-tag>
              </div>
            </el-tab-pane>
          </el-tabs>
        </div>

        <!-- 预警提醒 -->
        <div class="page-card">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <h4 style="margin:0 0 8px">🔔 预警提醒（{{ d.alerts.openCount }} 条待处理）</h4>
            <span>
              <el-button size="small" text type="primary" @click="readAll" :disabled="!d.alerts.openCount">全部已读</el-button>
              <el-button size="small" text type="primary" @click="$router.push('/alerts')">全部预警</el-button>
            </span>
          </div>
          <div v-if="!d.alerts.items.length" class="empty">暂无未处理预警 🎉</div>
          <div v-for="a in d.alerts.items" :key="a.id" class="todo-item" style="align-items:flex-start">
            <span style="flex:1;cursor:pointer" @click="goAlert(a)">
              <el-tag size="small" :type="a.level === 'high' ? 'danger' : 'warning'" style="margin-right:6px">{{ a.level === 'high' ? '高危' : '中危' }}</el-tag>
              <b>{{ a.title }}</b>
              <p style="margin:4px 0 0;color:#86909c;font-size:12px">{{ a.content.slice(0, 60) }}{{ a.content.length > 60 ? '…' : '' }}<span v-if="a.count > 1">（升级 {{ a.count }} 次）</span></p>
            </span>
            <el-button size="small" text type="primary" @click="handleAlert(a)">处理</el-button>
          </div>
        </div>
      </el-col>
      <el-col :span="10">
        <div class="page-card mb-12">
          <h4 style="margin-top:0">⚡ 快捷筛选</h4>
          <div class="todo-item" @click="goFilter('highRisk')">
            <span>🔴 高风险患者</span><el-badge :value="d.quick.highRisk.length" type="danger" />
          </div>
          <div class="todo-item" @click="goFilter('notFollowed')">
            <span>🟠 近30天未随访</span><el-badge :value="d.quick.notFollowed.length" type="warning" />
          </div>
          <div class="todo-item" @click="goFilter('abnormal')">
            <span>🟣 数据异常待关注</span><el-badge :value="d.quick.abnormal.length" />
          </div>
          <el-alert v-if="abnormalDetail" type="error" style="margin-top:10px">
            <div v-for="a in abnormalDetail" :key="a.id" style="cursor:pointer" @click="goDetail(a.id)">
              <b>{{ a.name }}</b>：{{ abnormalText(a.abnormal) }}
            </div>
          </el-alert>
        </div>
        <div class="page-card mb-12">
          <h4 style="margin-top:0">🚀 快捷入口</h4>
          <div class="quick-entry">
            <el-button plain @click="$router.push('/medical-records')"><el-icon><Notebook /></el-icon>&nbsp;专病建档</el-button>
            <el-button plain @click="$router.push('/screening')"><el-icon><Search /></el-icon>&nbsp;筛查识别<span v-if="d.metrics.screeningPending" class="mini-badge">{{ d.metrics.screeningPending }}</span></el-button>
            <el-button plain @click="$router.push('/followup')"><el-icon><Calendar /></el-icon>&nbsp;随访管理</el-button>
            <el-button plain @click="$router.push('/quality')"><el-icon><DataAnalysis /></el-icon>&nbsp;质量看板</el-button>
          </div>
        </div>
        <div class="page-card">
          <h4 style="margin-top:0">ℹ️ 数据同步说明</h4>
          <p style="color:#86909c;font-size:13px;margin:0">
            Serverless 无 WebSocket，工作台每 <b>30s</b> 自动轮询；患者提交数据 &lt;3s 可见（下次轮询即拉取）。随访日期前 <b>3 天</b> 系统自动弹窗提醒。
          </p>
        </div>
      </el-col>
    </el-row>

    <el-row v-else :gutter="12">
      <el-col :span="12">
        <div class="page-card">
          <h4 style="margin-top:0">📢 护理工作提示</h4>
          <p>本月已推送宣教 <b>{{ d.metrics.eduPushed || 0 }}</b> 次，创建个案指导 <b>{{ d.metrics.guidanceCreated || 0 }}</b> 条。</p>
          <el-button type="primary" @click="$router.push('/education')">去推送宣教</el-button>
          <el-button @click="$router.push('/guidance')">记录个案指导</el-button>
        </div>
      </el-col>
      <el-col :span="12">
        <div class="page-card">
          <h4 style="margin-top:0">👥 患者管理</h4>
          <p>当前病区共管理 <b>{{ d.metrics.totalPatients }}</b> 名患者，本周新增 <b>{{ d.metrics.newThisWeek }}</b> 名。</p>
          <el-button @click="$router.push('/patients')">查看患者列表</el-button>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { RISK_LABELS } from '@flwb/shared';
import RiskTag from '../components/RiskTag.vue';

const router = useRouter();
const auth = useAuthStore();
const d = reactive({
  metrics: { totalPatients: 0, newThisWeek: 0, fillRate: 0, pendingMdt: 0, archived: 0, lost: 0, highRisk: 0, screeningPending: 0, alertsOpen: 0, alertsUnread: 0 },
  todos: { todayFollowups: [], soonFollowups: [], overdueFollowups: [], revisitQueue: [], mdtPending: [] },
  quick: { highRisk: [], notFollowed: [], abnormal: [] },
  alerts: { unread: 0, openCount: 0, items: [] },
  followupPopup: [],
  today: ''
});
const todoTab = ref('overdue');
const remindVisible = ref(false);
let timer = null;

const riskLabel = (r) => RISK_LABELS[r] || '未评估';

const remindList = computed(() => d.followupPopup.slice(0, 8));

const metricCards = computed(() => {
  if (auth.isDoctor) {
    return [
      { label: '管理患者总数', value: d.metrics.totalPatients },
      { label: '已专病建档', value: d.metrics.archived, to: '/medical-records' },
      { label: '待处理预警', value: d.metrics.alertsOpen, warn: d.metrics.alertsOpen > 0, to: '/alerts' },
      { label: '筛查待处理', value: d.metrics.screeningPending, warn: d.metrics.screeningPending > 0, to: '/screening' }
    ];
  }
  return [
    { label: '管理患者总数', value: d.metrics.totalPatients },
    { label: '本周新增', value: d.metrics.newThisWeek },
    { label: '7日数据填报率', value: d.metrics.fillRate + '%' },
    { label: '待处理任务', value: d.todos.todayFollowups.length + d.todos.mdtPending.length }
  ];
});

function popupTagType(status) {
  return { overdue: 'danger', today: 'danger', soon3d: 'warning' }[status] || 'info';
}
function popupTagText(p) {
  if (p.status === 'overdue') return `逾期 ${p.daysLeft != null ? -p.daysLeft : '?'} 天`;
  if (p.status === 'today') return '今日随访';
  if (p.status === 'soon3d') return p.daysLeft != null ? `${p.daysLeft} 日后` : '3日内';
  return p.date || '';
}

const abnormalDetail = computed(() => d.quick.abnormal.slice(0, 5));
function abnormalText(a) {
  const parts = [];
  if (a.sbp) parts.push(`血压 ${a.sbp}/${a.dbp}`);
  if (a.glucose) parts.push(`血糖 ${a.glucose}`);
  if (a.bmi) parts.push(`BMI ${a.bmi}`);
  return parts.join('，');
}

async function load() {
  try {
    const data = await api.dashboard();
    Object.assign(d.metrics, data.metrics);
    Object.assign(d.todos, data.todos);
    Object.assign(d.quick, data.quick);
    if (data.alerts) d.alerts = data.alerts;
    if (data.followupPopup) d.followupPopup = data.followupPopup;
    d.today = data.today;
    const dismissedUntil = Number(sessionStorage.getItem('flwb_remind_dismiss') || 0);
    if (remindList.value.length && Date.now() > dismissedUntil) remindVisible.value = true;
  } catch { /* 轮询失败静默 */ }
}

function goDetail(id) { router.push(`/patients/${id}`); }
function goAlert(a) {
  if (a.link) router.push(a.link);
  else if (a.patientId) goDetail(a.patientId);
  else router.push('/alerts');
}
async function handleAlert(a) {
  try {
    const { value } = await ElMessageBox.prompt('处理备注（选填）', `处理预警：${a.title}`, { inputValue: '', inputType: 'textarea', confirmButtonText: '已处理', cancelButtonText: '取消' });
    await api.alertHandle(a.id, { note: value || '' });
    ElMessage.success('预警已处理');
    load();
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}
async function readAll() {
  try {
    await api.alertsReadAll();
    ElMessage.success('已全部标记处理');
    load();
  } catch (e) { ElMessage.error(e.message); }
}
async function remindOne(p) {
  try {
    const r = await api.followupRemind({ patientIds: [p.id] });
    if (r.sent > 0) ElMessage.success(`已发送提醒给 ${p.name}`);
    else ElMessage.warning(r.skipped[0] && r.skipped[0].reason || '患者未绑定小程序账号');
  } catch (e) { ElMessage.error(e.message); }
}
function goFilter(f) { router.push({ path: '/patients', query: { filter: f } }); }
function snooze() {
  remindVisible.value = false;
  sessionStorage.setItem('flwb_remind_dismiss', String(Date.now() + 10 * 60 * 1000)); // 10分钟内不再弹
}

onMounted(() => {
  load();
  timer = setInterval(load, 30000); // 30s 轮询
  document.addEventListener('visibilitychange', onVisible);
});
onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); });
onActivated(load);
onDeactivated(() => clearInterval(timer));
function onVisible() { if (!document.hidden) load(); }
</script>

<style scoped>
.metric { text-align: center; padding: 20px 8px; }
.metric-click { cursor: pointer; }
.metric-warn { color: #f56c6c; }
.empty { color: #86909c; font-size: 13px; padding: 20px 0; text-align: center; }
.quick-entry { display: flex; flex-wrap: wrap; gap: 8px; }
.quick-entry .el-button { margin: 0; }
.mini-badge {
  display: inline-block; margin-left: 4px; min-width: 16px; height: 16px; line-height: 16px;
  border-radius: 8px; background: #f56c6c; color: #fff; font-size: 11px; text-align: center; padding: 0 4px;
}
</style>
