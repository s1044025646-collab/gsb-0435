#!/usr/bin/env node
import { openDb, DEFAULT_DATA_DIR } from "./db";
import { startServer } from "./api";
import * as svc from "./service";
import { ApiError } from "./fraction";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function readJsonArg(args: string[], flag: string): unknown {
  const v = argValue(args, flag);
  if (v == null) return undefined;
  if (v.startsWith("@")) {
    return JSON.parse(require("node:fs").readFileSync(v.slice(1), "utf8"));
  }
  return JSON.parse(v);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const dataDir = argValue(process.argv.slice(2), "--data-dir") ?? DEFAULT_DATA_DIR;
  const db = openDb(dataDir);
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  switch (cmd) {
    case "serve": {
      const port = Number(argValue(args, "--port") ?? 0); // 默认空闲端口
      const { port: actual } = await startServer(db, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}  (数据目录: ${dataDir})`);
      break;
    }
    case "add-ingredient":
      out(svc.createIngredient(db, argValue(args, "--name")!, argValue(args, "--category")!));
      break;
    case "add-mixture":
      out(svc.createMixture(db, argValue(args, "--name")!, readJsonArg(args, "--items") as svc.ItemInput[]));
      break;
    case "add-recipe":
      out(svc.createRecipe(db, argValue(args, "--name") ?? "未命名配方", readJsonArg(args, "--items") as svc.ItemInput[], argValue(args, "--request-id")));
      break;
    case "report":
      out(svc.generateReport(db, Number(argValue(args, "--recipe")), argValue(args, "--target-total"), argValue(args, "--request-id")));
      break;
    case "get-report":
      out(svc.getReport(db, Number(argValue(args, "--id"))));
      break;
    case "list-reports":
      out(svc.listReports(db, Number(argValue(args, "--page") ?? 1), Number(argValue(args, "--page-size") ?? 20)));
      break;
    case "verify":
      out(svc.verifyConservation(db, Number(argValue(args, "--recipe")), argValue(args, "--target-total")));
      break;
    case "export": {
      const id = Number(argValue(args, "--id"));
      const file = argValue(args, "--out") ?? `report-${id}.json`;
      require("node:fs").writeFileSync(file, JSON.stringify(svc.getReport(db, id), null, 2), "utf8");
      console.log(`已导出: ${file}`);
      break;
    }
    case "demo":
      runDemo(db);
      break;
    default:
      console.log(`用法: node dist/cli.js <命令> [参数] [--data-dir 目录]
命令:
  serve --port 8080                 启动 API（缺省 --port 时自动选空闲端口）
  add-ingredient --name 面粉 --category flour
  add-mixture --name 酵头 --items '[{"type":"ingredient","name":"面粉","mass":"50"},...]'
  add-recipe --name 吐司 --items '[...]' [--request-id abc]
  report --recipe 1 [--target-total 1518] [--request-id r1]
  get-report --id 1 | list-reports | verify --recipe 1 [--target-total 1518]
  export --id 1 --out report.json
  demo                              运行题目已知例子演示`);
  }
}

function runDemo(db: import("node:sqlite").DatabaseSync) {
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  console.log("== 登记基础原料 ==");
  svc.createIngredient(db, "高筋面粉", "flour");
  svc.createIngredient(db, "水", "water");
  svc.createIngredient(db, "盐", "other");
  console.log("== 保存酵头 v1（面粉 50 : 水 50）==");
  const mix = svc.createMixture(db, "酵头", [
    { type: "ingredient", name: "高筋面粉", mass: "50" },
    { type: "ingredient", name: "水", mass: "50" },
  ]);
  out(mix);
  console.log("== 创建最终配方：面粉400 水250 盐9 酵头100 ==");
  const recipe = svc.createRecipe(db, "基础白吐司", [
    { type: "ingredient", name: "高筋面粉", mass: "400" },
    { type: "ingredient", name: "水", mass: "250" },
    { type: "ingredient", name: "盐", mass: "9" },
    { type: "mixture", name: "酵头", version: 1, mass: "100" },
  ], "demo-recipe-1");
  out(recipe);
  console.log("== 生成报告（期望: 总759 面粉450 水300 含水2/3 盐2%）==");
  const report = svc.generateReport(db, recipe.id, undefined, "demo-report-1");
  out(report);
  console.log("== 缩放至 1518g（期望全部翻倍，百分比不变）==");
  out(svc.generateReport(db, recipe.id, "1518", "demo-report-scaled"));
  console.log("== 质量守恒核验 ==");
  out(svc.verifyConservation(db, recipe.id));
  out(svc.verifyConservation(db, recipe.id, "1518"));
  console.log("== 修改酵头配比 -> 新版本 v2（面粉 60 : 水 40），新配方新报告；旧报告不变 ==");
  const mix2 = svc.createMixture(db, "酵头", [
    { type: "ingredient", name: "高筋面粉", mass: "60" },
    { type: "ingredient", name: "水", mass: "40" },
  ]);
  const recipe2 = svc.createRecipe(db, "低水酵头吐司", [
    { type: "ingredient", name: "高筋面粉", mass: "400" },
    { type: "ingredient", name: "水", mass: "250" },
    { type: "ingredient", name: "盐", mass: "9" },
    { type: "mixture", name: "酵头", version: mix2.version, mass: "100" },
  ], "demo-recipe-2");
  out(svc.generateReport(db, recipe2.id, undefined, "demo-report-2"));
  console.log("== 旧报告重读（仍为 v1 结果，总面粉 450）==");
  out(svc.getReport(db, report.id));
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(JSON.stringify({ error: { code: e.code, message: e.message } }, null, 2));
  } else {
    console.error(e);
  }
  process.exit(1);
});
