import { defineStore } from 'pinia';
import { db, recalculateTestValidity, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { broadcastChange } from '../utils/crossTab';
import type {
  CalibrationInstrument,
  CalibrationInstrumentDraft,
  InstrumentStatus,
} from '../types/instrument';

interface InstrumentState {
  items: CalibrationInstrument[];
  loaded: boolean;
}

export const useInstrumentStore = defineStore('instrument', {
  state: (): InstrumentState => ({ items: [], loaded: false }),
  getters: {
    byId: (state) => (id: string) => state.items.find((it) => it.id === id),
    byAssetNo: (state) => (no: string) => state.items.find((it) => it.assetNo === no),
    usable: (state) => state.items.filter((it) => it.status === 'active' && it.validUntil > Date.now()),
  },
  actions: {
    async load() {
      this.items = await db.instruments.orderBy('assetNo').toArray();
      this.loaded = true;
    },

    async add(draft: CalibrationInstrumentDraft) {
      const record: CalibrationInstrument = {
        ...toPlain(draft),
        id: newId('ins'),
        certVersion: 1,
        createdAt: Date.now(),
      };
      await db.instruments.put(toPlain(record));
      this.items = [...this.items, record];
      broadcastChange('instruments', 'add');
      return record;
    },

    async update(id: string, patch: Partial<CalibrationInstrumentDraft>) {
      // 改检定有效期属于检定状态变化：版本递增，关联测试立即失效待复测
      const current = this.items.find((it) => it.id === id);
      const certBumped =
        patch.validUntil !== undefined && current !== undefined && patch.validUntil !== current.validUntil;
      const plain = toPlain(patch);
      const nextPatch = certBumped
        ? { ...plain, certVersion: (current?.certVersion ?? 1) + 1 }
        : plain;
      await db.instruments.update(id, nextPatch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...nextPatch } : it));
      if (certBumped) await recalculateTestValidity(id);
      broadcastChange('instruments', certBumped ? 'validity-changed' : 'update');
    },

    /** 补检 / 重新校准：记录检定时间、给新有效期，版本递增，旧测试全部失效待复测 */
    async recalibrate(id: string, payload: { validUntil: number; lastCheckedAt?: number }) {
      const current = this.items.find((it) => it.id === id);
      if (!current) return;
      const patch = {
        validUntil: payload.validUntil,
        lastCheckedAt: payload.lastCheckedAt ?? Date.now(),
        certVersion: current.certVersion + 1,
        // 补检只更新检定状态，是否保持停用由台账单独操作
      };
      await db.instruments.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      await recalculateTestValidity(id);
      broadcastChange('instruments', 'recalibrated');
    },

    /** 停用 / 重新启用：停用立即使关联测试失效；重新启用本身不恢复旧版本测试，须复测 */
    async setStatus(id: string, status: InstrumentStatus) {
      const current = this.items.find((it) => it.id === id);
      if (!current || current.status === status) return;
      const patch: Partial<CalibrationInstrument> = { status };
      if (status === 'disabled') patch.certVersion = current.certVersion + 1;
      await db.instruments.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      await recalculateTestValidity(id);
      broadcastChange('instruments', status === 'disabled' ? 'disabled' : 'enabled');
    },

    async remove(id: string) {
      await db.instruments.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
      // 仪器删除后，其测试按"仪器不存在"重算为失效
      await recalculateTestValidity(id);
      broadcastChange('instruments', 'removed');
    },
  },
});
