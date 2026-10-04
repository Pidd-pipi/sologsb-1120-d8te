import { db } from './db';
import { newId } from './id';
import { isInstrumentUsable } from '../types/instrument';
import type { CalibrationInstrument } from '../types/instrument';
import type { InstrumentReservation } from './booking-types';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';
import { pulseBooking } from './crossTab';

/**
 * 仪器预约与跨页签互斥。
 *
 * 两张系统表：
 * - instrumentLocks：仪器级短 TTL 互斥锁（主键 = 仪器 id）。保存测试时在 rw 事务内
 *   「占锁 → 查已存测试时段 → 查他页签预约 → 写测试 → 释放」，IndexedDB 事务串行化
 *   保证两个页签同时抢同一台仪器时只有一个成功。
 * - instrumentReservations：页签对仪器时段的占用（心跳续约，关页签后 TTL 过期自动释放）。
 */

/** 锁 / 预约的存活时长：3 次心跳内有效 */
export const RESERVATION_TTL = 9000;
const HEARTBEAT_INTERVAL = 3000;

export class BookingRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingRejectedError';
  }
}

/** 当前页签标识，整个会话不变 */
export const TAB_TOKEN = newId('tab');

export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 本页签对某仪器当前持有（未过期）的预约 */
export async function myReservation(instrumentId: string): Promise<InstrumentReservation | undefined> {
  const now = Date.now();
  const rows = await db.instrumentReservations.where('instrumentId').equals(instrumentId).toArray();
  return rows.find((r) => r.tabToken === TAB_TOKEN && r.expireAt > now);
}

async function purgeStale(instrumentId: string, now = Date.now()): Promise<void> {
  const stale = await db.instrumentReservations
    .where('instrumentId')
    .equals(instrumentId)
    .toArray();
  const dead = stale.filter((r) => r.expireAt <= now);
  if (dead.length) await db.instrumentReservations.bulkDelete(dead.map((r) => r.id));
}

/**
 * 预约某仪器的测试时段（测前占用）。
 * 与已保存测试或他页签未过期预约冲突、仪器不可用时拒绝。
 */
export async function reserveSlot(params: {
  instrumentId: string;
  clockId: string;
  slotStart: number;
  slotEnd: number;
}): Promise<InstrumentReservation> {
  const { instrumentId, clockId, slotStart, slotEnd } = params;
  if (!(slotEnd > slotStart)) throw new BookingRejectedError('预约时段不合法（结束须晚于开始）');

  const inst = await db.instruments.get(instrumentId);
  if (!inst) throw new BookingRejectedError('所选校表仪不存在');
  if (inst.status === 'disabled') throw new BookingRejectedError('该仪器已停用，无法预约');
  if (inst.validUntil <= slotStart) {
    throw new BookingRejectedError('测试时段超出仪器检定有效期，无法预约（请先补检）');
  }
  if (!isInstrumentUsable(inst)) {
    throw new BookingRejectedError('该仪器当前不可用');
  }

  await purgeStale(instrumentId);
  const others = await db.instrumentReservations.where('instrumentId').equals(instrumentId).toArray();
  const clash = others.find(
    (r) => r.tabToken !== TAB_TOKEN && overlap(slotStart, slotEnd, r.slotStart, r.slotEnd),
  );
  if (clash) {
    throw new BookingRejectedError(
      `该时段已被其他页面预约（${new Date(clash.slotStart).toLocaleString('zh-CN')} 起），请更换仪器或时段`,
    );
  }

  const savedClash = await findTestClash(instrumentId, slotStart, slotEnd);
  if (savedClash) {
    throw new BookingRejectedError(
      `该时段已有测试记录（${new Date(savedClash.slotStart ?? savedClash.testedAt).toLocaleString('zh-CN')}）`,
    );
  }

  const now = Date.now();
  const reservation: InstrumentReservation = {
    id: `${instrumentId}__${TAB_TOKEN}`,
    instrumentId,
    clockId,
    tabToken: TAB_TOKEN,
    slotStart,
    slotEnd,
    expireAt: now + RESERVATION_TTL,
    createdAt: now,
  };
  await db.instrumentReservations.put(reservation);
  pulseBooking(instrumentId);
  return reservation;
}

