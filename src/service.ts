import { DatabaseSync } from "node:sqlite";
import { ApiError, Frac } from "./fraction";
import { expandItem, summarize, Leaf } from "./expand";

export interface ItemInput { type: "ingredient" | "mixture"; id?: number; name?: string; version?: number; mass: string }

function resolveIngredientId(db: DatabaseSync, item: ItemInput): number {
  if (item.id != null) {
    const row = db.prepare("SELECT id FROM ingredients WHERE id = ?").get(item.id);
    if (!row) throw new ApiError("NOT_FOUND", `原料不存在: id=${item.id}`);
    return item.id;
  }
  if (item.name != null) {
    const row = db.prepare("SELECT id FROM ingredients WHERE name = ?").get(item.name) as { id: number } | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `原料不存在: ${item.name}`);
    return row.id;
  }
  throw new ApiError("INVALID_INPUT", "组成项必须提供 id 或 name");
}

function resolveMixtureId(db: DatabaseSync, item: ItemInput): number {
  if (item.id != null) {
    const row = db.prepare("SELECT id FROM mixtures WHERE id = ?").get(item.id);
    if (!row) throw new ApiError("UNKNOWN_MIXTURE_VERSION", `混合物版本不存在: id=${item.id}`);
    return item.id;
  }
  if (item.name != null && item.version != null) {
    const row = db.prepare("SELECT id FROM mixtures WHERE name = ? AND version = ?").get(item.name, item.version) as { id: number } | undefined;
    if (!row) throw new ApiError("UNKNOWN_MIXTURE_VERSION", `混合物版本不存在: ${item.name}@v${item.version}`);
    return row.id;
  }
  throw new ApiError("INVALID_INPUT", "混合物引用必须提供 id，或 name + version");
}

export function createIngredient(db: DatabaseSync, name: string, category: string) {
  if (!name || typeof name !== "string") throw new ApiError("INVALID_INPUT", "原料名称不能为空");
  if (!["flour", "water", "other"].includes(category)) {
    throw new ApiError("INVALID_INPUT", `category 必须是 flour / water / other，收到: ${category}`);
  }
  const existing = db.prepare("SELECT id, category FROM ingredients WHERE name = ?").get(name) as { id: number; category: string } | undefined;
  if (existing) {
    if (existing.category !== category) throw new ApiError("DUPLICATE_NAME", `原料 ${name} 已存在且分类为 ${existing.category}`);
    return { id: existing.id, name, category, existed: true };
  }
  const r = db.prepare("INSERT INTO ingredients (name, category) VALUES (?, ?)").run(name, category);
  return { id: Number(r.lastInsertRowid), name, category, existed: false };
}

