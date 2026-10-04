import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { onSync, publishSync } from '../utils/syncBus';
import type {
  Calibration,
  Instrument,
  InstrumentDraft,
  InstrumentEvent,
  InstrumentEventType,
} from '../types/instrument';
import { INSTRUMENT_EVENT_LABEL } from '../types/instrument';

interface InstrumentState {
  items: Instrument[];
  calibrations: Calibration[];
  events: InstrumentEvent[];
  loaded: boolean;
}

let syncSubscribed = false;

export interface CalibrationDraft {
  calibratedAt: number;
  validUntil: number;
  certNo: string;
  org: string;
  supplementary: boolean;
  note: string;
}

export const useInstrumentStore = defineStore('instrument', {
  state: (): InstrumentState => ({ items: [], calibrations: [], events: [], loaded: false }),
  getters: {
    byId: (state) => (id?: string) => state.items.find((it) => it.id === id) || undefined,
    calibrationsOf: (state) => (instrumentId: string) =>
      state.calibrations
        .filter((c) => c.instrumentId === instrumentId)
        .sort((a, b) => b.calibratedAt - a.calibratedAt),
    eventsOf: (state) => (instrumentId: string) =>
      state.events
        .filter((e) => e.instrumentId === instrumentId)
        .sort((a, b) => b.happenedAt - a.happenedAt),
  },
  actions: {
    async load() {
      const [items, calibrations, events] = await Promise.all([
        db.instruments.toArray(),
        db.calibrations.toArray(),
        db.instrumentEvents.toArray(),
      ]);
      this.items = items.sort((a, b) => a.code.localeCompare(b.code));
      this.calibrations = calibrations;
      this.events = events;
      this.loaded = true;
      this.subscribeSync();
    },

    /** 其他页签改动仪器台账（补检 / 停用 / 改有效期等）后立即同步本页签 */
    subscribeSync() {
      if (syncSubscribed) return;
      syncSubscribed = true;
      onSync((msg) => {
        if (msg.topic !== 'instruments') return;
        const store = useInstrumentStore();
        void store.load();
      });
    },

    /**
     * 某台仪器在给定时刻所处的证据纪元：
     * 取「不晚于该时刻」的最后一次事件所确立的纪元；时刻之前没有事件则为 0。
     * 补证旧测试时必须盖测试当时的纪元，不能盖当前纪元，否则旧结论会蒙混过关。
     */
    epochAt(instrumentId: string, at: number): number {
      const past = this.events
        .filter((e) => e.instrumentId === instrumentId && e.happenedAt <= at)
        .sort((a, b) => b.epoch - a.epoch);
      return past[0]?.epoch ?? 0;
    },

    async add(draft: InstrumentDraft): Promise<Instrument> {
      const code = draft.code.trim();
      if (this.items.some((it) => it.code === code)) {
        throw new Error(`仪器编号「${code}」已存在`);
      }
      const record: Instrument = {
        ...toPlain(draft),
        code,
        id: newId('ins'),
        status: 'active',
        evidenceEpoch: 0,
        createdAt: Date.now(),
      };
      await db.instruments.put(toPlain(record));
      this.items = [...this.items, record].sort((a, b) => a.code.localeCompare(b.code));
      publishSync({ topic: 'instruments', payload: { type: 'add', id: record.id } });
      return record;
    },

    async update(id: string, patch: Partial<Instrument>): Promise<void> {
      // 编号 / 状态 / 纪元不允许走普通更新
      const { code: _code, status: _status, evidenceEpoch: _epoch, ...rest } = patch;
      void _code;
      void _status;
      void _epoch;
      const plain = toPlain(rest) as Partial<Instrument>;
      await db.instruments.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
      publishSync({ topic: 'instruments', payload: { type: 'update', id } });
    },

    async remove(id: string): Promise<void> {
      const reservations = await db.reservations.where('instrumentId').equals(id).toArray();
      await db.transaction(
        'rw',
        db.instruments,
        db.calibrations,
        db.instrumentEvents,
        db.reservations,
        async () => {
          await db.instruments.delete(id);
          await db.calibrations.where('instrumentId').equals(id).delete();
          await db.instrumentEvents.where('instrumentId').equals(id).delete();
          await db.reservations.bulkDelete(reservations.map((r) => r.id));
        },
      );
      this.items = this.items.filter((it) => it.id !== id);
      this.calibrations = this.calibrations.filter((c) => c.instrumentId !== id);
      this.events = this.events.filter((e) => e.instrumentId !== id);
      publishSync({ topic: 'instruments', payload: { type: 'remove', id } });
    },

    /**
     * 登记检定（普通检定或脱检后补检）。
     * 补检：翻证据纪元 + 写事件 + 发布台账变更，stepStore 收到后立即重算测试并撤完工。
     * 普通周期检定不翻纪元。
     */
    async addCalibration(instrumentId: string, draft: CalibrationDraft): Promise<Calibration> {
      const instrument = await db.instruments.get(instrumentId);
      if (!instrument) throw new Error('仪器不存在');
      if (draft.validUntil <= draft.calibratedAt) throw new Error('有效期必须晚于检定日期');

      const record: Calibration = {
        id: newId('cal'),
        instrumentId,
        ...toPlain(draft),
        createdAt: Date.now(),
      };
      await db.transaction('rw', db.calibrations, db.instruments, async () => {
        await db.calibrations.put(record);
        await db.instruments.update(instrumentId, { activeCalibrationId: record.id });
      });
      this.calibrations = [...this.calibrations, record];
      this.items = this.items.map((it) =>
        it.id === instrumentId ? { ...it, activeCalibrationId: record.id } : it,
      );

      if (draft.supplementary) {
        await this.bumpEpoch(
          instrumentId,
          'calibrate_supplementary',
          `补检登记（证书 ${draft.certNo || '无编号'}，检定至 ${new Date(draft.validUntil).toLocaleDateString('zh-CN')}），补检前测试全部作废待复测`,
        );
      } else {
        publishSync({ topic: 'instruments', payload: { type: 'calibration', id: instrumentId } });
      }
      return record;
    },

    /**
     * 修改检定有效期：翻证据纪元，原有效期覆盖的结论不再可信，相关测试立即重算。
     */
    async changeCalibrationValidity(
      calibrationId: string,
      patch: { calibratedAt?: number; validUntil?: number; certNo?: string; org?: string; note?: string },
    ): Promise<void> {
      const calibration = await db.calibrations.get(calibrationId);
      if (!calibration) throw new Error('检定记录不存在');
      const merged = { ...calibration, ...patch };
      if (merged.validUntil <= merged.calibratedAt) throw new Error('有效期必须晚于检定日期');
      await db.calibrations.update(calibrationId, toPlain(patch));
      this.calibrations = this.calibrations.map((c) => (c.id === calibrationId ? { ...c, ...patch } : c));
      await this.bumpEpoch(
        calibration.instrumentId,
        'change_validity',
        `检定有效期变更为 ${new Date(merged.calibratedAt).toLocaleDateString('zh-CN')} ~ ${new Date(
          merged.validUntil,
        ).toLocaleDateString('zh-CN')}，该仪器全部既有测试作废待复测`,
      );
    },

    /**
     * 停用仪器：翻纪元 + 清掉全部未确认的占台预约。
     * 重新启用不清算纪元——停用前的测试必须复测确认后才能恢复。
     */
    async retire(instrumentId: string, reason: string): Promise<void> {
      const instrument = await db.instruments.get(instrumentId);
      if (!instrument) throw new Error('仪器不存在');
      if (instrument.status === 'retired') return;
      const pending = await db.reservations.where('instrumentId').equals(instrumentId).toArray();
      await db.transaction('rw', db.instruments, db.reservations, async () => {
        await db.instruments.update(instrumentId, { status: 'retired' });
        await db.reservations.bulkDelete(pending.map((r) => r.id));
      });
      this.items = this.items.map((it) => (it.id === instrumentId ? { ...it, status: 'retired' } : it));
      await this.bumpEpoch(
        instrumentId,
        'retire',
        `仪器停用${reason ? `：${reason}` : ''}，占台预约全部取消，既有测试作废待复测`,
      );
    },

    /** 重新启用：只恢复可预约状态，纪元不清算（停用前测试仍须复测） */
    async reactivate(instrumentId: string): Promise<void> {
      const instrument = await db.instruments.get(instrumentId);
      if (!instrument || instrument.status !== 'retired') return;
      await db.instruments.update(instrumentId, { status: 'active' });
      this.items = this.items.map((it) => (it.id === instrumentId ? { ...it, status: 'active' } : it));
      publishSync({ topic: 'instruments', payload: { type: 'reactivate', id: instrumentId } });
    },

    /**
     * 翻证据纪元并落事件；测试保存时记录的纪元小于当前值即失效。
     * 事件广播会让所有页签（含本页签之外）立即重算。
     */
    async bumpEpoch(instrumentId: string, type: InstrumentEventType, detail: string): Promise<void> {
      const instrument = await db.instruments.get(instrumentId);
      if (!instrument) return;
      const epoch = instrument.evidenceEpoch + 1;
      const event: InstrumentEvent = {
        id: newId('evt'),
        instrumentId,
        type,
        epoch,
        happenedAt: Date.now(),
        detail: detail || INSTRUMENT_EVENT_LABEL[type],
      };
      await db.transaction('rw', db.instrumentEvents, db.instruments, async () => {
        await db.instrumentEvents.put(event);
        await db.instruments.update(instrumentId, { evidenceEpoch: epoch });
      });
      this.events = [...this.events, event];
      this.items = this.items.map((it) => (it.id === instrumentId ? { ...it, evidenceEpoch: epoch } : it));
      publishSync({ topic: 'instruments', payload: { type, id: instrumentId, eventType: type } });
    },
  },
});
