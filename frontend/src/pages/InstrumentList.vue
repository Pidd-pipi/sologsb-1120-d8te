<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useInstrumentStore } from '../stores/instrumentStore';
import { useStepStore } from '../stores/stepStore';
import { onChange } from '../utils/crossTab';
import { isInstrumentUsable, instrumentUnusableReason, validUntilLabel } from '../types/instrument';
import type { CalibrationInstrument, CalibrationInstrumentDraft } from '../types/instrument';
import { invalidReasonLabel, validityLabel } from '../types/test';

const instrumentStore = useInstrumentStore();
const stepStore = useStepStore();

const dialogVisible = ref(false);
const editingId = ref('');
const checkDialogVisible = ref(false);
const checking = ref<CalibrationInstrument | null>(null);
const checkValidUntil = ref(Date.now());
const formError = ref('');

const form = reactive<CalibrationInstrumentDraft>({
  assetNo: '',
  name: '',
  model: '',
  maker: '',
  validUntil: Date.now() + 180 * 86400000,
  lastCheckedAt: Date.now(),
  status: 'active',
  note: '',
});

const statsOf = computed(() => (instId: string) => {
  const list = stepStore.tests.filter((t) => t.instrumentId === instId);
  return {
    total: list.length,
    valid: list.filter((t) => t.validity === 'valid').length,
    invalid: list.filter((t) => t.validity === 'invalid').length,
    pending: list.filter((t) => t.validity === 'pending-proof').length,
  };
});

function testsOf(instId: string) {
  return stepStore.tests
    .filter((t) => t.instrumentId === instId)
    .slice(0, 6);
}

function openCreate() {
  editingId.value = '';
  Object.assign(form, {
    assetNo: '',
    name: '',
    model: '',
    maker: '',
    validUntil: Date.now() + 180 * 86400000,
    lastCheckedAt: Date.now(),
    status: 'active',
    note: '',
  });
  formError.value = '';
  dialogVisible.value = true;
}

function openEdit(row: CalibrationInstrument) {
  editingId.value = row.id;
  Object.assign(form, {
    assetNo: row.assetNo,
    name: row.name,
    model: row.model,
    maker: row.maker,
    validUntil: row.validUntil,
    lastCheckedAt: row.lastCheckedAt,
    status: row.status,
    note: row.note,
  });
  formError.value = '';
  dialogVisible.value = true;
}

async function submit() {
  if (!form.assetNo.trim()) {
    formError.value = '资产编号必填';
    return;
  }
  const dup = instrumentStore.items.find(
    (it) => it.assetNo === form.assetNo.trim() && it.id !== editingId.value,
  );
  if (dup) {
    formError.value = '资产编号已存在';
    return;
  }
  if (editingId.value) {
    const current = instrumentStore.items.find((it) => it.id === editingId.value);
    // 停用必须走专用动作：检定版本递增 + 关联测试立即失效
    if (current && form.status === 'disabled' && current.status === 'active') {
      await ElMessageBox.confirm(
        `停用后，使用「${current.assetNo}」的全部测试立即失效，相关钟表撤下完工结论，确认停用？`,
        '停用仪器',
        { type: 'warning' },
      );
      await instrumentStore.setStatus(current.id, 'disabled');
    } else if (current && form.status === 'active' && current.status === 'disabled') {
      await instrumentStore.setStatus(current.id, 'active');
    }
    await instrumentStore.update(editingId.value, {
      assetNo: form.assetNo.trim(),
      name: form.name,
      model: form.model,
      maker: form.maker,
      validUntil: Number(form.validUntil),
      lastCheckedAt: Number(form.lastCheckedAt),
      note: form.note,
    });
    ElMessage.success('仪器台账已更新（有效期变更已使关联测试失效待复测）');
  } else {
    await instrumentStore.add({ ...form, assetNo: form.assetNo.trim(), validUntil: Number(form.validUntil), lastCheckedAt: Number(form.lastCheckedAt) });
    ElMessage.success('仪器已登记');
  }
  dialogVisible.value = false;
  await stepStore.loadTests();
}

