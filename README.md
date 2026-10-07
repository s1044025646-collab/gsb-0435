# 烘焙配方预发酵面团拆分与百分比核算后端

离线本地运行的烘焙配方核算服务：将直接投料与预发酵面团（酵头、中种等混合物）逐层拆分为基础原料，按总面粉质量计算烘焙百分比与加水比例。仅做配方质量核算，不涉及库存、订单、过敏原、发酵过程、营养成分，也不连接生产设备。

技术栈：TypeScript + Node.js（>= 20，使用内置 `node:sqlite`，无原生依赖、无外部在线服务）+ SQLite。只做 API 与 CLI，Windows 本地直接运行，不需要 Docker / WSL。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口）
node dist/src/cli.js serve --port 8080   # 指定端口
node dist/src/cli.js demo                # 运行题目已知例子完整演示
```

数据保存在项目内 `data/` 目录（可用 `--data-dir` 覆盖），重启后报告可直接读取。

## 概念与约定

- **基础原料**：由用户明确标记为 `flour`（面粉）、`water`（水）或 `other`（其他）。牛奶、鸡蛋等若标为 `other`，系统**不猜测其含水量**；加水比例只用明确标记为 `water` 的质量 ÷ 全部面粉质量。
- **混合物（酵头/预发酵面团）**：记录各组成项的相对质量，保存即生成**不可变版本**（`name@version`，版本号自动递增）。最终配方引用具体版本，按本次使用的混合物质量等比例拆分。修改配比会生成新版本，旧配方与旧报告永远引用旧版本。
- **展开**：支持有限层嵌套（深度上限 8，叶子上限 10000）。同一原料经多条路径进入时**累加**而非去重；叶子只计基础原料，混合物本身不会被重复计一次。
- **精度**：输入为最多 6 位小数的非负十进制字符串；组成项质量必须为正。内部全部使用 BigInt 精确有理数计算，不在中间层四舍五入。输出同时带 `exact`（精确分数，如 `2/3`、`100/3`）与固定小数展示（仅展示用，不影响后续计算）。
- **质量守恒**：无蒸发、损耗、吸水率修正，全部叶子质量之和恒等于原配方总投料（或缩放后目标总质量），可用 `verify` / `/conservation` 核验。
- **烘焙百分比**：各项质量 ÷ 总面粉质量 × 100。面粉恒为 100%，其余各项独立相对面粉计算，因此**总和不必等于 100%**（例如已知例子为 100% + 66.67% + 2% = 168.67%）。配方不含任何面粉时返回 `NO_FLOUR` 错误。
- **缩放**：支持按目标总面团质量等比例缩放（`targetTotalMass`），缩放后总质量精确等于目标且百分比不变；不做给定目标含水率的逆向求解。
- **幂等与事务**：`requestId` 相同的重复请求返回已有记录，不重复建行；非法质量、未知版本、循环引用等失败会整体回滚，不留下部分配方。

## API（默认 127.0.0.1，端口启动时打印）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/ingredients` | 登记基础原料 `{name, category: flour\|water\|other}` |
| GET | `/ingredients` | 原料列表 |
| POST | `/mixtures` | 保存混合物新版本 `{name, items:[{type, name\|id, version?, mass}]}` |
| POST | `/recipes` | 创建最终配方 `{name, items, requestId?}` |
| POST | `/reports` | 生成报告 `{recipeId, targetTotalMass?, requestId?}` |
| GET | `/reports/:id` | 读取已冻结报告 |
| GET | `/reports?page=&pageSize=` | 报告分页列表（汇总本身始终包含全部叶子） |
| GET | `/recipes/:id/expand?targetTotalMass=` | 展开来源并计算百分比 |
| GET | `/recipes/:id/conservation?targetTotalMass=` | 核验质量守恒 |

错误统一返回 `{"error": {"code", "message"}}`，错误码：`INVALID_MASS`、`INVALID_INPUT`、`NOT_FOUND`、`UNKNOWN_MIXTURE_VERSION`、`CIRCULAR_REFERENCE`（消息含实际引用路径）、`EXPANSION_TOO_DEEP`、`TOO_MANY_ITEMS`、`NO_FLOUR`、`EMPTY_MIXTURE`、`ZERO_TOTAL_MASS`、`DUPLICATE_NAME`。

## CLI

```powershell
node dist/src/cli.js add-ingredient --name 高筋面粉 --category flour
node dist/src/cli.js add-mixture --name 酵头 --items '[{"type":"ingredient","name":"高筋面粉","mass":"50"},{"type":"ingredient","name":"水","mass":"50"}]'
node dist/src/cli.js add-recipe --name 白吐司 --items '[{"type":"ingredient","name":"高筋面粉","mass":"400"},{"type":"ingredient","name":"水","mass":"250"},{"type":"ingredient","name":"盐","mass":"9"},{"type":"mixture","name":"酵头","version":1,"mass":"100"}]' --request-id r1
node dist/src/cli.js report --recipe 1                      # 展开 + 百分比
node dist/src/cli.js report --recipe 1 --target-total 1518  # 等比例缩放
node dist/src/cli.js verify --recipe 1 --target-total 1518  # 守恒核验
node dist/src/cli.js get-report --id 1                      # 重启后读旧报告
node dist/src/cli.js list-reports --page 1 --page-size 20
node dist/src/cli.js export --id 1 --out report.json        # 导出 JSON
```

## 已知例子（`npm run demo` 可复现）

直接面粉 400g、水 250g、盐 9g，另加 100g 等质量面粉/水组成的酵头：

- 总质量 759g；总面粉 450g、总水 300g，加水比例精确为 `2/3`；盐为面粉的 2%。
- 缩放至 1518g 后各质量精确翻倍，百分比不变，守恒核验通过。
- 修改酵头为 60:40 生成 v2，新报告面粉 460g / 水 290g；旧报告重读仍为 450 / 300。

## 测试

`npm test` 覆盖：已知例子、多路径累加、嵌套酵头、三分之一精确比例（`100/3`）、零面粉、直接与间接循环引用（带路径报错）、未知版本、非法/零质量、幂等、版本冻结与旧报告不变、重启后读取、HTTP 端到端。

## 限制

- 单机本地服务，无鉴权与多用户；监听 `127.0.0.1`。
- 展开深度上限 8 层、叶子上限 10000，防止失控嵌套。
- 不做营养、过敏原、库存与生产过程管理；不做目标含水率逆向求解。
