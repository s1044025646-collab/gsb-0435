import { DatabaseSync } from "node:sqlite";
import { Fraction } from "./fraction";
import { ApiError } from "./errors";
import { expandRef, totalsOf, Leaf, MAX_MIXTURE_ITEMS } from "./core";

export interface ItemInput {
  refType: "ingredient" | "mixture";
  refId: number;
  mass: string;
}

function requireName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ApiError("VALIDATION", "name 必须是非空字符串");
  }
  return name.trim();
}

function parseMass(mass: unknown, opts: { allowZero: boolean }): Fraction {
  if (!Fraction.isValidDecimalString(mass)) {
    throw new ApiError("INVALID_MASS", `质量必须是最多六位小数的非负十进制字符串: ${String(mass)}`);
  }
  const f = Fraction.parseDecimal(mass as string)!;
  if (!opts.allowZero && !f.isPositive()) {
    throw new ApiError("INVALID_MASS", "组成项质量必须为正数");
  }
  return f;
}

function validateItems(items: unknown): ItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError("VALIDATION", "items 必须是非空数组");
  }
  return items.map((raw, i) => {
    const it = raw as Partial<ItemInput>;
    if (it.refType !== "ingredient" && it.refType !== "mixture") {
      throw new ApiError("VALIDATION", `items[${i}].refType 必须是 ingredient 或 mixture`);
    }
    if (!Number.isInteger(it.refId) || (it.refId as number) <= 0) {
      throw new ApiError("VALIDATION", `items[${i}].refId 必须是正整数`);
    }
    parseMass(it.mass, { allowZero: false });
    return { refType: it.refType, refId: it.refId as number, mass: it.mass as string };
  });
}

function idempotentLookup(db: DatabaseSync, table: string, requestId?: string): { id: number } | null {
  if (!requestId) return null;
  const row = db.prepare(`SELECT id FROM ${table} WHERE request_id = ?`).get(requestId) as { id: number } | undefined;
  return row ?? null;
}

export function createIngredient(db: DatabaseSync, body: { name?: unknown; kind?: unknown; requestId?: string }): any {
  const existing = idempotentLookup(db, "ingredients", body.requestId);
  if (existing) return getIngredient(db, existing.id);
  const name = requireName(body.name);
  if (body.kind !== "flour" && body.kind !== "water" && body.kind !== "other") {
    throw new ApiError("VALIDATION", "kind 必须是 flour / water / other");
  }
  const r = db.prepare("INSERT INTO ingredients (name, kind, request_id) VALUES (?, ?, ?)").run(name, body.kind, body.requestId ?? null);
  return getIngredient(db, Number(r.lastInsertRowid));
}

export function getIngredient(db: DatabaseSync, id: number): any {
  const row = db.prepare("SELECT id, name, kind, request_id AS requestId, created_at AS createdAt FROM ingredients WHERE id = ?").get(id);
  if (!row) throw new ApiError("NOT_FOUND", `基础原料不存在: id=${id}`, 404);
  return row;
}

export function listIngredients(db: DatabaseSync, limit = 50, offset = 0): any {
  return db.prepare("SELECT id, name, kind, created_at AS createdAt FROM ingredients ORDER BY id LIMIT ? OFFSET ?").all(limit, offset);
}