/** 续约 / 调整预约时段 */
export async function heartbeatReservation(params: {
  instrumentId: string;
  clockId: string;
  slotStart: number;
  slotEnd: number;
}): Promise<InstrumentReservation> {
  const { instrumentId, clockId, slotStart, slotEnd } = params;
  await purgeStale(instrumentId);
  const now = Date.now();
  const reservation: InstrumentReservation = {
    id: `${instrumentId}__${TAB_TOKEN}`,
    instrumentId,
    clockId,
    tabToken: TAB_TOKEN,
    slotStart,
    slotEnd,
    expireAt: now + RESERVATION_TTL,
    createdAt: now,
  };
  await db.instrumentReservations.put(reservation);
  pulseBooking(instrumentId);
  return reservation;
}

/** 主动释放本页签对仪器的预约（保存完成 / 切换 / 离开页面） */
export async function releaseReservation(instrumentId: string): Promise<void> {
  await db.instrumentReservations.delete(`${instrumentId}__${TAB_TOKEN}`);
  pulseBooking(instrumentId);
}

/** 释放本页签全部预约 */
export async function releaseAllReservations(): Promise<void> {
  const mine = await db.instrumentReservations.where('tabToken').equals(TAB_TOKEN).toArray();
  if (mine.length) {
    await db.instrumentReservations.bulkDelete(mine.map((r) => r.id));
    mine.forEach((r) => pulseBooking(r.instrumentId));
  }
}

async function findTestClash(
  instrumentId: string,
  slotStart: number,
  slotEnd: number,
): Promise<TimekeepingTest | undefined> {
  const tests = await db.tests.toArray();
  return tests
    .filter((t) => t.instrumentId === instrumentId && t.slotStart !== undefined && t.slotEnd !== undefined)
    .find((t) => overlap(slotStart, slotEnd, t.slotStart as number, t.slotEnd as number));
}

/**
 * 保存测试：在仪器级互斥事务内做最终校验，两个页签抢同一台仪器时只能一人成功。
 * 预约只是软提示，这里才是最终闸门；预约中断（未保存离开）随 TTL 自动失效，不会长期占用。
 */
export async function saveTestWithBooking(
  draft: TimekeepingTestDraft & { instrumentId: string; slotStart: number; slotEnd: number },
  makeId: () => string,
): Promise<TimekeepingTest> {
  const { instrumentId, slotStart, slotEnd } = draft;
  if (!(slotEnd > slotStart)) throw new BookingRejectedError('测试时段不合法（结束须晚于开始）');

  // 回调只执行一次（Dexie 4 不自动重试）：锁、冲突复查与测试写入在同一事务内，
  // 抛错即整体回滚，不会留下锁或半截记录。
  let saved: TimekeepingTest | null = null;

  await db.transaction(
    'rw',
    db.instruments,
    db.instrumentLocks,
    db.instrumentReservations,
    db.tests,
    async () => {
      const lockKey = instrumentId;
      try {
        // add 命中同名主键即抛 ConstraintError → 事务 abort → 后到者失败
        await db.instrumentLocks.add({ id: lockKey, tabToken: TAB_TOKEN, createdAt: Date.now() });
      } catch {
        throw new BookingRejectedError('另一页面正在使用该仪器保存测试，请稍后重试');
      }

      const inst = await db.instruments.get(instrumentId);
      if (!inst) throw new BookingRejectedError('所选校表仪不存在');
      const unusable =
        inst.status === 'disabled'
          ? '该仪器已停用，禁止保存测试'
          : inst.validUntil <= slotStart
            ? '测试时段超出仪器检定有效期，禁止保存'
            : '';
      if (unusable) throw new BookingRejectedError(unusable);

      // 已保存测试的时段冲突
      const allTests = await db.tests.toArray();
      const testClash = allTests
        .filter(
          (t) =>
            t.instrumentId === instrumentId &&
            t.slotStart !== undefined &&
            t.slotEnd !== undefined,
        )
        .find((t) => overlap(slotStart, slotEnd, t.slotStart as number, t.slotEnd as number));
      if (testClash) {
        throw new BookingRejectedError(
          `时段冲突：该仪器在 ${new Date(testClash.slotStart as number).toLocaleString('zh-CN')} 已有测试`,
        );
      }

      // 他页签未过期预约冲突
      const reservations = await db.instrumentReservations
        .where('instrumentId')
        .equals(instrumentId)
        .toArray();
      const resClash = reservations.find(
        (r) =>
          r.tabToken !== TAB_TOKEN &&
          r.expireAt > Date.now() &&
          overlap(slotStart, slotEnd, r.slotStart, r.slotEnd),
      );
      if (resClash) {
        throw new BookingRejectedError('时段已被其他页面预约，保存被拒绝');
      }

      const record: TimekeepingTest = {
        ...draft,
        id: makeId(),
        instrumentId: inst.id,
        instrumentNo: inst.assetNo,
        instrumentName: inst.name,
        certVersion: inst.certVersion,
        validity: 'valid',
        invalidReason: '',
      };
      await db.tests.put(record);
      saved = record;

      // 本页签的预约随落盘释放
      await db.instrumentReservations.delete(`${instrumentId}__${TAB_TOKEN}`);
      // 锁在事务提交时随回滚删除（见 finally 对事务外不可靠，故在成功路径显式删）
      await db.instrumentLocks.delete(lockKey);
    },
  );

  if (!saved) {
    // 发生过事务重试且首跑已写锁的极端情况：直接判定失败，交由用户重试
    throw new BookingRejectedError('保存冲突，请重试');
  }
  return saved;
}

