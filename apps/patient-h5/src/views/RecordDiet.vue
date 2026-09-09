<template>
  <div>
    <div class="page-head"><h1>🍚 饮食记录</h1><p class="sub">拍下餐食，记录吃了什么</p></div>
    <div class="card">
      <div class="field">
        <label>用餐时段</label>
        <div class="chips">
          <div v-for="m in meals" :key="m.value" class="chip" :class="{ active: form.meal === m.value }" @click="form.meal = m.value">{{ m.label }}</div>
        </div>
      </div>
      <div class="field">
        <label>用餐时间</label>
        <input v-model="form.time" type="time" />
      </div>

      <div class="field">
        <label>食物明细（名称 + 估算量）</label>
        <div v-for="(f, i) in form.foods" :key="i" style="display:flex;gap:8px;margin-bottom:8px">
          <input v-model="f.name" placeholder="如：糙米饭" style="flex:1" />
          <input v-model.number="f.grams" type="number" placeholder="克" style="width:84px" />
          <button class="btn plain" style="width:44px;margin:0;padding:8px 0" @click="form.foods.length > 1 && form.foods.splice(i, 1)">✕</button>
        </div>
        <button class="btn plain" style="margin-top:4px" @click="form.foods.push({ name: '', grams: null })">＋ 添加食物</button>
      </div>

      <div class="field">
        <label>拍照记录（可选）</label>
        <input ref="fileEl" type="file" accept="image/jpeg,image/png" capture="environment" style="display:none" @change="onFile" />
        <div v-if="photoUrl" style="display:flex;align-items:center;gap:10px">
          <img :src="photoUrl" class="photo-preview" />
          <button class="btn plain" style="width:90px;margin:0" @click="photoUrl = ''; uploading = false">移除</button>
        </div>
        <button v-else class="btn plain" :disabled="uploading" @click="$refs.fileEl.click()">{{ uploading ? '上传中…' : '📷 拍照 / 选图' }}</button>
      </div>

      <div class="field">
        <label>备注（可选）</label>
        <textarea v-model="form.note" rows="2" maxlength="200" placeholder="如：外卖少油"></textarea>
      </div>

      <button class="btn" :disabled="saving" @click="save">{{ saving ? '提交中…' : '提交饮食记录' }}</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { compressImage, todayStr } from '../utils';
import { MEALS } from '@flwb/shared';

const router = useRouter();
const meals = MEALS;
const form = reactive({ meal: 'breakfast', time: currentTime(), foods: [{ name: '', grams: null }], note: '' });
const photoUrl = ref('');
const uploading = ref(false);
const saving = ref(false);

function currentTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  uploading.value = true;
  try {
    const dataUrl = await compressImage(file);
    const d = await api.upload({ filename: 'diet.jpg', dataUrl });
    photoUrl.value = d.url;
  } catch (err) {
    alert(err.message || '上传失败');
  } finally {
    uploading.value = false;
  }
}

async function save() {
  const foods = form.foods.filter((f) => f.name && f.grams > 0);
  if (!foods.length) { alert('请至少填写一种食物（名称和估算量）'); return; }
  saving.value = true;
  try {
    await api.submitDiet({
      meal: form.meal,
      recordDate: todayStr(),
      recordTime: form.time,
      foods,
      photoUrl: photoUrl.value || undefined,
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
