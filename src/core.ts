import { DatabaseSync } from "node:sqlite";
import { Fraction } from "./fraction";
import { ApiError } from "./errors";

export const MAX_DEPTH = 8;
export const MAX_LEAVES = 1000;
export const MAX_MIXTURE_ITEMS = 100;

export interface LeafPathStep {
  refType: "ingredient" | "mixture";
  refId: number;
  name: string;
  version?: number;
}

export interface Leaf {
  ingredientId: number;
  name: string;
  kind: "flour" | "water" | "other";
  mass: Fraction;
  paths: LeafPathStep[][];
}

interface MixtureItemRow {
  ref_type: "ingredient" | "mixture";
  ref_id: number;
  mass: string;
}

// 把一项投料（基础原料或指定版本混合物）按质量展开为基础原料叶子。
// 同一原料经多条路径进入时累加质量，并保留全部来源路径。
export function expandRef(
  db: DatabaseSync,
  refType: "ingredient" | "mixture",
  refId: number,
  mass: Fraction,
  leaves: Map<number, Leaf>,
  stack: LeafPathStep[],
  depth: number
): void {
  if (depth > MAX_DEPTH) {
    throw new ApiError("TOO_DEEP", `展开深度超过上限 ${MAX_DEPTH}`, 400, { path: stack });
  }

  if (refType === "ingredient") {
    const ing = db.prepare("SELECT id, name, kind FROM ingredients WHERE id = ?").get(refId) as
      | { id: number; name: string; kind: Leaf["kind"] }
      | undefined;
    if (!ing) {
      throw new ApiError("NOT_FOUND", `基础原料不存在: id=${refId}`, 404, { path: stack });
    }
    const path = [...stack, { refType: "ingredient" as const, refId: ing.id, name: ing.name }];
    const existing = leaves.get(ing.id);
    if (existing) {
      existing.mass = existing.mass.add(mass);
      existing.paths.push(path);
    } else {
      if (leaves.size >= MAX_LEAVES) {
        throw new ApiError("TOO_MANY_ITEMS", `叶子数量超过上限 ${MAX_LEAVES}`, 400, { path });
      }
      leaves.set(ing.id, { ingredientId: ing.id, name: ing.name, kind: ing.kind, mass, paths: [path] });
    }
    return;
  }

  // 混合物：refId 必须是不可变的具体版本 id
  const mixture = db.prepare("SELECT id, name, version FROM mixtures WHERE id = ?").get(refId) as
    | { id: number; name: string; version: number }
    | undefined;
  if (!mixture) {
    throw new ApiError("UNKNOWN_VERSION", `未知混合物版本: id=${refId}`, 400, { path: stack });
  }
  if (stack.some((s) => s.refType === "mixture" && s.refId === mixture.id)) {
    throw new ApiError("CYCLE", `混合物循环引用: ${mixture.name} v${mixture.version}`, 400, {
      path: [...stack, { refType: "mixture", refId: mixture.id, name: mixture.name, version: mixture.version }],
    });
  }

  const items = db
    .prepare("SELECT ref_type, ref_id, mass FROM mixture_items WHERE mixture_id = ? ORDER BY id")
    .all(mixture.id) as unknown as MixtureItemRow[];
  if (items.length === 0) {
    throw new ApiError("EMPTY_MIXTURE", `混合物为空: ${mixture.name} v${mixture.version}`, 400, { path: stack });
  }

  let recipeTotal = Fraction.zero();
  const parsed: { refType: "ingredient" | "mixture"; refId: number; mass: Fraction }[] = [];
  for (const it of items) {
    const m = Fraction.parseDecimal(it.mass);
    if (!m || !m.isPositive()) {
      throw new ApiError("INVALID_MASS", `混合物组成项质量非法: ${it.mass}`, 400, { path: stack });
    }
    recipeTotal = recipeTotal.add(m);
    parsed.push({ refType: it.ref_type, refId: it.ref_id, mass: m });
  }

  const step: LeafPathStep = {
    refType: "mixture",
    refId: mixture.id,
    name: mixture.name,
    version: mixture.version,
  };
  for (const p of parsed) {
    // 按本次使用的混合物质量等比例拆分：mass * item / recipeTotal
    const share = mass.mul(p.mass).div(recipeTotal);
    expandRef(db, p.refType, p.refId, share, leaves, [...stack, step], depth + 1);
  }
}

export interface Totals {
  flour: Fraction;
  water: Fraction;
  other: Fraction;
  total: Fraction;
}

export function totalsOf(leaves: Map<number, Leaf>): Totals {
  let flour = Fraction.zero();
  let water = Fraction.zero();
  let other = Fraction.zero();
  for (const leaf of leaves.values()) {
    if (leaf.kind === "flour") flour = flour.add(leaf.mass);
    else if (leaf.kind === "water") water = water.add(leaf.mass);
    else other = other.add(leaf.mass);
  }
  return { flour, water, other, total: flour.add(water).add(other) };
}
