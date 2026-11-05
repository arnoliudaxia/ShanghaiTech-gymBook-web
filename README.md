# 上科大场馆空闲看板

一个展示上科大ShanghaiTech 体育场馆空闲查询的看板

基于 **Vue 3 + Node.js** 。账户认证方式抄了egate的实现方式. 相当于写了一个egate lite版本.


![预览](docs/preview.png)

## 功能

- 覆盖 OA 里 **全部 13 个场馆分类**，自动发现，不写死
- 未来 3 天 × 11 个时段（11:00–22:00）的**逐场地**可约情况
- 服务端缓存快照，前端 2 秒轮询采集进度，避免重复打 OA

## 快速开始

```bash
cd gymbook-web
cp .env.example .env      # 填 MYUSERNAME / PASSWORD（本机已填好）
npm run setup             # 安装 server 与 web 依赖

npm run dev               # 开发：API(8787) + Vite(5173)，浏览器打开 5173
```

> ⚠️ `:8787` 托管的是**上一次 `npm run build` 的产物**（`web/dist`），不是实时源码。
> 改完前端要么看 Vite 的 `:5173`，要么重新 `npm run build`。服务端会检测构建是否过期并告警。

生产模式（单端口托管前端 + API）：

```bash
npm run build             # 产出 web/dist
npm start                 # http://localhost:8787
```

一次性采集（给系统 cron / 任务计划用）：

```bash
npm run refresh           # 采集一次后退出
npm run refresh:all       # 连「整体预约」型场馆一起采
```

## 刷新机制

只有一个文本文件：**`cron.txt`**，标准 crontab 格式 —— `分 时 日 月 周   命令`。

```
*/10 * * * *   node server/src/refresh.js     ← 默认：每 10 分钟
```

- 服务端进程内调度器读取前 5 个时间字段并定时刷新；命令字段仅供系统 cron 使用
- 改完保存即生效（`fs.watchFile` 监听，日志会打印新的下次触发时间）
- 想让系统 cron 接管：把该行原样加进 `crontab -e`，再设 `CRON_DISABLED=1` 关掉内置调度器
  （`cron.txt` 的“命令”字段就是给系统 cron 用的，即 `npm run refresh`）
- 支持 `*` / `*/n` / `a-b` / `a-b/n` / `a,b,c`；周字段 0 与 7 都是周日

### 也可以用环境变量覆盖（优先级从高到低）

| 环境变量 | 示例 | 说明 |
|---|---|---|
| `CRON_DISABLED=1` | `1` | 停用进程内调度（用于交给系统 cron 接管） |
| `CRON_EXPR` | `*/5 * * * *` | 直接给 cron 表达式，**忽略 `cron.txt`** |
| `REFRESH_INTERVAL` | `10m` / `600s` / `1h` / `600` | 按间隔刷新，自动换算成 cron 表达式（最小粒度 1 分钟，不足则向上取整并告警） |
| `CRON_FILE` | `./my-cron.txt` | 换一个规则文件路径 |

```bash
# 每 5 分钟（命令行临时覆盖，不写文件）
REFRESH_INTERVAL=5m npm start

# 只在工作日 8-22 点每 5 分钟
CRON_EXPR="*/5 8-22 * * 1-5" npm start

# 交给系统 cron，进程内不再调度
CRON_DISABLED=1 npm start
```

换算关系：`600s`/`10m` → `*/10 * * * *`，`1h` → `0 * * * *`，`2h` → `0 */2 * * *`，
`90s` → 按 2 分钟 `*/2 * * * *`（会告警）。

> 本机 npm 配置了 `omit=dev` 且 `NODE_ENV=production`，装依赖需要 `npm install --include=dev`，
> 否则 `vite` / `concurrently` 不会装上。`npm run setup` 里已带 `--include=dev`。

## 目录结构

