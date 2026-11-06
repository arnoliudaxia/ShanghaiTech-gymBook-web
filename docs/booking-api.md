# 预约（场馆借用申请）接口与审计记录

## 当前结论与验证边界

预约不是 REST 接口，而是在泛微 e-cology 中提交工作流表单：

```
GET  /workflow/request/AddRequest.jsp?workflowid=14862
GET  /workflow/request/AddRequestIframe.jsp?workflowid=43364&nodeid=47012&isbill=1&formid=-248&requestid=-1
POST /workflow/request/RequestOperation.jsp
```

表单为 `application/x-www-form-urlencoded`。入口 `workflowid=14862` 与实际流程 `43364` 不同。

**本次已确认的缺陷：初始隐藏字段 `src` 为空，原来的 prepare 仅复制它；浏览器提交动作需要 `src=submit`。**
现在准备 payload 和直接调用 `submitBooking` 都在最后强制设置 `src: 'submit'`，不信任表单初值或调用方传值。
**修正后的真实提交尚未测试**：本次只做本地代码审查、离线测试和构建，没有远程 POST、预约或重试。
缺失 `src` 可解释操作分支没有执行，但不能据此证明历史每次错误都由它造成。

## 主要字段

每次先取新表单，保留身份字段、隐藏值和防重 token，不自行生成 token。

| 字段 | 含义 / 取值 |
|---|---|
| `field31876` | 自动预填申请人 userid，非学号 |
| `field31877` / `field34283` | 申请人单位 / 学号工号 |
| `field31879` / `field31880` | 申请人电话 / 邮箱 |
| `field32340` | 场馆类型：羽毛球 `4`、乒乓球 `5`、网球 `6`、匹克球 `11`、排球 `12` |
| `field31901` / `field31902` | 使用日期 `YYYY-MM-DD` / 时段 id `1..11`（不是时间字符串） |
| `field31883` | 场地树节点 id，例如 `63_25` |
| `field31884` / `field31885` | 人数 / 人员类别（学生 `0`、教职工 `1`、校外 `2`） |
| `field31888` / `field31889` | 现场责任人 / 电话 |
| `field31892` | 第三方服务：有 `0`、无 `1` |
| `field31904` / `field31905` | 由时段换算的开始 / 结束时间 |
| `field31878` | 当天申请日期，不是使用日期 |
| `requestname` | 原表单生成的申请标题 |

流程隐藏值包括 `workflowid=43364`、`workflowtype=61`、`nodeid=47012`、`nodetype=0`、
`formid=-248`、`isbill=1`、`iscreate=1`、`requestid=-1`、`needwfback=1`，以及 **`src=submit`**。
其余如 `needcheck`、`rand`、`oldfieldviewNNNNN`、空占位字段和
`<userid>_43364_addrequest_submit_token` 随新表单保留。token 形态像时间戳不代表可自行生成。

## 为什么 OA 能显示错误，而本地以前只查树

旧代码只粗略 strip tags 扫描初次响应，没有解析结果导航；它还把公共脚本中的字符串当成可见文本，
并错误地以树消失认定成功。历史约 11KB 的脚手架页不证明“OA 成功失败响应总是相同”，
更不证明“服务端绝不返回错误文案”。缺失操作类型也是此前探测不能说明正常提交行为的重要原因。

本地保存的 OA 页面中，已检查：

- `function wfforward(wfurl) { parent.location.href = wfurl; }` 是定义，不是本次跳转。
- `ReloadOpenerByDialogClose` 内的登录跳转也是定义，不能跟随。
- 通用校验函数中的 `Dialog.alert` 不代表本次校验失败。
- 错误页 `sendSystemwf` 回调里的“已成功向管理员发送提醒流程”并非预约成功。
- 真正渲染的 `<span>工作流初始错误，</span>` 才是可提取的错误证据。

当前纯解析器识别 HTTP 3xx `Location`、顶层字面量 `location.href=...` / `location=...`、
实际 `wfforward('...')`、顶层字面量 `Dialog.alert`，并解码常见及数字 HTML 实体。
脚本使用 AST 解析，不执行；函数、回调、条件分支、动态表达式、事件处理器和外部脚本不作结果证据。
可见错误检测先去掉 script/style/comment，避免公共脚手架误报。
客户端在网络提交之前触发的提示，本地服务器仍无法观察。

## 受限结果页导航与判定

- POST 只发送一次，绝不自动重发，也不把 `RequestOperation.jsp` 当 GET 跟随。
- 最多跟随 3 次 GET，只允许同源 HTTPS 的已检查只读结果路径 `/notice/RequestError.jsp`。
  未经确认的其他结果路径也不猜测跟随。
  其他路径、跨域、带用户名密码、循环及任意 URL 均停止；不执行页面脚本或通知管理员等操作。
