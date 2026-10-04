<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { useStepStore } from '../stores/stepStore';
import { useInstrumentStore } from '../stores/instrumentStore';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import { TEST_POSITIONS, judgeTest, validityLabel, type PositionReading } from '../types/test';
import { isInstrumentUsable, instrumentUnusableReason, validUntilLabel } from '../types/instrument';
import { amplitudeLevel, avgAmplitude, avgBeatError, avgRate, beatErrorLevel, rateLabel, ratePerDayToMonth } from '../utils/timeCalc';
import {
  BookingRejectedError,
  RESERVATION_TTL,
  heartbeatReservation,
  inspectSlot,
  occupancyOf,
  releaseAllReservations,
  releaseReservation,
  reserveSlot,
  saveTestWithBooking,
  startHeartbeat,
  type SlotOccupancy,
} from '../utils/booking';
import { newId } from '../utils/id';
import { onChange, onBookingPulse } from '../utils/crossTab';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const stepStore = useStepStore();
const instrumentStore = useInstrumentStore();

const clockId = ref(String(route.params.clockId ?? ''));
const clock = computed(() => clockStore.byId(clockId.value));
const tests = computed(() => stepStore.testsByClock(clockId.value));

const readings = reactive<PositionReading[]>(
  TEST_POSITIONS.map((position) => ({ position, rate: 0, amplitude: 260, beatError: 0.4 })),
);
const powerReserve = ref(42);
const customConclusion = ref('');

// ---- 仪器与预约时段 ----
const instrumentId = ref('');
const defaultSlotStart = roundUpToQuarter(Date.now() + 5 * 60000);
const slotStart = ref(defaultSlotStart);
const slotDurationMin = ref(30);
const slotEnd = computed(() => Number(slotStart.value) + slotDurationMin.value * 60000);

const occupancy = ref<SlotOccupancy>({ reservation: undefined, others: [] });
const slotWarning = ref('');
const reserveHint = ref('');
const saving = ref(false);

function roundUpToQuarter(ts: number): number {
  return Math.ceil(ts / (15 * 60000)) * 15 * 60000;
}

const selectedInstrument = computed(() => instrumentStore.byId(instrumentId.value));
const now = ref(Date.now());

const instrumentOptions = computed(() =>
  instrumentStore.items.map((it) => ({
    ...it,
    usable: isInstrumentUsable(it, now.value),
    reason: instrumentUnusableReason(it, now.value),
  })),
);

const heldByMe = computed(() => occupancy.value.reservation !== undefined);

const avg = computed(() => ({
  rate: avgRate(readings),
  amplitude: avgAmplitude(readings),
  beatError: avgBeatError(readings),
}));

const conclusion = computed(() =>
  customConclusion.value.trim() ? customConclusion.value.trim() : judgeTest(avg.value.rate, avg.value.beatError, avg.value.amplitude),
);

const workSheet = computed(() => {
  const lines: string[] = [];
  lines.push('走时测试单');
  lines.push(`藏品号：${clock.value?.clockNo ?? '未知'}（${clock.value?.kind ?? ''} / ${clock.value?.caliber ?? ''}）`);
  lines.push(`测试时间：${new Date(slotStart.value).toLocaleString('zh-CN')} ~ ${new Date(slotEnd.value).toLocaleString('zh-CN')}`);
  lines.push(
    `校表仪：${selectedInstrument.value ? `${selectedInstrument.value.assetNo} ${selectedInstrument.value.name}（${selectedInstrument.value.model}）` : '未选择'}`,
  );
  lines.push('');
  lines.push('方位\t日差(s/d)\t摆幅(°)\t偏振(ms)');
  readings.forEach((r) => {
    lines.push(`${r.position}\t${r.rate}\t${r.amplitude}\t${r.beatError}`);
  });
  lines.push('');
  lines.push(`平均日差：${avg.value.rate} s/d（约 ${ratePerDayToMonth(avg.value.rate)} s/月，${rateLabel(avg.value.rate)}）`);
  lines.push(`平均摆幅：${avg.value.amplitude} °（${amplitudeLevel(avg.value.amplitude).label}）`);
  lines.push(`平均偏振：${avg.value.beatError} ms（${beatErrorLevel(avg.value.beatError).label}）`);
  lines.push(`动力储备：${powerReserve.value} h`);
  lines.push(`结论：${conclusion.value}`);
  return lines.join('\n');
});

