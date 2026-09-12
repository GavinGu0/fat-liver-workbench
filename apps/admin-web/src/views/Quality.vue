<template>
  <div>
    <!-- 筛选 -->
    <div class="page-card mb-12" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span style="font-size:13px;color:#4e5969">统计窗口</span>
      <el-radio-group v-model="days" @change="load">
        <el-radio-button :value="30">近30天</el-radio-button>
        <el-radio-button :value="60">近60天</el-radio-button>
        <el-radio-button :value="90">近90天</el-radio-button>
        <el-radio-button :value="180">近180天</el-radio-button>
      </el-radio-group>
      <span style="font-size:13px;color:#4e5969">风险人群</span>
      <el-select v-model="risk" style="width:120px" @change="load">
        <el-option label="全部患者" value="" />
        <el-option label="高风险" value="high" />
        <el-option label="中风险" value="mid" />
        <el-option label="低风险" value="low" />
      </el-select>
      <div style="flex:1"></div>
      <el-dropdown @command="exportAll">
        <el-button size="small">
          📥 导出全部趋势数据<el-icon style="margin-left:4px"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="csv">CSV 格式</el-dropdown-item>
            <el-dropdown-item command="excel">Excel 格式</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <span style="color:#86909c;font-size:12px">
        统计人群 {{ cohort.total }} 人 · {{ window.from }} ~ {{ window.to }}
      </span>
    </div>

    <!-- 核心指标 -->
    <el-row :gutter="12" class="mb-12">
      <el-col :span="4" v-for="m in metricCards" :key="m.label">
        <div class="page-card metric">
          <div class="metric-num">{{ m.rate == null ? '-' : m.rate + '%' }}</div>
          <div class="metric-label">{{ m.label }}</div>
          <div class="metric-sub">{{ m.num }}/{{ m.den }}</div>
        </div>
      </el-col>
      <el-col :span="4">
        <div class="page-card metric">
          <div class="metric-num" :class="{ 'metric-warn': screening.pending > 0 }">{{ screening.pending }}</div>
          <div class="metric-label">筛查待处理</div>
          <div class="metric-sub">累计 {{ screening.total }} 例</div>
        </div>
      </el-col>
    </el-row>

    <!-- 业务趋势：4 个独立分析图表 -->
    <el-row :gutter="12" class="mb-12">
      <el-col :span="12" v-for="c in chartConfigs" :key="c.key">
        <div class="page-card mb-12 chart-card">
          <div class="chart-head">
            <h4 style="margin:0">{{ c.icon }} {{ c.title }}趋势（按天）</h4>
            <div class="chart-tools">
              <span class="chart-sum">{{ c.total }}（{{ window.from }} ~ {{ window.to }}）</span>
              <el-radio-group v-model="chartTypes[c.key]" size="small">
                <el-radio-button value="line">折线</el-radio-button>
                <el-radio-button value="bar">柱状</el-radio-button>
                <el-radio-button value="area">面积</el-radio-button>
              </el-radio-group>
              <el-dropdown @command="(fmt) => exportOne(c, fmt)">
                <el-button size="small" text type="primary">导出<el-icon style="margin-left:2px"><ArrowDown /></el-icon></el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="csv">CSV 格式</el-dropdown-item>
                    <el-dropdown-item command="excel">Excel 格式</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
          <TrendChart :series="c.series" :type="chartTypes[c.key]" height="230px" :color="[c.color]" />
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="12">
      <!-- 随访状态分布 -->
      <el-col :span="14">
        <div class="page-card">
          <h4 style="margin-top:0">📋 随访状态分布</h4>
          <div v-for="s in statusRows" :key="s.key" class="dist-row">
            <span class="dist-label">{{ s.label }}</span>
            <el-progress :percentage="s.pct" :color="s.color" :stroke-width="14" style="flex:1" />
            <span class="dist-count">{{ s.count }} 人</span>
          </div>
        </div>
      </el-col>
      <el-col :span="10">
        <!-- 风险分布 -->
        <div class="page-card mb-12">
          <h4 style="margin-top:0">🎯 风险等级分布</h4>
          <div v-for="r in riskRows" :key="r.key" class="dist-row">
            <span class="dist-label">{{ r.label }}</span>
            <el-progress :percentage="r.pct" :color="r.color" :stroke-width="14" style="flex:1" />
            <span class="dist-count">{{ r.count }} 人</span>
          </div>
          <el-alert v-if="riskDist.high > 0" type="warning" :closable="false" style="margin-top:10px">
            高风险患者 {{ riskDist.high }} 人，建议优先随访并评估 MDT 会诊需求。
          </el-alert>
        </div>
        <!-- 指标口径说明 -->
        <div class="page-card">
          <h4 style="margin-top:0">ℹ️ 指标口径</h4>
          <ul class="caliber">
            <li><b>随访率</b> = 窗口内已随访人数 / 应随访人数（计划到期 ∪ 已执行）</li>
            <li><b>失访率</b> = 失访人数 / 在管人数</li>
            <li><b>建档率</b> = 已完成专病建档人数 / 在管人数</li>
            <li><b>高风险占比</b> = 高风险人数 / 在管人数</li>
            <li><b>复查完成率</b> = 建档患者中窗口内有检验记录人数 / 建档人数</li>
          </ul>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue';
import { ElMessage } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import { api } from '../api';
import TrendChart from '../components/TrendChart.vue';
import { exportCsv, exportExcel } from '../utils/export';

