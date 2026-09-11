<template>
  <div>
    <!-- 模块定位说明（对齐专病平台「专病建档」页首说明） -->
    <el-alert type="info" :closable="false" class="mb-12 intro-alert">
      复用电子病历，新建【脂肪肝专病管理表单】，嵌入现有电子病历。纳入后自动建立专病档案，支持院前筛查 - 院中建档 - 院内干预 - 院后随访全流程。
    </el-alert>

    <!-- 统计 + 工具条 -->
    <div class="page-card mb-12">
      <div class="toolbar">
        <div class="stat-chips">
          <div class="chip" :class="{ active: activeChip === 'archived' }" @click="applyChip('archived')">
            <span class="chip-num">{{ stats.archived }}</span><span class="chip-label">已建档</span>
          </div>
          <div class="chip chip-high" :class="{ active: activeChip === 'high' }" @click="applyChip('high')">
            <span class="chip-num">{{ stats.high }}</span><span class="chip-label">高风险</span>
          </div>
          <div class="chip chip-mid" :class="{ active: activeChip === 'mid' }" @click="applyChip('mid')">
            <span class="chip-num">{{ stats.mid }}</span><span class="chip-label">中风险</span>
          </div>
          <div class="chip chip-low" :class="{ active: activeChip === 'low' }" @click="applyChip('low')">
            <span class="chip-num">{{ stats.low }}</span><span class="chip-label">低风险</span>
          </div>
          <div class="chip chip-warn" :class="{ active: activeChip === 'incomplete' }" @click="applyChip('incomplete')">
            <span class="chip-num">{{ stats.incomplete }}</span><span class="chip-label">待完善</span>
          </div>
          <div class="chip chip-warn" :class="{ active: activeChip === 'pending' }" @click="applyChip('pending')">
            <span class="chip-num">{{ stats.pending }}</span><span class="chip-label">待建档</span>
          </div>
        </div>
        <div class="toolbar-right">
          <el-input
            v-model="query.keyword" placeholder="搜索姓名 / 手机号 / 门诊号" clearable
            style="width: 230px" @keyup.enter="reload" @clear="reload"
          >
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-select v-model="query.risk" placeholder="风险等级" clearable style="width: 120px" @change="reload">
            <el-option v-for="r in RISK_LEVELS" :key="r.value" :value="r.value" :label="r.label" />
          </el-select>
          <el-select v-model="query.status" style="width: 120px" @change="reload">
            <el-option value="archived" label="已建档" />
            <el-option value="incomplete" label="待完善" />
            <el-option value="pending" label="待建档" />
            <el-option value="all" label="全部患者" />
          </el-select>
          <el-button type="primary" @click="$router.push('/medical-records?mode=new')">
            <el-icon style="margin-right:4px"><Plus /></el-icon>新建档案
          </el-button>
        </div>
      </div>
    </div>

    <!-- 档案列表 -->
    <div class="page-card">
      <el-table v-loading="loading" :data="items" stripe>
        <el-table-column label="患者" min-width="150" fixed="left">
          <template #default="{ row }">
            <div class="pt-cell">
              <span class="pt-name">{{ row.name }}</span>
              <span class="pt-sub">{{ genderLabel(row.gender) }}<template v-if="row.age != null"> · {{ row.age }}岁</template></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="门诊号" min-width="110">
          <template #default="{ row }">{{ row.visitNumber || '-' }}</template>
        </el-table-column>
        <el-table-column label="住院号" min-width="110">
          <template #default="{ row }">{{ row.inpatientNumber || '-' }}</template>
        </el-table-column>
        <el-table-column label="BMI" width="80">
          <template #default="{ row }">{{ row.bmi ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="风险分层" width="100">
          <template #default="{ row }">
            <RiskTag v-if="row.risk" :risk="row.risk" />
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="随访情况" width="150">
          <template #default="{ row }">
            <div class="fu-cell">
              <span v-if="row.nextFollowupDate" class="fu-date">{{ row.nextFollowupDate }}</span>
              <span v-else class="fu-none">暂无随访</span>
              <el-tag
                v-if="row.followupStatus && row.followupStatus !== 'none'"
                size="small" effect="light" :type="fuTagType(row.followupStatus)"
              >{{ row.followupStatusLabel }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="档案状态" width="120">
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
        <el-table-column label="建档医生" width="100">
          <template #default="{ row }">{{ row.createdByName || '-' }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="160">
          <template #default="{ row }">
            <span v-if="row.updatedAt">{{ fmtTime(row.updatedAt) }}</span>
            <span v-else style="color:#86909c">未建档 · {{ fmtDate(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push(`/medical-records?patientId=${row.patientId}`)">
              {{ row.archived ? '查看 / 编辑' : '去建档' }}
            </el-button>
            <el-button link type="primary" @click="$router.push(`/patients/${row.patientId}`)">患者详情</el-button>
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
import { Search, Plus } from '@element-plus/icons-vue';
import { api } from '../api';
import { fmtTime, fmtDate } from '../utils/format';
import RiskTag from '../components/RiskTag.vue';
import { RISK_LEVELS } from '@flwb/shared';

const loading = ref(false);
const items = ref([]);
const total = ref(0);
const stats = ref({ archived: 0, pending: 0, incomplete: 0, high: 0, mid: 0, low: 0 });
const activeChip = ref('archived');
const query = reactive({ keyword: '', risk: '', status: 'archived', page: 1, size: 20 });

const genderLabel = (g) => (g === 'male' ? '男' : g === 'female' ? '女' : '-');

/** 随访状态 → 标签色：失访/逾期红色警示，今日/3日内橙色提醒，已预约蓝色 */
const FU_TAG_TYPES = { lost: 'danger', overdue: 'danger', today: 'warning', soon3d: 'warning', scheduled: 'info' };
const fuTagType = (s) => FU_TAG_TYPES[s] || 'info';

async function load() {
  loading.value = true;
  try {
    const d = await api.registryList({ ...query, keyword: query.keyword.trim() || undefined, risk: query.risk || undefined });
    items.value = d.items;
    total.value = d.total;
    stats.value = d.stats;
  } catch (e) {
    ElMessage.error(e.message);
  } finally { loading.value = false; }
}

function reload() { query.page = 1; load(); }

/** 统计卡片点击 → 联动筛选 */
function applyChip(chip) {
  activeChip.value = chip;
  query.risk = ['high', 'mid', 'low'].includes(chip) ? chip : '';
  query.status = chip === 'pending' ? 'pending' : chip === 'incomplete' ? 'incomplete' : chip === 'archived' ? 'archived' : 'all';
  reload();
}

onMounted(load);
onActivated(load);
</script>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.stat-chips { display: flex; gap: 10px; flex-wrap: wrap; }
.chip {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  min-width: 76px; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  background: #f7f8fa; border: 1px solid transparent; transition: all .15s;
  user-select: none;
}
.chip:hover { background: #f0f2f5; }
.chip.active { border-color: #1668dc; background: #e8f1fd; }
.chip-num { font-size: 20px; font-weight: 700; color: #1d2129; line-height: 1.2; }
.chip-label { font-size: 12px; color: #86909c; }
.chip-high.active { border-color: #f56c6c; background: #fef0f0; }
.chip-high.active .chip-num { color: #f56c6c; }
.chip-mid.active { border-color: #e6a23c; background: #fdf6ec; }
.chip-mid.active .chip-num { color: #e6a23c; }
.chip-low.active { border-color: #67c23a; background: #f0f9eb; }
.chip-low.active .chip-num { color: #67c23a; }
.chip-warn.active { border-color: #ff7d00; background: #fff3e8; }
.chip-warn.active .chip-num { color: #ff7d00; }
.toolbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pt-cell { display: flex; flex-direction: column; line-height: 1.4; }
.pt-name { font-weight: 600; color: #1d2129; }
.pt-sub { font-size: 12px; color: #86909c; }
.fu-cell { display: flex; flex-direction: column; line-height: 1.4; gap: 2px; align-items: flex-start; }
.fu-date { color: #4e5969; }
.fu-none { color: #86909c; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
