<template>
  <div>
    <!-- 模块定位说明（对齐专病平台「专病建档」页首说明） -->
    <el-alert type="info" :closable="false" class="mb-12 intro-alert">
      复用电子病历，新建【脂肪肝专病管理表单】，嵌入现有电子病历。纳入后自动建立专病档案，支持院前筛查 - 院中建档 - 院内干预 - 院后随访全流程。
    </el-alert>

    <!-- 统计卡片 + 新建入口 -->
    <div class="page-card mb-12">
      <div class="toolbar">
        <div class="stat-chips">
          <div class="chip" :class="{ active: query.status === 'archived' }" @click="applyChip('archived')">
            <span class="chip-num">{{ stats.archived }}</span><span class="chip-label">已建档</span>
          </div>
          <div class="chip" :class="{ active: query.status === 'pending' }" @click="applyChip('pending')">
            <span class="chip-num">{{ stats.pending }}</span><span class="chip-label">待建档</span>
          </div>
          <div class="chip chip-warn" :class="{ active: query.status === 'incomplete' }" @click="applyChip('incomplete')">
            <span class="chip-num">{{ stats.incomplete }}</span><span class="chip-label">待完善</span>
          </div>
        </div>
        <el-button type="primary" @click="$router.push('/medical-records?mode=new')">
          <el-icon style="margin-right:4px"><Plus /></el-icon>新建档案
        </el-button>
      </div>
    </div>

    <!-- 档案列表 -->
    <div class="page-card">
      <el-table v-loading="loading" :data="items" stripe>
        <el-table-column label="姓名" min-width="120" fixed="left">
          <template #default="{ row }">
            <div class="pt-cell">
              <span class="pt-name">{{ row.name }}</span>
              <span class="pt-sub"><template v-if="row.age != null">{{ row.age }}岁</template></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="门诊号" min-width="130">
          <template #default="{ row }">{{ row.visitNumber || '-' }}</template>
        </el-table-column>
        <el-table-column label="性别" width="70">
          <template #default="{ row }">{{ genderLabel(row.gender) }}</template>
        </el-table-column>
        <el-table-column label="BMI" width="80">
          <template #default="{ row }">{{ row.bmi ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="风险" width="100">
          <template #default="{ row }">
            <RiskTag v-if="row.risk" :risk="row.risk" />
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="纳入" width="120">
          <template #default="{ row }">
            <span v-if="row.archivedAt">{{ fmtDate(row.archivedAt) }}</span>
            <span v-else class="td-dim">未纳入</span>
          </template>
        </el-table-column>
        <el-table-column label="处理情况" width="130">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.archived && row.incomplete"
              placement="top"
              :content="`缺少关键信息或检验：${(row.missingItems || []).join('、')}`"
            >
              <el-tag type="warning" size="small" effect="light">待完善 v{{ row.version }}</el-tag>
            </el-tooltip>
            <el-tag v-else-if="row.archived" type="success" size="small" effect="light">已建档 v{{ row.version }}</el-tag>
            <el-tag v-else type="info" size="small" effect="light">待建档</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push(`/patients/${row.patientId}`)">详情</el-button>
            <el-button link type="primary" @click="$router.push(`/medical-records?patientId=${row.patientId}`)">
              {{ row.archived ? '编辑' : '去建档' }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无档案数据" :image-size="80" />
        </template>
      </el-table>
      <div class="pager">
        <el-pagination
          background layout="total, prev, pager, next, sizes" :total="total"
          v-model:current-page="query.page" v-model:page-size="query.size"
          :page-sizes="[10, 20, 50]" @current-change="load" @size-change="reload"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onActivated } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { api } from '../api';
import { fmtDate } from '../utils/format';
import RiskTag from '../components/RiskTag.vue';

const loading = ref(false);
const items = ref([]);
const total = ref(0);
const stats = ref({ archived: 0, pending: 0, incomplete: 0 });
const query = reactive({ status: 'archived', page: 1, size: 20 });

const genderLabel = (g) => (g === 'male' ? '男' : g === 'female' ? '女' : '-');

async function load() {
  loading.value = true;
  try {
    const d = await api.registryList({ status: query.status, page: query.page, size: query.size });
    items.value = d.items;
    total.value = d.total;
    stats.value = d.stats;
  } catch (e) {
    ElMessage.error(e.message);
  } finally { loading.value = false; }
}

function reload() { query.page = 1; load(); }

/** 统计卡片点击 → 联动筛选（与原型一致：三卡片切换） */
function applyChip(chip) {
  if (query.status === chip) return;
  query.status = chip;
  reload();
}

onMounted(load);
onActivated(load);
</script>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.stat-chips { display: flex; gap: 12px; flex-wrap: wrap; }
.chip {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  min-width: 96px; padding: 10px 18px; border-radius: 8px; cursor: pointer;
  background: #f7f8fa; border: 1px solid transparent; transition: all .15s;
  user-select: none;
}
.chip:hover { background: #f0f2f5; }
.chip.active { border-color: #1668dc; background: #e8f1fd; }
.chip-num { font-size: 22px; font-weight: 700; color: #1d2129; line-height: 1.2; }
.chip-label { font-size: 12px; color: #86909c; }
.chip-warn.active { border-color: #ff7d00; background: #fff3e8; }
.chip-warn.active .chip-num { color: #ff7d00; }
.pt-cell { display: flex; flex-direction: column; line-height: 1.4; }
.pt-name { font-weight: 600; color: #1d2129; }
.pt-sub { font-size: 12px; color: #86909c; }
.td-dim { color: #86909c; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
