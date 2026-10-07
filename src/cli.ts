import { openDb } from "./db";
import { ApiError } from "./errors";
import * as svc from "./service";
import { startServer } from "./api";

function print(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function parseJsonArg(s: string | undefined): unknown {
  if (!s) return {};
  return JSON.parse(s);
}

const HELP = `烘焙配方核算 CLI
用法: node dist/src/cli.js <命令> [参数]
命令:
  serve [端口]                          启动 API 服务（默认端口 0 = 自动选空闲端口）
  ingredient:add '<JSON>'               登记基础原料 {"name":"高筋面粉","kind":"flour","requestId":"..."}
  ingredient:list                       列出基础原料
  mixture:add '<JSON>'                  保存混合物新版本 {"name":"酵头","items":[{"refType":"ingredient","refId":1,"mass":"50"},...]}
  mixture:get <id>                      查看混合物版本
  recipe:create '<JSON>'                创建最终配方 {"name":"白吐司","items":[...]}
  report:expand <recipeId>              展开来源并计算百分比
  report:scale <recipeId> <目标总质量>   按目标总面团质量等比例缩放
  report:get <id>                       读取报告
  report:leaves <id> [limit] [offset]   分页查看叶子
  report:verify <id>                    核验质量守恒
  report:recompute <id>                 按冻结引用重新核算
  report:export <id>                    导出报告 JSON
  demo                                  运行题目已知示例演示
`;

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return;
  }
  if (cmd === "serve") {
    const port = args[0] ? Number(args[0]) : 0;
    const { port: p } = await startServer(port);
    console.log(`烘焙核算 API 已启动: http://localhost:${p}`);
    return;
  }
  const db = openDb();
  try {
    switch (cmd) {
      case "ingredient:add": print(svc.createIngredient(db, parseJsonArg(args[0]) as any)); break;
      case "ingredient:list": print(svc.listIngredients(db)); break;
      case "mixture:add": print(svc.createMixture(db, parseJsonArg(args[0]) as any)); break;
      case "mixture:get": print(svc.getMixture(db, Number(args[0]))); break;
      case "recipe:create": print(svc.createRecipe(db, parseJsonArg(args[0]) as any)); break;
      case "report:expand": print(svc.createReport(db, { recipeId: Number(args[0]), requestId: args[1] })); break;
      case "report:scale": print(svc.createReport(db, { recipeId: Number(args[0]), targetTotalMass: args[1], requestId: args[2] })); break;
      case "report:get": print(svc.getReport(db, Number(args[0]))); break;
      case "report:leaves": print(svc.getReportLeaves(db, Number(args[0]), Number(args[1] ?? 50), Number(args[2] ?? 0))); break;
      case "report:verify": print(svc.verifyConservation(db, Number(args[0]))); break;
      case "report:recompute": print(svc.recomputeReport(db, Number(args[0]))); break;
      case "report:export": print(svc.getReport(db, Number(args[0]))); break;
      case "demo": runDemo(db); break;
      default:
        console.error(`未知命令: ${cmd}`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(JSON.stringify(e.toJSON(), null, 2));
      process.exitCode = 1;
    } else throw e;
  }
}

// 题目已知示例：400g 面粉 + 250g 水 + 9g 盐 + 100g 酵头(50面粉/50水)
function runDemo(db: ReturnType<typeof openDb>) {
  const tag = `demo-${Date.now()}`;
  const flour = svc.createIngredient(db, { name: "高筋面粉", kind: "flour", requestId: `${tag}-flour` }) as { id: number };
  const water = svc.createIngredient(db, { name: "水", kind: "water", requestId: `${tag}-water` }) as { id: number };
  const salt = svc.createIngredient(db, { name: "盐", kind: "other", requestId: `${tag}-salt` }) as { id: number };
  const starter = svc.createMixture(db, {
    name: "酵头",
    requestId: `${tag}-starter`,
    items: [
      { refType: "ingredient", refId: flour.id, mass: "50" },
      { refType: "ingredient", refId: water.id, mass: "50" },
    ],
  }) as { id: number };
  const recipe = svc.createRecipe(db, {
    name: "白吐司",
    requestId: `${tag}-recipe`,
    items: [
      { refType: "ingredient", refId: flour.id, mass: "400" },
      { refType: "ingredient", refId: water.id, mass: "250" },
      { refType: "ingredient", refId: salt.id, mass: "9" },
      { refType: "mixture", refId: starter.id, mass: "100" },
    ],
  }) as { id: number };

  console.log("== 展开报告（总质量 759g，面粉 450g，水 300g，加水比例 2/3，盐 2%）==");
  const report = svc.createReport(db, { recipeId: recipe.id, requestId: `${tag}-report` });
  print(report);

  console.log("== 缩放至 1518g（各质量翻倍，百分比不变）==");
  const scaled = svc.createReport(db, { recipeId: recipe.id, targetTotalMass: "1518", requestId: `${tag}-scaled` });
  print(scaled);

  console.log("== 修改酵头配比（新版本 40面粉/60水），旧报告不变 ==");
  const starterV2 = svc.createMixture(db, {
    name: "酵头",
    requestId: `${tag}-starter-v2`,
    items: [
      { refType: "ingredient", refId: flour.id, mass: "40" },
      { refType: "ingredient", refId: water.id, mass: "60" },
    ],
  }) as { id: number; version: number };
  const recipe2 = svc.createRecipe(db, {
    name: "白吐司-新酵头",
    requestId: `${tag}-recipe2`,
    items: [
      { refType: "ingredient", refId: flour.id, mass: "400" },
      { refType: "ingredient", refId: water.id, mass: "250" },
      { refType: "ingredient", refId: salt.id, mass: "9" },
      { refType: "mixture", refId: starterV2.id, mass: "100" },
    ],
  }) as { id: number };
  const report2 = svc.createReport(db, { recipeId: recipe2.id, requestId: `${tag}-report2` });
  print(report2);
  console.log(`旧酵头 v1 报告面粉总量仍为 450（未受 v${starterV2.version} 影响），新报告面粉为 440。`);
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
