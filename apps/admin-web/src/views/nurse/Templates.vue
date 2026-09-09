<template>
  <el-row :gutter="12">
    <el-col :span="10">
      <div class="page-card">
        <h4 style="margin-top:0">📋 {{ tpl.name }}</h4>
        <el-alert type="info" :closable="false" style="margin-bottom:10px" :title="'标准化评估：按模板逐项确认，提交后自动生成结构化报告'" />
        <el-form label-width="110px" size="default">
          <template v-for="f in tpl.fields" :key="f.key">
            <el-form-item v-if="!f.showIf || answers[f.showIf.key] === f.showIf.eq" :label="f.label">
              <el-radio-group v-if="f.type === 'radio'" v-model="answers[f.key]">
                <el-radio v-for="o in f.options" :key="o" :value="o">{{ o }}</el-radio>
              </el-radio-group>
              <el-checkbox-group v-else-if="f.type === 'checkbox'" v-model="answers[f.key]">
                <el-checkbox v-for="o in f.options" :key="o" :value="o">{{ o }}</el-checkbox>
              </el-checkbox-group>
              <el-input-number v-else-if="f.type === 'number'" v-model="answers[f.key]" :min="0" style="width:160px" />
              <el-input v-else-if="f.type === 'textarea'" v-model="answers[f.key]" type="textarea" :rows="2" />
              <el-input v-else v-model="answers[f.key]" />
            </el-form-item>
          </template>
        </el-form>
        <el-form label-width="110px">
          <el-form-item label="评估患者">
            <el-select v-model="patientId" filterable placeholder="选择患者" style="width:100%">
              <el-option v-for="pt in patients" :key="pt.id" :label="pt.name" :value="pt.id" />
            </el-select>
          </el-form-item>
        </el-form>
        <el-button type="primary" style="width:100%" :loading="saving" @click="submit">生成评估报告</el-button>
      </div>
    </el-col>
    <el-col :span="14">
      <div class="page-card">
        <h4 style="margin-top:0">📄 我的评估历史</h4>
        <el-table :data="reports" v-loading="loading" @row-click="viewReport" style="cursor:pointer">
          <el-table-column label="时间" width="110"><template #default="{ row }">{{ fmtTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="患者" width="90" prop="patientName" />
          <el-table-column label="风险摘要" min-width="180" show-overflow-tooltip prop="summary" />
        </el-table>
        <el-empty v-if="!reports.length && !loading" description="暂无评估报告" :image-size="60" />
      </div>
    </el-col>

    <el-dialog v-model="rpVisible" title="评估报告" width="560px">
      <div class="report-html" v-html="rpHtml"></div>
      <template #footer>
        <el-button @click="rpVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </el-row>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import DOMPurify from 'dompurify';
import { api } from '../../api';
import { fmtTime } from '../../utils/format';

const tpl = reactive({ name: '', fields: [] });
const patients = ref([]);
const reports = ref([]);
const loading = ref(false);
const saving = ref(false);
const patientId = ref('');
const answers = reactive({});

const rpVisible = ref(false);
const rpHtml = ref('');

async function load() {
  loading.value = true;
  try {
    const [tpld, pl] = await Promise.all([api.templates(), api.patients({ size: 100 })]);
    tpl.name = tpld.template.name;
    tpl.fields = tpld.template.fields || [];
    tpl.fields.forEach((f) => {
      if (f.type === 'checkbox' && !answers[f.key]) answers[f.key] = [];
    });
    reports.value = tpld.reports;
    patients.value = pl.items;
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

async function submit() {
  if (!patientId.value) return ElMessage.warning('请选择患者');
  saving.value = true;
  try {
    const d = await api.submitAssessment({ patientId: patientId.value, answers: { ...answers } });
    ElMessage.success(`报告已生成：${d.summary}`);
    await viewReportById(d.reportId);
    load();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}

async function viewReport(row) {
  await viewReportById(row.id);
}
async function viewReportById(id) {
  const r = await api.report(id);
  rpHtml.value = DOMPurify.sanitize(r.html || '');
  rpVisible.value = true;
}

onMounted(load);
</script>