/** 仪器选择/预约面板展示的占用信息 */
export interface SlotOccupancy {
  reservation: InstrumentReservation | undefined;
  others: InstrumentReservation[];
}

export async function occupancyOf(
  instrumentId: string,
  clockId: string,
): Promise<SlotOccupancy> {
  await purgeStale(instrumentId);
  const rows = await db.instrumentReservations.where('instrumentId').equals(instrumentId).toArray();
  return {
    reservation: rows.find((r) => r.tabToken === TAB_TOKEN && r.clockId === clockId),
    others: rows.filter((r) => r.tabToken !== TAB_TOKEN),
  };
}

/** 心跳定时器句柄工具 */
export function startHeartbeat(send: () => void | Promise<void>): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void send();
  }, HEARTBEAT_INTERVAL);
}

/** 启动时清理本页签可能残留的过期预约（崩溃后重开） */
export async function cleanupOnBoot(): Promise<void> {
  const now = Date.now();
  const all = await db.instrumentReservations.toArray();
  const stale = all.filter((r) => r.tabToken === TAB_TOKEN || r.expireAt <= now);
  if (stale.length) await db.instrumentReservations.bulkDelete(stale.map((r) => r.id));
  const locks = await db.instrumentLocks.toCollection().primaryKeys();
  // 锁理论上随事务结束即删；残留只可能来自旧版本，启动时清掉
  if (locks.length) await db.instrumentLocks.clear();
}

/** 查某仪器在给定时段的冲突（页面实时提示用） */
export async function inspectSlot(
  instrument: CalibrationInstrument,
  slotStart: number,
  slotEnd: number,
): Promise<string> {
  if (instrument.status === 'disabled') return '仪器已停用';
  if (instrument.validUntil <= slotStart) return '测试时段超出检定有效期';
  await purgeStale(instrument.id);
  const reservations = await db.instrumentReservations.where('instrumentId').equals(instrument.id).toArray();
  const clash = reservations.find(
    (r) => r.tabToken !== TAB_TOKEN && overlap(slotStart, slotEnd, r.slotStart, r.slotEnd),
  );
  if (clash) return `与其他页签预约冲突（${new Date(clash.slotStart).toLocaleString('zh-CN')} 起）`;
  const saved = await findTestClash(instrument.id, slotStart, slotEnd);
  if (saved) return '与已保存测试时段冲突';
  return '';
}
