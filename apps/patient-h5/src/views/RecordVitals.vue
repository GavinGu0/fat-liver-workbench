<template>
  <div>
    <div class="page-head"><h1>💉 随访指标</h1><p class="sub">体重 / 腹围 / 血压 / 血糖</p></div>
    <div class="card">
      <div class="field">
        <label>记录日期</label>
        <input v-model="form.recordDate" type="date" :max="today" />
      </div>
      <div class="field">
        <label>体重 (kg)</label>
        <input v-model="form.weight" type="number" step="0.1" placeholder="如 72.5" />
        <p class="hint">合理范围 {{ range('weight').min }} - {{ range('weight').max }} {{ range('weight').unit }}</p>
      </div>
      <div class="field">
        <label>腹围 (cm)</label>
        <input v-model="form.waist" type="number" step="0.1" placeholder="如 92" />
        <p class="hint">合理范围 {{ range('waist').min }} - {{ range('waist').max }} {{ range('waist').unit }}</p>
      </div>
      <div class="field">
        <label>血压 (mmHg)</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input v-model="form.sbp" type="number" placeholder="收缩压" style="flex:1" />
          <span style="color:#9ca3af">/</span>
          <input v-model="form.dbp" type="number" placeholder="舒张压" style="flex:1" />
        </div>
        <p class="hint">收缩压 {{ range('sbp').min }}-{{ range('sbp').max }}，舒张压 {{ range('dbp').min }}-{{ range('dbp').max }}</p>
      </div>
      <div class="field">
        <label>空腹血糖 (mmol/L)</label>
        <input v-model="form.glucose" type="number" step="0.1" placeholder="如 5.6" />
        <p class="hint">合理范围 {{ range('glucose').min }} - {{ range('glucose').max }} {{ range('glucose').unit }}</p>
      </div>

      <button class="btn" :disabled="saving" @click="save">{{ saving ? '提交中…' : '提交指标' }}</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { todayStr } from '../utils';
import { MED_RANGES } from '@flwb/shared';

const router = useRouter();
const range = (k) => MED_RANGES[k];
const form = reactive({ recordDate: todayStr(), weight: '', waist: '', sbp: '', dbp: '', glucose: '' });
const saving = ref(false);

function clientCheck() {
  for (const [k, v] of Object.entries({ weight: form.weight, waist: form.waist, sbp: form.sbp, dbp: form.dbp, glucose: form.glucose })) {
    if (v === '' || v == null) continue;
    const n = Number(v);
    const r = MED_RANGES[k];
    if (Number.isNaN(n)) return `${r.label}必须为数字`;
    if (n < r.min || n > r.max) return `${r.label}超出合理范围（${r.min}-${r.max}${r.unit}）`;
  }
  if (form.sbp && form.dbp && Number(form.sbp) <= Number(form.dbp)) return '收缩压应大于舒张压';
  return '';
}

async function save() {
  const err = clientCheck();
  if (err) { alert(err); return; }
  const hasAny = [form.weight, form.waist, form.sbp, form.dbp, form.glucose].some((v) => v !== '' && v != null);
  if (!hasAny) { alert('请至少填写一项指标'); return; }
  saving.value = true;
  try {
    const d = await api.submitVitals({
      recordDate: form.recordDate,
      weight: form.weight === '' ? undefined : Number(form.weight),
      waist: form.waist === '' ? undefined : Number(form.waist),
      sbp: form.sbp === '' ? undefined : Number(form.sbp),
      dbp: form.dbp === '' ? undefined : Number(form.dbp),
      glucose: form.glucose === '' ? undefined : Number(form.glucose)
    });
    if (d.warnings && d.warnings.length) {
      alert('⚠️ 已记录，但注意：' + d.warnings.join('；'));
    } else {
      alert('✅ 指标已提交，医生端实时可见');
    }
    router.replace('/');
  } catch (e) {
    alert(e.message || '提交失败');
  } finally {
    saving.value = false;
  }
}
</script>
