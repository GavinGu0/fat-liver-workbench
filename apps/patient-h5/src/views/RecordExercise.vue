<template>
  <div>
    <div class="page-head"><h1>🏃 运动记录</h1><p class="sub">管住嘴，迈开腿</p></div>
    <div class="card">
      <div class="field">
        <label>运动类型</label>
        <div class="chips">
          <div v-for="t in types" :key="t" class="chip" :class="{ active: form.type === t }" @click="form.type = t">{{ t }}</div>
        </div>
      </div>
      <div class="field">
        <label>运动时长（分钟）</label>
        <input v-model.number="form.minutes" type="number" placeholder="1 - 600" />
        <p class="hint">建议每周至少 150 分钟中等强度运动</p>
      </div>
      <div class="field">
        <label>运动强度</label>
        <div class="chips">
          <div v-for="it in intensities" :key="it.value" class="chip" :class="{ active: form.intensity === it.value }" @click="form.intensity = it.value">{{ it.label }}</div>
        </div>
      </div>
      <div class="field">
        <label>备注（可选）</label>
        <textarea v-model="form.note" rows="2" maxlength="200" placeholder="如：晚饭后公园快走"></textarea>
      </div>
      <button class="btn" :disabled="saving" @click="save">{{ saving ? '提交中…' : '提交运动记录' }}</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { todayStr } from '../utils';
import { EXERCISE_TYPES, INTENSITIES } from '@flwb/shared';

const router = useRouter();
const types = EXERCISE_TYPES;
const intensities = INTENSITIES;
const form = reactive({ type: EXERCISE_TYPES[0], minutes: 30, intensity: 'mid', note: '' });
const saving = ref(false);

async function save() {
  if (!form.minutes || form.minutes < 1 || form.minutes > 600) { alert('运动时长需在 1-600 分钟'); return; }
  saving.value = true;
  try {
    await api.submitExercise({
      type: form.type,
      minutes: form.minutes,
      intensity: form.intensity,
      recordDate: todayStr(),
      note: form.note || undefined
    });
    alert('✅ 记录成功');
    router.replace('/');
  } catch (e) {
    alert(e.message || '提交失败');
  } finally {
    saving.value = false;
  }
}
</script>
