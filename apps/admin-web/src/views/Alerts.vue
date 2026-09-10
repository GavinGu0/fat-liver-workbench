<template>
  <div class="page-card">
    <div class="filters mb-12">
      <el-radio-group v-model="q.status" @change="load">
        <el-radio-button value="open">未处理（{{ stats.open }}）</el-radio-button>
        <el-radio-button value="handled">已处理</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
      <el-select v-model="q.level" placeholder="预警级别" style="width:120px" clearable @change="load">
        <el-option label="仅高危" value="high" />
        <el-option label="仅中危" value="mid" />
        <el-option label="仅低危" value="low" />
      </el-select>
      <div style="flex:1"></div>
      <el-button :disabled="!stats.open" type="warning" plain @click="readAll">全部标记已读</el-button>
    </div>

    <el-empty v-if="!rows.length && !loading" description="暂无预警 🎉" :image-size="80" />
    <div v-for="a in rows" :key="a.id" class="alert-card" :class="`level-${a.level}`">
      <div class="alert-head">
        <span style="display:flex;gap:8px;align-items:center">
          <el-tag size="small" :type="a.level === 'high' ? 'danger' : 'warning'">{{ levelLabel(a.level) }}</el-tag>
          <el-tag size="small" effect="plain" type="info">{{ typeLabel(a.type) }}</el-tag>
          <b style="font-size:15px">{{ a.title }}</b>
          <el-badge v-if="a.count > 1" :value="`升级${a.count}次`" type="danger" />
        </span>
        <span style="display:flex;gap:8px;align-items:center">
          <span style="color:#86909c;font-size:12px">{{ fmtTime(a.ts) }}</span>
          <el-button v-if="a.status === 'open'" size="small" type="primary" @click="handle(a)">处理</el-button>
          <el-tag v-else size="small" type="success">已处理</el-tag>
        </span>
      </div>
      <p class="alert-content">{{ a.content }}</p>
      <div class="alert-foot">
        <el-link type="primary" @click="goPatient(a)">查看患者 {{ a.patientName }}</el-link>
        <span v-if="a.status === 'handled'" style="color:#86909c;font-size:12px">
          {{ a.handledBy }} 处理于 {{ fmtTime(a.handledAt) }}{{ a.handlerNote ? ` · ${a.handlerNote}` : '' }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onActivated } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import { fmtTime } from '../utils/format';
import { ALERT_TYPE_LABELS } from '@flwb/shared';

const router = useRouter();
const q = reactive({ status: 'open', level: '' });
const rows = ref([]);
const stats = reactive({ total: 0, open: 0, highOpen: 0, unread: 0 });
const loading = ref(false);

const levelLabel = (l) => ({ high: '高危', mid: '中危', low: '低危' }[l] || l);
const typeLabel = (t) => ALERT_TYPE_LABELS[t] || t;

async function load() {
  loading.value = true;
  try {
    const d = await api.alerts({ status: q.status || undefined, level: q.level || undefined });
    rows.value = d.items;
    Object.assign(stats, d.stats);
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

function goPatient(a) {
  if (a.link) router.push(a.link);
  else if (a.patientId) router.push(`/patients/${a.patientId}`);
}

async function handle(a) {
  try {
    const { value } = await ElMessageBox.prompt('处理备注（选填）', a.title, {
      inputValue: '', inputType: 'textarea', inputPlaceholder: '如：已电话联系患者，重新预约随访', confirmButtonText: '已处理', cancelButtonText: '取消'
    });
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

onMounted(load);
onActivated(load);
</script>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.alert-card { border: 1px solid #e5e6eb; border-left-width: 4px; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
.alert-card.level-high { border-left-color: #f56c6c; }
.alert-card.level-mid { border-left-color: #e6a23c; }
.alert-card.level-low { border-left-color: #c9cdd4; }
.alert-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.alert-content { margin: 8px 0; color: #4e5969; font-size: 13px; }
.alert-foot { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
</style>