export function createMixture(db: DatabaseSync, body: { name?: unknown; items?: unknown; requestId?: string }): any {
  const existing = idempotentLookup(db, "mixtures", body.requestId);
  if (existing) return getMixture(db, existing.id);
  const name = requireName(body.name);
  const items = validateItems(body.items);
  if (items.length > MAX_MIXTURE_ITEMS) {
    throw new ApiError("TOO_MANY_ITEMS", `混合物组成项超过上限 ${MAX_MIXTURE_ITEMS}`);
  }
  db.exec("BEGIN");
  try {
    const vrow = db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM mixtures WHERE name = ?").get(name) as { v: number };
    const r = db.prepare("INSERT INTO mixtures (name, version, request_id) VALUES (?, ?, ?)").run(name, vrow.v, body.requestId ?? null);
    const mixtureId = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO mixture_items (mixture_id, ref_type, ref_id, mass) VALUES (?, ?, ?, ?)");
    for (const it of items) {
      assertRefExists(db, it.refType, it.refId, `混合物 ${name} v${vrow.v}`);
      ins.run(mixtureId, it.refType, it.refId, it.mass);
    }
    expandRef(db, "mixture", mixtureId, Fraction.of(1n), new Map(), [], 1);
    db.exec("COMMIT");
    return getMixture(db, mixtureId);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function assertRefExists(db: DatabaseSync, refType: string, refId: number, ctx: string) {
  const table = refType === "ingredient" ? "ingredients" : "mixtures";
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(refId);
  if (!row) {
    throw new ApiError(
      refType === "mixture" ? "UNKNOWN_VERSION" : "NOT_FOUND",
      `${ctx} 引用了不存在的 ${refType}#${refId}`,
      refType === "mixture" ? 400 : 404
    );
  }
}

export function getMixture(db: DatabaseSync, id: number): any {
  const m = db.prepare("SELECT id, name, version, request_id AS requestId, created_at AS createdAt FROM mixtures WHERE id = ?").get(id) as
    | { id: number; name: string; version: number }
    | undefined;
  if (!m) throw new ApiError("UNKNOWN_VERSION", `未知混合物版本: id=${id}`, 404);
  const items = db.prepare("SELECT ref_type AS refType, ref_id AS refId, mass FROM mixture_items WHERE mixture_id = ? ORDER BY id").all(id);
  return { ...m, items };
}

export function listMixtures(db: DatabaseSync, limit = 50, offset = 0): any {
  return db.prepare("SELECT id, name, version, created_at AS createdAt FROM mixtures ORDER BY id LIMIT ? OFFSET ?").all(limit, offset);
}

export function createRecipe(db: DatabaseSync, body: { name?: unknown; items?: unknown; requestId?: string }): any {
  const existing = idempotentLookup(db, "recipes", body.requestId);
  if (existing) return getRecipe(db, existing.id);
  const name = requireName(body.name);
  const items = validateItems(body.items);
  db.exec("BEGIN");
  try {
    const r = db.prepare("INSERT INTO recipes (name, request_id) VALUES (?, ?)").run(name, body.requestId ?? null);
    const recipeId = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO recipe_items (recipe_id, ref_type, ref_id, mass) VALUES (?, ?, ?, ?)");
    let total = Fraction.zero();
    for (const it of items) {
      assertRefExists(db, it.refType, it.refId, `配方 ${name}`);
      total = total.add(Fraction.parseDecimal(it.mass)!);
      ins.run(recipeId, it.refType, it.refId, it.mass);
    }
    if (total.isZero()) {
      throw new ApiError("ZERO_TOTAL", "配方总质量为零，已拒绝");
    }
    db.exec("COMMIT");
    return getRecipe(db, recipeId);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getRecipe(db: DatabaseSync, id: number): any {
  const r = db.prepare("SELECT id, name, request_id AS requestId, created_at AS createdAt FROM recipes WHERE id = ?").get(id);
  if (!r) throw new ApiError("NOT_FOUND", `配方不存在: id=${id}`, 404);
  const items = db.prepare("SELECT ref_type AS refType, ref_id AS refId, mass FROM recipe_items WHERE recipe_id = ? ORDER BY id").all(id);
  return { ...(r as object), items };
}

interface RecipeItemRow { ref_type: "ingredient" | "mixture"; ref_id: number; mass: string }

function expandRecipe(db: DatabaseSync, recipeId: number, factor: Fraction): { leaves: Map<number, Leaf>; inputTotal: Fraction } {
  const items = db.prepare("SELECT ref_type, ref_id, mass FROM recipe_items WHERE recipe_id = ? ORDER BY id").all(recipeId) as unknown as RecipeItemRow[];
  if (items.length === 0) throw new ApiError("NOT_FOUND", `配方不存在或无投料项: id=${recipeId}`, 404);
  const leaves = new Map<number, Leaf>();
  let inputTotal = Fraction.zero();
  for (const it of items) {
    const m = Fraction.parseDecimal(it.mass);
    if (!m) throw new ApiError("INVALID_MASS", `配方投料质量非法: ${it.mass}`);
    const scaled = m.mul(factor);
    inputTotal = inputTotal.add(scaled);
    expandRef(db, it.ref_type, it.ref_id, scaled, leaves, [], 1);
  }
  return { leaves, inputTotal };
}

const DISPLAY_PLACES = 6;

function fmt(f: Fraction) {
  return { exact: f.toString(), decimal: f.toFixed(DISPLAY_PLACES) };
}

function buildReportPayload(db: DatabaseSync, recipeId: number, factor: Fraction, scaleTarget: Fraction | null) {
  const { leaves, inputTotal } = expandRecipe(db, recipeId, factor);
  const totals = totalsOf(leaves);

  if (totals.total.toString() !== inputTotal.toString()) {
    throw new ApiError("VALIDATION", `质量不守恒: 叶子和=${totals.total} 投料=${inputTotal}`, 500);
  }
  if (totals.flour.isZero()) {
    throw new ApiError("NO_FLOUR", "配方不含任何面粉，无法计算烘焙百分比", 400);
  }

  const leafList = [...leaves.values()].map((l) => ({
    ingredientId: l.ingredientId,
    name: l.name,
    kind: l.kind,
    mass: fmt(l.mass),
    percentOfFlour: fmt(l.mass.div(totals.flour).mul(Fraction.of(100n))),
    paths: l.paths,
  }));

  return {
    recipeId,
    scaleFactor: factor.toString(),
    scaleTarget: scaleTarget ? scaleTarget.toString() : null,
    totals: {
      flour: fmt(totals.flour),
      water: fmt(totals.water),
      other: fmt(totals.other),
      total: fmt(totals.total),
    },
    hydration: fmt(totals.water.div(totals.flour)),
    hydrationPercent: fmt(totals.water.div(totals.flour).mul(Fraction.of(100n))),
    leaves: leafList,
    leafCount: leafList.length,
    conservation: { leafSum: totals.total.toString(), inputTotal: inputTotal.toString(), ok: true },
  };
}

export function createReport(db: DatabaseSync, body: { recipeId?: unknown; targetTotalMass?: unknown; requestId?: string }): any {
  const existing = idempotentLookup(db, "reports", body.requestId);
  if (existing) return getReport(db, existing.id);
  if (!Number.isInteger(body.recipeId) || (body.recipeId as number) <= 0) {
    throw new ApiError("VALIDATION", "recipeId 必须是正整数");
  }
  const recipeId = body.recipeId as number;
  getRecipe(db, recipeId);

  let factor = Fraction.of(1n);
  let target: Fraction | null = null;
  if (body.targetTotalMass !== undefined && body.targetTotalMass !== null) {
    target = parseMass(body.targetTotalMass, { allowZero: false });
    const { inputTotal } = expandRecipe(db, recipeId, Fraction.of(1n));
    if (inputTotal.isZero()) throw new ApiError("ZERO_TOTAL", "配方总质量为零，无法缩放");
    factor = target.div(inputTotal);
  }

  const payload = buildReportPayload(db, recipeId, factor, target);
  const kind = target ? "scale" : "expand";
  const r = db
    .prepare("INSERT INTO reports (recipe_id, kind, scale_target, scale_factor, payload, request_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(recipeId, kind, target ? target.toString() : null, factor.toString(), JSON.stringify(payload), body.requestId ?? null);
  return getReport(db, Number(r.lastInsertRowid));
}

export function getReport(db: DatabaseSync, id: number): any {
  const row = db
    .prepare("SELECT id, recipe_id AS recipeId, kind, scale_target AS scaleTarget, scale_factor AS scaleFactor, payload, request_id AS requestId, created_at AS createdAt FROM reports WHERE id = ?")
    .get(id) as ({ payload: string } & Record<string, unknown>) | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `报告不存在: id=${id}`, 404);
  return { ...row, payload: JSON.parse(row.payload) };
}

export function listReports(db: DatabaseSync, limit = 50, offset = 0): any {
  return db
    .prepare("SELECT id, recipe_id AS recipeId, kind, scale_target AS scaleTarget, created_at AS createdAt FROM reports ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, offset);
}

export function getReportLeaves(db: DatabaseSync, id: number, limit = 50, offset = 0): any {
  const report = getReport(db, id) as unknown as { payload: { leaves: unknown[]; leafCount: number } };
  return {
    total: report.payload.leafCount,
    limit,
    offset,
    leaves: report.payload.leaves.slice(offset, offset + limit),
  };
}

function parseFractionString(s: string): Fraction {
  const parts = s.split("/");
  return Fraction.of(BigInt(parts[0]), parts[1] ? BigInt(parts[1]) : 1n);
}

export function recomputeReport(db: DatabaseSync, id: number): any {
  const row = getReport(db, id) as unknown as { recipeId: number; scaleFactor: string };
  const factor = parseFractionString(row.scaleFactor);
  return buildReportPayload(db, row.recipeId, factor, null);
}

export function verifyConservation(db: DatabaseSync, reportId: number): any {
  const report = getReport(db, reportId) as unknown as { payload: { conservation: unknown; totals: { total: { exact: string } } } };
  const recomputed = recomputeReport(db, reportId);
  const ok = recomputed.totals.total.exact === report.payload.totals.total.exact;
  return { reportId, ok, conservation: report.payload.conservation, recomputedTotal: recomputed.totals.total.exact };
}


