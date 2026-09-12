<template>
  <div ref="chartEl" class="trend-chart" :style="{ height }"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  /** [{name, unit, data: [[ts, value], ...], markLine?}] */
  series: { type: Array, default: () => [] },
  height: { type: String, default: '260px' },
  /** 图表类型：line 折线 | bar 柱状 | area 面积 */
  type: { type: String, default: 'line' },
  /** 悬停详情格式化器：(params) => string */
  tooltipFormatter: { type: Function, default: null },
  color: { type: Array, default: null }
});

const chartEl = ref(null);
let chart = null;

const PALETTE = ['#1668dc', '#00b42a', '#f7ba1e', '#f53f3f', '#722ed1', '#14c9c9'];

function buildOption() {
  const isArea = props.type === 'area';
  const isBar = props.type === 'bar';
  return {
    tooltip: {
      trigger: 'axis',
      ...(props.tooltipFormatter ? { formatter: props.tooltipFormatter } : {})
    },
    legend: { data: props.series.map((s) => s.name), bottom: 0 },
    grid: { left: 52, right: 24, top: 24, bottom: 48 },
    xAxis: { type: 'time', axisLabel: { formatter: '{MM}-{dd}' } },
    yAxis: { type: 'value', scale: true },
    color: props.color || PALETTE,
    series: props.series.map((s) => ({
      name: s.name,
      type: isBar ? 'bar' : 'line',
      smooth: true,
      connectNulls: true,
      symbolSize: 5,
      barMaxWidth: 18,
      data: s.data,
      ...(isArea ? { areaStyle: { opacity: 0.18 } } : {}),
      markLine: s.markLine || undefined
    }))
  };
}

function render() {
  if (!chart || !props.series) return;
  chart.setOption(buildOption(), true);
}

function resize() { chart && chart.resize(); }

onMounted(() => {
  chart = echarts.init(chartEl.value);
  render();
  window.addEventListener('resize', resize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  if (chart) { chart.dispose(); chart = null; }
});
watch(() => props.series, render, { deep: true });
watch(() => props.type, render);
</script>

<style scoped>
.trend-chart { width: 100%; }
</style>
