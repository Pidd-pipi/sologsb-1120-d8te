<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useInstrumentStore, type CalibrationDraft } from '../stores/instrumentStore';
import { useStepStore } from '../stores/stepStore';
import { useClockStore } from '../stores/clockStore';
import StateBadge from '../components/common/StateBadge.vue';
import EvidenceDialog from '../components/common/EvidenceDialog.vue';
import { onSync } from '../utils/syncBus';
import { busySlots } from '../utils/booking';
import { startOfDay, endOfDay } from '../utils/timeCalc';
import { INSTRUMENT_EVENT_LABEL, calibrationCovers } from '../types/instrument';
import type { Instrument, Calibration, InstrumentEvent } from '../types/instrument';
import type { TimekeepingTest } from '../types/test';
import { TEST_VALIDITY_META } from '../types/test';

const instrumentStore = useInstrumentStore();
const stepStore = useStepStore();
const clockStore = useClockStore();

const activeTab = ref('instruments');

/* ---------- 仪器新增 / 编辑 ---------- */
const instrumentDialog = ref(false);
const instrumentEditing = ref<Instrument | null>(null);
const instrumentForm = reactive({
  code: '',
  name: '',
  model: '',
  maker: '',
  location: '',
  note: '',
});
const instrumentError = ref('');

function openAddInstrument() {
  instrumentEditing.value = null;
  instrumentError.value = '';
  Object.assign(instrumentForm, { code: '', name: '', model: '', maker: '', location: '', note: '' });
  instrumentDialog.value = true;
}
function openEditInstrument(row: Instrument) {
  instrumentEditing.value = row;
  instrumentError.value = '';
  Object.assign(instrumentForm, {
    code: row.code,
    name: row.name,
    model: row.model,
    maker: row.maker,
    location: row.location,
    note: row.note,
  });
  instrumentDialog.value = true;
}
async function submitInstrument() {
  if (!instrumentForm.code.trim()) {
    instrumentError.value = '仪器编号必填';
    return;
  }
  try {
    if (instrumentEditing.value) {
      await instrumentStore.update(instrumentEditing.value.id, { ...instrumentForm, code: instrumentForm.code.trim() });
      ElMessage.success('仪器信息已更新');
    } else {
      await instrumentStore.add({ ...instrumentForm, code: instrumentForm.code.trim() });
      ElMessage.success(`仪器「${instrumentForm.code.trim()}」已入账`);
    }
    instrumentDialog.value = false;
  } catch (err) {
    instrumentError.value = err instanceof Error ? err.message : '保存失败';
  }
}

