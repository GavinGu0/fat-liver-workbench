<template>
  <div class="page-card">
    <!-- 筛选栏 -->
    <div class="filters mb-12">
      <el-input v-model="q.keyword" placeholder="搜索姓名/手机号/诊断" style="width:220px" clearable @keyup.enter="load(1)" @clear="load(1)">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="q.risk" placeholder="风险等级" style="width:120px" clearable @change="load(1)">
        <el-option label="高风险" value="high" />
        <el-option label="中风险" value="mid" />
        <el-option label="低风险" value="low" />
      </el-select>
      <el-select v-model="q.filter" placeholder="快捷筛选" style="width:150px" clearable @change="load(1)">
        <el-option label="高风险患者" value="highRisk" />
        <el-option label="近30天未随访" value="notFollowed" />
        <el-option label="数据异常" value="abnormal" />
        <el-option label="7日未填报" value="notFilled7d" />
      </el-select>
      <el-button type="primary" @click="load(1)">查询</el-button>
      <div style="flex:1"></div>
      <el-button v-if="auth.isDoctor" type="warning" :disabled="!selected.length" @click="batchVisible = true">
        批量设置随访（{{ selected.length }}）
      </el-button>
    </div>

    <!-- 患者表格（左列表） -->
    <el-table :data="rows" v-loading="loading" @selection-change="(s) => (selected = s)" @row-click="(r) => $router.push(`/patients/${r.id}`)" style="cursor:pointer">
      <el-table-column v-if="auth.isDoctor" type="selection" width="42" />
      <el-table-column label="患者" min-width="110">
        <template #default="{ row }"><b>{{ row.name }}</b></template>
      </el-table-column>
      <el-table-column label="性别/年龄" width="90">
        <template #default="{ row }">{{ row.gender === 'male' ? '男' : '女' }} / {{ row.age }}</template>
      </el-table-column>
      <el-table-column label="风险等级" width="90" align="center"><template #default="{ row }"><RiskTag :risk="row.risk" /></template></el-table-column>
      <el-table-column label="体重/BMI" width="110">
        <template #default="{ row }">{{ row.lastWeight ?? '-' }}kg · {{ row.bmi ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="最近随访" width="110">
        <template #default="{ row }">{{ fmtTime(row.lastFollowupAt) }}</template>
      </el-table-column>
      <el-table-column label="下次随访" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.nextFollowupDate" size="small" :type="row.nextFollowupDate === today ? 'danger' : 'info'">{{ row.nextFollowupDate }}</el-tag>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="7日填报" width="80" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.filled7d ? 'success' : 'info'">{{ row.filled7d ? '已填报' : '未填报' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近活动" width="120">
        <template #default="{ row }">{{ fmtTime(row.lastActivityAt) }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      style="margin-top:12px;justify-content:flex-end"
      layout="total, prev, pager, next"
      :total="total" :page-size="q.size" :current-page="q.page"
      @current-change="(p) => load(p)"
    />

    <!-- 批量随访弹窗 -->
    <el-dialog v-model="batchVisible" title="批量设置随访日期" width="380px">
      <el-date-picker v-model="batchDate" type="date" value-format="YYYY-MM-DD" placeholder="选择随访日期" style="width:100%" />
      <el-input v-model="batchNote" placeholder="随访备注（选填）" style="margin-top:10px" />
      <template #footer>
        <el-button @click="batchVisible = false">取消</el-button>
        <el-button type="primary" :loading="batchLoading" @click="doBatch">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmtTime, todayStr } from '../utils/format';
import RiskTag from '../components/RiskTag.vue';

const route = useRoute();
const auth = useAuthStore();

const q = reactive({ keyword: '', risk: '', filter: route.query.filter || '', page: 1, size: 20 });
const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const today = todayStr();
const selected = ref([]);

const batchVisible = ref(false);
const batchDate = ref('');
const batchNote = ref('');
const batchLoading = ref(false);

async function load(page) {
  loading.value = true;
  try {
    if (page) q.page = page;
    const d = await api.patients({ ...q });
    rows.value = d.items;
    total.value = d.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function doBatch() {
  if (!batchDate.value) return ElMessage.warning('请选择日期');
  batchLoading.value = true;
  try {
    const d = await api.batchFollowup({ patientIds: selected.value.map((s) => s.id), date: batchDate.value, note: batchNote.value });
    ElMessage.success(`已为 ${d.updated} 名患者设置 ${d.date} 随访`);
    batchVisible.value = false;
    load();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    batchLoading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
