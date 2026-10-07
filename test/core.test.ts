import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb } from "../src/db";
import * as svc from "../src/service";
import { ApiError } from "../src/fraction";
import { startServer } from "../src/api";

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bakery-test-"));
  return openDb(dir);
}

function seedBasic(db: ReturnType<typeof freshDb>) {
  svc.createIngredient(db, "面粉", "flour");
  svc.createIngredient(db, "水", "water");
  svc.createIngredient(db, "盐", "other");
  svc.createMixture(db, "酵头", [
    { type: "ingredient", name: "面粉", mass: "50" },
    { type: "ingredient", name: "水", mass: "50" },
  ]);
}

function seedRecipe(db: ReturnType<typeof freshDb>) {
  return svc.createRecipe(db, "白吐司", [
    { type: "ingredient", name: "面粉", mass: "400" },
    { type: "ingredient", name: "水", mass: "250" },
    { type: "ingredient", name: "盐", mass: "9" },
    { type: "mixture", name: "酵头", version: 1, mass: "100" },
  ]);
}

test("已知例子：展开、百分比、含水比例", () => {
  const db = freshDb();
  seedBasic(db);
  const r = seedRecipe(db);
  const report = svc.generateReport(db, r.id);
  assert.equal(report.totals.total.exact, "759");
  assert.equal(report.totals.flour.exact, "450");
  assert.equal(report.totals.water.exact, "300");
  assert.equal(report.totals.water.hydrationExact, "2/3");
  const salt = report.leaves.find((l: any) => l.name === "盐");
  assert.equal(salt.percentOfFlour, "2.0000");
  assert.equal(report.totals.other.exact, "9");
});

test("缩放至 1518g：质量翻倍、百分比不变、守恒", () => {
  const db = freshDb();
  seedBasic(db);
  const r = seedRecipe(db);
  const scaled = svc.generateReport(db, r.id, "1518");
  assert.equal(scaled.totals.total.exact, "1518");
  assert.equal(scaled.totals.flour.exact, "900");
  assert.equal(scaled.totals.water.hydrationExact, "2/3");
  const salt = scaled.leaves.find((l: any) => l.name === "盐");
  assert.equal(salt.percentOfFlour, "2.0000");
  const cons = svc.verifyConservation(db, r.id, "1518");
  assert.equal(cons.holds, true);
});

test("同一原料多路径进入时累加", () => {
  const db = freshDb();
  seedBasic(db);
  const r = seedRecipe(db);
  const report = svc.generateReport(db, r.id);
  const flour = report.leaves.find((l: any) => l.name === "面粉");
  assert.equal(flour.mass.exact, "450"); // 400 直接 + 50 来自酵头
  assert.ok(flour.paths.length >= 2);
});

test("嵌套酵头与三分之一比例精确展开", () => {
  const db = freshDb();
  svc.createIngredient(db, "面粉", "flour");
  svc.createIngredient(db, "水", "water");
  svc.createMixture(db, "内层酵头", [
    { type: "ingredient", name: "面粉", mass: "1" },
    { type: "ingredient", name: "水", mass: "1" },
  ]);
  svc.createMixture(db, "外层酵头", [
    { type: "mixture", name: "内层酵头", version: 1, mass: "2" },
    { type: "ingredient", name: "面粉", mass: "1" },
  ]);
  const r = svc.createRecipe(db, "嵌套", [
    { type: "mixture", name: "外层酵头", version: 1, mass: "300" },
  ]);
  const report = svc.generateReport(db, r.id);
  // 外层 300g：内层 200g（面粉100 水100）+ 面粉100
  assert.equal(report.totals.flour.exact, "200");
  assert.equal(report.totals.water.exact, "100");
  assert.equal(report.totals.total.exact, "300");
  // 三分之一：1/3 比例拆分保持精确
  const db2 = freshDb();
  svc.createIngredient(db2, "面粉", "flour");
  svc.createIngredient(db2, "水", "water");
  svc.createMixture(db2, "三份", [
    { type: "ingredient", name: "面粉", mass: "1" },
    { type: "ingredient", name: "水", mass: "2" },
  ]);
  const r2 = svc.createRecipe(db2, "三分之一", [
    { type: "mixture", name: "三份", version: 1, mass: "100" },
  ]);
  const rep2 = svc.generateReport(db2, r2.id);
  assert.equal(rep2.totals.flour.exact, "100/3");
  assert.equal(rep2.totals.water.exact, "200/3");
  assert.equal(rep2.totals.total.exact, "100");
  assert.equal(svc.verifyConservation(db2, r2.id).holds, true);
});

test("无面粉返回 NO_FLOUR", () => {
  const db = freshDb();
  svc.createIngredient(db, "水", "water");
  svc.createIngredient(db, "盐", "other");
  const r = svc.createRecipe(db, "无面粉", [
    { type: "ingredient", name: "水", mass: "100" },
    { type: "ingredient", name: "盐", mass: "2" },
  ]);
  assert.throws(() => svc.generateReport(db, r.id), (e: unknown) => e instanceof ApiError && e.code === "NO_FLOUR");
});

test("循环引用被拒绝且带路径", () => {
  const db = freshDb();
  svc.createIngredient(db, "面粉", "flour");
  const a = svc.createMixture(db, "A", [{ type: "ingredient", name: "面粉", mass: "1" }]);
  // 手工把 A 的组成改成引用自身（模拟间接循环场景），或直接构造 B->A、A->B
  db.prepare("INSERT INTO mixture_items (mixture_id, item_type, child_mixture_id, mass) VALUES (?,?,?,?)")
    .run(a.id, "mixture", a.id, "1");
  const r = svc.createRecipe(db, "循环", [{ type: "mixture", id: a.id, mass: "10" }]);
  assert.throws(
    () => svc.generateReport(db, r.id),
    (e: unknown) => e instanceof ApiError && e.code === "CIRCULAR_REFERENCE" && /A@v1/.test(e.message)
  );
});

