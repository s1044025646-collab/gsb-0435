import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb } from "../src/db";
import * as svc from "../src/service";
import { ApiError } from "../src/errors";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let ids: { flour: number; water: number; salt: number; starter: number };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bakery-test-"));
  db = openDb(path.join(tmp, "test.db"));
  const flour = svc.createIngredient(db, { name: "高筋面粉", kind: "flour" }) as { id: number };
  const water = svc.createIngredient(db, { name: "水", kind: "water" }) as { id: number };
  const salt = svc.createIngredient(db, { name: "盐", kind: "other" }) as { id: number };
  const starter = svc.createMixture(db, {
    name: "酵头",
    items: [
      { refType: "ingredient", refId: flour.id, mass: "50" },
      { refType: "ingredient", refId: water.id, mass: "50" },
    ],
  }) as { id: number };
  ids = { flour: flour.id, water: water.id, salt: salt.id, starter: starter.id };
});

function makeRecipe() {
  return svc.createRecipe(db, {
    name: "白吐司",
    items: [
      { refType: "ingredient", refId: ids.flour, mass: "400" },
      { refType: "ingredient", refId: ids.water, mass: "250" },
      { refType: "ingredient", refId: ids.salt, mass: "9" },
      { refType: "mixture", refId: ids.starter, mass: "100" },
    ],
  }) as { id: number };
}

test("已知示例：展开、百分比、加水比例", () => {
  const recipe = makeRecipe();
  const report = svc.createReport(db, { recipeId: recipe.id }) as any;
  const p = report.payload;
  assert.equal(p.totals.total.exact, "759");
  assert.equal(p.totals.flour.exact, "450");
  assert.equal(p.totals.water.exact, "300");
  assert.equal(p.totals.other.exact, "9");
  assert.equal(p.hydration.exact, "2/3");
  const salt = p.leaves.find((l: any) => l.name === "盐");
  assert.equal(salt.percentOfFlour.exact, "2");
  assert.equal(p.conservation.ok, true);
});

test("缩放至 1518g：质量翻倍，百分比不变", () => {
  const recipe = makeRecipe();
  const report = svc.createReport(db, { recipeId: recipe.id, targetTotalMass: "1518" }) as any;
  const p = report.payload;
  assert.equal(p.totals.total.exact, "1518");
  assert.equal(p.totals.flour.exact, "900");
  assert.equal(p.totals.water.exact, "600");
  assert.equal(p.hydration.exact, "2/3");
  const salt = p.leaves.find((l: any) => l.name === "盐");
  assert.equal(salt.percentOfFlour.exact, "2");
});

test("同一原料多路径进入时累加且保留全部路径", () => {
  const recipe = makeRecipe();
  const report = svc.createReport(db, { recipeId: recipe.id }) as any;
  const flour = report.payload.leaves.find((l: any) => l.name === "高筋面粉");
  assert.equal(flour.mass.exact, "450");
  assert.equal(flour.paths.length, 2); // 直接投料 + 经酵头
});

test("嵌套酵头：两层混合物正确展开", () => {
  const poolish = svc.createMixture(db, {
    name: "波兰种",
    items: [
      { refType: "ingredient", refId: ids.flour, mass: "100" },
      { refType: "ingredient", refId: ids.water, mass: "100" },
    ],
  }) as { id: number };
  const biga = svc.createMixture(db, {
    name: "复合酵头",
    items: [
      { refType: "mixture", refId: poolish.id, mass: "200" },
      { refType: "ingredient", refId: ids.flour, mass: "100" },
    ],
  }) as { id: number };
  const recipe = svc.createRecipe(db, {
    name: "嵌套",
    items: [{ refType: "mixture", refId: biga.id, mass: "300" }],
  }) as { id: number };
  const report = svc.createReport(db, { recipeId: recipe.id }) as any;
  // 300g 复合酵头 = 200g 波兰种(100面粉+100水) + 100g 面粉
  assert.equal(report.payload.totals.flour.exact, "200");
  assert.equal(report.payload.totals.water.exact, "100");
  assert.equal(report.payload.totals.total.exact, "300");
});

test("三分之一比例精确保留（1:1:1 混合物）", () => {
  const third = svc.createMixture(db, {
    name: "三等分",
    items: [
      { refType: "ingredient", refId: ids.flour, mass: "1" },
      { refType: "ingredient", refId: ids.water, mass: "1" },
      { refType: "ingredient", refId: ids.salt, mass: "1" },
    ],
  }) as { id: number };
  const recipe = svc.createRecipe(db, {
    name: "三分之一",
    items: [{ refType: "mixture", refId: third.id, mass: "100" }],
  }) as { id: number };
  const report = svc.createReport(db, { recipeId: recipe.id }) as any;
  assert.equal(report.payload.totals.flour.exact, "100/3");
  assert.equal(report.payload.totals.water.exact, "100/3");
  assert.equal(report.payload.totals.total.exact, "100"); // 守恒
  assert.equal(report.payload.hydration.exact, "1");
});

test("无面粉时返回 NO_FLOUR", () => {
  const recipe = svc.createRecipe(db, {
    name: "无面粉",
    items: [
      { refType: "ingredient", refId: ids.water, mass: "100" },
      { refType: "ingredient", refId: ids.salt, mass: "5" },
    ],
  }) as { id: number };
  assert.throws(() => svc.createReport(db, { recipeId: recipe.id }), (e: unknown) => {
    return e instanceof ApiError && e.code === "NO_FLOUR";
  });
});

