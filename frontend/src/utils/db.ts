import Dexie, { type Table } from 'dexie';
import type { Clock } from '../types/clock';
import type { MovementPart } from '../types/part';
import type { RepairStep } from '../types/step';
import type { CalibrationInstrument } from '../types/instrument';
import { evaluateTest, type TimekeepingTest } from '../types/test';
import type { InstrumentReservation } from './booking-types';
import { newId } from './id';
import { cleanupOnBoot } from './booking';

export const DB_NAME = 'gbclockrepair';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbclockrepair:db-version';

interface InstrumentLockRow {
  id: string;
  tabToken: string;
  createdAt: number;
}

class ClockRepairDB extends Dexie {
  clocks!: Table<Clock, string>;
  parts!: Table<MovementPart, string>;
  steps!: Table<RepairStep, string>;
  tests!: Table<TimekeepingTest, string>;
  instruments!: Table<CalibrationInstrument, string>;
  instrumentLocks!: Table<InstrumentLockRow, string>;
  instrumentReservations!: Table<InstrumentReservation, string>;

  constructor() {
    super(DB_NAME);
    // v1：四张业务表
    this.version(1).stores({
      clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
      parts: 'id, clockId, name, wearState, decision',
      steps: 'id, clockId, seq, stepType, state',
      tests: 'id, clockId, testedAt',
    });
    // v2：补索引并迁移老记录缺省字段
    this.version(2)
      .stores({
        clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
        parts: 'id, clockId, name, wearState, decision, sourceLot',
        steps: 'id, clockId, seq, stepType, state, startedAt',
        tests: 'id, clockId, testedAt, conclusion',
      })
      .upgrade(async (tx) => {
        await tx
          .table('steps')
          .toCollection()
          .modify((row: any) => {
            if (!row.state) row.state = 'pending';
            if (row.partIds === undefined) row.partIds = [];
            if (row.torque === undefined) row.torque = 0;
          });
        await tx
          .table('tests')
          .toCollection()
          .modify((row: any) => {
            if (row.positions === undefined) row.positions = [];
          });
      });
    // v3：仪器台账 + 仪器预约/互斥；测试关联仪器与凭证状态
    this.version(3)
      .stores({
        clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
        parts: 'id, clockId, name, wearState, decision, sourceLot',
        steps: 'id, clockId, seq, stepType, state, startedAt',
        tests: 'id, clockId, testedAt, conclusion, instrumentId, validity, slotStart',
        instruments: 'id, assetNo, status, validUntil, certVersion',
        instrumentLocks: 'id',
        instrumentReservations: 'id, instrumentId, tabToken, expireAt, slotStart',
      })
      .upgrade(async (tx) => {
        // 老测试没有仪器记录 → 待补证，不沿用原合格结论
        await tx
          .table('tests')
          .toCollection()
          .modify((row: any) => {
            if (!row.instrumentId) {
              row.validity = 'pending-proof';
              row.invalidReason = 'missing-instrument';
            }
          });
        // 升级即补两台示范仪器，供复测使用（不回写老测试）
        const instCount = await tx.table('instruments').count();
        if (instCount === 0) {
          const now = Date.now();
          const day = 24 * 3600 * 1000;
          await tx.table('instruments').bulkPut([
            {
              id: newId('ins'),
              assetNo: 'WIT-2201',
              name: '机械校表仪',
              model: 'Witschi Chronoscope X1',
              maker: 'Witschi',
              validUntil: now + 180 * day,
              lastCheckedAt: now - 10 * day,
              status: 'active',
              certVersion: 1,
              note: '综合修复间常用，支持摆幅/偏振/日差',
              createdAt: now,
            },
            {
              id: newId('ins'),
              assetNo: 'WTG-1107',
              name: '便携校表仪',
              model: 'Timegrapher MTG-1900',
              maker: '通用',
              validUntil: now - 3 * day,
              lastCheckedAt: now - 200 * day,
              status: 'active',
              certVersion: 1,
              note: '已过检，补检前不可用于新测试',
              createdAt: now,
            },
          ]);
        }
      });
  }
}

