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
        <el-tabs v-model="tab">
          <el-tab-pane label="推送素材" name="push">
            <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
              <el-select v-model="pushCategory" placeholder="全部分类" size="small" clearable style="width:120px">
                <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
              </el-select>
              <el-input v-model="pushKw" placeholder="搜索标题/标签" size="small" style="flex:1;min-width:120px" clearable />
            </div>
            <div v-for="m in pushMaterials" :key="m.id" class="material" :class="{ active: chosen === m.id }" @click="chosen = m.id">
              <div style="display:flex;align-items:center;gap:6px">
                <b style="flex:1">{{ m.title }}</b>
                <el-tag size="small" type="info">{{ m.category || '其他' }}</el-tag>
              </div>
              <p>{{ m.summary }}</p>
              <div v-if="m.tags && m.tags.length" class="tags">
                <span v-for="t in m.tags" :key="t" class="tag">#{{ t }}</span>
              </div>
            </div>
            <el-empty v-if="!pushMaterials.length" description="暂无可用素材" :image-size="50" />
            <el-input v-model="note" placeholder="护士留言（选填，随素材一起推送）" style="margin:10px 0" />
            <el-button type="primary" style="width:100%" :loading="sending" :disabled="!chosen || !selected.length" @click="push">
              推送给 {{ selected.length }} 名患者
            </el-button>
            <el-button text style="width:100%;margin:6px 0 0" :disabled="!chosen" @click="preview(chosen)">预览素材内容</el-button>
          </el-tab-pane>

          <el-tab-pane :label="`模板管理（${stats.custom || 0}）`" name="manage">
            <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
              <el-select v-model="mgmtCategory" placeholder="全部分类" size="small" clearable style="width:120px">
                <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
              </el-select>
              <el-input v-model="mgmtKw" placeholder="搜索标题/标签" size="small" style="flex:1;min-width:120px" clearable />
              <el-button type="primary" size="small" @click="openEditor(null)">新建模板</el-button>
            </div>
            <div v-for="m in mgmtMaterials" :key="m.id" class="material manage-row" :class="{ disabled: m.enabled === false }">
              <div style="display:flex;align-items:center;gap:6px">
                <b style="flex:1">{{ m.title }}</b>
                <el-tag size="small" :type="m.isCustom ? 'primary' : 'info'" effect="plain">{{ m.isCustom ? '自定义' : '固定' }}</el-tag>
                <el-tag v-if="m.enabled === false" size="small" type="danger">已禁用</el-tag>
              </div>
              <p>{{ m.summary || '（无摘要）' }}</p>
              <div v-if="m.tags && m.tags.length" class="tags">
                <span v-for="t in m.tags" :key="t" class="tag">#{{ t }}</span>
              </div>
              <div class="row-actions">
                <el-button size="small" text type="primary" @click="preview(m.id)">预览</el-button>
                <template v-if="m.isCustom">
                  <el-button size="small" text type="primary" @click="openEditor(m)">编辑</el-button>
                  <el-button size="small" text :type="m.enabled === false ? 'success' : 'warning'" @click="toggle(m)">
                    {{ m.enabled === false ? '启用' : '禁用' }}
                  </el-button>
                  <el-button v-if="m.versionCount > 1" size="small" text @click="openVersions(m)">v{{ m.version }} 历史</el-button>
                  <el-button size="small" text type="danger" @click="remove(m)">删除</el-button>
                </template>
                <span v-else style="color:#c9cdd4;font-size:12px">固定模板不可编辑</span>
              </div>
            </div>
            <el-empty v-if="!mgmtMaterials.length" description="暂无模板" :image-size="50" />
          </el-tab-pane>
        </el-tabs>
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

    <!-- 素材预览 -->
    <el-dialog v-model="pvVisible" title="素材预览" width="480px">
      <div class="report-html" v-html="pvHtml"></div>
    </el-dialog>

    <!-- 新建/编辑模板 -->
    <el-dialog v-model="edVisible" :title="editing.id ? `编辑模板（当前 v${editing.version || 1}）` : '新建宣教模板'" width="560px">
      <el-form label-width="76px">
        <el-form-item label="标题" required>
          <el-input v-model="editing.title" maxlength="50" show-word-limit placeholder="如：脂肪肝患者节日饮食指南" />
        </el-form-item>
        <el-form-item label="摘要">
          <el-input v-model="editing.summary" maxlength="100" show-word-limit placeholder="一句话说明适用人群/场景" />
        </el-form-item>
        <el-form-item label="分类" required>
          <el-select v-model="editing.category" style="width:160px">
            <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签">
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <el-tag v-for="(t, i) in editing.tags" :key="t + i" closable @close="editing.tags.splice(i, 1)">#{{ t }}</el-tag>
            <el-input
              v-if="editing.tags.length < 6"
              v-model="tagInput" size="small" style="width:120px" maxlength="12"
              placeholder="输入后回车" @keyup.enter="addTag"
            />
          </div>
          <p style="color:#86909c;font-size:12px;margin:4px 0 0">最多6个标签，便于按主题快速检索</p>
        </el-form-item>
        <el-form-item label="正文内容" required>
          <el-input v-model="editing.html" type="textarea" :rows="8" maxlength="30000" show-word-limit placeholder="支持简单 HTML（h3/p/ul/li/b 等标签）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="edVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingTpl" @click="saveTpl">
          {{ editing.id ? '保存（生成新版本）' : '创建模板' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 版本历史 -->
    <el-dialog v-model="verVisible" :title="`版本历史：${verTarget.title || ''}`" width="520px">
      <el-timeline style="padding-left:6px">
        <el-timeline-item :timestamp="fmtTime(v.updatedAt)">
          <b>当前版本 v{{ verTarget.version }}</b> · {{ verTarget.title }}（{{ verTarget.updatedBy || '系统' }}）
        </el-timeline-item>
        <el-timeline-item v-for="v in verTarget.versions || []" :key="v.version" :timestamp="fmtTime(v.updatedAt)">
          <b>v{{ v.version }}</b> · {{ v.title }}（{{ v.updatedBy || '系统' }}）
          <el-button size="small" text type="primary" style="margin-left:8px" @click="previewVersion(v)">查看内容</el-button>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-if="!(verTarget.versions || []).length" description="暂无历史版本（首次创建）" :image-size="60" />
    </el-dialog>
  </el-row>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import DOMPurify from 'dompurify';
import { api } from '../../api';
import { fmtTime } from '../../utils/format';
import RiskTag from '../../components/RiskTag.vue';

const patients = ref([]);
const selected = ref([]);
const history = ref([]);
const kw = ref('');
const chosen = ref('');
const note = ref('');
const sending = ref(false);
const pvVisible = ref(false);
const pvHtml = ref('');

/* 模板管理状态 */
const tab = ref('push');
const materials = ref([]);
const categories = ref(['饮食宣教', '运动指导', '戒酒限酒', '用药安全', '复查随访', '心理调适', '其他']);
const stats = reactive({ total: 0, custom: 0, enabled: 0, disabled: 0 });
const pushCategory = ref('');
const pushKw = ref('');
const mgmtCategory = ref('');
const mgmtKw = ref('');
const edVisible = ref(false);
const savingTpl = ref(false);
const editing = reactive({ id: '', title: '', summary: '', category: '其他', tags: [], html: '', version: 1 });
const tagInput = ref('');
const verVisible = ref(false);
const verTarget = reactive({ title: '', version: 1, versions: [] });

const matchKw = (m, kw) => {
  if (!kw) return true;
  const s = kw.trim().toLowerCase();
  return [m.title, m.summary, ...(m.tags || [])].filter(Boolean).some((v) => String(v).toLowerCase().includes(s));
};

/* 推送视图：仅启用模板 */
const pushMaterials = computed(() =>
  materials.value.filter((m) => m.enabled !== false && (!pushCategory.value || m.category === pushCategory.value) && matchKw(m, pushKw.value))
);

/* 管理视图：全量模板 */
const mgmtMaterials = computed(() =>
  materials.value.filter((m) => (!mgmtCategory.value || m.category === mgmtCategory.value) && matchKw(m, mgmtKw.value))
);

async function load() {
  const [pl, ed, mt] = await Promise.all([api.patients({ size: 100 }), api.education(), api.materials()]);
  patients.value = pl.items;
  history.value = ed.history;
  materials.value = mt.materials;
  categories.value = mt.categories || categories.value;
  Object.assign(stats, mt.stats || {});
  if (!chosen.value && pushMaterials.value.length) chosen.value = pushMaterials.value[0].id;
}

function preview(id) {
  const m = materials.value.find((x) => x.id === id);
  if (!m) return;
  pvHtml.value = DOMPurify.sanitize(m.html || '');
  pvVisible.value = true;
}

function previewVersion(v) {
  pvHtml.value = DOMPurify.sanitize(v.html || '');
  pvVisible.value = true;
}

function openEditor(m) {
  editing.id = m ? m.id : '';
  editing.title = m ? m.title : '';
  editing.summary = m ? (m.summary || '') : '';
  editing.category = m ? (m.category || '其他') : '其他';
  editing.tags = m ? [...(m.tags || [])] : [];
  editing.html = m ? m.html : '';
  editing.version = m ? m.version || 1 : 1;
  tagInput.value = '';
  edVisible.value = true;
}

function addTag() {
  const t = tagInput.value.trim();
  if (!t) return;
  if (editing.tags.includes(t)) return ElMessage.warning('标签已存在');
  if (editing.tags.length >= 6) return ElMessage.warning('最多6个标签');
  editing.tags.push(t);
  tagInput.value = '';
}

async function saveTpl() {
  if (!editing.title.trim()) return ElMessage.warning('请填写模板标题');
  if (!editing.html || editing.html.trim().length < 5) return ElMessage.warning('请填写模板内容（至少5个字符）');
  savingTpl.value = true;
  try {
    const payload = { title: editing.title.trim(), summary: editing.summary.trim(), html: editing.html, category: editing.category, tags: editing.tags };
    if (editing.id) {
      await api.updateMaterial({ id: editing.id, ...payload });
      ElMessage.success('模板已更新，生成新版本');
    } else {
      await api.createMaterial(payload);
      ElMessage.success('模板已创建');
    }
    edVisible.value = false;
    load();
  } catch (e) { ElMessage.error(e.message); } finally { savingTpl.value = false; }
}

async function toggle(m) {
  try {
    const d = await api.toggleMaterial(m.id);
    ElMessage.success(d.enabled ? '模板已启用' : '模板已禁用（不再出现在推送素材中）');
    load();
  } catch (e) { ElMessage.error(e.message); }
}

async function remove(m) {
  try {
    await ElMessageBox.confirm(`删除模板「${m.title}」？该操作不可恢复（历史版本一并删除）。`, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
    await api.deleteMaterial(m.id);
    ElMessage.success('模板已删除');
    load();
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}

function openVersions(m) {
  verTarget.title = m.title;
  verTarget.version = m.version || 1;
  verTarget.versions = m.versions || [];
  verVisible.value = true;
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
.material.manage-row { cursor: default; }
.material.disabled { opacity: 0.6; }
.material p { margin: 4px 0 0; color: #86909c; font-size: 12px; }
.tags { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.tag { font-size: 11px; color: #1668dc; background: #f0f7ff; border-radius: 4px; padding: 1px 6px; }
.row-actions { display: flex; gap: 2px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
</style>
