<template>
  <div class="page-card">
    <!-- 筛选 -->
    <div class="filters mb-12">
      <el-date-picker v-model="q.date" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:150px" @change="load" />
      <el-select v-model="q.status" style="width:130px" @change="load">
        <el-option label="全部状态" value="" />
        <el-option label="成功" value="success" />
        <el-option label="失败" value="fail" />
        <el-option label="锁定" value="lock" />
        <el-option label="密码重置" value="reset" />
      </el-select>
      <div style="flex:1"></div>
      <span v-if="stats" style="color:#86909c;font-size:12px">
        共 {{ stats.total }} 条 · 成功 {{ stats.success }} · 失败 {{ stats.fail }} · 锁定 {{ stats.lock }} · 重置 {{ stats.reset }}
      </span>
      <el-button :icon="Refresh" circle @click="load" />
    </div>

    <!-- 异常登录检测：失败集中 + 多账号同 IP（疑似撞库） -->
    <el-alert
      v-if="anomalies.length" type="warning" :closable="false" style="margin-bottom:12px"
      :title="`检出 ${anomalies.length} 项异常登录信号，请关注账号安全`"
    >
      <div v-for="(a, i) in anomalies" :key="i" style="font-size:12px;line-height:1.8">
        · {{ a }}
      </div>
    </el-alert>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column label="时间" width="140">
        <template #default="{ row }">{{ fmtTime(row.ts) }}</template>
      </el-table-column>
      <el-table-column label="账号" min-width="130">
        <template #default="{ row }">{{ row.account || '-' }}</template>
      </el-table-column>
      <el-table-column label="角色" width="80" align="center">
        <template #default="{ row }">{{ roleLabel(row.role) }}</template>
      </el-table-column>
      <el-table-column label="方式" width="80" align="center">
        <template #default="{ row }">{{ modeLabel(row.mode) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="tagType(row.status)">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="原因" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.reason || '-' }}</template>
      </el-table-column>
      <el-table-column label="IP" width="130" show-overflow-tooltip>
        <template #default="{ row }">{{ row.ip || '-' }}</template>
      </el-table-column>
      <el-table-column label="设备(UA)" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.ua || '-' }}</template>
      </el-table-column>
    </el-table>

    <p style="color:#86909c;font-size:12px;margin:10px 0 0">
      安全策略：15 分钟内密码连续错误 5 次将临时锁定账号 15 分钟；患者可通过短信验证码登录或重置密码自助解锁。日志按日保留最近 500 条，账号已脱敏展示。
    </p>
  </div>
</template>

<script setup>
import { computed, onActivated, onMounted, reactive, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '../api';
import { fmtTime, todayStr } from '../utils/format';

const q = reactive({ date: todayStr(), status: '' });
const rows = ref([]);
const stats = ref(null);
const loading = ref(false);

const anomalies = computed(() => {
  const list = [];
  if (!stats.value) return list;
  for (const t of stats.value.topFailed || []) {
    if (t.count >= 3) list.push(`账号 ${t.account} 当日失败 ${t.count} 次（疑似暴力破解，已达锁定阈值将自动防护）`);
  }
  for (const m of stats.value.multiAccountIps || []) {
    list.push(`IP ${m.ip} 尝试了 ${m.accounts.length} 个不同账号（${m.accounts.join('、')}，疑似撞库）`);
  }
  return list;
});

const roleLabel = (r) => ({ patient: '患者', doctor: '医生', nurse: '护士' }[r] || '-');
const modeLabel = (m) => ({ password: '密码', sms: '短信', register: '注册', reset: '重置' }[m] || m || '-');
const statusLabel = (s) => ({ success: '成功', fail: '失败', lock: '锁定', reset: '重置' }[s] || s);
const tagType = (s) => ({ success: 'success', fail: 'danger', lock: 'warning', reset: 'info' }[s] || 'info');

async function load() {
  loading.value = true;
  try {
    const d = await api.loginLogs({ date: q.date, status: q.status });
    rows.value = d.items || [];
    stats.value = d.stats || null;
  } catch (e) {
    rows.value = [];
    stats.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
onActivated(load);
</script>