export const db = new ClockRepairDB();

/**
 * 把 Vue 响应式代理（reactive/ref 内部对象，含嵌套数组）转成可结构化克隆的普通对象。
 * IndexedDB 的 put/add 无法克隆 Proxy，否则抛 DataCloneError。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/**
 * 依据仪器台账重算全部测试的凭证状态。
 * 仪器补检 / 改有效期 / 停用 / 删除后调用：该仪器关联测试立即失效或恢复待复测。
 * 返回受影响钟表 id（去重），用于撤下/恢复完工结论。
 */
export async function recalculateTestValidity(instrumentId?: string): Promise<string[]> {
  const [tests, instruments] = await Promise.all([
    instrumentId
      ? db.tests.where('instrumentId').equals(instrumentId).toArray()
      : db.tests.toArray(),
    db.instruments.toArray(),
  ]);
  const instMap = new Map(instruments.map((it) => [it.id, it]));
  const affectedClocks = new Set<string>();
  const now = Date.now();

  await db.transaction('rw', db.tests, async () => {
    for (const test of tests) {
      if (!test.instrumentId) {
        if (test.validity !== 'pending-proof') {
          await db.tests.update(test.id, {
            validity: 'pending-proof',
            invalidReason: 'missing-instrument',
            invalidatedAt: now,
          });
          affectedClocks.add(test.clockId);
        }
        continue;
      }
      const result = evaluateTest(test, instMap.get(test.instrumentId));
      if (result.validity === test.validity && result.reason === (test.invalidReason ?? '')) continue;
      affectedClocks.add(test.clockId);
      if (result.validity === 'valid') {
        await db.tests.update(test.id, {
          validity: 'valid',
          invalidReason: '',
          invalidatedAt: undefined,
        });
      } else {
        await db.tests.update(test.id, {
          validity: result.validity,
          invalidReason: result.reason,
          invalidatedAt: now,
        });
      }
    }
  });
  return Array.from(affectedClocks);
}

