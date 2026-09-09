<template>
  <div>
    <div class="page-head"><h1>📋 我的记录</h1><p class="sub">饮食 / 运动 / 指标 / 医护指导 全记录</p></div>

    <div style="padding:12px 12px 0">
      <div class="chips">
        <div class="chip" :class="{ active: !type }" @click="switchType('')">全部</div>
        <div class="chip" :class="{ active: type === 'diet' }" @click="switchType('diet')">饮食</div>
        <div class="chip" :class="{ active: type === 'exercise' }" @click="switchType('exercise')">运动</div>
        <div class="chip" :class="{ active: type === 'vitals' }" @click="switchType('vitals')">指标</div>
        <div class="chip" :class="{ active: type === 'guidance' }" @click="switchType('guidance')">指导</div>
      </div>
    </div>

    <div v-if="!items.length" class="empty">暂无记录，去首页填报吧</div>

    <div class="tl">
      <div v-for="r in items" :key="r.id || r.mid || r.ts" class="tl-item">
        <div class="tl-time">{{ fmtTime(r.ts) }}</div>
        <div class="tl-type">{{ typeLabel(r.type) }}</div>
        <div class="tl-body">{{ summary(r) }}</div>
        <img v-if="r.photoUrl && r.photoUrl.startsWith('data:')" :src="r.photoUrl" class="photo-preview" />
      </div>
    </div>

    <div v-if="nextBefore" style="text-align:center;padding:6px 0 16px">
      <button class="btn plain" style="width:50%;margin:0 auto" @click="more">加载更多</button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { fmtTime } from '../utils';
import { MEAL_LABELS, INTENSITY_LABELS } from '@flwb/shared';

const items = ref([]);
const type = ref('');
const nextBefore = ref(null);

const LABELS = { diet: '🍚 饮食', exercise: '🏃 运动', vitals: '💉 指标', guidance: '🧑‍⚕️ 医护指导', education: '📖 健康宣教', assessment: '📋 评估报告', labs: '🧪 检验结果' };
const typeLabel = (t) => LABELS[t] || '记录';

function summary(r) {
  switch (r.type) {
    case 'diet': return `${MEAL_LABELS[r.meal] || r.meal}：${(r.foods || []).map((f) => `${f.name}${f.grams}g`).join('、')}${r.note ? '（' + r.note + '）' : ''}`;
    case 'exercise': return `${r.exType || ''} ${r.minutes}分钟 · ${INTENSITY_LABELS[r.intensity] || r.intensity}强度${r.note ? '（' + r.note + '）' : ''}`;
    case 'vitals': {
      const parts = [];
      if (r.weight != null) parts.push(`体重 ${r.weight}kg`);
      if (r.waist != null) parts.push(`腹围 ${r.waist}cm`);
      if (r.sbp != null) parts.push(`血压 ${r.sbp}/${r.dbp}`);
      if (r.glucose != null) parts.push(`空腹血糖 ${r.glucose}`);
      return parts.join('，') || '指标记录';
    }
    case 'guidance': return `${r.category}（${r.method}）：${r.content}`;
    case 'education': return `${r.title || '健康宣教'}`;
    case 'assessment': return `${r.title || '评估报告'}：${r.summary || ''}`;
    case 'labs': return `检验结果（${r.examDate || ''}）`;
    default: return r.title || '记录';
  }
}

async function load(reset) {
  const params = { limit: 15 };
  if (type.value) params.types = type.value;
  if (!reset && nextBefore.value) params.before = nextBefore.value;
  const d = await api.myRecords(params);
  items.value = reset ? d.items : items.value.concat(d.items);
  nextBefore.value = d.nextBefore;
}

function switchType(t) { type.value = t; load(true); }
function more() { load(false); }

onMounted(() => load(true));
</script>