- 明确失败提示优先显示；仅明确的提交/预约成功文本认定 `ok`。
- 空白响应、未支持的动态导航、无法识别的提示均为 `unknown`。
- `verifyBooking` 的 `gone` / `still-free` / `unknown` 只作补充信息：消失可能是他人预约，
  仍可约也不能证明当前提交失败。unknown 不记成功、不移除前端场地，不建议直接重试。
- API 的 `status` 和 `location` 保留初始 POST 的值，`finalUrl` 为最后实际取得的响应 URL。

## 本地诊断与隐私

每次取得的完整响应正文及状态、响应头、响应 URL 保存到被 git 忽略的
`server/data/booking-diagnostics/<时间戳-随机ID>/`；初次 POST 为 `00.*`，后续 GET 递增，
`result.json` 保存最终 URL。不保存请求 payload 或请求 Cookie；凭证类响应头值会脱敏。
终端只打印状态，不打印 payload、token、响应 URL 或 OA 原文。

目录尝试设为 `0700`，文件 `0600`，失败不影响提交；Windows 权限取决于 ACL，不能保证 POSIX mode 生效。
完整 OA 响应和 URL 本身仍可能含个人信息或一次性值，**只应留在受保护本机，不可上传或贴入日志**。
尚无自动清理策略，应由使用者按需删除。写入失败时可能缺少诊断；网络失败时没有完整响应可保存。

## 限额与历史观察的限制

OA 曾显示“每个人每天只能成功预约1次室内网球场……无法预约”。
本地 `bookings.json` 限额保护是既有 workaround，本次没有扩展，也不依赖它推断 OA 的错误。
它不是 OA 实时限额查询，旧记录还可能来自过去不充分的树复核判断。
表单内嵌 `field85914`/SQL 标记不能当可靠预检。

旧记录中有树消失、清理草稿后恢复、浏览器工作流初始错误等观察；
这些不证明申请确已成功，也不证明所有错误都由遗留草稿引起。不要根据旧文档直接删除申请单或反复提交。

## 日期开放规则与 2026-11-07 实测

结果表单的 `jssj()` / `yy()` 使用严格比较 `noon < now`。本项目在前后端共用 `shared/booking-date.mjs`，固定以 **Asia/Shanghai 的当前时间与日历日期差**校验（不是相隔多少个 24 小时，也不受运行机器时区/DST 影响）：

- 日期须为真实有效的 `YYYY-MM-DD`；过去日期一律拒绝。
- **12:00:00.000 及之前**：`0 <= 日期差 < 2`，即今天、明天。
- **严格晚于 12:00:00.000**：`0 <= 日期差 < 3`，即今天、明天、后天。
- 周六 11:59:59 和 12:00:00 均不能约周一；周六 12:00:01 可以。

前端继续展示未来日期的树接口空闲数据，但标注「尚未开放」，不能点选场地或提交；解释具体开放日的上海时间中午 12:00 **之后**（12:00 整尚未开放）。总览只统计已开放日期，明细区分「树接口空闲」与「可预约」。现有每秒时钟驱动开放状态更新，不需重新采集。前端仍排除已开始的时段。

后端 `buildPayload` 校验日期；`prepareBooking` 在认证/获取新表单 **之前**执行它，prepare/submit API 和 CLI 均受约束。submit API 先校验请求日期，`submitBooking` 还独立校验最终 payload 的 `field31901`，并在认证后、唯一一次 POST 前重新校验，不能以 caller metadata、旧 prepare 或 `force` 绕过日期窗口。本地校验失败返回 HTTP 400 / `state: rejected`（submit），不表示已经向 OA 提交。离线测试不会请求 OA。

树接口返回未来日期的空场地并不能证明该日期可提交。该规则来自 OA 客户端代码；本地强制执行不是对 OA 后台实现的独立验证，也不保证开放日期一定能约到。

2026-11-07 零点后仅提交一次：乒乓球场 1 号 / 2026-11-09 / 18:00–19:00。初始响应含 `wfforward(...)`，沿 View → Manage → Manage iframe 读取后，可见明确的“流程提交失败”，但没有详细原因。未重复提交，未记为成功；不能将失败唯一归因于日期规则。该失败申请 **1845767 已由用户在浏览器中确认删除**：原生确认后 OA 提示「删除成功」，随后 ViewRequest GET 返回 302 至 `/notice/Deleted.jsp?showtype=wf`；无需再清理该申请。本次代码实现与离线验证未发起远程请求或重复提交。

另：`field85914` 在实际客户端代码中用于黑名单校验，不应当作每日限额标志。

## OA 强制收回入口：浏览器观察与边界

以下仅记录主浏览器提供的证据，不是可调用实现，也不是已验证的取消预约 API。本轮文档工作没有发起远程请求、触发收回或删除。

原申请 `ViewRequest` 的 `requestid=1845769`，处于校区中心待审批状态。页面中的处理器为：

```js
function doRetract(obj) {
  obj.disabled = true;
  enableAllmenu();
  document.location.href = '/workflow/workflow/wfFunctionManageLink.jsp?f_weaver_belongto_userid=18471&f_weaver_belongto_usertype=0&flag=rb&requestid=1845769';
}
```