async function refreshOccupancy() {
  if (!instrumentId.value) {
    occupancy.value = { reservation: undefined, others: [] };
    slotWarning.value = '';
    return;
  }
  occupancy.value = await occupancyOf(instrumentId.value, clockId.value);
  const inst = instrumentStore.byId(instrumentId.value);
  slotWarning.value = inst ? await inspectSlot(inst, slotStart.value, slotEnd.value) : '所选仪器不存在';
}

/** 选择仪器或调整时段后（重新）预约；冲突即拒绝并释放原占用 */
async function takeSlot() {
  if (!instrumentId.value) {
    reserveHint.value = '请先选择校表仪';
    return;
  }
  try {
    const res = await reserveSlot({
      instrumentId: instrumentId.value,
      clockId: clockId.value,
      slotStart: slotStart.value,
      slotEnd: slotEnd.value,
    });
    occupancy.value = { reservation: res, others: occupancy.value.others };
    slotWarning.value = '';
    reserveHint.value = `已预约 ${new Date(res.slotStart).toLocaleString('zh-CN')} ~ ${new Date(res.slotEnd).toLocaleString('zh-CN')}，${Math.round(RESERVATION_TTL / 1000)}s 内心跳续约；中断不保存将自动释放`;
  } catch (e) {
    occupancy.value = { reservation: undefined, others: occupancy.value.others };
    reserveHint.value = '';
    if (e instanceof BookingRejectedError) {
      slotWarning.value = e.message;
      ElMessage.error(e.message);
    } else {
      throw e;
    }
  }
}

async function onInstrumentChange() {
  slotWarning.value = '';
  reserveHint.value = '';
  // 切换仪器：释放本页签在其他仪器上的占用
  await releaseAllReservations();
  if (instrumentId.value) await takeSlot();
  await refreshOccupancy();
}

async function onSlotChange() {
  slotWarning.value = '';
  // el-date-picker 的 value-format="x" 运行时可能给字符串，统一归一化
  slotStart.value = Number(slotStart.value);
  if (!instrumentId.value) return;
  await takeSlot();
}

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;

async function beat() {
  if (!instrumentId.value || !clockId.value) return;
  try {
    const res = await heartbeatReservation({
      instrumentId: instrumentId.value,
      clockId: clockId.value,
      slotStart: slotStart.value,
      slotEnd: slotEnd.value,
    });
    occupancy.value = { ...occupancy.value, reservation: res };
  } catch {
    occupancy.value = { ...occupancy.value, reservation: undefined };
  }
  await refreshOccupancy();
}

async function save() {
  if (!clockId.value) {
    ElMessage.error('未指定钟表');
    return;
  }
  if (!instrumentId.value) {
    ElMessage.error('请先选择本次测试使用的校表仪');
    return;
  }
  if (slotWarning.value) {
    ElMessage.error(`无法保存：${slotWarning.value}`);
    return;
  }
  saving.value = true;
  const start = Number(slotStart.value);
  const end = Number(slotEnd.value);
  try {
    const record = await saveTestWithBooking(
      {
        clockId: clockId.value,
        testedAt: start,
        amplitude: avg.value.amplitude,
        beatError: avg.value.beatError,
        rate: avg.value.rate,
        positions: readings.map((r) => ({ ...r })),
        powerReserve: powerReserve.value,
        conclusion: conclusion.value,
        instrumentId: instrumentId.value,
        slotStart: start,
        slotEnd: end,
      },
      () => newId('tst'),
    );
    stepStore.tests = [record, ...stepStore.tests.filter((t) => t.id !== record.id)];
    occupancy.value = { reservation: undefined, others: occupancy.value.others };
    reserveHint.value = '';
    ElMessage.success('走时测试已记录（仪器凭证有效）');
    reset();
  } catch (e) {
    if (e instanceof BookingRejectedError) ElMessage.error(e.message);
    else throw e;
  } finally {
    saving.value = false;
    await refreshOccupancy();
  }
}

async function copySheet() {
  try {
    await navigator.clipboard.writeText(workSheet.value);
    ElMessage.success('走时单已复制');
  } catch {
    ElMessage.warning('浏览器未授权剪贴板，请手动复制');
  }
}

