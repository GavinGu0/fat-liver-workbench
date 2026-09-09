<template>
  <el-row :gutter="12">
    <el-col :span="15">
      <div class="page-card">
        <h4 style="margin-top:0">1️⃣ 选择推送对象</h4>
        <el-input v-model="kw" placeholder="搜索患者姓名" size="small" style="width:200px;margin-bottom:8px" clearable />
        <el-table ref="tableRef" :data="patients" max-height="420" @selection-change="(s) => (selected = s)">
          <el-table-column type="selection" width="42" />
          <el-table-column label="患者" min-width="90"><template #default="{ row }"><b>{{ row.name }}</b></template></el-table-column>
          <el-table-column label="风险" width="90" align="center"><template #default="{ row }"><RiskTag :risk="row.risk" /></template></el-table-column>
          <el-table-column label="最近活动" width="110"><template #default="{ row }">{{ fmtTime(row.lastActivityAt) }}</template></el-table-column>
        </el-table>
      </div>
    </el-col>
    <el-col :span="9">
      <div class="page-card">
        <h4 style="margin-top:0">2️⃣ 选择宣教素材</h4>
        <div v-for="m in materials" :key="m.id" class="material" :class="{ active: chosen === m.id }" @click="chosen = m.id">
          <b>{{ m.title }}</b>
          <p>{{ m.summary }}</p>
        </div>
        <el-input v-model="note" placeholder="护士留言（选填，随素材一起推送）" style="margin:10px 0" />
        <el-button type="primary" style="width:100%" :loading="sending" :disabled="!chosen || !selected.length" @click="push">
          推送给 {{ selected.length }} 名患者
        </el-button>
        <el-button text style="width:100%;margin:6px 0 0" :disabled="!chosen" @click="preview">预览素材内容</el-button>
      </div>

      <div class="page-card" style="margin-top:12px">
        <h4 style="margin-top:0">📤 最近推送记录</h4>
        <div v-for="(h, i) in history" :key="i" class="todo-item">
          <span>{{ h.patientName }} · {{ h.materialTitle }}</span>
          <span style="color:#86909c;font-size:12px">{{ fmtTime(h.ts) }}</span>
        </div>
        <el-empty v-if="!history.length" description="暂无推送" :image-size="50" />
      </div>
    </el-col>

    <el-dialog v-model="pvVisible" title="素材预览" width="480px">
      <div class="report-html" v-html="pvHtml"></div>
    </el-dialog>
  </el-row>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import DOMPurify from 'dompurify';
import { api } from '../../api';
import { fmtTime } from '../../utils/format';
import RiskTag from '../../components/RiskTag.vue';

const patients = ref([]);
const selected = ref([]);
const materials = ref([]);
const history = ref([]);
const kw = ref('');
const chosen = ref('');
const note = ref('');
const sending = ref(false);
const pvVisible = ref(false);
const pvHtml = ref('');

async function load() {
  const [pl, ed] = await Promise.all([api.patients({ size: 100 }), api.education()]);
  patients.value = pl.items;
  materials.value = ed.materials;
  history.value = ed.history;
}

function preview() {
  const m = materials.value.find((x) => x.id === chosen.value);
  pvHtml.value = DOMPurify.sanitize(m.html || '');
  pvVisible.value = true;
}

async function push() {
  sending.value = true;
  try {
    const d = await api.pushEducation({ patientIds: selected.value.map((s) => s.id), materialId: chosen.value, note: note.value });
    ElMessage.success(`已推送 ${d.sent} 人${d.skipped.length ? `，${d.skipped.length} 人未注册账号已跳过` : ''}`);
    note.value = '';
    load();
  } catch (e) { ElMessage.error(e.message); } finally { sending.value = false; }
}

onMounted(load);
</script>

<style scoped>
.material {
  border: 1px solid #e5e6eb; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer;
}
.material.active { border-color: #1668dc; background: #f0f7ff; }
.material p { margin: 4px 0 0; color: #86909c; font-size: 12px; }
</style>
