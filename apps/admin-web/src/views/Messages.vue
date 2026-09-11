<template>
  <div class="page-card">
    <div class="toolbar">
      <div>
        <h4 class="page-title">消息中心</h4>
        <p class="page-sub">患者填报动态 / 随访提醒 / 系统通知</p>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <el-tag v-if="unread" type="danger" effect="light">{{ unread }} 条未读</el-tag>
        <el-button :disabled="!items.length" @click="readAll">全部已读</el-button>
      </div>
    </div>

    <el-table :data="items" v-loading="loading" @row-click="open" row-class-name="msg-row" empty-text="暂无消息">
      <el-table-column width="36">
        <template #default="{ row }">
          <span class="dot" :class="{ on: !row.read }"></span>
        </template>
      </el-table-column>
      <el-table-column label="标题" min-width="300">
        <template #default="{ row }">
          <span :class="{ 'row-title-unread': !row.read }">{{ row.title }}</span>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.type === 'patient_submit' ? 'success' : 'info'" effect="plain">{{ typeLabel(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="from" label="来自" width="120" show-overflow-tooltip />
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ fmtTime(row.ts) }}</template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="visible" :title="current && current.title" width="560px">
      <p class="dialog-meta">
        <el-tag size="small" effect="plain">{{ typeLabel(current && current.type) }}</el-tag>
        <span>来自 {{ current && current.from }} · {{ current && fmtTime(current.ts) }}</span>
      </p>
      <div class="msg-html" v-html="html"></div>
      <template #footer>
        <el-button @click="visible = false">关闭</el-button>
        <el-button v-if="current && current.link" type="primary" @click="goLink">前往查看</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { fmtTime } from '../utils/format';
import DOMPurify from 'dompurify';

const router = useRouter();
const items = ref([]);
const unread = ref(0);
const loading = ref(false);
const visible = ref(false);
const current = ref(null);
const html = computed(() => (current.value ? DOMPurify.sanitize(current.value.content || '') : ''));

const TYPE_LABELS = {
  patient_submit: '患者填报',
  education: '健康宣教',
  revisit_reminder: '复诊提醒',
  guidance: '个案指导',
  followup: '随访提醒',
  system: '系统通知'
};
const typeLabel = (t) => TYPE_LABELS[t] || '通知';

async function load() {
  loading.value = true;
  try {
    const d = await api.messages();
    items.value = d.items || [];
    unread.value = d.unread || 0;
  } finally {
    loading.value = false;
  }
}

async function open(m) {
  current.value = m;
  visible.value = true;
  if (!m.read) {
    try {
      await api.readMessage(m.mid);
      m.read = true;
      unread.value = Math.max(0, unread.value - 1);
    } catch { /* 静默 */ }
  }
}

function goLink() {
  const link = current.value && current.value.link;
  visible.value = false;
  if (link) router.push(link);
}

async function readAll() {
  await api.readAllMessages();
  items.value = items.value.map((m) => ({ ...m, read: true }));
  unread.value = 0;
}

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.page-title { margin: 0; font-size: 16px; }
.page-sub { margin: 4px 0 0; font-size: 12px; color: #86909c; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #e5e6eb; }
.dot.on { background: #f53f3f; }
.row-title-unread { font-weight: 600; }
.msg-row { cursor: pointer; }
.dialog-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #86909c; margin: 0 0 12px; }
.msg-html :deep(p) { margin: 0 0 8px; line-height: 1.7; }
</style>
