import type { Booster } from "./boosters";

export interface PromoFlagItem {
  id?: string;
  created_at?: string;
  booster_sys_name: string;
  discount_factor?: string;
  start_date: string;
  end_date: string;
  promo_buster_sysname: string;
}

export interface ActiveBoosterPromotion {
  productId: string;
  discountPercent: number | null;
}

export type ActiveBoosterPromotions = Record<string, ActiveBoosterPromotion>;
export type ProductBoosterLookup = Record<string, string>;

export interface BoosterInventorySnapshot {
  version: 1;
  counts: Record<string, number>;
  processedPurchaseTokens: string[];
}

export const BOOSTER_INVENTORY_DATA_KEY = "iapBoosterInventoryV1";
const MAX_REMEMBERED_PURCHASE_TOKENS = 250;

export const EMPTY_BOOSTER_INVENTORY: BoosterInventorySnapshot = {
  version: 1,
  counts: {},
  processedPurchaseTokens: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDateOnly = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

function utcDayBoundary(value: string, endOfDay: boolean): number | null {
  if (!isDateOnly(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return endOfDay ? timestamp + 24 * 60 * 60 * 1000 - 1 : timestamp;
}

/** Безопасно разбирает строковое значение флага PROMO. */
export function parsePromoFlag(value: string | undefined): PromoFlagItem[] {
  if (!value?.trim()) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is PromoFlagItem => {
      if (!isRecord(item)) return false;
      return (
        typeof item.booster_sys_name === "string" &&
        item.booster_sys_name.trim().length > 0 &&
        typeof item.promo_buster_sysname === "string" &&
        item.promo_buster_sysname.trim().length > 0 &&
        typeof item.start_date === "string" &&
        typeof item.end_date === "string" &&
        utcDayBoundary(item.start_date, false) !== null &&
        utcDayBoundary(item.end_date, true) !== null
      );
    });
  } catch {
    return [];
  }
}

/** Даты промо считаются включительно и сравниваются как календарные дни UTC. */
export function isPromotionActive(item: PromoFlagItem, now: number): boolean {
  const startsAt = utcDayBoundary(item.start_date, false);
  const endsAt = utcDayBoundary(item.end_date, true);
  return startsAt !== null && endsAt !== null && startsAt <= now && now <= endsAt;
}

function parseDiscountPercent(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) return null;
  return Math.round(factor * 100);
}

/**
 * Возвращает активное промо для каждого бустера. Если конфигурации пересеклись,
 * выигрывает более поздняя запись (created_at, затем порядок в массиве).
 */
export function getActiveBoosterPromotions(
  items: PromoFlagItem[],
  now: number
): ActiveBoosterPromotions {
  const active: ActiveBoosterPromotions = {};
  const ordered = [...items].sort((left, right) => {
    const leftCreated = Date.parse(left.created_at ?? "") || 0;
    const rightCreated = Date.parse(right.created_at ?? "") || 0;
    return leftCreated - rightCreated;
  });

  for (const item of ordered) {
    if (!isPromotionActive(item, now)) continue;
    active[item.booster_sys_name] = {
      productId: item.promo_buster_sysname,
      discountPercent: parseDiscountPercent(item.discount_factor),
    };
  }
  return active;
}

/**
 * Для восстановления покупки учитываем и истёкшие промо-ID: покупка могла
 * застрять до окончания акции и всё равно должна найти исходный бустер.
 */
export function buildProductBoosterLookup(
  boosters: Booster[],
  promoItems: PromoFlagItem[]
): ProductBoosterLookup {
  const boosterIdBySystemName = new Map(
    boosters.map((booster) => [booster.system_name, booster.id])
  );
  const lookup: ProductBoosterLookup = {};

  for (const booster of boosters) lookup[booster.system_name] = booster.id;
  for (const item of promoItems) {
    const boosterId = boosterIdBySystemName.get(item.booster_sys_name);
    if (boosterId) lookup[item.promo_buster_sysname] = boosterId;
  }
  return lookup;
}

export function getBoosterProductId(
  booster: Booster,
  promotions: ActiveBoosterPromotions
): string {
  return promotions[booster.system_name]?.productId ?? booster.system_name;
}

export function normalizeBoosterInventory(value: unknown): BoosterInventorySnapshot {
  if (!isRecord(value)) return { ...EMPTY_BOOSTER_INVENTORY, counts: {} };

  const counts: Record<string, number> = {};
  if (isRecord(value.counts)) {
    for (const [boosterId, rawCount] of Object.entries(value.counts)) {
      const count = typeof rawCount === "number" ? Math.floor(rawCount) : 0;
      if (count > 0) counts[boosterId] = count;
    }
  }

  const processedPurchaseTokens = Array.isArray(value.processedPurchaseTokens)
    ? value.processedPurchaseTokens.filter(
        (token): token is string => typeof token === "string" && token.length > 0
      ).slice(-MAX_REMEMBERED_PURCHASE_TOKENS)
    : [];

  return { version: 1, counts, processedPurchaseTokens };
}

export function creditPurchaseToInventory(
  inventory: BoosterInventorySnapshot,
  boosterId: string,
  purchaseToken: string
): { inventory: BoosterInventorySnapshot; credited: boolean } {
  if (inventory.processedPurchaseTokens.includes(purchaseToken)) {
    return { inventory, credited: false };
  }

  return {
    credited: true,
    inventory: {
      version: 1,
      counts: {
        ...inventory.counts,
        [boosterId]: (inventory.counts[boosterId] ?? 0) + 1,
      },
      processedPurchaseTokens: [
        ...inventory.processedPurchaseTokens,
        purchaseToken,
      ].slice(-MAX_REMEMBERED_PURCHASE_TOKENS),
    },
  };
}

export function changeBoosterInventoryCount(
  inventory: BoosterInventorySnapshot,
  boosterId: string,
  delta: number
): BoosterInventorySnapshot | null {
  const nextCount = (inventory.counts[boosterId] ?? 0) + delta;
  if (!Number.isInteger(delta) || nextCount < 0) return null;

  const counts = { ...inventory.counts };
  if (nextCount === 0) delete counts[boosterId];
  else counts[boosterId] = nextCount;
  return { ...inventory, counts };
}
