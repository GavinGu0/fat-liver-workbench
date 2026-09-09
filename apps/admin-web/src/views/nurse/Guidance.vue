<template>
  <el-row :gutter="12">
    <el-col :span="9">
      <div class="page-card">
        <h4 style="margin-top:0">✍️ 新建个案指导</h4>
        <el-form label-width="70px" size="default">
          <el-form-item label="患者">
            <el-select v-model="form.patientId" filterable placeholder="选择患者" style="width:100%">
              <el-option v-for="pt in patients" :key="pt.id" :label="`${pt.name}（${pt.age}岁 ${pt.gender === 'male' ? '男' : '女'}）`" :value="pt.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="指导方式">
            <el-select v-model="form.method" style="width:100%">
              <el-option v-for="m in methods" :key="m" :label="m" :value="m" />
            </el-select>
          </el-form-item>
          <el-form-item label="指导类别">
            <el-select v-model="form.category" style="width:100%">
              <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="指导内容">
            <el-input v-model="form.content" type="textarea" :rows="4" placeholder="指导要点，如：每日主食减半、餐后快走30分钟…" />
          </el-form-item>
          <el-form-item label="患者反馈">
            <el-input v-model="form.feedback" placeholder="患者反馈（选填）" />
          </el-form-item>
          <el-button type="primary" style="width:100%" :loading="saving" @click="save">保存并推送患者</el-button>
        </el-form>
      </div>
    </el-col>
    <el-col :span="15">
      <div class="page-card">
        <div style="display:flex;align-items:center;gap:8px" class="mb-12">
          <h4 style="margin:0">📒 指导记录</h4>
          <el-select v-model="filterPid" clearable placeholder="按患者过滤" size="small" style="width:160px" @change="load">
            <el-option v-for="pt in patients" :key="pt.id" :label="pt.name" :value="pt.id" />
          </el-select>
        </div>
        <el-table :data="records" v-loading="loading">
          <el-table-column label="时间" width="100"><template #default="{ row }">{{ fmtTime(row.ts) }}</template></el-table-column>
          <el-table-column label="类别" width="90"><template #default="{ row }"><el-tag size="small">{{ row.category }}</el-tag></template></el-table-column>
          <el-table-column label="方式" width="70" prop="method" />
          <el-table-column label="内容" min-width="200" show-overflow-tooltip prop="content" />
          <el-table-column label="反馈" min-width="110" show-overflow-tooltip prop="feedback" />
        </el-table>
        <el-empty v-if="!records.length && !loading" description="暂无指导记录" :image-size="60" />
      </div>
    </el-col>
  </el-row>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../../api';
import { fmtTime } from '../../utils/format';
import { GUIDANCE_METHODS, GUIDANCE_CATEGORIES } from '@flwb/shared';

const route = useRoute();
const methods = GUIDANCE_METHODS;
const categories = GUIDANCE_CATEGORIES;

const patients = ref([]);
const records = ref([]);
const loading = ref(false);
const saving = ref(false);
const filterPid = ref(route.query.patientId || '');
const form = reactive({ patientId: '', method: '电话', category: '饮食指导', content: '', feedback: '' });

async function load() {
  loading.value = true;
  try {
    const d = await api.guidance(filterPid.value ? { patientId: filterPid.value } : {});
    records.value = d.items;
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

async function save() {
  if (!form.patientId || !form.content.trim()) return ElMessage.warning('请选择患者并填写指导内容');
  saving.value = true;
  try {
    await api.createGuidance({ ...form });
    ElMessage.success('指导记录已保存并推送患者');
    form.content = '';
    form.feedback = '';
    load();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}

onMounted(async () => {
  const pl = await api.patients({ size: 100 });
  patients.value = pl.items;
  load();
});
</script>