test("未知混合物版本被拒绝", () => {
  const db = freshDb();
  svc.createIngredient(db, "面粉", "flour");
  assert.throws(
    () => svc.createRecipe(db, "坏引用", [{ type: "mixture", name: "不存在", version: 9, mass: "10" }]),
    (e: unknown) => e instanceof ApiError && e.code === "UNKNOWN_MIXTURE_VERSION"
  );
  // 失败引用不留下部分配方
  const count = (db.prepare("SELECT COUNT(*) AS c FROM recipes").get() as { c: number }).c;
  assert.equal(count, 0);
});

test("非法质量与零总质量被拒绝", () => {
  const db = freshDb();
  svc.createIngredient(db, "面粉", "flour");
  assert.throws(() => svc.createRecipe(db, "坏质量", [{ type: "ingredient", name: "面粉", mass: "1.1234567" }]),
    (e: unknown) => e instanceof ApiError && e.code === "INVALID_MASS");
  assert.throws(() => svc.createRecipe(db, "负数", [{ type: "ingredient", name: "面粉", mass: "-5" }]),
    (e: unknown) => e instanceof ApiError && e.code === "INVALID_MASS");
  assert.throws(() => svc.createRecipe(db, "零总量", [{ type: "ingredient", name: "面粉", mass: "0" }]),
    (e: unknown) => e instanceof ApiError && e.code === "ZERO_TOTAL_MASS");
  assert.throws(() => svc.createMixture(db, "空", []),
    (e: unknown) => e instanceof ApiError && e.code === "EMPTY_MIXTURE");
  assert.throws(() => svc.createMixture(db, "零项", [{ type: "ingredient", name: "面粉", mass: "0" }]),
    (e: unknown) => e instanceof ApiError && e.code === "INVALID_MASS");
});

test("requestId 幂等：重复请求不重复建记录", () => {
  const db = freshDb();
  seedBasic(db);
  const items: svc.ItemInput[] = [{ type: "ingredient", name: "面粉", mass: "100" }];
  const r1 = svc.createRecipe(db, "幂等", items, "req-1");
  const r2 = svc.createRecipe(db, "幂等", items, "req-1");
  assert.equal(r1.id, r2.id);
  assert.equal(r2.duplicated, true);
  const rep1 = svc.generateReport(db, r1.id, undefined, "rep-1");
  const rep2 = svc.generateReport(db, r1.id, undefined, "rep-1");
  assert.equal(rep1.id, rep2.id);
});

test("修改酵头生成新版本，旧报告不变", () => {
  const db = freshDb();
  seedBasic(db);
  const r1 = seedRecipe(db);
  const oldReport = svc.generateReport(db, r1.id);
  svc.createMixture(db, "酵头", [
    { type: "ingredient", name: "面粉", mass: "60" },
    { type: "ingredient", name: "水", mass: "40" },
  ]); // v2
  const reread = svc.getReport(db, oldReport.id);
  assert.equal(reread.totals.flour.exact, "450"); // 仍按 v1 冻结结果
  // 用被冻结的引用重新核算，结果相同
  const recomputed = svc.generateReport(db, r1.id);
  assert.equal(recomputed.totals.flour.exact, "450");
  // 新配方引用 v2
  const r2 = svc.createRecipe(db, "新配比", [
    { type: "ingredient", name: "面粉", mass: "400" },
    { type: "ingredient", name: "水", mass: "250" },
    { type: "ingredient", name: "盐", mass: "9" },
    { type: "mixture", name: "酵头", version: 2, mass: "100" },
  ]);
  const newReport = svc.generateReport(db, r2.id);
  assert.equal(newReport.totals.flour.exact, "460");
  assert.equal(newReport.totals.water.exact, "290");
});

test("重启后可直接读取旧报告", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bakery-restart-"));
  const db1 = openDb(dir);
  seedBasic(db1);
  const r = seedRecipe(db1);
  const report = svc.generateReport(db1, r.id);
  db1.close();
  const db2 = openDb(dir); // 模拟重启
  const reread = svc.getReport(db2, report.id);
  assert.equal(reread.totals.total.exact, "759");
  assert.equal(reread.totals.water.hydrationExact, "2/3");
  db2.close();
});

test("HTTP API 端到端", async () => {
  const db = freshDb();
  const { port, server } = await startServer(db, 0);
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown) => {
    const res = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  await post("/ingredients", { name: "面粉", category: "flour" });
  await post("/ingredients", { name: "水", category: "water" });
  await post("/mixtures", { name: "酵头", items: [
    { type: "ingredient", name: "面粉", mass: "50" },
    { type: "ingredient", name: "水", mass: "50" },
  ]});
  const recipe = await post("/recipes", { name: "API 吐司", items: [
    { type: "ingredient", name: "面粉", mass: "400" },
    { type: "ingredient", name: "水", mass: "250" },
    { type: "mixture", name: "酵头", version: 1, mass: "100" },
  ]});
  assert.equal(recipe.status, 201);
  const report = await post("/reports", { recipeId: recipe.body.id });
  assert.equal(report.body.totals.flour.exact, "450");
  const get = await fetch(`${base}/reports/${report.body.id}`);
  assert.equal(get.status, 200);
  const bad = await post("/reports", { recipeId: 999 });
  assert.equal(bad.body.error.code, "NOT_FOUND");
  const cons = await fetch(`${base}/recipes/${recipe.body.id}/conservation`);
  assert.equal((await cons.json() as any).holds, true);
  server.close();
});