test("循环引用被拒绝并给出路径", () => {
  // 服务层按构造只能形成 DAG（只能引用已存在的不可变版本），
  // 这里直接写入一个环来验证展开器能拒绝并给出路径而非栈溢出。
  const m1 = svc.createMixture(db, {
    name: "m1",
    items: [{ refType: "ingredient", refId: ids.flour, mass: "10" }],
  }) as { id: number };
  const m2 = svc.createMixture(db, {
    name: "m2",
    items: [{ refType: "mixture", refId: m1.id, mass: "10" }],
  }) as { id: number };
  db.prepare("INSERT INTO mixture_items (mixture_id, ref_type, ref_id, mass) VALUES (?, 'mixture', ?, '10')").run(m1.id, m2.id);
  const recipe = svc.createRecipe(db, {
    name: "环",
    items: [{ refType: "mixture", refId: m2.id, mass: "10" }],
  }) as { id: number };
  assert.throws(
    () => svc.createReport(db, { recipeId: recipe.id }),
    (e: unknown) => e instanceof ApiError && e.code === "CYCLE" && JSON.stringify(e.details).includes("m1")
  );
});

test("未知混合物版本被拒绝", () => {
  assert.throws(
    () =>
      svc.createRecipe(db, {
        name: "坏引用",
        items: [{ refType: "mixture", refId: 9999, mass: "10" }],
      }),
    (e: unknown) => e instanceof ApiError && e.code === "UNKNOWN_VERSION"
  );
  // 失败不留下部分配方
  const recipes = db.prepare("SELECT COUNT(*) AS c FROM recipes").get() as { c: number };
  assert.equal(recipes.c, 0);
});

test("非法质量与空混合物被拒绝", () => {
  assert.throws(
    () => svc.createRecipe(db, { name: "x", items: [{ refType: "ingredient", refId: ids.flour, mass: "1.1234567" }] }),
    (e: unknown) => e instanceof ApiError && e.code === "INVALID_MASS"
  );
  assert.throws(
    () => svc.createRecipe(db, { name: "x", items: [{ refType: "ingredient", refId: ids.flour, mass: "-5" }] }),
    (e: unknown) => e instanceof ApiError && e.code === "INVALID_MASS"
  );
  assert.throws(
    () => svc.createMixture(db, { name: "空", items: [] }),
    (e: unknown) => e instanceof ApiError && e.code === "VALIDATION"
  );
  assert.throws(
    () => svc.createMixture(db, { name: "零", items: [{ refType: "ingredient", refId: ids.flour, mass: "0" }] }),
    (e: unknown) => e instanceof ApiError && e.code === "INVALID_MASS"
  );
});

test("幂等：相同 requestId 不重复建记录", () => {
  const a = svc.createIngredient(db, { name: "糖", kind: "other", requestId: "req-1" }) as { id: number };
  const b = svc.createIngredient(db, { name: "糖", kind: "other", requestId: "req-1" }) as { id: number };
  assert.equal(a.id, b.id);
  const recipe = makeRecipe();
  const r1 = svc.createReport(db, { recipeId: recipe.id, requestId: "rep-1" }) as { id: number };
  const r2 = svc.createReport(db, { recipeId: recipe.id, requestId: "rep-1" }) as { id: number };
  assert.equal(r1.id, r2.id);
});

test("修改酵头生成新版本，旧报告不变", () => {
  const recipe = makeRecipe();
  const before = svc.createReport(db, { recipeId: recipe.id }) as any;
  svc.createMixture(db, {
    name: "酵头",
    items: [
      { refType: "ingredient", refId: ids.flour, mass: "40" },
      { refType: "ingredient", refId: ids.water, mass: "60" },
    ],
  });
  const after = svc.getReport(db, before.id) as any;
  assert.equal(after.payload.totals.flour.exact, "450");
  const recomputed = svc.recomputeReport(db, before.id);
  assert.equal(recomputed.totals.flour.exact, "450"); // 冻结引用重算一致
});

test("重启后读取旧报告并重算一致", () => {
  const recipe = makeRecipe();
  const report = svc.createReport(db, { recipeId: recipe.id }) as { id: number };
  const file = path.join(tmp, "test.db");
  db.close();
  const db2 = openDb(file);
  const loaded = svc.getReport(db2, report.id) as any;
  assert.equal(loaded.payload.totals.total.exact, "759");
  const recomputed = svc.recomputeReport(db2, report.id);
  assert.equal(recomputed.totals.total.exact, "759");
  const verify = svc.verifyConservation(db2, report.id);
  assert.equal(verify.ok, true);
  db2.close();
});

test("叶子分页，汇总包含全部叶子", () => {
  const recipe = makeRecipe();
  const report = svc.createReport(db, { recipeId: recipe.id }) as { id: number };
  const page = svc.getReportLeaves(db, report.id, 2, 0) as any;
  assert.equal(page.total, 3);
  assert.equal(page.leaves.length, 2);
  const full = svc.getReport(db, report.id) as any;
  assert.equal(full.payload.leaves.length, 3);
});