async function removeInstrument(row: Instrument) {
  const linked = stepStore.tests.filter((t) => t.instrumentId === row.id).length;
  try {
    await ElMessageBox.confirm(
      `确定删除仪器「${row.code}」？${linked ? `已有 ${linked} 条测试关联，删除后这些测试将变为待补证。` : ''}检定记录与事件链一并删除。`,
      '删除确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  await instrumentStore.remove(row.id);
  await stepStore.recomputeAll();
  ElMessage.success('仪器已删除');
}

/* ---------- 检定状态展示 ---------- */
const now = ref(Date.now());
setInterval(() => {
  now.value = Date.now();
}, 30_000);

function latestCalibration(row: Instrument): Calibration | undefined {
  return instrumentStore.calibrationsOf(row.id)[0];
}

function calState(row: Instrument): { label: string; type: 'success' | 'danger' | 'info' } {
  if (row.status === 'retired') return { label: '停用', type: 'info' };
  const latest = latestCalibration(row);
  if (!latest) return { label: '无检定', type: 'danger' };
  return calibrationCovers(latest, now.value) ? { label: '检定有效', type: 'success' } : { label: '已过检', type: 'danger' };
}

/* ---------- 检定登记 / 补检 ---------- */
const calDialog = ref(false);
const calInstrument = ref<Instrument | null>(null);
const calForm = reactive<CalibrationDraft>({
  calibratedAt: startOfDay(),
  validUntil: endOfDay(Date.now() + 365 * 24 * 3600 * 1000),
  certNo: '',
  org: '',
  supplementary: false,
  note: '',
});

function openCalibration(row: Instrument) {
  calInstrument.value = row;
  const state = calState(row);
  calForm.calibratedAt = startOfDay();
  calForm.validUntil = endOfDay(Date.now() + 365 * 24 * 3600 * 1000);
  calForm.certNo = '';
  calForm.org = latestCalibration(row)?.org ?? '';
  calForm.supplementary = state.label === '已过检' || state.label === '无检定';
  calForm.note = '';
  calDialog.value = true;
}

async function submitCalibration() {
  if (!calInstrument.value) return;
  const draft: CalibrationDraft = {
    ...calForm,
    calibratedAt: startOfDay(Number(calForm.calibratedAt)),
    validUntil: endOfDay(Number(calForm.validUntil)),
  };
  try {
    const record = await instrumentStore.addCalibration(calInstrument.value.id, draft);
    await stepStore.recomputeForInstrument(calInstrument.value.id);
    ElMessage.success(
      calForm.supplementary
        ? `补检已登记（证书 ${record.certNo || '无编号'}）：补检前涉及该仪器的测试已全部作废，复测确认后恢复`
        : '检定记录已登记',
    );
    calDialog.value = false;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '登记失败');
  }
}

/* ---------- 改有效期 ---------- */
const validityDialog = ref(false);
const validityCalibration = ref<Calibration | null>(null);
const validityForm = reactive({ calibratedAt: 0, validUntil: 0, certNo: '', org: '', note: '' });

function openValidity(row: Instrument) {
  const latest = latestCalibration(row);
  if (!latest) {
    ElMessage.warning('该仪器尚无检定记录，请先登记检定');
    return;
  }
  validityCalibration.value = latest;
  Object.assign(validityForm, {
    calibratedAt: latest.calibratedAt,
    validUntil: latest.validUntil,
    certNo: latest.certNo,
    org: latest.org,
    note: latest.note,
  });
  validityDialog.value = true;
}

async function submitValidity() {
  if (!validityCalibration.value) return;
  const patch = {
    ...validityForm,
    calibratedAt: startOfDay(Number(validityForm.calibratedAt)),
    validUntil: endOfDay(Number(validityForm.validUntil)),
  };
  try {
    await ElMessageBox.confirm(
      '修改检定有效期后，涉及该仪器的既有测试立即全部作废，相关钟表撤下完工结论，须复测确认后恢复。是否继续？',
      '改有效期确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await instrumentStore.changeCalibrationValidity(validityCalibration.value.id, patch);
    await stepStore.recomputeForInstrument(validityCalibration.value.instrumentId);
    ElMessage.success('有效期已变更，相关测试已作废待复测');
    validityDialog.value = false;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '修改失败');
  }
}

/* ---------- 停用 / 启用 ---------- */
async function retire(row: Instrument) {
  let reason = '';
  try {
    const value = await ElMessageBox.prompt('请填写停用原因（故障、报废、送检等）', `停用「${row.code}」`, {
      confirmButtonText: '确认停用',
      cancelButtonText: '取消',
      inputType: 'textarea',
    });
    reason = (value.value || '').trim();
  } catch {
    return;
  }
  await instrumentStore.retire(row.id, reason);
  await stepStore.recomputeForInstrument(row.id);
  ElMessage.warning('仪器已停用：未确认预约全部取消，既有测试作废待复测');
}

async function reactivate(row: Instrument) {
  await instrumentStore.reactivate(row.id);
  ElMessage.success('仪器已重新启用；停用前的测试仍须复测确认');
}

/* ---------- 事件链抽屉 ---------- */
const eventDrawer = ref(false);
const eventInstrument = ref<Instrument | null>(null);
const eventList = computed<InstrumentEvent[]>(() =>
  eventInstrument.value ? instrumentStore.eventsOf(eventInstrument.value.id) : [],
);

function openEvents(row: Instrument) {
  eventInstrument.value = row;
  eventDrawer.value = true;
}

/* ---------- 待补证 ---------- */
const pendingTests = computed(() => stepStore.pendingEvidenceTests);

const evidenceDialog = ref(false);
const evidenceTest = ref<TimekeepingTest | null>(null);

function openEvidence(test: TimekeepingTest) {
  evidenceTest.value = test;
  evidenceDialog.value = true;
}

function clockNoOf(clockId: string): string {
  return clockStore.byId(clockId)?.clockNo ?? clockId;
}
function instrumentCodeOf(id?: string): string {
  return id ? instrumentStore.byId(id)?.code ?? '未知仪器' : '—';
}

/* ---------- 占台监视 ---------- */
const reservations = ref<Awaited<ReturnType<typeof busySlots>>['reservations']>([]);
const resTick = ref(0);

async function refreshReservations() {
  const all: Awaited<ReturnType<typeof busySlots>>['reservations'] = [];
  for (const ins of instrumentStore.items) {
    const { reservations: rs } = await busySlots(
      ins.id,
      Date.now() - 60 * 60_000,
      Date.now() + 12 * 3600 * 1000,
    );
    all.push(...rs);
  }
  reservations.value = all.sort((a, b) => a.slotStart - b.slotStart);
  resTick.value += 1;
}

let reservationTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeSync: (() => void) | undefined;

onMounted(async () => {
  await Promise.all([instrumentStore.load(), stepStore.load(), clockStore.load()]);
  await refreshReservations();
  reservationTimer = setInterval(refreshReservations, 4000);
  unsubscribeSync = onSync((msg) => {
    if (msg.topic === 'reservations') void refreshReservations();
  });
});

onUnmounted(() => {
  if (reservationTimer) clearInterval(reservationTimer);
  if (unsubscribeSync) unsubscribeSync();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>校表仪台账</h2>
      <el-tag>共 {{ instrumentStore.items.length }} 台</el-tag>
      <el-tag type="warning" effect="plain">待补证测试 {{ pendingTests.length }} 条</el-tag>
      <el-tag type="danger" effect="plain">在用占台 {{ reservations.length }} 个</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openAddInstrument">新仪器入账</el-button>
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="仪器台账" name="instruments">
        <el-table :data="instrumentStore.items" border size="small">
          <el-table-column label="编号" width="110">
            <template #default="{ row }">
              <strong>{{ row.code }}</strong>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="名称" width="120" />
          <el-table-column prop="model" label="型号" min-width="160" />
          <el-table-column prop="location" label="位置" width="150" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <StateBadge :label="calState(row).label" :tone="calState(row).type" />
            </template>
          </el-table-column>
          <el-table-column label="有效期至" width="120">
            <template #default="{ row }">
              <span v-if="latestCalibration(row)">{{ new Date(latestCalibration(row)!.validUntil).toLocaleDateString('zh-CN') }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="证据纪元" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.evidenceEpoch > 0 ? 'danger' : 'info'">{{ row.evidenceEpoch }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="360">
            <template #default="{ row }">
              <el-button size="small" type="primary" :disabled="row.status === 'retired'" @click="openCalibration(row)">
                {{ calState(row).label === '已过检' || calState(row).label === '无检定' ? '补检登记' : '检定登记' }}
              </el-button>
              <el-button size="small" @click="openValidity(row)">改有效期</el-button>
              <el-button size="small" type="warning" v-if="row.status === 'active'" @click="retire(row)">停用</el-button>
              <el-button size="small" type="success" v-else @click="reactivate(row)">重新启用</el-button>
              <el-button size="small" @click="openEvents(row)">事件链</el-button>
              <el-button size="small" @click="openEditInstrument(row)">编辑</el-button>
              <el-button size="small" type="danger" text @click="removeInstrument(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="`待补证（${pendingTests.length}）`" name="pending">
        <el-alert
          title="以下为仪器台账建立前的旧走时测试，查不出使用的校表仪：原合格结论不沿用。可登记当时所用仪器补证，证据不满足采信条件时必须复测。"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
        />
        <el-table :data="pendingTests" border size="small">
          <el-table-column label="钟表" min-width="160">
            <template #default="{ row }">{{ clockNoOf(row.clockId) }}</template>
          </el-table-column>
          <el-table-column label="测试时间" width="180">
            <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column prop="rate" label="日差" width="90" />
          <el-table-column prop="conclusion" label="原结论" width="120" />
          <el-table-column prop="invalidReason" label="待补证原因" min-width="240" />
          <el-table-column label="操作" width="220">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="openEvidence(row)">补证登记仪器</el-button>
              <el-button size="small" @click="$router.push(`/tests/${row.clockId}`)">去复测</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="pendingTests.length === 0" description="没有待补证测试" />
      </el-tab-pane>

      <el-tab-pane label="失效测试" name="invalid">
        <el-table
          :data="stepStore.tests.filter((t) => ['invalid_instrument', 'invalid_calibration', 'invalid_epoch'].includes(t.validity ?? ''))"
          border
          size="small"
        >
          <el-table-column label="钟表" min-width="150">
            <template #default="{ row }">{{ clockNoOf(row.clockId) }}</template>
          </el-table-column>
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column label="仪器" width="110">
            <template #default="{ row }">{{ instrumentCodeOf(row.instrumentId) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="130">
            <template #default="{ row }">
              <StateBadge
                :label="TEST_VALIDITY_META[(row.validity ?? 'pending_evidence') as keyof typeof TEST_VALIDITY_META].label"
                :tone="TEST_VALIDITY_META[(row.validity ?? 'pending_evidence') as keyof typeof TEST_VALIDITY_META].type"
              />
            </template>
          </el-table-column>
          <el-table-column prop="invalidReason" label="失效原因" min-width="260" />
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="$router.push(`/tests/${row.clockId}`)">安排复测</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="占台监视" name="reservations">
        <el-table :data="reservations" border size="small">
          <el-table-column label="仪器" width="120">
            <template #default="{ row }">{{ instrumentCodeOf(row.instrumentId) }}</template>
          </el-table-column>
          <el-table-column label="钟表" min-width="150">
            <template #default="{ row }">{{ clockNoOf(row.clockId) }}</template>
          </el-table-column>
          <el-table-column label="时段开始" width="180">
            <template #default="{ row }">{{ new Date(row.slotStart).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column label="时段结束" width="180">
            <template #default="{ row }">{{ new Date(row.slotEnd).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column prop="owner" label="持有者" width="130" />
          <el-table-column label="心跳截止" width="180">
            <template #default="{ row }">{{ new Date(row.expiresAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-if="reservations.length === 0" description="当前无临时占台" />
        <div class="muted" style="margin-top: 8px">占台预约由测试页发起；关闭页签或中断预约会立即释放，崩溃残留至多 20 秒后自动清理。</div>
      </el-tab-pane>
    </el-tabs>

    <!-- 新仪器 / 编辑 -->
    <el-dialog v-model="instrumentDialog" :title="instrumentEditing ? '编辑仪器' : '新仪器入账'" width="560px">
      <el-alert v-if="instrumentError" :title="instrumentError" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-form :model="instrumentForm" label-width="92px">
        <el-form-item label="仪器编号" required>
          <el-input v-model="instrumentForm.code" placeholder="如 BYQ-03" :disabled="!!instrumentEditing" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="instrumentForm.name" placeholder="如 机械校表仪" />
        </el-form-item>
        <el-form-item label="型号">
          <el-input v-model="instrumentForm.model" />
        </el-form-item>
        <el-form-item label="厂家">
          <el-input v-model="instrumentForm.maker" />
        </el-form-item>
        <el-form-item label="摆放位置">
          <el-input v-model="instrumentForm.location" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="instrumentForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="instrumentDialog = false">取消</el-button>
        <el-button type="primary" @click="submitInstrument">保存</el-button>
      </template>
    </el-dialog>

    <!-- 检定登记 / 补检 -->
    <el-dialog v-model="calDialog" :title="calForm.supplementary ? '脱检补检登记' : '检定登记'" width="560px">
      <el-alert
        v-if="calForm.supplementary"
        title="这是脱检后的补检：登记后该仪器证据纪元翻页，补检之前涉及该仪器的测试立即失效，相关钟表撤下完工结论，须复测确认后恢复。"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
      />
      <el-form :model="calForm" label-width="92px">
        <el-form-item label="检定日期">
          <el-date-picker v-model="calForm.calibratedAt" type="date" value-format="x" style="width: 100%" />
        </el-form-item>
        <el-form-item label="有效期至">
          <el-date-picker v-model="calForm.validUntil" type="date" value-format="x" style="width: 100%" />
        </el-form-item>
        <el-form-item label="证书编号">
          <el-input v-model="calForm.certNo" />
        </el-form-item>
        <el-form-item label="检定机构">
          <el-input v-model="calForm.org" />
        </el-form-item>
        <el-form-item label="标记为补检">
          <el-switch v-model="calForm.supplementary" />
          <span class="muted" style="margin-left: 10px">脱检后补回的检定请保持开启</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="calForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="calDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCalibration">{{ calForm.supplementary ? '确认补检' : '确认检定' }}</el-button>
      </template>
    </el-dialog>

    <!-- 改有效期 -->
    <el-dialog v-model="validityDialog" title="修改检定有效期" width="560px">
      <el-alert
        title="有效期是测试能否采信的依据。修改即视为原证据链变更：该仪器全部既有测试立即作废，相关钟表撤下完工结论，复测合格后恢复。"
        type="error"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
      />
      <el-form :model="validityForm" label-width="92px">
        <el-form-item label="检定日期">
          <el-date-picker v-model="validityForm.calibratedAt" type="date" value-format="x" style="width: 100%" />
        </el-form-item>
        <el-form-item label="有效期至">
          <el-date-picker v-model="validityForm.validUntil" type="date" value-format="x" style="width: 100%" />
        </el-form-item>
        <el-form-item label="证书编号">
          <el-input v-model="validityForm.certNo" />
        </el-form-item>
        <el-form-item label="检定机构">
          <el-input v-model="validityForm.org" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="validityForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="validityDialog = false">取消</el-button>
        <el-button type="danger" @click="submitValidity">确认修改并作废旧测试</el-button>
      </template>
    </el-dialog>

    <!-- 事件链 -->
    <el-drawer v-model="eventDrawer" :title="`仪器事件链 · ${eventInstrument?.code ?? ''}`" size="520px">
      <el-timeline v-if="eventList.length">
        <el-timeline-item
          v-for="e in eventList"
          :key="e.id"
          :timestamp="new Date(e.happenedAt).toLocaleString('zh-CN')"
          type="danger"
        >
          <el-tag size="small" type="danger">{{ INSTRUMENT_EVENT_LABEL[e.type] }}</el-tag>
          <el-tag size="small" effect="plain" style="margin-left: 6px">纪元 {{ e.epoch }}</el-tag>
          <div class="event-detail">{{ e.detail }}</div>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else description="暂无补检 / 停用 / 改有效期事件" />
    </el-drawer>

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
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.event-detail {
  margin-top: 6px;
  font-size: 13px;
  color: #5b6470;
  line-height: 1.6;
}
</style>
