import { db } from './db';
import { newId } from './id';
import { publishSync } from './syncBus';
import type { Reservation, Instrument, Calibration } from '../types/instrument';
import type { TimekeepingTest } from '../types/test';

/** 临时占台的心跳有效期；崩溃页签的哨兵即使来不及释放，也至多占这么久 */
export const RESERVATION_TTL_MS = 20_000;
/** 哨兵锁仍在但心跳过期时，再宽限的时长（避免心跳抖动误抢） */
export const SENTINEL_GRACE_MS = 5_000;
/** 心跳续期间隔 */
export const HEARTBEAT_MS = 8_000;
/** 默认预约时长 */
export const DEFAULT_SLOT_MS = 30 * 60_000;

export type BookingErrorCode =
  | 'retired'
  | 'no_calibration'
  | 'conflict'
  | 'no_reservation'
  | 'instrument_changed'
  | 'lock_failed';

/** 占台 / 保存测试时的业务拒绝 */
export class BookingError extends Error {
  code: BookingErrorCode;
  conflict?: Reservation;
  constructor(code: BookingErrorCode, message: string, conflict?: Reservation) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.conflict = conflict;
  }
}

/** Web Locks API 的最小本地类型（避免依赖不同 TS DOM 版本声明） */
interface LockInfoLike {
  name: string;
}
interface LockSnapshotLike {
  held: LockInfoLike[];
  pending: LockInfoLike[];
}
interface LockManagerLike {
  runExclusive<T>(name: string, callback: () => Promise<T>): Promise<T>;
  request(name: string, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
  query(): Promise<LockSnapshotLike>;
}

type LockManagerWithApi = Navigator & { locks?: LockManagerLike };
const locksApi = (): LockManagerLike | undefined => (navigator as LockManagerWithApi).locks;
const LOCKS_SUPPORTED = typeof navigator !== 'undefined' && !!(navigator as LockManagerWithApi).locks;

/** 当前页签标识（写进占台记录，便于排查是谁占着） */
const TAB_TAG = newId('tab');

export function tabTag(): string {
  return TAB_TAG;
}

/** 对同一台仪器串行化「查冲突 → 写入」，让两个页签不可能同时通过冲突检查 */
function withInstrumentLock<T>(instrumentId: string, fn: () => Promise<T>): Promise<T> {
  const locks = locksApi();
  if (locks) {
    return locks.runExclusive(`gbclockrepair:instrument:${instrumentId}`, fn);
  }
  return fn();
}

function sentinelLockName(instrumentId: string, reservationId: string): string {
  return `gbclockrepair:sentinel:${instrumentId}:${reservationId}`;
}

async function isSentinelAlive(name: string): Promise<boolean> {
  const locks = locksApi();
  if (!locks) return false;
  const snapshot = await locks.query();
  return (snapshot.held ?? []).some((l) => l.name === name);
}

/**
 * 预约是否已失效：
 * - 有 Web Lock：哨兵锁被释放（页签关闭 / 崩溃 / 主动取消）立即失效，TTL + 宽限兜底
 * - 无 Web Lock：只认心跳 TTL
 */
async function isReservationStale(r: Reservation, now: number): Promise<boolean> {
  if (!LOCKS_SUPPORTED) return r.expiresAt < now;
  const alive = await isSentinelAlive(r.sentinelName);
  if (!alive) return true;
  return r.expiresAt + SENTINEL_GRACE_MS < now;
}

/**
 * 后台持有一把哨兵锁直到调用 release；页签关闭 / 崩溃时浏览器自动释放，
 * 其他页签可立刻通过 locks.query 发现该锁已不在。
 */
function holdSentinel(name: string): Promise<() => Promise<void>> {
  const locks = locksApi();
  if (!locks) return Promise.resolve(async () => {});
  return new Promise((resolve, reject) => {
    let releaseLock: () => void = () => {};
    const released = new Promise<void>((res) => {
      releaseLock = res;
    });
    const request = locks.request(name, async () => {
      // 锁已授予：把释放函数交给调用方，锁一直持有到 release 被调用
      resolve(async () => {
        releaseLock();
        await request;
      });
      await released;
    });
    request.catch(reject);
  });
}

interface OverlapResult {
  test?: TimekeepingTest;
  reservation?: Reservation;
}

/**
 * 查询该仪器在 [start, end] 上的占用：已保存测试或未释放的临时预约。
 * 顺手清掉崩溃 / 超时残留的预约，避免预约中断后一直占着。
 */
async function findOverlap(
  instrumentId: string,
  start: number,
  end: number,
  now: number,
): Promise<OverlapResult | null> {
  const tests = await db.tests.where('instrumentId').equals(instrumentId).toArray();
  const overlapTest = tests.find((t) => start < (t.slotEnd ?? t.testedAt) && t.testedAt < end);
  if (overlapTest) return { test: overlapTest };

  const reservations = await db.reservations.where('instrumentId').equals(instrumentId).toArray();
  for (const r of reservations) {
    if (!(start < r.slotEnd && r.slotStart < end)) continue;
    if (await isReservationStale(r, now)) {
      await db.reservations.delete(r.id);
      publishSync({ topic: 'reservations', payload: { instrumentId } });
      continue;
    }
    return { reservation: r };
  }
  return null;
}

function assertUsable(instrument: Instrument, calibrations: Calibration[], at: number): void {
  if (instrument.status === 'retired') {
    throw new BookingError('retired', `仪器「${instrument.code}」已停用，不能占台`);
  }
  const covered = calibrations.some(
    (c) => c.instrumentId === instrument.id && c.calibratedAt <= at && at <= c.validUntil,
  );
  if (!covered) {
    throw new BookingError('no_calibration', `仪器「${instrument.code}」当前无有效检定（已过检），请先补检`);
  }
}

export interface HoldHandle {
  reservation: Reservation;
  heartbeat: ReturnType<typeof setInterval>;
  /** 预约记录是否已被删除（其他页签抢占 / 取消 / 清理） */
  isGone(): Promise<boolean>;
  /** 放弃占台（关闭对话框 / 中断 / 页签离开） */
  release(): Promise<void>;
}

/**
 * 先占台：校验在用 + 检定覆盖 + 时段冲突，然后登记临时预约。
 * 两个页签抢同一时段时，仪器级串行锁保证只有一个成功。
 */
export async function acquireSlot(
  instrument: Instrument,
  slotStart: number,
  slotEnd: number,
  clockId: string,
): Promise<HoldHandle> {
  if (slotEnd <= slotStart) {
    throw new BookingError('conflict', '预约时段结束时间必须晚于开始时间');
  }
  const calibrations = await db.calibrations.where('instrumentId').equals(instrument.id).toArray();
  assertUsable(instrument, calibrations, slotStart);

  return withInstrumentLock(instrument.id, async () => {
    // 串行区内重新取最新状态，防止占台瞬间被停用 / 改有效期
    const latest = await db.instruments.get(instrument.id);
    if (!latest) throw new BookingError('instrument_changed', '仪器不存在');
    const latestCals = await db.calibrations.where('instrumentId').equals(latest.id).toArray();
    assertUsable(latest, latestCals, slotStart);

    const overlap = await findOverlap(latest.id, slotStart, slotEnd, Date.now());
    if (overlap?.reservation) {
      const r = overlap.reservation;
      throw new BookingError(
        'conflict',
        `该时段已被占用（${new Date(r.slotStart).toLocaleString('zh-CN')} 起，${r.owner} 预约）`,
        r,
      );
    }
    if (overlap?.test) {
      const t = overlap.test;
      throw new BookingError(
        'conflict',
        `该时段已有保存的测试（${new Date(t.testedAt).toLocaleString('zh-CN')}），请换时段`,
      );
    }

    const reservationId = newId('rsv');
    const sentinelName = sentinelLockName(latest.id, reservationId);
    let releaseSentinel: () => Promise<void> = async () => {};
    if (LOCKS_SUPPORTED) {
      releaseSentinel = await holdSentinel(sentinelName);
    }

    const now = Date.now();
    const reservation: Reservation = {
      id: reservationId,
      instrumentId: latest.id,
      clockId,
      slotStart,
      slotEnd,
      owner: `页签 ${TAB_TAG.slice(-4)}`,
      sentinelName,
      evidenceEpoch: latest.evidenceEpoch,
      expiresAt: now + RESERVATION_TTL_MS,
      createdAt: now,
    };
    try {
      await db.reservations.put(reservation);
    } catch (err) {
      await releaseSentinel();
      throw err;
    }
    publishSync({ topic: 'reservations', payload: { instrumentId: latest.id } });

    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const existing = await db.reservations.get(reservationId);
          if (existing) {
            existing.expiresAt = Date.now() + RESERVATION_TTL_MS;
            await db.reservations.put(existing);
          }
        } catch {
          /* 页签卸载 / 库关闭期间心跳失败可忽略，TTL 与哨兵锁会兜底 */
        }
      })();
    }, HEARTBEAT_MS);

    return {
      reservation,
      heartbeat,
      async isGone() {
        const existing = await db.reservations.get(reservationId);
        return !existing;
      },
      async release() {
        clearInterval(heartbeat);
        await db.reservations.delete(reservationId);
        await releaseSentinel();
        publishSync({ topic: 'reservations', payload: { instrumentId: instrument.id } });
      },
    };
  });
}

