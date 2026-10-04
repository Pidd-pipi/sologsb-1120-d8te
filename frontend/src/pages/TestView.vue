<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { useStepStore } from '../stores/stepStore';
import { useInstrumentStore } from '../stores/instrumentStore';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import EvidenceDialog from '../components/common/EvidenceDialog.vue';
import { TEST_POSITIONS, TEST_VALIDITY_META, judgeTest, type PositionReading } from '../types/test';
import type { TimekeepingTest } from '../types/test';
import { calibrationCovers } from '../types/instrument';
import {
  acquireSlot,
  confirmTest,
  busySlots,
  BookingError,
  DEFAULT_SLOT_MS,
  type HoldHandle,
} from '../utils/booking';
import { onSync } from '../utils/syncBus';
import {
  amplitudeLevel,
  avgAmplitude,
  avgBeatError,
  avgRate,
  beatErrorLevel,
  rateLabel,
  ratePerDayToMonth,
  truncateToMinute,
} from '../utils/timeCalc';

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

/* ---------- 仪器与时段选择 ---------- */
const instrumentId = ref('');
const slotStart = ref(truncateToMinute(Date.now() + 60_000));
const slotEnd = ref(truncateToMinute(Date.now() + 60_000 + DEFAULT_SLOT_MS));
const hold = ref<HoldHandle | null>(null);
const acquiring = ref(false);
const saving = ref(false);
const busy = ref<Awaited<ReturnType<typeof busySlots>>>({ tests: [], reservations: [] });

const selectedInstrument = computed(() => instrumentStore.byId(instrumentId.value));

const instrumentOptions = computed(() =>
  instrumentStore.items.map((it) => {
    const latest = instrumentStore.calibrationsOf(it.id)[0];
    const coveredNow = latest ? calibrationCovers(latest, slotStart.value) : false;
    const disabled = it.status === 'retired' || !coveredNow;
    return {
      ...it,
      latest,
      coveredNow,
      disabled,
      disabledReason: it.status === 'retired' ? '已停用' : !latest ? '无检定记录' : !coveredNow ? '已过检' : '',
    };
  }),
);

function onSlotStartChange(value: number | null) {
  const start = truncateToMinute(Number(value ?? Date.now() + 60_000));
  slotStart.value = start;
  if (slotEnd.value <= start) {
    slotEnd.value = truncateToMinute(start + DEFAULT_SLOT_MS);
  }
}
function onSlotEndChange(value: number | null) {
  slotEnd.value = truncateToMinute(Number(value ?? slotStart.value + DEFAULT_SLOT_MS));
}

async function refreshBusy() {
  if (!instrumentId.value) {
    busy.value = { tests: [], reservations: [] };
    return;
  }
  busy.value = await busySlots(
    instrumentId.value,
    Date.now() - 60 * 60_000,
    Date.now() + 12 * 3600 * 1000,
  );
}

function clockNoOf(id: string): string {
  return clockStore.byId(id)?.clockNo ?? id;
}

/** 测前占台：过检 / 停用 / 时段冲突在此被拒绝 */
async function acquire() {
  if (!instrumentId.value || !selectedInstrument.value) {
    ElMessage.error('请先选择校表仪');
    return;
  }
  if (slotEnd.value <= slotStart.value) {
    ElMessage.error('时段结束必须晚于开始');
    return;
  }
  if (!clockId.value) {
    ElMessage.error('未指定钟表');
    return;
  }
  acquiring.value = true;
  try {
    // 重新拉取最新仪器状态（可能刚被其他页签停用 / 改有效期）
    await instrumentStore.load();
    const fresh = instrumentStore.byId(instrumentId.value);
    if (!fresh) throw new BookingError('instrument_changed', '仪器不存在或已被删除');
    hold.value = await acquireSlot(fresh, slotStart.value, slotEnd.value, clockId.value);
    ElMessage.success(`已占用「${fresh.code}」${new Date(slotStart.value).toLocaleTimeString('zh-CN')} 时段，请尽快完成读数并保存`);
    await refreshBusy();
  } catch (err) {
    hold.value = null;
    if (err instanceof BookingError) {
      ElMessage.error(err.message);
    } else {
      ElMessage.error(err instanceof Error ? err.message : '占台失败');
    }
  } finally {
    acquiring.value = false;
  }
}

async function cancelHold() {
  if (hold.value) {
    await hold.value.release();
    hold.value = null;
    ElMessage.info('已放弃占台');
    await refreshBusy();
  }
}

