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
| `/instruments` | 校表仪台账：登记/补检/停用/改检定有效期，查看该仪器关联测试凭证状态 | CalibrationInstrument、TimekeepingTest |
| `/tests/:clockId?` | 走时测试录入：测前选可用仪器并预约时段，跨页签互斥，多方位均值与走时单 | TimekeepingTest、CalibrationInstrument |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 六张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）、`instruments`（校表仪台账）、`instrumentReservations`（仪器时段预约）、`instrumentLocks`（保存时仪器级短事务互斥锁）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3 迁移：新增仪器/预约/锁表；`tests` 增加仪器快照、预约时段、检定版本与凭证状态字段；**无仪器记录的旧测试一律置为「待补证」**，不再作为完工依据；升级时补两台示范仪器（其中一台已过检）。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序、2 台校表仪与 1 次待补证走时测试。

## 仪器凭证与完工规则

- **测前选仪**：保存测试必须选择「启用且在检定有效期内」的校表仪并预约时段；停用、过检一律拒绝。
- **时段唯一**：同一仪器的已保存测试时段不得重叠；保存走 IndexedDB 读写事务（仪器级互斥锁 + 时段复查），两个页签同时抢同一台仪器时只有一人成功，另一人收到拒绝。
- **预约不长期占用**：预约以心跳续约（约 9 秒 TTL），关页签/中断不保存数秒后自动释放；其他页签可实时看到占用。
- **级联失效**：仪器补检、停用、删除或修改检定有效期（检定版本 `certVersion` 递增）后，涉及该仪器的历史测试立即重算为「已失效」；相关钟表的「已完成」结论自动撤下（完工 = 全部工序完成 + 存在凭证有效且结论合格的测试）。
- **复测恢复**：用新检定版本的可用仪器复测合格后，新测试凭证有效，完工结论自动恢复；旧失效记录保留留痕。
- **旧测试待补证**：没有仪器记录的历史测试列入「待补证」，不沿用原合格结果，须补测。

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本，可复制或下载 txt。