按钮带 `_disabled='true'` 及 CSS 类 `e8_btn_top_first_disabled`，但没有原生 `disabled` 属性。因此此前仅凭这些标记认定按钮不可用的假设不成立；外观和自定义属性不是权限依据，真正权限由后端检查。

该入口使用 **会改变状态的 GET** `/workflow/workflow/wfFunctionManageLink.jsp`，不能因方法是 GET 就视为只读。**绝不自动跟随、预取或重试**，也不能加入只读结果导航白名单。参数仅按本次证据解释：

| 参数 | 本次观察 / 边界 |
|---|---|
| `flag=rb` | 本次页面收回处理器使用的动作值；不推导其他 flag 枚举，`cancel` / `stop` 等未经测试 |
| `requestid=1845769` | 明确指定操作的申请单，不能省略、猜测或替换为他人申请 |
| `f_weaver_belongto_userid=18471` | 页面显式携带的身份上下文，不是授权凭证 |
| `f_weaver_belongto_usertype=0` | 页面显式携带的用户类型上下文，不代表可自行选择身份 |

认证依赖 OA 会话 Cookie，服务端仍须校验当前用户及该申请的操作权限；这些查询参数不能替代认证或授权。

后续主浏览器已在 `ManageRequestNoForm.jsp`（`requestid=1845769`、`reEdit=1`），节点标题为「强制收回」，可见提交 / 保存 / 删除动作，原流程日志已不再显示。这是后续页面状态的观察：**没有捕获实际收回请求或响应，本轮也没有触发收回，不能据此声称谁点击了收回、HTTP 状态码是多少，或已掌握完整收回链路**。`reEdit=1` 本身也不是取消或释放预约成功的证据。

收回后的树查询中，目标 `63_23` / 2026-11-08 / 时段 `9` 仍不可用，故 **收回不等于保证释放预约**。后续按用户授权调用原生 `doDelete()`，只放行这张单的 `POST RequestOperation.jsp`、`src=delete`。OA 弹窗“删除成功”，再次 GET `ViewRequest.jsp?requestid=1845769` 返回 302 到 `/notice/Deleted.jsp?showtype=wf`，据此确认流程单已删除。但删除后两次查询该场地仍不可用，尚不能确定是释放延迟、另有占用还是业务记录独立保留；不能宣称预约占位已清除。流程删除状态与场地可用性必须分别核实。

## 本人待审核申请列表与撤销功能

门户入口为 `https://egate-new.shanghaitech.edu.cn/blue/index.html#/taskList?cardName=mytask`。经独立 CAS 会话认证后：

1. `GET /getLoginUser` 获取当前门户账号。
2. `GET /getPageView?pageCode=taskList&lang=zh_CN` 获取 `CUS_CARD_MYTASKLIST` 卡片标识，不写死实例 ID。
3. `POST /execCardMethod/{cardWid}/CUS_CARD_MYTASKLIST`，仅调用只读 `method=renderData`，参数包含 `pageNum/pageSize`、标题前缀 `学生和教工场馆借用申请-`、`processInstanceStatus=RUNNING`。
4. 校验记录的 `initiatorId` 等于当前登录账号，`bizDomain=oa`，从显式 OA 链接提取 `requestid`，并与 `processInstanceId` 一致后才映射到本地列表。门户 `wid` 不是 OA 单号。

本地 `GET /api/applications` 还会读取 OA 申请详情；明确已删除的门户残留记录排除，未能核实的记录提示但禁用撤销。`POST /api/applications/:id/cancel` 需要 JSON 显式确认，并重新查询可信本人待审核列表；不能由客户端随意提供 OA 单号或操作 URL。服务仅对本人、已知场馆工作流版本 `14862` / `43364`（表单为 `-248`）且有原生收回操作的申请执行单次收回与单次删除；删除表单必须保留该单的原始工作流版本，随后验证完整删除提示。状态不明的修改意图持久化，禁止重放修改。

提交成功验证现以 `ViewRequest.jsp?requestid=...` 及只读详情页中匹配的申请人、工作流、预约字段为依据；明确失败后留下的草稿不转判成功，树占用不再决定成败。实现和回归测试边界详见 `cancellation-backend.md`。

## 剩余未知与风险

- 修正 `src` 后的实际提交响应、审批状态、冲突和限额页面形态仍需经授权的独立验证。
- 结果页若使用动态 JS、外部脚本、未列入白名单的路径或未知文案，仍返回 unknown。
- 防重 token 的服务端校验、后续审批节点及完整取消 / 释放接口尚未确认；上述强制收回入口仅有页面代码与后续状态证据。原生删除已确认，但该场地仍不可用，完整释放机制待分析。
- 提交无幂等保证；人工重复点击/CLI 重跑也可能产生重复申请，应先到 OA「我的请求」核实。
- 自动化须遵守学校规定；本次没有执行任何真实预约。