/** 保存：确认占台原子落库；仪器事件、被抢占、冲突都会拒绝 */
async function save() {
  if (!hold.value) {
    ElMessage.error('请先选择仪器与时段并占台');
    return;
  }
  saving.value = true;
  try {
    const record = await confirmTest(hold.value, {
      clockId: clockId.value,
      amplitude: avg.value.amplitude,
      beatError: avg.value.beatError,
      rate: avg.value.rate,
      positions: readings.map((r) => ({ ...r })),
      powerReserve: powerReserve.value,
      conclusion: conclusion.value,
    });
    hold.value = null;
    stepStore.acceptSavedTest(record);
    ElMessage.success('走时测试已记录，仪器时段已确认');
    reset();
    await refreshBusy();
  } catch (err) {
    if (err instanceof BookingError) {
      // 预约失效 / 仪器事件 / 冲突：本次占台已无意义，释放后提示重新占台
      if (hold.value) {
        await hold.value.release().catch(() => {});
        hold.value = null;
      }
      ElMessage.error(`保存被拒绝：${err.message}`);
    } else {
      ElMessage.error(err instanceof Error ? err.message : '保存失败');
    }
  } finally {
    saving.value = false;
  }
}

/* ---------- 均值 / 走时单 ---------- */
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
  lines.push(`校表仪：${selectedInstrument.value?.code ?? '未选择'} · ${selectedInstrument.value?.name ?? ''}`);
  if (selectedInstrument.value) {
    const latest = instrumentStore.calibrationsOf(selectedInstrument.value.id)[0];
    if (latest) lines.push(`检定证书：${latest.certNo || '—'}，有效期至 ${new Date(latest.validUntil).toLocaleDateString('zh-CN')}`);
  }
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

/* ---------- 待补证 ---------- */
const evidenceDialog = ref(false);
const evidenceTest = ref<TimekeepingTest | null>(null);
function openEvidence(test: TimekeepingTest) {
  evidenceTest.value = test;
  evidenceDialog.value = true;
}
function validityMeta(test: TimekeepingTest) {
  return TEST_VALIDITY_META[test.validity ?? 'pending_evidence'];
}
function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- 占台存活轮询 / 跨页签刷新 ---------- */
let pollTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeSync: (() => void) | undefined;

async function poll() {
  if (hold.value) {
    if (await hold.value.isGone()) {
      hold.value = null;
      ElMessage.error('占台预约已中断（可能被其他页签抢占或超时），请重新选择时段占台');
    }
  }
  await refreshBusy();
}

function onVisibility() {
  // 切走页面即视为预约中断，释放仪器，避免「人不在还占着」
  if (document.hidden && hold.value) {
    void hold.value.release();
    hold.value = null;
    ElMessage.info('页面已切走，占台自动释放');
  }
}

onMounted(async () => {
  await clockStore.load();
  await instrumentStore.load();
  await stepStore.load();
  if (!clock.value && clockStore.items.length > 0) {
    clockId.value = clockStore.items[0].id;
    await router.replace(`/tests/${clockId.value}`);
  }
  pollTimer = setInterval(poll, 3000);
  unsubscribeSync = onSync((msg) => {
    if (msg.topic === 'reservations' || msg.topic === 'instruments') {
      void poll();
    }
  });
  document.addEventListener('visibilitychange', onVisibility);
});