function downloadSheet() {
  const blob = new Blob([workSheet.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `走时单_${clock.value?.clockNo ?? 'clock'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('走时单已导出');
}

function reset() {
  readings.forEach((r) => {
    r.rate = 0;
    r.amplitude = 260;
    r.beatError = 0.4;
  });
  customConclusion.value = '';
}

const offCrossTab = onChange((topic) => {
  if (topic === 'instruments') void instrumentStore.load();
  if (topic === 'tests') void stepStore.loadTests();
  if (topic === 'instruments' || topic === 'tests') void refreshOccupancy();
});

const offBookingPulse = onBookingPulse((id) => {
  // 只关心当前所选仪器的占用变化（他页签预约/心跳/释放）
  if (id === instrumentId.value) void refreshOccupancy();
});

onMounted(async () => {
  await clockStore.load();
  await stepStore.load();
  await instrumentStore.load();
  if (!clock.value && clockStore.items.length > 0) {
    clockId.value = clockStore.items[0].id;
    await router.replace(`/tests/${clockId.value}`);
  }
  heartbeatTimer = startHeartbeat(beat);
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 30000);
  window.addEventListener('beforeunload', leavePage);
});

function leavePage() {
  // 同步尽力释放（IndexedDB 事务在 unload 时未必完成，TTL 也会兜底）
  if (instrumentId.value) void releaseReservation(instrumentId.value);
}

onBeforeUnmount(() => {
  offCrossTab();
  offBookingPulse();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (clockTimer) clearInterval(clockTimer);
  window.removeEventListener('beforeunload', leavePage);
  if (instrumentId.value) void releaseReservation(instrumentId.value);
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>走时测试 · {{ clock?.clockNo ?? '未选择' }}</h2>
      <StateBadge :grade="clock?.conditionGrade" />
      <el-tag type="info" effect="plain">历史测试 {{ tests.length }} 次</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/clocks/${clockId}`)">返回钟表详情</el-button>
    </div>

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>测前准备：校表仪与时段</strong></template>
        <el-form label-width="110px">
          <el-form-item label="校表仪" required>
            <el-select
              v-model="instrumentId"
              placeholder="选择本次使用的校表仪"
              style="width: 100%"
              @change="onInstrumentChange"
            >
              <el-option
                v-for="opt in instrumentOptions"
                :key="opt.id"
                :label="`${opt.assetNo} · ${opt.name}（${opt.model}）${opt.usable ? '' : ` —— ${opt.reason}`}`"
                :value="opt.id"
                :disabled="!opt.usable"
              >
                <span>{{ opt.assetNo }} · {{ opt.name }}</span>
                <el-tag v-if="opt.usable" size="small" type="success" style="margin-left: 8px">
                  {{ validUntilLabel(opt.validUntil, now) }}
                </el-tag>
                <el-tag v-else size="small" type="danger" style="margin-left: 8px">{{ opt.reason }}</el-tag>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="测试时段" required>
            <el-date-picker
              v-model="slotStart"
              type="datetime"
              placeholder="开始时间"
              format="MM-DD HH:mm"
              value-format="x"
              style="width: 190px"
              @change="onSlotChange"
            />
            <span style="margin: 0 8px">起 · 时长</span>
            <el-select v-model="slotDurationMin" style="width: 110px" @change="onSlotChange">
              <el-option :value="15" label="15 分钟" />
              <el-option :value="30" label="30 分钟" />
              <el-option :value="60" label="60 分钟" />
              <el-option :value="90" label="90 分钟" />
              <el-option :value="120" label="120 分钟" />
            </el-select>
          </el-form-item>
          <el-form-item label="时段预览">
            <span class="muted">
              {{ new Date(slotStart).toLocaleString('zh-CN') }} ~ {{ new Date(slotEnd).toLocaleString('zh-CN') }}
            </span>
          </el-form-item>
        </el-form>

        <el-alert
          v-if="heldByMe && !slotWarning"
          :title="reserveHint || '已占用该时段'"
          type="success"
          :closable="false"
          show-icon
          style="margin: 4px 0 10px"
        />
        <el-alert v-if="slotWarning" :title="slotWarning" type="error" :closable="false" show-icon style="margin: 4px 0 10px" />
        <el-alert
          v-if="occupancy.others.length"
          :title="`其他页签正在占用：${occupancy.others
            .map((r) => `${new Date(r.slotStart).toLocaleString('zh-CN')} 起 ${Math.round((r.slotEnd - r.slotStart) / 60000)} 分钟`)
            .join('；')}`"
          type="warning"
          :closable="false"
          show-icon
          style="margin: 4px 0 10px"
        />
        <el-alert
          title="两个页签同时抢同一台仪器的同一时段时，仅后保存者会收到冲突拒绝；预约随本页签心跳保持，关闭/中断后数秒自动释放，不会长期占用。"
          type="info"
          :closable="false"
          style="margin-bottom: 10px"
        />

        <el-divider style="margin: 6px 0" />

        <strong>多方位读数录入</strong>
        <el-table :data="readings" size="small" border style="margin-top: 8px">
          <el-table-column prop="position" label="方位" width="90" />
          <el-table-column label="日差 s/d" width="150">
            <template #default="{ row }">
              <el-input-number v-model="row.rate" :min="-99" :max="99" :step="0.1" :precision="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="摆幅 °" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.amplitude" :min="0" :max="400" :step="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="偏振 ms" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.beatError" :min="0" :max="9.9" :step="0.1" :precision="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="分级" min-width="140">
            <template #default="{ row }">
              <StateBadge :label="amplitudeLevel(row.amplitude).label" :tone="amplitudeLevel(row.amplitude).type" />
              <StateBadge :label="beatErrorLevel(row.beatError).label" :tone="beatErrorLevel(row.beatError).type" />
            </template>
          </el-table-column>
        </el-table>

        <el-form label-width="110px" style="margin-top: 14px">
          <el-form-item label="动力储备 h">
            <el-input-number v-model="powerReserve" :min="0" :max="400" />
          </el-form-item>
          <el-form-item label="结论（可选）">
            <el-input v-model="customConclusion" placeholder="留空则按均值自动判定" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" :disabled="!heldByMe" @click="save">保存测试记录</el-button>
            <el-button @click="reset">重置读数</el-button>
            <span v-if="!heldByMe" class="muted" style="margin-left: 8px">须先成功预约仪器时段</span>
          </el-form-item>
        </el-form>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header><strong>多方位均值</strong></template>
          <div class="stats">
            <div><span class="muted">平均日差</span><strong>{{ avg.rate }}</strong> s/d</div>
            <div><span class="muted">折算</span><strong>{{ ratePerDayToMonth(avg.rate) }}</strong> s/月</div>
            <div><span class="muted">平均摆幅</span><strong>{{ avg.amplitude }}</strong> °</div>
            <div><span class="muted">平均偏振</span><strong>{{ avg.beatError }}</strong> ms</div>
          </div>
          <el-alert
            :title="`判定结论：${conclusion}（${rateLabel(avg.rate)}）`"
            :type="conclusion === '合格' ? 'success' : conclusion === '不合格' ? 'error' : 'warning'"
            :closable="false"
            show-icon
          />
          <RateChart :readings="readings" />
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>走时单</strong>
              <div class="spacer" />
              <el-button size="small" @click="copySheet">复制</el-button>
              <el-button size="small" type="primary" @click="downloadSheet">导出</el-button>
            </div>
          </template>
          <el-input v-model="workSheet" type="textarea" :rows="12" readonly />
        </el-card>

        <el-card shadow="never">
          <template #header><strong>历史测试记录</strong></template>
          <el-table :data="tests" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="校表仪" min-width="140">
              <template #default="{ row }">
                <span v-if="row.instrumentNo">{{ row.instrumentNo }}</span>
                <el-tag v-else size="small" type="warning">无记录</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="rate" label="日差" width="70" />
            <el-table-column prop="amplitude" label="摆幅" width="70" />
            <el-table-column prop="powerReserve" label="动储" width="70" />
            <el-table-column label="凭证 / 结论" min-width="120">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="row.validity === 'valid' ? 'success' : row.validity === 'invalid' ? 'danger' : 'warning'"
                >
                  {{ validityLabel(row.validity) }}
                </el-tag>
                <div v-if="row.validity === 'valid'" class="muted">{{ row.conclusion }}</div>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="tests.length === 0" description="暂无历史测试" :image-size="60" />
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 660px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 14px;
}
.stats strong {
  font-size: 18px;
  margin: 0 4px;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.card-head {
  display: flex;
  align-items: center;
}
</style>