function openRecalibrate(row: CalibrationInstrument) {
  checking.value = row;
  checkValidUntil.value = Date.now() + 180 * 86400000;
  checkDialogVisible.value = true;
}

async function confirmRecalibrate() {
  if (!checking.value) return;
  if (checkValidUntil.value <= Date.now()) {
    ElMessage.error('新有效期必须晚于当前时间');
    return;
  }
  await instrumentStore.recalibrate(checking.value.id, { validUntil: checkValidUntil.value });
  await stepStore.loadTests();
  checkDialogVisible.value = false;
  ElMessage.success('补检完成：该仪器历史测试已标记失效，复测合格后钟表恢复完工');
}

async function toggleStatus(row: CalibrationInstrument) {
  if (row.status === 'active') {
    await ElMessageBox.confirm(
      `停用后，使用「${row.assetNo}」的全部测试立即失效，相关钟表撤下完工结论，确认停用？`,
      '停用仪器',
      { type: 'warning' },
    );
    await instrumentStore.setStatus(row.id, 'disabled');
    ElMessage.warning('仪器已停用，关联测试已失效');
  } else {
    await instrumentStore.setStatus(row.id, 'active');
    ElMessage.success('仪器已重新启用，旧测试仍需复测确认');
  }
  await stepStore.loadTests();
}

