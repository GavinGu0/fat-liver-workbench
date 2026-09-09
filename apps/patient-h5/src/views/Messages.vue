<template>
  <div>
    <div class="page-head"><h1>💬 消息中心</h1><p class="sub">宣教内容 / 复诊提醒 / 个案指导</p></div>

    <div style="padding:12px 12px 0;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;color:#9ca3af">共 {{ items.length }} 条</span>
      <span style="font-size:13px;color:var(--brand);cursor:pointer" @click="readAll">全部已读</span>
    </div>

    <div v-if="!items.length" class="empty">暂无消息</div>

    <div v-for="m in items" :key="m.mid" class="list-item" @click="open(m)">
      <div style="flex:1">
        <div class="title"><span v-if="!m.read" class="dot"></span>{{ m.title }}</div>
        <div class="desc">{{ typeLabel(m.type) }} · {{ m.from }} · {{ fmtTime(m.ts) }}</div>
      </div>
      <span style="color:#c7c9cd">›</span>
    </div>

    <div class="mask" v-if="current" @click.self="current = null">
      <div class="sheet">
        <h3>{{ current.title }}</h3>
        <p style="font-size:12px;color:#9ca3af;margin-bottom:10px">{{ typeLabel(current.type) }} · 来自 {{ current.from }} · {{ fmtTime(current.ts) }}</p>
        <div class="msg-html" v-html="html"></div>
        <button class="btn" @click="close">我已阅读</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { fmtTime } from '../utils';
import DOMPurify from 'dompurify';

const items = ref([]);
const current = ref(null);
const html = computed(() => (current.value ? DOMPurify.sanitize(current.value.content || '') : ''));

const TYPE_LABELS = {
  education: '健康宣教',
  revisit_reminder: '复诊提醒',
  guidance: '个案指导',
  followup: '随访提醒',
  system: '系统通知'
};
const typeLabel = (t) => TYPE_LABELS[t] || '通知';

async function load() {
  const d = await api.messages();
  items.value = d.items;
  if (d.followupToday && !sessionStorage.getItem('flwb_fu_popup_done')) {
    items.value.unshift({
      mid: '__followup__',
      type: 'followup',
      title: '⏰ 今日随访提醒',
      content: '<p>您的医生为您安排了今天的随访，请记得完成指标填报（体重/腹围/血压/血糖）。</p>',
      from: '系统',
      ts: Date.now(),
      read: true
    });
  }
}

async function open(m) {
  current.value = m;
  if (m.mid !== '__followup__' && !m.read) {
    try { await api.markRead(m.mid); m.read = true; } catch { /* 静默 */ }
  }
}

async function close() {
  if (current.value && current.value.mid === '__followup__') sessionStorage.setItem('flwb_fu_popup_done', '1');
  current.value = null;
  load();
}

async function readAll() {
  await api.markAllRead();
  items.value = items.value.map((m) => ({ ...m, read: true }));
}

onMounted(load);
</script>
