<template>
  <div>
    <!-- 智能提醒弹窗（登录触发 + 30s 轮询） -->
    <el-dialog v-model="remindVisible" title="⏰ 随访提醒" width="420px" append-to-body>
      <p style="margin-top:0">以下患者今日/近期需要随访：</p>
      <div v-for="p in remindList" :key="p.id" class="todo-item" @click="remindVisible = false; $router.push(`/patients/${p.id}`)">
        <span><b>{{ p.name }}</b>（{{ p.risk === 'high' ? '高风险' : p.risk === 'mid' ? '中风险' : '低风险' }}）</span>
        <el-tag size="small">{{ p.date }}</el-tag>
      </div>
      <template #footer>
        <el-button @click="snooze">稍后处理</el-button>
        <el-button type="primary" @click="goPatients">去处理</el-button>
      </template>
    </el-dialog>

    <!-- 指标卡 -->
    <el-row :gutter="12" class="mb-12">
      <el-col :span="6" v-for="m in metricCards" :key="m.label">
        <div class="page-card metric">
          <div class="metric-num">{{ m.value }}</div>
          <div class="metric-label">{{ m.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="12" v-if="auth.isDoctor">
      <el-col :span="14">
        <div class="page-card mb-12">
          <h4 style="margin-top:0">📋 待办任务</h4>
          <el-tabs v-model="todoTab">
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
        <div class="page-card">
          <h4 style="margin-top:0">ℹ️ 数据同步说明</h4>
          <p style="color:#86909c;font-size:13px;margin:0">
            Serverless 无 WebSocket，工作台每 <b>30s</b> 自动轮询；患者提交数据 &lt;3s 可见（下次轮询即拉取）。
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
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import RiskTag from '../components/RiskTag.vue';

const router = useRouter();
const auth = useAuthStore();
const d = reactive({
  metrics: { totalPatients: 0, newThisWeek: 0, fillRate: 0, pendingMdt: 0 },
  todos: { todayFollowups: [], soonFollowups: [], revisitQueue: [], mdtPending: [] },
  quick: { highRisk: [], notFollowed: [], abnormal: [] },
  today: ''
});
const todoTab = ref('today');
const remindVisible = ref(false);
let timer = null;

const remindList = computed(() => [...d.todos.todayFollowups, ...d.todos.soonFollowups].slice(0, 8));

const metricCards = computed(() => [
  { label: '管理患者总数', value: d.metrics.totalPatients },
  { label: '本周新增', value: d.metrics.newThisWeek },
  { label: '7日数据填报率', value: d.metrics.fillRate + '%' },
  { label: '待处理任务', value: d.todos.todayFollowups.length + d.todos.mdtPending.length }
]);

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
    d.today = data.today;
    const dismissedUntil = Number(sessionStorage.getItem('flwb_remind_dismiss') || 0);
    if (remindList.value.length && Date.now() > dismissedUntil) remindVisible.value = true;
  } catch { /* 轮询失败静默 */ }
}

function goDetail(id) { router.push(`/patients/${id}`); }
function goFilter(f) { router.push({ path: '/patients', query: { filter: f } }); }
function goPatients() { remindVisible.value = false; router.push({ path: '/patients', query: { filter: 'notFollowed' } }); }
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

// 稍后处理：10分钟内不再弹
</script>

<style scoped>
.metric { text-align: center; padding: 20px 8px; }
.empty { color: #86909c; font-size: 13px; padding: 20px 0; text-align: center; }
</style>
