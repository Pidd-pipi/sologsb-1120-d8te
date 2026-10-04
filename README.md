# sologsb-1120 古钟表维修工序档案（gbclockrepair）

面向钟表修复师的工序档案台：为一台古董钟表建档，记录机芯型号、零件缺失与配换、拆解顺序、清洗润滑点位，以及修复后的走时测试数据。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21820**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1120/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{clock,part,step,test}.ts
        ├── stores/{clock,part,step}Store.ts
        ├── components/common/{StepSequence,RateChart,ClockCard,StateBadge}.vue
        ├── hooks/{useClockSearch,useRepairProgress}.ts
        ├── pages/{ClockList,ClockDetail,StepForm,PartList,TestView}.vue
        └── utils/{db,timeCalc,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/clocks` | 钟表台账：按种类/机芯/品相/年代区间筛选，按修复状态分栏 | Clock |
| `/clocks/:id` | 钟表详情：左侧机芯信息，右侧工序流与走时测试记录，可切零件清单 | Clock、RepairStep、TimekeepingTest、MovementPart |
| `/steps/new` | 新建维修工序：选步骤类型后动态出清洗液/油脂/力矩字段，顺序号冲突即报错 | RepairStep、MovementPart |
| `/parts` | 零件与配换清单：按磨损状态分组，标出待修配条目与来源批号 | MovementPart |
| `/instruments` | 校表仪台账：检定/补检登记、停用/启用、改有效期、事件链、待补证与失效测试队列、占台监视 | Instrument、Calibration、InstrumentEvent、Reservation、TimekeepingTest |
| `/tests/:clockId` | 走时测试录入：测前选仪器与时段占台，多方位均值计算，生成走时单文本 | TimekeepingTest、Instrument、Reservation |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 八张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）、`instruments`（校表仪台账）、`calibrations`（检定记录）、`instrument_events`（补检/停用/改有效期事件链）、`reservations`（临时占台预约）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3 迁移：新增仪器四表与 `tests.instrumentId / validity` 索引；**旧测试没有仪器记录，一律标为「待补证」，不沿用原合格结果**。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序、2 台校表仪（一台检定有效、一台已过检）与 2 次走时测试（一条待补证、一条有效）。

## 仪器台账与走时测试的证据链规则

- **测前必须占台**：保存走时测试前先选一台「在用 + 检定覆盖测试时段」的校表仪并预约时段；仪器停用、已过检（无有效检定）或时段与已保存测试 / 他人预约重叠时直接拒绝，无法只留读数。
- **跨页签互斥**：「查冲突 → 写预约」在 Web Locks 仪器级串行锁内完成，两个页签抢同一台仪器同一时段只有一人成功；每个预约持有同名哨兵锁，页签关闭 / 崩溃即由浏览器释放，他人可立即抢入，另有 20 秒心跳 TTL 兜底。
- **预约中断不占着**：主动放弃、切走测试页、离开页面都会释放预约；仪器被停用时未确认预约全部取消。
- **证据纪元（epoch）**：仪器发生 **补检 / 停用 / 改检定有效期** 任一事件，纪元 +1 并写入事件链；保存测试时快照当时纪元，纪元落后即判定失效，相关钟表立即撤下「已完成」结论退回「待测试」；用该仪器重新复测合格后恢复完工。重新启用不清算纪元，停用前测试仍须复测。
- **旧测试待补证**：台账建立前查不出所用仪器的测试列入「待补证」，可登记当时所用仪器补证；系统按测试时刻的纪元与检定覆盖重新判定，证据站不住（仪器事后有事件、检定不覆盖、已停用）仍判失效，必须复测。
- 测试证据状态：`valid`（有效）、`pending_evidence`（待补证）、`invalid_instrument`（仪器停用）、`invalid_calibration`（无有效检定）、`invalid_epoch`（仪器事件作废）。

## 业务规则验证

```bash
cd frontend
npm run logic-test   # fake-indexeddb 下验证占台互斥/崩溃释放/纪元失效/补证/完工推导（36 项断言）
```

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **完工只认证词**：全部工序完成仅为「待测试」；必须存在至少一条证据状态 `valid` 的走时测试才分栏到「已完成」；待补证 / 失效测试不计入，仪器事件触发重算后完工自动撤下。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本（含仪器编号、检定证书与有效期），可复制或下载 txt。