onUnmounted(async () => {
  if (pollTimer) clearInterval(pollTimer);
  if (unsubscribeSync) unsubscribeSync();
  document.removeEventListener('visibilitychange', onVisibility);
  // 离开测试页：预约中断，不占着仪器
  if (hold.value) await hold.value.release();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>走时测试 · {{ clock?.clockNo ?? '未选择' }}</h2>
      <StateBadge v-if="clock" :grade="clock.conditionGrade" />
      <el-tag type="info" effect="plain">历史测试 {{ tests.length }} 次</el-tag>
      <div class="spacer" />
      <el-button @click="router.push('/instruments')">仪器台账</el-button>
      <el-button @click="router.push(`/clocks/${clockId}`)">返回钟表详情</el-button>
    </div>

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>测前准备：选择校表仪与时段</strong></template>
        <el-alert
          title="走时测试必须先选择一台在检定有效期内、且时段空闲的校表仪并完成占台；仪器停用、已过检或时段被占时无法保存。"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
        />
        <el-form label-width="110px">
          <el-form-item label="校表仪" required>
            <el-select
              v-model="instrumentId"
              placeholder="选择校表仪"
              style="width: 100%"
              :disabled="!!hold"
              @change="refreshBusy"
            >
              <el-option
                v-for="it in instrumentOptions"
                :key="it.id"
                :label="`${it.code} · ${it.name}（${it.disabled ? it.disabledReason : '可用'}）`"
                :value="it.id"
                :disabled="it.disabled"
              >
                <span>{{ it.code }} · {{ it.name }}</span>
                <el-tag
                  size="small"
                  :type="it.status === 'retired' ? 'info' : it.coveredNow ? 'success' : 'danger'"
                  style="margin-left: 8px"
                >
                  {{ it.status === 'retired' ? '停用' : it.coveredNow ? '检定有效' : '已过检' }}
                </el-tag>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="时段开始" required>
            <el-date-picker
              :model-value="slotStart"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              value-format="x"
              :disabled="!!hold"
              style="width: 100%"
              @update:model-value="onSlotStartChange"
            />
          </el-form-item>
          <el-form-item label="时段结束" required>
            <el-date-picker
              :model-value="slotEnd"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              value-format="x"
              :disabled="!!hold"
              style="width: 100%"
              @update:model-value="onSlotEndChange"
            />
          </el-form-item>
          <el-form-item>
            <el-button v-if="!hold" type="warning" :loading="acquiring" @click="acquire">占台并开始读数</el-button>
            <template v-else>
              <el-tag type="success" effect="dark" style="margin-right: 10px">
                已占用 {{ selectedInstrument?.code }}（保存或离开后释放）
              </el-tag>
              <el-button type="danger" plain @click="cancelHold">放弃占台</el-button>
            </template>
          </el-form-item>
        </el-form>

        <div v-if="instrumentId" class="busy">
          <div class="busy-title">该仪器近期占用</div>
          <el-tag
            v-for="t in busy.tests"
            :key="`t-${t.start}`"
            size="small"
            type="info"
            style="margin: 3px"
          >
            测试 {{ new Date(t.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }} · {{ clockNoOf(t.clockId) }}
          </el-tag>
          <el-tag
            v-for="r in busy.reservations"
            :key="r.id"
            size="small"
            type="danger"
            style="margin: 3px"
          >
            预约 {{ new Date(r.slotStart).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }} · {{ r.owner }}
          </el-tag>
          <div v-if="busy.tests.length === 0 && busy.reservations.length === 0" class="muted">近期无占用</div>
        </div>
      </el-card>

      <el-card shadow="never" :class="{ 'is-readonly': !hold }">
        <template #header>
          <strong>多方位读数录入</strong>
          <el-tag v-if="!hold" size="small" type="warning" style="margin-left: 8px">占台后可录入并保存</el-tag>
        </template>
        <el-table :data="readings" size="small" border>
          <el-table-column prop="position" label="方位" width="90" />
          <el-table-column label="日差 s/d" width="150">
            <template #default="{ row }">
              <el-input-number v-model="row.rate" :min="-99" :max="99" :step="0.1" :precision="1" size="small" :disabled="!hold" />
            </template>
          </el-table-column>
          <el-table-column label="摆幅 °" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.amplitude" :min="0" :max="400" :step="1" size="small" :disabled="!hold" />
            </template>
          </el-table-column>
          <el-table-column label="偏振 ms" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.beatError" :min="0" :max="9.9" :step="0.1" :precision="1" size="small" :disabled="!hold" />
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
            <el-input-number v-model="powerReserve" :min="0" :max="400" :disabled="!hold" />
          </el-form-item>
          <el-form-item label="结论（可选）">
            <el-input v-model="customConclusion" placeholder="留空则按均值自动判定" :disabled="!hold" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" :disabled="!hold" @click="save">保存测试记录</el-button>
            <el-button :disabled="!hold" @click="reset">重置读数</el-button>
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
            <el-table-column prop="rate" label="日差" width="80" />
            <el-table-column prop="amplitude" label="摆幅" width="80" />
            <el-table-column prop="beatError" label="偏振" width="80" />
            <el-table-column prop="conclusion" label="读数结论" min-width="110" />
            <el-table-column label="证据状态" min-width="120">
              <template #default="{ row }">
                <StateBadge :label="validityMeta(row).label" :tone="validityMeta(row).type" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button
                  v-if="row.validity === 'pending_evidence'"
                  size="small"
                  type="primary"
                  @click="openEvidence(row)"
                >
                  补证
                </el-button>
                <el-tooltip v-else-if="row.validity !== 'valid'" :content="row.invalidReason ?? ''" placement="top">
                  <el-button size="small" @click="scrollToTop">去复测</el-button>
                </el-tooltip>
                <el-tag v-else size="small" type="success">可采信</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="tests.length === 0" description="暂无历史测试" :image-size="60" />
        </el-card>
      </div>
    </div>

    <EvidenceDialog v-model="evidenceDialog" :test="evidenceTest" />
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
  grid-template-columns: minmax(0, 420px) minmax(0, 480px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.is-readonly {
  opacity: 0.85;
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
.busy {
  margin-top: 6px;
  border-top: 1px dashed #dcdfe6;
  padding-top: 8px;
}
.busy-title {
  font-size: 13px;
  color: #7b8592;
  margin-bottom: 4px;
}
</style>