const days = ref(30);
const risk = ref('');
const window = reactive({ from: '', to: '' });
const cohort = reactive({ total: 0 });
const metrics = reactive({});
const statusDist = ref({});
const riskDist = reactive({ high: 0, mid: 0, low: 0, unknown: 0 });
const screening = reactive({ total: 0, pending: 0 });
const trend = ref([]);

const metricCards = computed(() => [
  { label: '随访率', ...(metrics.followupRate || {}) },
  { label: '失访率', ...(metrics.lostRate || {}) },
  { label: '建档率', ...(metrics.archiveRate || {}) },
  { label: '高风险占比', ...(metrics.highRiskRatio || {}) },
  { label: '复查完成率', ...(metrics.revisitRate || {}) }
]);

/* ---------------- 趋势图表：4 个独立分析单元 ---------------- */
const ts = (date) => new Date(date + 'T00:00:00+08:00').getTime();

const chartConfigs = computed(() => ([
  { key: 'archived', icon: '🗂️', title: '专病建档', field: 'archived', color: '#1668dc', unit: '人' },
  { key: 'followups', icon: '🩺', title: '随访执行', field: 'followups', color: '#00b42a', unit: '人次' },
  { key: 'lost', icon: '📉', title: '失访', field: 'lost', color: '#f53f3f', unit: '人' },
  { key: 'screenings', icon: '🔍', title: '筛查登记', field: 'screenings', color: '#f7ba1e', unit: '例' }
].map((c) => ({
  ...c,
  total: trend.value.reduce((s, d) => s + (Number(d[c.field]) || 0), 0),
  series: [{ name: c.title, data: trend.value.map((d) => [ts(d.date), d[c.field]]) }]
}))));

/** 每张图表独立的类型状态（默认折线） */
const chartTypes = reactive({ archived: 'line', followups: 'line', lost: 'line', screenings: 'line' });

const STATUS_COLORS = { overdue: '#f56c6c', today: '#f56c6c', soon3d: '#e6a23c', scheduled: '#1668dc', none: '#c9cdd4', lost: '#86909c' };
const statusRows = computed(() => {
  const total = cohort.total || 1;
  return Object.entries(statusDist.value).map(([key, v]) => ({
    key, label: v.label || key, count: v.count, pct: Math.round((v.count / total) * 100), color: STATUS_COLORS[key] || '#1668dc'
  }));
});
const riskRows = computed(() => {
  const total = cohort.total || 1;
  return [
    { key: 'high', label: '高风险', color: '#f56c6c' },
    { key: 'mid', label: '中风险', color: '#e6a23c' },
    { key: 'low', label: '低风险', color: '#67c23a' },
    { key: 'unknown', label: '未评估', color: '#c9cdd4' }
  ].map((r) => ({ ...r, count: riskDist[r.key] || 0, pct: Math.round(((riskDist[r.key] || 0) / total) * 100) }));
});

/* ---------------- 导出 ---------------- */
const fmtDateLabel = (d) => d.date;
const fmtVal = (v) => (v == null ? 0 : v);

function exportOne(cfg, fmt) {
  const headers = ['日期', `${cfg.title}（${cfg.unit}）`];
  const rows = trend.value.map((d) => [fmtDateLabel(d), fmtVal(d[cfg.field])]);
  const name = `业务趋势_${cfg.title}_${window.from}_${window.to}`;
  if (fmt === 'excel') exportExcel(name, cfg.title, headers, rows);
  else exportCsv(name, headers, rows);
  ElMessage.success(`${cfg.title}趋势数据已导出（${fmt === 'excel' ? 'Excel' : 'CSV'}）`);
}

function exportAll(fmt) {
  const headers = ['日期', '专病建档（人）', '随访执行（人次）', '失访（人）', '筛查登记（例）'];
  const rows = trend.value.map((d) => [fmtDateLabel(d), fmtVal(d.archived), fmtVal(d.followups), fmtVal(d.lost), fmtVal(d.screenings)]);
  const name = `业务趋势汇总_${window.from}_${window.to}`;
  if (fmt === 'excel') exportExcel(name, '业务趋势', headers, rows);
  else exportCsv(name, headers, rows);
  ElMessage.success(`全部趋势数据已导出（${fmt === 'excel' ? 'Excel' : 'CSV'}）`);
}

async function load() {
  try {
    const d = await api.quality({ days: days.value, risk: risk.value || undefined });
    Object.assign(window, d.window);
    Object.assign(cohort, d.cohort);
    Object.assign(metrics, d.metrics);
    statusDist.value = d.statusDist;
    Object.assign(riskDist, d.riskDist);
    Object.assign(screening, d.screening);
    trend.value = d.trend;
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(load);
onActivated(load);
</script>

<style scoped>
.metric { text-align: center; padding: 18px 8px; }
.metric-warn { color: #f56c6c; }
.metric-sub { color: #86909c; font-size: 12px; margin-top: 2px; }
.dist-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.dist-label { width: 64px; font-size: 13px; color: #4e5969; }
.dist-count { width: 48px; font-size: 12px; color: #86909c; text-align: right; }
.caliber { margin: 0; padding-left: 18px; color: #4e5969; font-size: 13px; line-height: 2; }
.chart-card { padding: 14px 16px 8px; }
.chart-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.chart-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chart-sum { color: #86909c; font-size: 12px; }
</style>