async function remove(row: CalibrationInstrument) {
  await ElMessageBox.confirm(`删除仪器「${row.assetNo}」后，关联测试将按仪器缺失判定失效，确认删除？`, '删除仪器', {
    type: 'warning',
  });
  await instrumentStore.remove(row.id);
  await stepStore.loadTests();
  ElMessage.warning('仪器已删除');
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

const off = onChange((topic) => {
  if (topic === 'instruments') void instrumentStore.load();
  if (topic === 'instruments' || topic === 'tests') void stepStore.loadTests();
});

onMounted(async () => {
  await instrumentStore.load();
  await stepStore.load();
});
onBeforeUnmount(off);
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>校表仪台账</h2>
      <el-tag>共 {{ instrumentStore.items.length }} 台</el-tag>
      <el-tag type="success" effect="plain">可用 {{ instrumentStore.usable.length }} 台</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openCreate">登记仪器</el-button>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="规则：测前必须选用「启用且在检定有效期内」的仪器；补检、停用或修改有效期后，该仪器的历史测试立即失效，相关钟表撤下完工结论，复测合格后恢复。"
      style="margin-bottom: 12px"
    />

    <el-table :data="instrumentStore.items" border>
      <el-table-column prop="assetNo" label="资产编号" width="130" />
      <el-table-column label="仪器 / 型号" min-width="200">
        <template #default="{ row }">
          <strong>{{ row.name }}</strong>
          <div class="muted">{{ row.maker }} · {{ row.model }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag v-if="isInstrumentUsable(row)" type="success">可用</el-tag>
          <el-tooltip v-else :content="instrumentUnusableReason(row)" placement="top">
            <el-tag type="danger">{{ row.status === 'disabled' ? '停用' : '已过检' }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="检定有效期" width="200">
        <template #default="{ row }">
          <div>{{ fmt(row.validUntil) }}</div>
          <div :class="isInstrumentUsable(row) ? 'muted' : 'danger'">
            {{ validUntilLabel(row.validUntil) }} · v{{ row.certVersion }}
          </div>
        </template>
      </el-table-column>
      <el-table-column label="最近补检" width="160">
        <template #default="{ row }">{{ fmt(row.lastCheckedAt) }}</template>
      </el-table-column>
      <el-table-column label="关联测试" width="180">
        <template #default="{ row }">
          <el-tag size="small" type="success" effect="plain">有效 {{ statsOf(row.id).valid }}</el-tag>
          <el-tag size="small" type="danger" effect="plain">失效 {{ statsOf(row.id).invalid }}</el-tag>
          <el-tag size="small" type="warning" effect="plain">共 {{ statsOf(row.id).total }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip />
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">改有效期</el-button>
          <el-button size="small" type="primary" :disabled="row.status === 'disabled'" @click="openRecalibrate(row)">
            补检
          </el-button>
          <el-button size="small" :type="row.status === 'active' ? 'danger' : 'success'" @click="toggleStatus(row)">
            {{ row.status === 'active' ? '停用' : '启用' }}
          </el-button>
          <el-button size="small" type="danger" link @click="remove(row)">删</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-card v-for="row in instrumentStore.items" :key="row.id" shadow="never" style="margin-top: 14px">
      <template #header>
        <div class="card-head">
          <strong>{{ row.assetNo }} · 最近测试凭证</strong>
          <div class="spacer" />
          <el-tag size="small" effect="plain">有效 {{ statsOf(row.id).valid }} / 失效 {{ statsOf(row.id).invalid }}</el-tag>
        </div>
      </template>
      <el-table :data="testsOf(row.id)" size="small" border>
        <el-table-column label="测试时间" width="170">
          <template #default="{ row: t }">{{ fmt(t.testedAt) }}</template>
        </el-table-column>
        <el-table-column label="凭证状态" width="110">
          <template #default="{ row: t }">
            <el-tag
              size="small"
              :type="t.validity === 'valid' ? 'success' : t.validity === 'invalid' ? 'danger' : 'warning'"
            >
              {{ validityLabel(t.validity) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原因 / 结论" min-width="240">
          <template #default="{ row: t }">
            <span v-if="t.validity !== 'valid'" class="danger">
              {{ invalidReasonLabel(t.invalidReason) }}
            </span>
            <span v-else>结论：{{ t.conclusion }}</span>
          </template>
        </el-table-column>
        <el-table-column label="检定版本" width="90">
          <template #default="{ row: t }">v{{ t.certVersion ?? '—' }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="statsOf(row.id).total === 0" description="该仪器暂无测试记录" :image-size="50" />
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑仪器（改有效期将使旧测试失效）' : '登记校表仪'" width="560px">
      <el-alert v-if="formError" :title="formError" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-form :model="form" label-width="110px">
        <el-form-item label="资产编号" required>
          <el-input v-model="form.assetNo" placeholder="如 WIT-2201" />
        </el-form-item>
        <el-form-item label="仪器名称">
          <el-input v-model="form.name" placeholder="如 机械校表仪" />
        </el-form-item>
        <el-form-item label="型号 / 厂家">
          <el-input v-model="form.model" style="width: 55%" placeholder="型号" />
          <el-input v-model="form.maker" style="width: 42%; margin-left: 3%" placeholder="厂家" />
        </el-form-item>
        <el-form-item label="检定有效期至" required>
          <el-date-picker
            v-model="form.validUntil"
            type="datetime"
            placeholder="选择有效期"
            format="YYYY-MM-DD HH:mm"
            value-format="x"
            style="width: 240px"
          />
        </el-form-item>
        <el-form-item label="最近检定时间">
          <el-date-picker
            v-model="form.lastCheckedAt"
            type="datetime"
            placeholder="选择检定时间"
            format="YYYY-MM-DD HH:mm"
            value-format="x"
            style="width: 240px"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="disabled">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="checkDialogVisible" title="仪器补检 / 重新校准" width="460px">
      <el-alert
        v-if="checking"
        type="warning"
        :closable="false"
        :title="`补检后检定版本 v${checking.certVersion} → v${checking.certVersion + 1}，该仪器历史测试立即失效，需复测确认。`"
        style="margin-bottom: 12px"
      />
      <el-form label-width="120px">
        <el-form-item label="新有效期至">
          <el-date-picker
            v-model="checkValidUntil"
            type="datetime"
            format="YYYY-MM-DD HH:mm"
            value-format="x"
            style="width: 240px"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="checkDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmRecalibrate">确认补检</el-button>
      </template>
    </el-dialog>
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
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.muted {
  color: #7b8592;
  font-size: 12px;
}
.danger {
  color: #c45656;
  font-size: 12px;
}
</style>