/** 保存混合物新版本（version 自动递增，版本不可变）。整体事务：任一项非法则不留下部分数据。 */
export function createMixture(db: DatabaseSync, name: string, items: ItemInput[]) {
  if (!name) throw new ApiError("INVALID_INPUT", "混合物名称不能为空");
  if (!Array.isArray(items) || items.length === 0) throw new ApiError("EMPTY_MIXTURE", "混合物至少需要一个组成项");
  db.exec("BEGIN");
  try {
    const prev = db.prepare("SELECT MAX(version) AS v FROM mixtures WHERE name = ?").get(name) as { v: number | null };
    const version = (prev.v ?? 0) + 1;
    const r = db.prepare("INSERT INTO mixtures (name, version) VALUES (?, ?)").run(name, version);
    const mixtureId = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO mixture_items (mixture_id, item_type, ingredient_id, child_mixture_id, mass) VALUES (?,?,?,?,?)");
    for (const it of items) {
      const mass = Frac.parseDecimal(it.mass, "组成项质量");
      if (!mass.isPositive()) throw new ApiError("INVALID_MASS", `组成项质量必须为正，收到: ${it.mass}`);
      if (it.type === "ingredient") {
        ins.run(mixtureId, "ingredient", resolveIngredientId(db, it), null, it.mass);
      } else if (it.type === "mixture") {
        const childId = resolveMixtureId(db, it);
        if (childId === mixtureId) throw new ApiError("CIRCULAR_REFERENCE", `混合物 ${name} 不能直接引用自身`);
        ins.run(mixtureId, "mixture", null, childId, it.mass);
      } else {
        throw new ApiError("INVALID_INPUT", `未知组成项类型: ${(it as ItemInput).type}`);
      }
    }
    // 保存后立即试展开，提前拒绝间接循环 / 过深嵌套
    const leaves = new Map<number, Leaf>();
    expandItem(db, { itemType: "mixture", mixtureId, mass: Frac.of(1n), label: name }, leaves, [], [], 0);
    db.exec("COMMIT");
    return { id: mixtureId, name, version, itemCount: items.length };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 创建最终配方（冻结输入质量与引用版本）。幂等：相同 requestId 返回已有记录。 */
export function createRecipe(db: DatabaseSync, name: string, items: ItemInput[], requestId?: string) {
  if (!Array.isArray(items) || items.length === 0) throw new ApiError("INVALID_INPUT", "配方至少需要一个投料项");
  if (requestId) {
    const dup = db.prepare("SELECT id FROM recipes WHERE request_id = ?").get(requestId) as { id: number } | undefined;
    if (dup) return { id: dup.id, name, duplicated: true };
  }
  db.exec("BEGIN");
  try {
    let total = Frac.zero();
    for (const it of items) total = total.add(Frac.parseDecimal(it.mass, "投料质量"));
    if (total.isZero()) throw new ApiError("ZERO_TOTAL_MASS", "配方总投料质量为零");
    const r = db.prepare("INSERT INTO recipes (name, request_id) VALUES (?, ?)").run(name ?? "未命名配方", requestId ?? null);
    const recipeId = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO recipe_items (recipe_id, item_type, ingredient_id, mixture_id, mass) VALUES (?,?,?,?,?)");
    for (const it of items) {
      Frac.parseDecimal(it.mass, "投料质量"); // 校验
      if (it.type === "ingredient") {
        ins.run(recipeId, "ingredient", resolveIngredientId(db, it), null, it.mass);
      } else if (it.type === "mixture") {
        ins.run(recipeId, "mixture", null, resolveMixtureId(db, it), it.mass);
      } else {
        throw new ApiError("INVALID_INPUT", `未知投料项类型: ${(it as ItemInput).type}`);
      }
    }
    db.exec("COMMIT");
    return { id: recipeId, name, duplicated: false };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

interface RecipeItemRow { item_type: "ingredient" | "mixture"; ingredient_id: number | null; mixture_id: number | null; mass: string }

function expandRecipe(db: DatabaseSync, recipeId: number, scale?: Frac) {
  const items = db.prepare("SELECT item_type, ingredient_id, mixture_id, mass FROM recipe_items WHERE recipe_id = ?").all(recipeId) as unknown as RecipeItemRow[];
  if (items.length === 0) throw new ApiError("NOT_FOUND", `配方不存在或无投料项: id=${recipeId}`);
  const leaves = new Map<number, Leaf>();
  for (const it of items) {
    let mass = Frac.parseDecimal(it.mass, "投料质量");
    if (scale) mass = mass.mul(scale);
    if (it.item_type === "ingredient") {
      expandItem(db, { itemType: "ingredient", ingredientId: it.ingredient_id!, mass, label: "" }, leaves, [], [], 0);
    } else {
      expandItem(db, { itemType: "mixture", mixtureId: it.mixture_id!, mass, label: "" }, leaves, [], [], 0);
    }
  }
  return summarize([...leaves.values()]);
}

function buildReportPayload(db: DatabaseSync, recipeId: number, targetTotalMass?: string) {
  const base = expandRecipe(db, recipeId);
  if (base.totalMass.isZero()) throw new ApiError("ZERO_TOTAL_MASS", "配方总质量为零");
  let scale: Frac | undefined;
  if (targetTotalMass != null) {
    const target = Frac.parseDecimal(targetTotalMass, "目标总质量");
    if (!target.isPositive()) throw new ApiError("INVALID_MASS", "目标总质量必须为正");
    scale = target.div(base.totalMass);
  }
  const result = scale ? expandRecipe(db, recipeId, scale) : base;
  if (result.flourMass.isZero()) {
    throw new ApiError("NO_FLOUR", "配方不含任何面粉，无法计算烘焙百分比");
  }
  const pct = (m: Frac) => m.mul(Frac.of(100n)).div(result.flourMass);
  return {
    recipeId,
    targetTotalMass: targetTotalMass ?? null,
    scaleFactor: scale ? scale.toString() : "1",
    totals: {
      total: { exact: result.totalMass.toString(), grams: result.totalMass.toFixed(3) },
      flour: { exact: result.flourMass.toString(), grams: result.flourMass.toFixed(3), percent: "100" },
      water: { exact: result.waterMass.toString(), grams: result.waterMass.toFixed(3), percent: pct(result.waterMass).toFixed(4), hydrationExact: result.waterMass.div(result.flourMass).toString() },
      other: { exact: result.otherMass.toString(), grams: result.otherMass.toFixed(3), percent: pct(result.otherMass).toFixed(4) },
    },
    leaves: result.leaves.map((l) => ({
      ingredientId: l.ingredientId,
      name: l.name,
      category: l.category,
      mass: { exact: l.mass.toString(), grams: l.mass.toFixed(6) },
      percentOfFlour: pct(l.mass).toFixed(4),
      paths: l.paths,
    })),
    conservation: {
      leafSumExact: result.totalMass.toString(),
      holds: true,
    },
  };
}

/** 生成（或按 requestId 幂等返回）报告；报告冻结在数据库中，重启可直接读取。 */
export function generateReport(db: DatabaseSync, recipeId: number, targetTotalMass?: string, requestId?: string) {
  if (requestId) {
    const dup = db.prepare("SELECT id, payload FROM reports WHERE request_id = ?").get(requestId) as { id: number; payload: string } | undefined;
    if (dup) return { id: dup.id, ...JSON.parse(dup.payload), duplicated: true };
  }
  const recipe = db.prepare("SELECT id FROM recipes WHERE id = ?").get(recipeId);
  if (!recipe) throw new ApiError("NOT_FOUND", `配方不存在: id=${recipeId}`);
  const payload = buildReportPayload(db, recipeId, targetTotalMass);
  const r = db.prepare("INSERT INTO reports (recipe_id, request_id, target_total_mass, payload) VALUES (?,?,?,?)")
    .run(recipeId, requestId ?? null, targetTotalMass ?? null, JSON.stringify(payload));
  return { id: Number(r.lastInsertRowid), ...payload, duplicated: false };
}

export function getReport(db: DatabaseSync, reportId: number) {
  const row = db.prepare("SELECT id, payload FROM reports WHERE id = ?").get(reportId) as { id: number; payload: string } | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `报告不存在: id=${reportId}`);
  return { id: row.id, ...JSON.parse(row.payload) };
}

/** 核验质量守恒：叶子之和 == 原投料（或缩放后目标）总质量。 */
export function verifyConservation(db: DatabaseSync, recipeId: number, targetTotalMass?: string) {
  const items = db.prepare("SELECT mass FROM recipe_items WHERE recipe_id = ?").all(recipeId) as unknown as Array<{ mass: string }>;
  if (items.length === 0) throw new ApiError("NOT_FOUND", `配方不存在: id=${recipeId}`);
  let inputTotal = Frac.zero();
  for (const it of items) inputTotal = inputTotal.add(Frac.parseDecimal(it.mass, "投料质量"));
  let expected = inputTotal;
  let scale: Frac | undefined;
  if (targetTotalMass != null) {
    const target = Frac.parseDecimal(targetTotalMass, "目标总质量");
    scale = target.div(inputTotal);
    expected = target;
  }
  const result = expandRecipe(db, recipeId, scale);
  return {
    recipeId,
    expectedTotal: { exact: expected.toString(), grams: expected.toFixed(6) },
    leafSum: { exact: result.totalMass.toString(), grams: result.totalMass.toFixed(6) },
    holds: result.totalMass.equals(expected),
  };
}

export function listReports(db: DatabaseSync, page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;
  const rows = db.prepare("SELECT id, recipe_id, target_total_mass, created_at FROM reports ORDER BY id LIMIT ? OFFSET ?").all(pageSize, offset);
  const total = (db.prepare("SELECT COUNT(*) AS c FROM reports").get() as { c: number }).c;
  return { page, pageSize, total, items: rows };
}