/** 首次进入灌入示范数据，保证页面非空壳 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.clocks.count();

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const clockA = newId('clk');
  const clockB = newId('clk');

  const instruments: CalibrationInstrument[] = [
    {
      id: newId('ins'),
      assetNo: 'WIT-2201',
      name: '机械校表仪',
      model: 'Witschi Chronoscope X1',
      maker: 'Witschi',
      validUntil: now + 180 * day,
      lastCheckedAt: now - 10 * day,
      status: 'active',
      certVersion: 1,
      note: '综合修复间常用，支持摆幅/偏振/日差',
      createdAt: now,
    },
    {
      id: newId('ins'),
      assetNo: 'WTG-1107',
      name: '便携校表仪',
      model: 'Timegrapher MTG-1900',
      maker: '通用',
      validUntil: now - 3 * day,
      lastCheckedAt: now - 200 * day,
      status: 'active',
      certVersion: 1,
      note: '已过检，补检前不可用于新测试',
      createdAt: now,
    },
  ];

  if (count > 0) {
    // 老库（v3 升级已建表）：确保至少有仪器台账数据
    const instCount = await db.instruments.count();
    if (instCount === 0) await db.instruments.bulkPut(instruments);
    await cleanupOnBoot();
    return;
  }

  const clocks: Clock[] = [
    {
      id: clockA,
      clockNo: 'CLK-1932-004',
      kind: '座钟',
      caliber: 'Junghans W278',
      origin: '德国',
      maker: 'Junghans',
      yearMade: '1932',
      caseMaterial: '胡桃木壳 + 铜机芯',
      size: '420×260×180',
      dialMark: 'Junghans 八日链，罗马数字盘',
      acquireFrom: '天津藏家转让',
      conditionGrade: '三级',
      storagePos: '修复台 A-2',
      createdAt: now - 20 * day,
    },
    {
      id: clockB,
      clockNo: 'CLK-1890-011',
      kind: '怀表',
      caliber: 'Longines 18.79',
      origin: '瑞士',
      maker: 'Longines',
      yearMade: '1890',
      caseMaterial: '银质猎壳',
      size: '52×18',
      dialMark: '白瓷盘，罗马数字，小秒针',
      acquireFrom: '上海拍卖会',
      conditionGrade: '二级',
      storagePos: '保险柜 B-1',
      createdAt: now - 9 * day,
    },
  ];

  const parts: MovementPart[] = [
    {
      id: newId('prt'),
      clockId: clockA,
      name: '发条',
      qtyNeeded: 1,
      position: '条盒内',
      wearState: '断裂',
      decision: '换新',
      sourceLot: 'MS-2024-07',
      dimension: 0.35,
    },
    {
      id: newId('prt'),
      clockId: clockA,
      name: '宝石轴承',
      qtyNeeded: 4,
      position: '二轮上下轴孔',
      wearState: '磨损',
      decision: '修配',
      sourceLot: 'JWL-18',
      dimension: 1.2,
    },
    {
      id: newId('prt'),
      clockId: clockB,
      name: '摆轮',
      qtyNeeded: 1,
      position: '摆轮夹板下',
      wearState: '完好',
      decision: '保留',
      sourceLot: '',
      dimension: 14.5,
    },
  ];

  const steps: RepairStep[] = [
    {
      id: newId('stp'),
      clockId: clockA,
      stepType: '拆解',
      seq: 1,
      partIds: [parts[0].id],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: '',
      oilPoints: '',
      torque: 0.6,
      troubleNote: '条盒盖螺纹轻微锈死，用渗透油浸润后拆下',
      operator: '祁仲言',
      startedAt: now - 12 * day,
      finishedAt: now - 12 * day + 80 * 60000,
      state: 'done',
    },
    {
      id: newId('stp'),
      clockId: clockA,
      stepType: '清洗',
      seq: 2,
      partIds: [parts[1].id],
      cleanSolvent: '石油醚 + 无水乙醇',
      cleanMethod: '超声',
      oilType: '',
      oilPoints: '',
      torque: 0,
      troubleNote: '宝石轴承孔内油泥结块，超声 3 遍',
      operator: '祁仲言',
      startedAt: now - 8 * day,
      finishedAt: now - 8 * day + 45 * 60000,
      state: 'done',
    },
    {
      id: newId('stp'),
      clockId: clockA,
      stepType: '润滑',
      seq: 3,
      partIds: [parts[1].id],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: 'Moebius 9010',
      oilPoints: '二轮上下轴孔、擒纵叉瓦',
      torque: 0,
      troubleNote: '',
      operator: '祁仲言',
      startedAt: now - 3 * day,
      state: 'pending',
    },
  ];

  // 旧测试没有仪器记录 → 待补证，不再作为完工依据
  const legacyTest: TimekeepingTest = {
    id: newId('tst'),
    clockId: clockA,
    testedAt: now - 2 * day,
    amplitude: 262,
    beatError: 0.4,
    rate: 6.5,
    positions: [
      { position: '面上', rate: 5.2, amplitude: 268, beatError: 0.3 },
      { position: '面下', rate: 7.8, amplitude: 256, beatError: 0.5 },
      { position: '12上', rate: 6.1, amplitude: 262, beatError: 0.4 },
      { position: '6上', rate: 6.9, amplitude: 258, beatError: 0.4 },
    ],
    powerReserve: 46,
    conclusion: '合格',
    validity: 'pending-proof',
    invalidReason: 'missing-instrument',
  };

  await db.transaction(
    'rw',
    db.clocks,
    db.parts,
    db.steps,
    db.tests,
    db.instruments,
    async () => {
      await db.clocks.bulkPut(clocks);
      await db.parts.bulkPut(parts);
      await db.steps.bulkPut(steps);
      await db.tests.put(legacyTest);
      await db.instruments.bulkPut(instruments);
    },
  );

  await cleanupOnBoot();
}