/**
 * 确认占台并原子落库测试。保存瞬间再次核验：
 * 仪器仍在用、检定仍覆盖、预约仍是自己且未被抢占；任一不满足即拒绝。
 */
export async function confirmTest(
  hold: HoldHandle,
  draft: Omit<
    TimekeepingTest,
    'id' | 'testedAt' | 'slotEnd' | 'instrumentId' | 'evidenceEpoch' | 'validity' | 'invalidReason'
  >,
): Promise<TimekeepingTest> {
  const r = hold.reservation;
  return withInstrumentLock(r.instrumentId, async () => {
    const mine = await db.reservations.get(r.id);
    if (!mine) {
      throw new BookingError('no_reservation', '预约已中断（可能被其他页签抢占或已超时），请重新占台');
    }
    if (mine.owner !== hold.reservation.owner) {
      throw new BookingError('no_reservation', '预约已不属于本页签，请重新占台');
    }
    const instrument = await db.instruments.get(r.instrumentId);
    if (!instrument || instrument.status === 'retired') {
      throw new BookingError('retired', '仪器已停用，测试拒绝保存');
    }
    const cals = await db.calibrations.where('instrumentId').equals(r.instrumentId).toArray();
    if (!cals.some((c) => c.calibratedAt <= r.slotStart && r.slotStart <= c.validUntil)) {
      throw new BookingError('no_calibration', '仪器当前无有效检定（已过检），测试拒绝保存');
    }
    // 占台之后仪器若被补检 / 停用 / 改有效期，证据纪元已翻：本次读数不能盖新纪元，拒绝并要求复测
    if (instrument.evidenceEpoch !== mine.evidenceEpoch) {
      throw new BookingError(
        'instrument_changed',
        '占台后该仪器发生了补检 / 停用 / 改有效期，本次测试不能采信，请重新占台复测',
      );
    }
    // 保存瞬间复查时段：防止占台之后该时段被补录进其他正式测试
    const tests = await db.tests.where('instrumentId').equals(r.instrumentId).toArray();
    const clash = tests.find((t) => r.slotStart < (t.slotEnd ?? t.testedAt) && t.testedAt < r.slotEnd);
    if (clash) {
      throw new BookingError(
        'conflict',
        `该时段已存在保存的测试（${new Date(clash.testedAt).toLocaleString('zh-CN')}），拒绝重复保存`,
      );
    }

    const fullRecord: TimekeepingTest = {
      ...draft,
      id: newId('tst'),
      testedAt: r.slotStart,
      slotEnd: r.slotEnd,
      instrumentId: r.instrumentId,
      evidenceEpoch: instrument.evidenceEpoch,
      validity: 'valid',
    };
    await db.transaction('rw', db.tests, db.reservations, async () => {
      await db.tests.add(fullRecord);
      await db.reservations.delete(r.id);
    });
    publishSync({ topic: 'reservations', payload: { instrumentId: r.instrumentId } });
    await hold.release();

    return fullRecord;
  });
}

/** 查询仪器时段占用（供时段选择界面展示），顺带清理残留预约 */
export async function busySlots(
  instrumentId: string,
  from: number,
  to: number,
): Promise<{
  tests: { start: number; end: number; clockId: string }[];
  reservations: Reservation[];
}> {
  const now = Date.now();
  const tests = await db.tests.where('instrumentId').equals(instrumentId).toArray();
  const testSlots = tests
    .map((t) => ({ start: t.testedAt, end: t.slotEnd ?? t.testedAt, clockId: t.clockId }))
    .filter((s) => s.end > from && s.start < to);

  const reservations = await db.reservations.where('instrumentId').equals(instrumentId).toArray();
  const alive: Reservation[] = [];
  for (const r of reservations) {
    if (r.slotEnd <= from || r.slotStart >= to) continue;
    if (await isReservationStale(r, now)) {
      await db.reservations.delete(r.id);
      publishSync({ topic: 'reservations', payload: { instrumentId } });
      continue;
    }
    alive.push(r);
  }
  return { tests: testSlots, reservations: alive };
}
