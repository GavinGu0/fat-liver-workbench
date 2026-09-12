<template>
  <div class="page-card">
    <!-- 统计标签 + 筛选 -->
    <div class="filters mb-12">
      <el-radio-group v-model="q.status" @change="load">
        <el-radio-button value="">全部（{{ stats.total }}）</el-radio-button>
        <el-radio-button value="overdue">逾期（{{ stats.overdue }}）</el-radio-button>
        <el-radio-button value="today">今日（{{ stats.today }}）</el-radio-button>
        <el-radio-button value="soon3d">3日内（{{ stats.soon3d }}）</el-radio-button>
        <el-radio-button value="scheduled">已预约（{{ stats.scheduled }}）</el-radio-button>
        <el-radio-button value="none">未安排（{{ stats.none }}）</el-radio-button>
        <el-radio-button value="lost">已失访（{{ stats.lost }}）</el-radio-button>
      </el-radio-group>
      <el-input v-model="q.keyword" placeholder="搜索姓名/手机号" style="width:200px" clearable @keyup.enter="load" @clear="load">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <div style="flex:1"></div>
      <el-button type="info" plain @click="openLog">📨 提醒发送日志</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" @row-click="(r) => $router.push(`/patients/${r.patientId}`)" style="cursor:pointer">
      <el-table-column label="患者" min-width="110">
        <template #default="{ row }"><b>{{ row.name }}</b> <span style="color:#86909c;font-size:12px">{{ row.gender === 'male' ? '男' : '女' }}/{{ row.age }}岁</span></template>
      </el-table-column>
      <el-table-column label="风险" width="86" align="center"><template #default="{ row }"><RiskTag :risk="row.risk" /></template></el-table-column>
      <el-table-column label="联系电话" width="120">
        <template #default="{ row }">{{ maskPhone(row.phone) }}</template>
      </el-table-column>
      <el-table-column label="随访日期" width="110">
        <template #default="{ row }">{{ row.nextFollowupDate || '-' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="tagType(row.status)">{{ row.statusLabel }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近随访" width="150">
        <template #default="{ row }">
          <span v-if="row.lastFollowupAt">{{ row.lastFollowupMethod || '已随访' }} · {{ fmtTime(row.lastFollowupAt) }}</span>
          <span v-else style="color:#86909c">从未随访</span>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.followupNote || row.lostReason || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="270" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status !== 'lost'">
            <el-button size="small" type="primary" text @click.stop="openExecute(row)">执行随访</el-button>
            <el-button size="small" type="success" text @click.stop="remind(row)">发提醒</el-button>
            <el-button size="small" text @click.stop="openRecords(row)">记录</el-button>
            <el-button size="small" text @click.stop="openReschedule(row)">改期</el-button>
            <el-button size="small" type="danger" text @click.stop="markLost(row)">失访</el-button>
          </template>
          <el-tag v-else size="small" type="info">失访：{{ row.lostReason }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <!-- 执行随访 -->
    <el-dialog v-model="execVisible" title="执行随访" width="460px">
      <el-descriptions v-if="current.patientId" :column="2" size="small" style="margin-bottom:12px">
        <el-descriptions-item label="患者">{{ current.name }}</el-descriptions-item>
        <el-descriptions-item label="随访日期">{{ current.nextFollowupDate || '未排期' }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="80px">
        <el-form-item label="随访方式" required>
          <el-radio-group v-model="execForm.method">
            <el-radio-button v-for="m in ['电话', '微信', '门诊', '住院']" :key="m" :value="m">{{ m }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="随访结果" required>
          <el-input v-model="execForm.outcome" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="如：体重82kg（-2.5kg），血压达标，已调整饮食方案" />
        </el-form-item>
        <el-form-item label="结论">
          <el-input v-model="execForm.conclusion" type="textarea" :rows="2" maxlength="500" placeholder="如：继续当前干预，1个月后复查肝功能" />
        </el-form-item>
        <el-form-item label="下次随访">
          <el-date-picker v-model="execForm.nextDate" type="date" value-format="YYYY-MM-DD" placeholder="留空按风险周期自动排期" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="execVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveExecute">完成随访</el-button>
      </template>
    </el-dialog>

    <!-- 随访执行记录 -->
    <el-dialog v-model="recVisible" :title="`随访执行记录：${current.name || ''}`" width="560px">
      <el-empty v-if="!records.length" description="暂无执行记录" :image-size="70" />
      <el-timeline v-else style="padding-left:6px;max-height:420px;overflow:auto">
        <el-timeline-item v-for="(r, i) in records" :key="i" :timestamp="`${fmtTime(r.ts)} · 计划 ${r.dueDate || '-'}`">
          <b>{{ r.method }}</b>
          <p style="margin:4px 0 0;color:#4e5969">{{ r.outcome }}</p>
          <p v-if="r.conclusion" style="margin:2px 0 0;color:#86909c;font-size:12px">结论：{{ r.conclusion }}</p>
          <p v-if="r.nextDate" style="margin:2px 0 0;color:#86909c;font-size:12px">下次随访：{{ r.nextDate }}</p>
          <p style="margin:2px 0 0;color:#86909c;font-size:12px">执行人：{{ r.by }}</p>
        </el-timeline-item>
      </el-timeline>
    </el-dialog>

    <!-- 改期 -->
    <el-dialog v-model="reschedVisible" title="调整随访日期" width="380px">
      <el-date-picker v-model="reschedDate" type="date" value-format="YYYY-MM-DD" placeholder="新随访日期" style="width:100%" />
      <el-input v-model="reschedNote" placeholder="备注（选填）" style="margin-top:10px" />
      <template #footer>
        <el-button @click="reschedVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveReschedule">保存</el-button>
      </template>
    </el-dialog>

    <!-- 提醒发送日志 -->
    <el-dialog v-model="logVisible" title="📨 提醒发送日志" width="760px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <el-date-picker v-model="logDate" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:150px" @change="loadLog" />
        <el-select v-model="logStatus" style="width:130px" @change="loadLog">
          <el-option label="全部状态" value="" />
          <el-option label="已送达" value="sent" />
          <el-option label="发送失败" value="failed" />
          <el-option label="部分成功" value="partial" />
          <el-option label="已跳过" value="skipped" />
        </el-select>
        <div style="flex:1"></div>
        <span v-if="logStats" style="color:#86909c;font-size:12px">
          送达 {{ logStats.sent }} · 失败 {{ logStats.failed }} · 跳过 {{ logStats.skipped }} · 待重试 {{ logStats.pending }}
        </span>
      </div>
      <el-table :data="logRows" v-loading="logLoading" max-height="380" size="small">
        <el-table-column label="时间" width="140">
          <template #default="{ row }">{{ fmtTime(row.ts) }}</template>
        </el-table-column>
        <el-table-column label="患者" width="90">
          <template #default="{ row }">{{ row.patientName || row.patientId || '-' }}</template>
        </el-table-column>
        <el-table-column label="业务" width="120">
          <template #default="{ row }">{{ logBizLabel(row.bizType) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="logTagType(row.status)">{{ logStatusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="center">
          <template #default="{ row }">
            <el-button v-if="row.status === 'failed' || row.status === 'partial'" size="small" type="primary" text @click="resend(row)">重发</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p style="color:#86909c;font-size:12px;margin:8px 0 0">
        失败提醒将按 30秒/5分钟/30分钟 间隔自动重试（最多3次），超限自动向主管医生推送告警。短信通道需配置 SMS_KEY，未配置时仅站内信送达。
      </p>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onActivated } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import { fmtTime, todayStr } from '../utils/format';
import RiskTag from '../components/RiskTag.vue';

const q = reactive({ status: '', keyword: '' });
const rows = ref([]);
const stats = reactive({ total: 0, overdue: 0, today: 0, soon3d: 0, scheduled: 0, none: 0, lost: 0 });
const loading = ref(false);
const saving = ref(false);

const current = reactive({ patientId: '', name: '' });
const execVisible = ref(false);
const execForm = reactive({ method: '电话', outcome: '', conclusion: '', nextDate: '' });
const recVisible = ref(false);
const records = ref([]);
const reschedVisible = ref(false);
const reschedDate = ref('');
const reschedNote = ref('');

/* 提醒发送日志 */
const logVisible = ref(false);
const logLoading = ref(false);
const logRows = ref([]);
const logStats = ref(null);
const logDate = ref(todayStr());
const logStatus = ref('');
const logBizLabels = {
  followup_remind: '每日随访提醒',
  followup_pre_remind: '3日预提醒',
  followup_remind_manual: '医生手动提醒',
  education_push: '宣教推送'
};
const logStatusLabel = (s) => ({ sent: '已送达', failed: '失败', partial: '部分成功', skipped: '已跳过', pending: '发送中', retrying: '重试中' }[s] || s);
const logTagType = (s) => ({ sent: 'success', failed: 'danger', partial: 'warning', skipped: 'info', pending: 'info', retrying: 'warning' }[s] || 'info');
const logBizLabel = (b) => logBizLabels[b] || (b || '').replace(/_resend$/, '（重发）');

function openLog() {
  logVisible.value = true;
  loadLog();
}
async function loadLog() {
  logLoading.value = true;
  try {
    const d = await api.remindLog({ date: logDate.value, status: logStatus.value || undefined });
    logRows.value = d.items;
    logStats.value = d.stats;
  } catch (e) { ElMessage.error(e.message); } finally { logLoading.value = false; }
}
async function resend(row) {
  try {
    await api.remindResend(row.id);
    ElMessage.success('已重新发送');
    loadLog();
  } catch (e) { ElMessage.error(e.message); }
}

const tagType = (s) => ({ overdue: 'danger', today: 'danger', soon3d: 'warning', scheduled: 'primary', none: 'info', lost: 'info' }[s] || 'info');
const maskPhone = (s) => (s ? String(s).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '-');

async function load() {
  loading.value = true;
  try {
    const d = await api.followups({ status: q.status || undefined, keyword: q.keyword || undefined });
    rows.value = d.items;
    Object.assign(stats, d.stats);
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

function openExecute(row) {
  current.patientId = row.patientId; current.name = row.name;
  execForm.method = '电话'; execForm.outcome = ''; execForm.conclusion = ''; execForm.nextDate = '';
  execVisible.value = true;
}
async function saveExecute() {
  if (!execForm.outcome.trim()) return ElMessage.warning('请填写随访结果');
  saving.value = true;
  try {
    const d = await api.followupExecute(current.patientId, { ...execForm, nextDate: execForm.nextDate || undefined });
    ElMessage.success(`随访已记录，下次随访：${d.nextFollowupDate}`);
    execVisible.value = false;
    load();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}

async function remind(row) {
  try {
    const d = await api.followupRemind({ patientIds: [row.patientId] });
    if (d.sent > 0) ElMessage.success(`提醒已发送给 ${row.name}`);
    else ElMessage.warning((d.skipped[0] && d.skipped[0].reason) || '患者未绑定小程序账号');
  } catch (e) { ElMessage.error(e.message); }
}

async function openRecords(row) {
  current.patientId = row.patientId; current.name = row.name;
  recVisible.value = true;
  try {
    const d = await api.followupRecords(row.patientId);
    records.value = d.records;
  } catch (e) { ElMessage.error(e.message); }
}

function openReschedule(row) {
  current.patientId = row.patientId; current.name = row.name;
  reschedDate.value = row.nextFollowupDate || '';
  reschedNote.value = row.followupNote || '';
  reschedVisible.value = true;
}
async function saveReschedule() {
  if (!reschedDate.value) return ElMessage.warning('请选择日期');
  saving.value = true;
  try {
    await api.setFollowup(current.patientId, { date: reschedDate.value, note: reschedNote.value });
    ElMessage.success('随访日期已更新');
    reschedVisible.value = false;
    load();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}

async function markLost(row) {
  try {
    const { value } = await ElMessageBox.prompt('失访原因（必填）', `标记失访：${row.name}`, {
      inputType: 'textarea', inputPlaceholder: '如：迁居外地，联系方式失效', confirmButtonText: '确认失访', cancelButtonText: '取消'
    });
    if (!value || value.trim().length < 2) return ElMessage.warning('请填写失访原因');
    await api.followupLost(row.patientId, { reason: value });
    ElMessage.success('已标记失访');
    load();
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}

onMounted(load);
onActivated(load);
</script>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
