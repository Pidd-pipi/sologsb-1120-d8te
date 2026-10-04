import Dexie, { type Table } from 'dexie';
import type { Clock } from '../types/clock';
import type { MovementPart } from '../types/part';
import type { RepairStep } from '../types/step';
import type { TimekeepingTest } from '../types/test';
import type { Instrument, Calibration, InstrumentEvent, Reservation } from '../types/instrument';
import { newId } from './id';

export const DB_NAME = 'gbclockrepair';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbclockrepair:db-version';

class ClockRepairDB extends Dexie {
  clocks!: Table<Clock, string>;
  parts!: Table<MovementPart, string>;
  steps!: Table<RepairStep, string>;
  tests!: Table<TimekeepingTest, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  instrumentEvents!: Table<InstrumentEvent, string>;
  reservations!: Table<Reservation, string>;

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
    // v3：仪器台账（校表仪 + 检定 + 事件）与占台预约；测试挂仪器与证据状态
    this.version(3)
      .stores({
        clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
        parts: 'id, clockId, name, wearState, decision, sourceLot',
        steps: 'id, clockId, seq, stepType, state, startedAt',
        tests: 'id, clockId, testedAt, conclusion, instrumentId, validity',
        instruments: 'id, code, status, activeCalibrationId',
        calibrations: 'id, instrumentId, calibratedAt, validUntil',
        instrumentEvents: 'id, instrumentId, happenedAt, type',
        reservations: 'id, instrumentId, clockId, slotStart, slotEnd, expiresAt',
      })
      .upgrade(async (tx) => {
        // 旧测试没有仪器记录：列入待补证，不沿用原合格结论
        await tx
          .table('tests')
          .toCollection()
          .modify((row: any) => {
            if (!row.instrumentId) {
              row.validity = 'pending_evidence';
              row.invalidReason = '旧测试无仪器记录，须补证或复测，不沿用原合格结果';
            }
          });
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

/** 当日 00:00 / 23:59:59.999，便于检定有效期按整天判断 */
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** 首次进入灌入示范数据，保证页面非空壳 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.clocks.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const clockA = newId('clk');
  const clockB = newId('clk');
  const instrumentA = newId('ins');
  const instrumentB = newId('ins');

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

  // 仪器台账：01 在检定有效期内可用；02 已过检，待补检
  const instruments: Instrument[] = [
    {
      id: instrumentA,
      code: 'BYQ-01',
      name: '机械校表仪',
      model: 'Witschi Q-Test 03',
      maker: 'Witschi',
      location: '检测室 1 号台',
      status: 'active',
      evidenceEpoch: 0,
      activeCalibrationId: undefined,
      note: '主力校表仪，走时测试专用',
      createdAt: now - 180 * day,
    },
    {
      id: instrumentB,
      code: 'BYQ-02',
      name: '便携校表仪',
      model: 'Timegrapher MTG-1900',
      maker: 'Vibrograf',
      location: '检测室储物柜',
      status: 'active',
      evidenceEpoch: 0,
      activeCalibrationId: undefined,
      note: '外修携带用，当前已过检',
      createdAt: now - 120 * day,
    },
  ];

  const calibrationA: Calibration = {
    id: newId('cal'),
    instrumentId: instrumentA,
    calibratedAt: startOfDay(now - 60 * day),
    validUntil: endOfDay(now + 30 * day),
    certNo: 'JL-2026-0317',
    org: '市计量检测院',
    supplementary: false,
    note: '周期检定合格',
    createdAt: now - 60 * day,
  };
  instruments[0].activeCalibrationId = calibrationA.id;
  const calibrationB: Calibration = {
    id: newId('cal'),
    instrumentId: instrumentB,
    calibratedAt: startOfDay(now - 400 * day),
    validUntil: endOfDay(now - 35 * day),
    certNo: 'JL-2025-0908',
    org: '市计量检测院',
    supplementary: false,
    note: '上一周期检定，已到期待补检',
    createdAt: now - 400 * day,
  };
  instruments[1].activeCalibrationId = calibrationB.id;

  const validTestTime = now - 1 * day;
  const tests: TimekeepingTest[] = [
    {
      // 旧测试：无仪器记录 → 待补证，不沿用原「合格」
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
      validity: 'pending_evidence',
      invalidReason: '旧测试无仪器记录，须补证或复测，不沿用原合格结果',
    },
    {
      // 有仪器且检定覆盖的有效测试
      id: newId('tst'),
      clockId: clockA,
      testedAt: validTestTime,
      slotEnd: validTestTime + 30 * 60000,
      amplitude: 271,
      beatError: 0.3,
      rate: 4.2,
      positions: [
        { position: '面上', rate: 3.8, amplitude: 275, beatError: 0.3 },
        { position: '面下', rate: 4.9, amplitude: 266, beatError: 0.4 },
        { position: '12上', rate: 4.0, amplitude: 272, beatError: 0.3 },
        { position: '6上', rate: 4.1, amplitude: 271, beatError: 0.3 },
      ],
      powerReserve: 48,
      conclusion: '合格',
      instrumentId: instrumentA,
      evidenceEpoch: 0,
      validity: 'valid',
    },
  ];

  await db.transaction(
    'rw',
    [
      db.clocks,
      db.parts,
      db.steps,
      db.tests,
      db.instruments,
      db.calibrations,
      db.instrumentEvents,
      db.reservations,
    ],
    async () => {
      await db.clocks.bulkPut(clocks);
      await db.parts.bulkPut(parts);
      await db.steps.bulkPut(steps);
      await db.instruments.bulkPut(instruments);
      await db.calibrations.bulkPut([calibrationA, calibrationB]);
      await db.tests.bulkPut(tests);
    },
  );
}
