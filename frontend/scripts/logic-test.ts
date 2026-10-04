/**
 * 业务规则端到端验证（Node + fake-indexeddb + 最小浏览器环境桩）。
 * env-setup 必须在最前，完成 IndexedDB 等浏览器 API 的安装。
 */
import './env-setup';
import { fakeLocks } from './env-setup';
import { db, ensureSeedData } from '../src/utils/db';
import { useInstrumentStore } from '../src/stores/instrumentStore';
import { useStepStore } from '../src/stores/stepStore';
import { useClockStore } from '../src/stores/clockStore';
import { repairStateOf } from '../src/utils/repairState';
import { acquireSlot, confirmTest, BookingError, busySlots, DEFAULT_SLOT_MS } from '../src/utils/booking';
import { createPinia, setActivePinia } from 'pinia';
import { startOfDay, endOfDay } from '../src/utils/timeCalc';

let passed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) throw new Error(`✗ ${name}${detail ? `：${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function expectBookingError(code: string, label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error(`✗ ${label}：应当被拒绝但成功了`);
  } catch (e) {
    if (e instanceof BookingError && e.code === code) {
      passed += 1;
      console.log(`  ✓ ${label}（${code}）`);
    } else if (e instanceof BookingError) {
      throw new Error(`✗ ${label}：错误码应为 ${code}，实际 ${e.code}（${e.message}）`);
    } else {
      throw e;
    }
  }
}

function readingDraft(clockId: string, rate = 4) {
  return {
    clockId,
    amplitude: 270,
    beatError: 0.3,
    rate,
    positions: [
      { position: '面上' as const, rate, amplitude: 272, beatError: 0.3 },
      { position: '面下' as const, rate, amplitude: 268, beatError: 0.3 },
      { position: '12上' as const, rate, amplitude: 271, beatError: 0.3 },
      { position: '6上' as const, rate, amplitude: 269, beatError: 0.3 },
    ],
    powerReserve: 45,
    conclusion: '合格',
  };
}

async function main() {
  setActivePinia(createPinia());
  await ensureSeedData();
  const clockStore = useClockStore();
  const instrumentStore = useInstrumentStore();
  const stepStore = useStepStore();
  await clockStore.load();
  await instrumentStore.load();
  await stepStore.load();

  const clockA = clockStore.items.find((c) => c.clockNo === 'CLK-1932-004')!; // Junghans
  const byq01 = instrumentStore.items.find((i) => i.code === 'BYQ-01')!;
  const byq02 = instrumentStore.items.find((i) => i.code === 'BYQ-02')!;
  check('示范钟表与仪器存在', !!clockA && !!byq01 && !!byq02);

  console.log('1) 旧测试迁移：待补证，不沿用合格；示范有效测试可采信');
  const testsA = stepStore.testsByClock(clockA.id);
  check(
    '旧测试为待补证',
    testsA.some((t) => t.validity === 'pending_evidence'),
    JSON.stringify(testsA.map((t) => t.validity)),
  );
  check('存在有效测试', testsA.some((t) => t.validity === 'valid'));

  console.log('2) 完工推导：待补证不算完工依据，有效测试 + 全工序完成才算');
  // 把 clockA 剩余工序全部完成
  for (const s of stepStore.byClock(clockA.id)) {
    if (s.state !== 'done') await stepStore.finish(s.id);
  }
  let state = repairStateOf(
    stepStore.byClock(clockA.id),
    stepStore.testsByClock(clockA.id),
  );
  check('有有效测试时已完成', state === '已完成', state);

  console.log('3) 测前必须占台：已过检仪器拒绝占台');
  const t0 = Date.now();
  await expectBookingError('no_calibration', '过检仪器不能占台', () =>
    acquireSlot(byq02, t0 + 3_600_000, t0 + 3_600_000 + DEFAULT_SLOT_MS, clockA.id),
  );

  console.log('4) 时段冲突：同一时段只能一人成功（模拟两个并发页签）');
  const start = startOfDay(Date.now() + 86_400_000) + 10 * 3600_000;
  const end = start + 30 * 60_000;
  const hold1 = await acquireSlot(byq01, start, end, clockA.id);
  check('第一次占台成功', !!hold1);
  await expectBookingError('conflict', '重叠时段第二次占台被拒', () =>
    acquireSlot(byq01, start + 10 * 60_000, end + 10 * 60_000, clockA.id),
  );
  // 不重叠的相邻时段允许
  const hold2 = await acquireSlot(byq01, end, end + 30 * 60_000, clockA.id);
  check('相邻不重叠时段可占', !!hold2);
  await hold2.release();

  console.log('5) 中断预约不占着：release 后同一时段立即可占');
  await hold1.release();
  const hold3 = await acquireSlot(byq01, start, end, clockA.id);
  check('释放后可重新占台', !!hold3);

  console.log('6) 占台后保存成功，成为有效测试并计入完工');
  const saved = await confirmTest(hold3, readingDraft(clockA.id));
  stepStore.acceptSavedTest(saved);
  check('保存的测试有效', saved.validity === 'valid' && saved.instrumentId === byq01.id);
  const slots = await busySlots(byq01.id, start - 1, end + 1);
  check('预约已转为正式占用（无残留预约）', slots.reservations.length === 0);
  check('正式测试出现在占用列表', slots.tests.some((s) => s.start === start));

  console.log('7) 与已保存测试时段冲突 → 拒绝');
  await expectBookingError('conflict', '与已保存测试重叠被拒', () =>
    acquireSlot(byq01, start, end, clockA.id),
  );

  console.log('8) 补检：纪元翻页，补检前测试立即失效，钟表撤下完工');
  const validBefore = stepStore.tests.filter((t) => t.instrumentId === byq01.id && t.validity === 'valid').length;
  check('补检前该仪器有有效测试', validBefore >= 1, `valid=${validBefore}`);
  await instrumentStore.addCalibration(byq01.id, {
    calibratedAt: startOfDay(Date.now()),
    validUntil: endOfDay(Date.now() + 180 * 86_400_000),
    certNo: 'JL-BU-001',
    org: '市计量检测院',
    supplementary: true,
    note: '脱检补检',
  });
  await stepStore.recomputeForInstrument(byq01.id);
  const afterSupp = stepStore.tests.filter((t) => t.instrumentId === byq01.id);
  check(
    '补检后该仪器旧测试全部失效（invalid_epoch）',
    afterSupp.every((t) => t.validity === 'invalid_epoch'),
    afterSupp.map((t) => t.validity).join(','),
  );
  state = repairStateOf(stepStore.byClock(clockA.id), stepStore.testsByClock(clockA.id));
  check('完工结论撤下为待测试', state === '待测试', state);

  console.log('9) 补检后新仪器可用，复测合格恢复完工');
  const fresh = await instrumentStore.byId(byq01.id);
  check('补检后纪元=1', fresh!.evidenceEpoch === 1, String(fresh!.evidenceEpoch));
  const retryStart = start + 2 * 3600_000 + 86_400_000;
  const retryHold = await acquireSlot(fresh!, retryStart, retryStart + DEFAULT_SLOT_MS, clockA.id);
  const retry = await confirmTest(retryHold, readingDraft(clockA.id, 3.2));
  stepStore.acceptSavedTest(retry);
  check('复测记录纪元一致且有效', retry.validity === 'valid' && retry.evidenceEpoch === 1);
  state = repairStateOf(stepStore.byClock(clockA.id), stepStore.testsByClock(clockA.id));
  check('复测后恢复已完成', state === '已完成', state);

  console.log('10) 停用：占台被拒、未确认预约取消、测试失效');
  const stopStart = retryStart + 86_400_000;
  const tempHold = await acquireSlot(fresh!, stopStart, stopStart + DEFAULT_SLOT_MS, clockA.id);
  check('停用前预约成功', !!tempHold);
  await instrumentStore.retire(fresh!.id, '故障送检');
  await stepStore.recomputeForInstrument(fresh!.id);
  const allRsv = await db.reservations.toArray();
  check('停用后未确认预约被清空', !allRsv.some((r) => r.instrumentId === fresh!.id), `剩余 ${allRsv.length}`);
  const retired = instrumentStore.byId(fresh!.id)!;
  check('停用后该仪器全部测试失效', stepStore.tests.filter((t) => t.instrumentId === retired.id).every((t) => t.validity === 'invalid_instrument'));
  await expectBookingError('retired', '停用仪器拒绝占台', () =>
    acquireSlot(retired, stopStart + 7200_000, stopStart + 7200_000 + DEFAULT_SLOT_MS, clockA.id),
  );

  console.log('11) 重新启用不清算纪元，旧测试仍失效，需复测');
  await instrumentStore.reactivate(retired.id);
  await stepStore.recomputeForInstrument(retired.id);
  check('启用后旧测试仍失效', stepStore.tests.filter((t) => t.instrumentId === retired.id).every((t) => t.validity !== 'valid'));

  console.log('12) 改有效期：纪元再翻，既有测试失效');
  const cals = instrumentStore.calibrationsOf(retired.id);
  const latest = cals[0]!;
  await instrumentStore.changeCalibrationValidity(latest.id, {
    validUntil: endOfDay(latest.validUntil + 30 * 86_400_000),
  });
  const renewed = instrumentStore.byId(retired.id)!;
  check('改有效期后纪元递增', renewed.evidenceEpoch >= 3, String(renewed.evidenceEpoch));
  await stepStore.recomputeForInstrument(retired.id);
  check('无有效测试残留', stepStore.tests.filter((t) => t.instrumentId === renewed.id && t.validity === 'valid').length === 0);

  console.log('13) 旧测试补证：仪器站得住则恢复有效；仪器已翻纪元则仍失效');
  const pending = stepStore.pendingEvidenceTests[0]!;
  // BYQ-02 从未翻纪元且有检定，但检定不覆盖测试时刻 → 补证后 invalid_calibration
  const v02 = await stepStore.attachEvidence(pending.id, byq02.id);
  check('检定不覆盖时刻 → 补证仍失效', v02 === 'invalid_calibration', v02);

  console.log('13b) 仪器无事件、检定覆盖测试时刻 → 补证恢复有效');
  const goodIns = await instrumentStore.add({
    code: 'BYQ-GOOD',
    name: '历史可追溯校表仪',
    model: 'H',
    maker: 'Z',
    location: '档案柜',
    note: '',
  });
  await instrumentStore.addCalibration(goodIns.id, {
    calibratedAt: startOfDay(pending.testedAt - 30 * 86_400_000),
    validUntil: endOfDay(pending.testedAt + 300 * 86_400_000),
    certNo: 'GOOD',
    org: '院',
    supplementary: false,
    note: '',
  });
  const vGood = await stepStore.attachEvidence(pending.id, goodIns.id);
  check('证据齐全 → 补证恢复有效', vGood === 'valid', vGood);

  console.log('13c) 仪器在测试「之后」补检过：盖测试时刻纪元（0），仍判失效');
  await instrumentStore.addCalibration(goodIns.id, {
    calibratedAt: startOfDay(Date.now()),
    validUntil: endOfDay(Date.now() + 365 * 86_400_000),
    certNo: 'GOOD-SUP',
    org: '院',
    supplementary: true,
    note: '事后补检',
  });
  await stepStore.recomputeForInstrument(goodIns.id);
  const restored = stepStore.tests.find((t) => t.id === pending.id)!;
  check('事后补检不会让旧测试蒙混', restored.validity === 'invalid_epoch', restored.validity);

  console.log('14) 事件链完整记录三类事件');
  const events = instrumentStore.eventsOf(renewed.id).map((e) => e.type).sort();
  check('事件链含补检/停用/改有效期', ['calibrate_supplementary', 'change_validity', 'retire'].every((t) => events.includes(t)), events.join(','));

  console.log('15) Web Locks 路径：两页签真并发抢同一时段，只有一人成功');
  const raceBase = startOfDay(Date.now() + 5 * 86_400_000) + 14 * 3600_000;
  // 用一台全新仪器避开历史占用
  const raceIns = await instrumentStore.add({
    code: 'BYQ-RACE',
    name: '并发测试仪',
    model: 'X',
    maker: 'Y',
    location: '测试',
    note: '',
  });
  await instrumentStore.addCalibration(raceIns.id, {
    calibratedAt: startOfDay(Date.now() - 10 * 86_400_000),
    validUntil: endOfDay(Date.now() + 300 * 86_400_000),
    certNo: 'RACE',
    org: '院',
    supplementary: false,
    note: '',
  });
  const raceAttempts = await Promise.allSettled([
    acquireSlot(raceIns, raceBase, raceBase + DEFAULT_SLOT_MS, clockA.id),
    acquireSlot(raceIns, raceBase, raceBase + DEFAULT_SLOT_MS, clockA.id),
    acquireSlot(raceIns, raceBase, raceBase + DEFAULT_SLOT_MS, clockA.id),
  ]);
  const fulfilled = raceAttempts.filter((r) => r.status === 'fulfilled');
  const rejected = raceAttempts.filter((r) => r.status === 'rejected');
  check('三个并发页签恰好一人成功', fulfilled.length === 1, `fulfilled=${fulfilled.length}`);
  check('其余两人被冲突拒绝', rejected.length === 2);
  check(
    '失败者均为 conflict',
    rejected.every((r) => r.status === 'rejected' && (r.reason as BookingError).code === 'conflict'),
  );
  if (fulfilled[0].status === 'fulfilled') await fulfilled[0].value.release();

  console.log('16) 预约中断（页签崩溃放锁）不占着：崩溃后立即可抢同一时段');
  const crashStart = raceBase + 3 * 3600_000;
  const crashedHold = await acquireSlot(raceIns, crashStart, crashStart + DEFAULT_SLOT_MS, clockA.id);
  check('崩溃前预约成功', !!crashedHold);
  // 模拟页签崩溃：sentinel 锁被浏览器回收
  fakeLocks.crash();
  // 不调用 crashedHold.release()，直接由新页签重新抢
  const recaptured = await acquireSlot(raceIns, crashStart, crashStart + DEFAULT_SLOT_MS, clockA.id);
  check('崩溃后新页签立即抢回成功', !!recaptured);
  const remainingRsv = await db.reservations.where('instrumentId').equals(raceIns.id).toArray();
  check('残留预约被清理为 1 条（新持有者）', remainingRsv.length === 1, `剩余 ${remainingRsv.length}`);
  await recaptured.release();

  console.log('17) 占台之后仪器被补检/停用：保存瞬间拒绝，不能拿旧占台盖新纪元');
  const raceIns2 = await instrumentStore.add({
    code: 'BYQ-EPOCH',
    name: '纪元竞态仪',
    model: 'E',
    maker: 'Q',
    location: '测试',
    note: '',
  });
  await instrumentStore.addCalibration(raceIns2.id, {
    calibratedAt: startOfDay(Date.now() - 5 * 86_400_000),
    validUntil: endOfDay(Date.now() + 300 * 86_400_000),
    certNo: 'EP',
    org: '院',
    supplementary: false,
    note: '',
  });
  const epochStart = startOfDay(Date.now() + 6 * 86_400_000) + 9 * 3600_000;
  const pendingHold = await acquireSlot(raceIns2, epochStart, epochStart + DEFAULT_SLOT_MS, clockA.id);
  // 另一页签/台账管理员在该仪器上登记补检（纪元翻页）
  await instrumentStore.addCalibration(raceIns2.id, {
    calibratedAt: startOfDay(Date.now()),
    validUntil: endOfDay(Date.now() + 365 * 86_400_000),
    certNo: 'EP-SUP',
    org: '院',
    supplementary: true,
    note: '占台期间补检',
  });
  await expectBookingError('instrument_changed', '占台后仪器翻纪元，保存被拒', () =>
    confirmTest(pendingHold, readingDraft(clockA.id, 2)),
  );
  await pendingHold.release().catch(() => {});

  console.log(`\n全部 ${passed} 项断言通过 ✅`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
