# 烘焙配方预发酵面团拆分与百分比核算服务

离线、本地运行的烘焙配方质量核算后端（TypeScript + Node.js + SQLite），只提供 API 与 CLI。
把直接投料和预先混合的酵头 / 预发酵面团逐层拆成基础原料，按**总面粉质量**计算烘焙百分比与加水比例。

只做配方质量核算：不管理库存、订单、过敏原、发酵过程与营养，不连接生产设备，不访问任何在线服务。

## 运行要求

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，无需原生编译、无需 Docker/WSL）
- 依赖仅 `typescript` / `@types/node`（开发依赖）

## 常用命令

```bash
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API 服务（默认端口 0 = 自动选择空闲端口）
npm run demo       # 运行题目已知示例演示（759g 白吐司）
node dist/src/cli.js help   # 查看全部 CLI 命令
```

端口配置：`PORT=8080 npm start` 或 `node dist/src/cli.js serve 8080`；不指定时由操作系统分配空闲端口并打印实际端口。
数据目录：项目内 `data/`（可用环境变量 `BAKERY_DATA_DIR` 覆盖），SQLite 文件为 `data/bakery.db`，重启后直接读旧报告。

## 概念与约定

### 基础原料与分类

基础原料由用户明确标记为 `flour`（面粉）、`water`（水）或 `other`（其他）。
牛奶、鸡蛋等若标为 `other`，系统**不猜测其含水量**；加水比例（hydration）只用明确标记为 `water` 的质量 ÷ 全部 `flour` 质量。

### 混合物（酵头 / 预发酵面团）

混合物记录各组成项的**相对质量**，每次保存生成一个**不可变新版本**（同名 version 递增）。
最终配方引用的是具体版本 id，按本次使用的混合物质量等比例拆分。允许有限层嵌套
（深度上限 8、叶子上限 1000、单混合物组成项上限 100）。同一原料经多条路径进入时**累加**质量并保留全部来源路径，不去重。

混合物不会"既算整体又算内部成分"：展开时只把混合物质量按比例分配给其组成项，叶子只落在基础原料上。

### 精度约定

- 输入质量：最多六位小数的非负十进制字符串（如 `"400"`、`"2.5"`、`"0.000001"`）；组成项质量必须为正。
- 内部计算：BigInt 精确有理数，逐层不提前四舍五入；1:1:1 混合物拆 100g 得到精确的 `100/3`。
- 输出：每个数值同时带 `exact`（精确分数，如 `"2/3"`）与 `decimal`（6 位小数展示，截断）；展示精度不影响后续计算。

### 烘焙百分比

所有百分比 = 该项质量 ÷ 总面粉质量 × 100。面粉合计恒为 100%，但**各项百分比总和不必为 100%**
（水、盐、酵头等都以面粉为基准叠加，例如 100% 面粉 + 66.67% 水 + 2% 盐 = 168.67%）。

### 质量守恒

全部叶子质量之和必须等于原配方总投料质量（缩放后等于目标总质量）。本题无蒸发、损耗或吸水率修正，
每份报告的 `conservation` 字段记录核验结果，也可用 `report:verify` / `GET /reports/:id/verify` 重新核验。

### 缩放

按目标总面团质量等比例缩放（`targetTotalMass`）：缩放因子为精确有理数，缩放后总质量精确等于目标，
烘焙百分比不变。不求解"给定目标含水率"的逆向配方。

### 版本冻结

调整任一原料或混合物会建立**新版本**；已生成的报告保持原引用关系（引用的是具体版本 id），
旧报告不因酵头后来改配比而改变。`report:recompute` 按被冻结的引用重新核算，结果与旧报告一致。

### 幂等与事务

创建类请求可带 `requestId`：相同 `requestId` 重复请求返回首次创建的记录，不重复建行。
混合物 / 配方保存在事务内完成，失败引用或非法质量不留下部分数据。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/ingredients` | 登记基础原料 `{name, kind: flour\|water\|other, requestId?}` |
| GET | `/ingredients?limit&offset` | 分页列出基础原料 |
| POST | `/mixtures` | 保存混合物新版本 `{name, items:[{refType, refId, mass}], requestId?}` |
| GET | `/mixtures/:id` | 查看混合物某版本 |
| POST | `/recipes` | 创建最终配方 `{name, items:[...], requestId?}` |
| GET | `/recipes/:id` | 查看配方 |
| POST | `/reports` | 生成报告 `{recipeId, targetTotalMass?, requestId?}`（带 target 即缩放） |
| GET | `/reports/:id` | 读取报告（汇总包含全部叶子） |
| GET | `/reports/:id/leaves?limit&offset` | 叶子分页 |
| GET | `/reports/:id/verify` | 核验质量守恒 |
| GET | `/reports/:id/recompute` | 按冻结引用重新核算 |
| GET | `/reports/:id/export` | 导出报告 JSON |

错误统一为 `{"error": {code, message, details}}`，错误码：
`VALIDATION`、`INVALID_MASS`、`EMPTY_MIXTURE`、`ZERO_TOTAL`、`NO_FLOUR`、
`UNKNOWN_VERSION`、`CYCLE`、`TOO_DEEP`、`TOO_MANY_ITEMS`、`NOT_FOUND`、`CONFLICT`。
循环引用、过深展开等错误的 `details.path` 给出实际引用路径，不会栈溢出。

## CLI 示例

```bash
node dist/src/cli.js ingredient:add '{"name":"高筋面粉","kind":"flour"}'
node dist/src/cli.js ingredient:add '{"name":"水","kind":"water"}'
node dist/src/cli.js mixture:add '{"name":"酵头","items":[{"refType":"ingredient","refId":1,"mass":"50"},{"refType":"ingredient","refId":2,"mass":"50"}]}'
node dist/src/cli.js recipe:create '{"name":"白吐司","items":[{"refType":"ingredient","refId":1,"mass":"400"},{"refType":"mixture","refId":1,"mass":"100"}]}'
node dist/src/cli.js report:expand 1
node dist/src/cli.js report:scale 1 1518
node dist/src/cli.js report:verify 1
```

## 已知示例（手算核对）

400g 面粉 + 250g 水 + 9g 盐 + 100g 酵头（50 面粉 / 50 水）：

- 总质量 759g；总面粉 450g、总水 300g、其他 9g
- 加水比例 = 300/450 = `2/3`（≈66.67%）；盐 = 9/450 = 2%
- 缩放至 1518g：全部质量翻倍（900/600/18），百分比不变

`npm run demo` 会完整演示上述内容，并演示"修改酵头配比生成新版本、旧报告不变"。

## 测试

`npm test` 覆盖：已知示例、多路径累加、嵌套酵头、三分之一精确比例、零面粉（NO_FLOUR）、
循环引用（含路径）、未知版本、非法质量 / 空混合物、幂等、版本冻结、重启后读取与重算一致、叶子分页。

## 限制

- 只做质量核算，不处理库存、营养、过敏原、发酵过程。
- 单进程本地服务，无鉴权；建议绑定 localhost 使用。
- 叶子分页基于报告快照，汇总始终在报告内完整给出。