```
gymbook-web/
├─ cron.txt             # ★ 刷新规则（crontab 格式，默认 */10）
├─ server/
│  ├─ data/            # 采集快照 + CAS 会话缓存（gitignore）
│  └─ src/
│     ├─ env.js        # .env 加载（必须最先执行）
│     ├─ oa.js         # CAS 登录 + AES 密码加密 + 树接口客户端（逻辑等价 Python 版）
│     ├─ service.js    # 发现分类 → 并发采集 → 快照缓存/落盘
│     ├─ cron.js       # cron 表达式解析（无第三方依赖）
│     ├─ scheduler.js  # 读 cron.txt 定时触发 + 文件热更新
│     ├─ refresh.js    # CLI 一次性采集
│     └─ index.js      # Express 路由 + 静态托管
└─ web/
   └─ src/
      ├─ App.vue
      ├─ components/OverviewMatrix.vue   # 场馆 × 日期 热力矩阵
      ├─ components/VenueGrid.vue        # 时段 × 日期 明细 + 点击查看具体场地
      ├─ api.js / time.js / styles.css
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活 + 采集状态 |
| GET | `/api/availability` | 只读快照（含 `schedule` 下次触发时间）。无数据时返回 202。**不触发采集** |
| GET | `/api/schedule` | 当前 cron 规则与下次触发时间 |

返回结构（节选）：

```json
{
  "status": "ready",
  "progress": { "done": 297, "total": 297 },
  "data": {
    "generatedAt": "2026-11-05T14:09:11.000Z",
    "dates": ["2026-11-05", "2026-11-06", "2026-11-07"],
    "slots": ["11:00-12:00", "...", "21:00-22:00"],
    "skipped": ["整体田径场场地", "室外足球场", "室外篮球场", "室内篮球场"],
    "venues": [
      {
        "id": "63_6", "name": "室内羽毛球场", "cat": 4,
        "isParent": true, "children": 6,
        "availability": {
          "2026-11-06": { "11:00-12:00": ["羽毛球场地6号"], "12:00-13:00": [] }
        }
      }
    ]
  }
}
```

- `availability[date][slot]`：`["场地名"...]` = 可约场地；`[]` = 该时段约满；`null` = 请求失败

## 认证与失效处理

- **登录一次，长期复用**：CAS 会话落在 `server/data/session.json`，后续每轮刷新直接拿它查数据，
  **不会每 10 分钟重新登录一次**（避免 CAS 风控 / 失败次数累积触发验证码）。
  实测第二轮起刷新从 42s 降到 5s，`logins` 计数也不再增长。
- 服务重启后会话仍然有效：启动时 `[auth] 已载入上次会话（已复用 N 轮）`。
- 会话统计可查：`GET /api/health` → `session.hasCookie / logins / uses / ageSeconds`（不含 cookie 本身）。
- 多进程共享同一会话文件（常驻服务 + `npm run refresh`）时，重新认证前会**先试磁盘上别的进程换过的新会话**，
  避免互相踢下线、反复登录。
- **采集中途掉线**（被踢下线 / 会话作废 / OA 侧要求重新认证）会被显式识别：
  响应不是以 `[` 开头的 JSON 时抛 `AuthLostError`，而不是当成空数组
  ——否则“掉线”会伪装成“全约满”，写出脏数据。
  识别后**自动重新登录一次，只重试受影响的格子**（不重跑整轮）。
- **失败兜底**：整轮里失败格子超过 20% 时**放弃本次更新、保留上次快照**，
  避免半残缺数据覆盖正确数据；少量失败（≤20%）标记为 `null`，前端显示 `×`。
- 登录页要求验证码（失败次数过多触发）时会抛出明确提示，
  需要在浏览器手动登录一次解除；正常情况下登录频率极低（只在会话失效时），不会触发。
- ⚠️ 该接口正常响应的 `content-type` 也是 `text/html`（返回体是 JSON 字符串），
  所以**不能**按 content-type 判断失效，只能看响应体 —— 这个坑已经踩过并修正。

## 接口要点（逆向所得，Python 版同源）

```
① GET  /workflow/request/AddRequest.jsp?workflowid=14862      → 302 到 CAS
② GET  ids.shanghaitech.edu.cn/authserver/login?service=...   → 取 pwdEncryptSalt / execution / lt
③ POST 同地址（form 表单）                                     → 得到 cookie shkjdx_session
       password = base64( AES-128-CBC( key=salt, iv="Nu1L"*4, "Nu1L"*16 + 明文 ) )
④ POST /formmode/tree/treebrowser/CustomTreeBrowserAjax.jsp?id=63
        dataconditionParam=_sfn_31901_sfv_<日期>_sfn_31902_sfv_<时段1..11>_sfn_32340_sfv_<分类号>
        body: pid=<节点id>&name=
```

- `id=63` 是**树组件 ID**，不是节点；真正的根是 `63_1`
- `31901` 使用日期，`31902` 使用时间段（**恰好 11 个取值**），`32340` 场地类型
- `isParent=true` 的分类：展开分类节点 → 返回该时段仍可约的场地，空数组 = 满场
- `isParent=false` 的分类（田径场/足球场/篮球场/室内篮球）：无子场地，看它在**根层结果里是否出现**
- **条件值非法会被服务端静默忽略**（如时段传 99 就退化成「不带时段条件」）。踩坑时表现为「全空」而不是报错，
  本项目用它一次性列出全部分类

## 与 Python 版的差异

| | Python 版 | 本项目 |
|---|---|---|
| 场馆数 | 4（羽毛球/乒乓/网球/匹克球） | 13（自动发现） |
| 乒乓球分类号 | 错用 `32340=4`，结果偏少 | 修正为 `5` |
| 输出 | 终端表格 + CSV | 网页看板 + JSON API |
| 请求超时 | 2s，实测偶发失败 | 8s + 3 次重试 |
| 并行度 | 串行（~40s） | 6 并发（~6s） |
| 内网 IP 补丁 | 默认开启 | 不需要（直接走 DNS） |

## 注意事项

- 数据依赖校园网/学校 OA 可达；校外需 WebVPN。
- 采集是全量刷新（297 次请求），频率不要低于 5 分钟；采集节奏完全由 `cron.txt`（或环境变量）决定，网页端不提供手动触发。
- `.env` 含明文密码，已在 `.gitignore` 中排除。