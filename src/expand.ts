import { DatabaseSync } from "node:sqlite";
import { ApiError, Frac } from "./fraction";
import { MAX_DEPTH, MAX_LEAVES } from "./db";

export interface Leaf {
  ingredientId: number;
  name: string;
  category: "flour" | "water" | "other";
  mass: Frac;
  paths: string[];
}

interface MixtureRow { id: number; name: string; version: number }

function loadMixtureItems(db: DatabaseSync, mixtureId: number) {
  return db.prepare(`
    SELECT mi.item_type, mi.ingredient_id, mi.child_mixture_id, mi.mass,
           i.name AS ingredient_name, i.category,
           cm.name AS child_name, cm.version AS child_version
    FROM mixture_items mi
    LEFT JOIN ingredients i ON i.id = mi.ingredient_id
    LEFT JOIN mixtures cm ON cm.id = mi.child_mixture_id
    WHERE mi.mixture_id = ?`).all(mixtureId) as unknown as Array<{
    item_type: "ingredient" | "mixture";
    ingredient_id: number | null;
    child_mixture_id: number | null;
    mass: string;
    ingredient_name: string | null;
    category: "flour" | "water" | "other" | null;
    child_name: string | null;
    child_version: number | null;
  }>;
}

/**
 * 将一项（基础原料或混合物版本）按给定质量展开为基础原料叶子。
 * 同一原料经多条路径进入时累加；路径记录用于来源展示与循环报错。
 */
export function expandItem(
  db: DatabaseSync,
  item: { itemType: "ingredient" | "mixture"; ingredientId?: number; mixtureId?: number; mass: Frac; label: string },
  leaves: Map<number, Leaf>,
  stack: string[],
  stackIds: number[],
  depth: number
): void {
  if (depth > MAX_DEPTH) {
    throw new ApiError("EXPANSION_TOO_DEEP", `展开深度超过上限 ${MAX_DEPTH}，路径: ${stack.join(" -> ")}`);
  }
  if (item.itemType === "ingredient") {
    const row = db.prepare("SELECT id, name, category FROM ingredients WHERE id = ?").get(item.ingredientId!) as
      | { id: number; name: string; category: "flour" | "water" | "other" } | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `原料不存在: id=${item.ingredientId}`);
    const pathStr = [...stack, `${row.name}(${item.mass.toFixed(6)}g)`].join(" -> ");
    const existing = leaves.get(row.id);
    if (existing) {
      existing.mass = existing.mass.add(item.mass);
      existing.paths.push(pathStr);
    } else {
      if (leaves.size >= MAX_LEAVES) {
        throw new ApiError("TOO_MANY_ITEMS", `展开叶子数超过上限 ${MAX_LEAVES}`);
      }
      leaves.set(row.id, { ingredientId: row.id, name: row.name, category: row.category, mass: item.mass, paths: [pathStr] });
    }
    return;
  }

  const mixture = db.prepare("SELECT id, name, version FROM mixtures WHERE id = ?").get(item.mixtureId!) as MixtureRow | undefined;
  if (!mixture) throw new ApiError("UNKNOWN_MIXTURE_VERSION", `混合物版本不存在: id=${item.mixtureId}，路径: ${stack.join(" -> ")}`);
  const mixLabel = `${mixture.name}@v${mixture.version}`;
  if (stackIds.includes(mixture.id)) {
    throw new ApiError("CIRCULAR_REFERENCE", `检测到循环引用: ${[...stack, mixLabel].join(" -> ")}`);
  }
  const items = loadMixtureItems(db, mixture.id);
  if (items.length === 0) {
    throw new ApiError("EMPTY_MIXTURE", `混合物 ${mixLabel} 没有组成项，路径: ${stack.join(" -> ")}`);
  }
  let total = Frac.zero();
  for (const it of items) total = total.add(Frac.parseDecimal(it.mass, "混合物组成项质量"));
  if (total.isZero()) {
    throw new ApiError("ZERO_TOTAL_MASS", `混合物 ${mixLabel} 组成项总质量为零`);
  }
  const nextStack = [...stack, mixLabel];
  const nextIds = [...stackIds, mixture.id];
  for (const it of items) {
    const itemMass = Frac.parseDecimal(it.mass, "混合物组成项质量");
    const scaled = item.mass.mul(itemMass).div(total); // 等比例拆分，精确分数
    if (it.item_type === "ingredient") {
      expandItem(db, { itemType: "ingredient", ingredientId: it.ingredient_id!, mass: scaled, label: it.ingredient_name! }, leaves, nextStack, nextIds, depth + 1);
    } else {
      expandItem(db, { itemType: "mixture", mixtureId: it.child_mixture_id!, mass: scaled, label: `${it.child_name}@v${it.child_version}` }, leaves, nextStack, nextIds, depth + 1);
    }
  }
}

export interface ExpansionResult {
  leaves: Leaf[];
  totalMass: Frac;
  flourMass: Frac;
  waterMass: Frac;
  otherMass: Frac;
}

export function summarize(leaves: Leaf[]): ExpansionResult {
  let total = Frac.zero(), flour = Frac.zero(), water = Frac.zero(), other = Frac.zero();
  for (const leaf of leaves) {
    total = total.add(leaf.mass);
    if (leaf.category === "flour") flour = flour.add(leaf.mass);
    else if (leaf.category === "water") water = water.add(leaf.mass);
    else other = other.add(leaf.mass);
  }
  return { leaves: [...leaves], totalMass: total, flourMass: flour, waterMass: water, otherMass: other };
}
