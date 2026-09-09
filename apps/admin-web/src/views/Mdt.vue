<template>
  <div class="page-card">
    <div class="filters mb-12">
      <el-radio-group v-model="statusFilter" @change="filterItems">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="pending">待反馈</el-radio-button>
        <el-radio-button value="feedback">已反馈</el-radio-button>
        <el-radio-button value="done">已归档</el-radio-button>
      </el-radio-group>
      <div style="flex:1"></div>
      <el-button @click="load">刷新</el-button>
    </div>

    <el-table :data="shown" v-loading="loading">
      <el-table-column label="患者" width="90"><template #default="{ row }"><b>{{ row.patientName }}</b></template></el-table-column>
      <el-table-column label="会诊原因" min-width="180" show-overflow-tooltip prop="reason" />
      <el-table-column label="受邀专家" min-width="140">
        <template #default="{ row }">{{ (row.specialists || []).map((s) => `${s.dept}·${s.expert}`).join('、') || '-' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)">{{ MDT_STATUS_LABELS[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发起时间" width="120"><template #default="{ row }">{{ fmtTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain :disabled="row.status === 'done'" @click="openFeedback(row)">专家反馈</el-button>
          <el-button size="small" type="success" plain :disabled="row.status !== 'feedback'" @click="openArchive(row)">归档</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!shown.length && !loading" description="暂无MDT会诊记录" />

    <!-- 反馈弹窗 -->
    <el-dialog v-model="fbVisible" title="专家反馈" width="440px">
      <el-form label-width="70px">
        <el-form-item label="科室">
          <el-input v-model="fbForm.dept" placeholder="如：内分泌科" />
        </el-form-item>
        <el-form-item label="专家">
          <el-input v-model="fbForm.expert" placeholder="如：刘强" />
        </el-form-item>
        <el-form-item label="意见">
          <el-input v-model="fbForm.opinion" type="textarea" :rows="3" placeholder="会诊意见与建议" />
        </el-form-item>
      </el-form>
      <div v-if="fbRow && (fbRow.feedbacks || []).length">
        <h5>已有反馈</h5>
        <div v-for="(f, i) in fbRow.feedbacks" :key="i" style="font-size:13px;color:#4e5969">
          <b>{{ f.dept }} {{ f.expert }}</b>：{{ f.opinion }}
        </div>
      </div>
      <template #footer>
        <el-button @click="fbVisible = false">取消</el-button>
        <el-button type="primary" @click="submitFeedback">提交反馈</el-button>
      </template>
    </el-dialog>

    <!-- 归档弹窗 -->
    <el-dialog v-model="arVisible" title="会诊结论归档" width="440px">
      <el-input v-model="arForm.conclusion" type="textarea" :rows="4" placeholder="MDT综合结论，归档后将写入患者健康档案" />
      <template #footer>
        <el-button @click="arVisible = false">取消</el-button>
        <el-button type="primary" @click="submitArchive">归档</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { fmtTime } from '../utils/format';
import { MDT_STATUS_LABELS } from '@flwb/shared';

const items = ref([]);
const shown = ref([]);
const loading = ref(false);
const statusFilter = ref('all');

const fbVisible = ref(false);
const fbRow = ref(null);
const fbForm = reactive({ dept: '', expert: '', opinion: '' });
const arVisible = ref(false);
const arRow = ref(null);
const arForm = reactive({ conclusion: '' });

function statusType(s) { return s === 'pending' ? 'danger' : s === 'feedback' ? 'warning' : 'success'; }
function filterItems() {
  shown.value = statusFilter.value === 'all' ? items.value : items.value.filter((x) => x.status === statusFilter.value);
}

async function load() {
  loading.value = true;
  try {
    const d = await api.mdtList();
    items.value = d.items;
    filterItems();
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

function openFeedback(row) {
  fbRow.value = row;
  fbForm.dept = '';
  fbForm.expert = '';
  fbForm.opinion = '';
  fbVisible.value = true;
}
async function submitFeedback() {
  if (!fbForm.dept || !fbForm.opinion) return ElMessage.warning('请填写科室与意见');
  await api.mdtAction(fbRow.value.patientId, { action: 'feedback', mdtId: fbRow.value.id, ...fbForm });
  ElMessage.success('反馈已提交');
  fbVisible.value = false;
  load();
}
function openArchive(row) {
  arRow.value = row;
  arForm.conclusion = '';
  arVisible.value = true;
}
async function submitArchive() {
  if (!arForm.conclusion.trim()) return ElMessage.warning('请填写会诊结论');
  await api.mdtAction(arRow.value.patientId, { action: 'archive', mdtId: arRow.value.id, conclusion: arForm.conclusion });
  ElMessage.success('已归档并写入患者健康档案');
  arVisible.value = false;
  load();
}

onMounted(load);
</script>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; }
</style>
