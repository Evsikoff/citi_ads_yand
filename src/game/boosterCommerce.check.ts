import {
  buildProductBoosterLookup,
  changeBoosterInventoryCount,
  creditPurchaseToInventory,
  getActiveBoosterPromotions,
  getBoosterProductId,
  isPromotionActive,
  normalizeBoosterInventory,
  parsePromoFlag,
} from "./boosterCommerce.ts";
import type { Booster } from "./boosters.ts";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const boosters = [
  {
    id: "6",
    system_name: "fuel10l",
    name: "+ 10 л. бенза",
    display_method: "Booster menu",
    sales_method: "In-app purchase",
    maximum_number_of_purchases_per_session: "2",
    icon_filename: "fuel.png",
  },
] satisfies Booster[];

const items = parsePromoFlag(`[
  {
    "id":"old",
    "created_at":"2026-08-29T10:00:00Z",
    "booster_sys_name":"fuel10l",
    "discount_factor":"0.25",
    "start_date":"2026-08-30",
    "end_date":"2026-09-15",
    "promo_buster_sysname":"fuel10l_25"
  },
  {
    "id":"new",
    "created_at":"2026-08-30T10:00:00Z",
    "booster_sys_name":"fuel10l",
    "discount_factor":"0.5",
    "start_date":"2026-08-30",
    "end_date":"2026-09-15",
    "promo_buster_sysname":"fuel10l_50"
  }
]`);

assert(items.length === 2, "PROMO должен разбираться как массив конфигураций");
assert(
  isPromotionActive(items[0], Date.parse("2026-08-30T00:00:00.000Z")),
  "Дата начала промо должна входить в интервал"
);
assert(
  isPromotionActive(items[0], Date.parse("2026-09-15T23:59:59.999Z")),
  "Дата окончания промо должна входить в интервал целиком"
);
assert(
  !isPromotionActive(items[0], Date.parse("2026-09-16T00:00:00.000Z")),
  "После даты окончания промо должно выключаться"
);

const active = getActiveBoosterPromotions(items, Date.parse("2026-09-01T12:00:00.000Z"));
assert(active.fuel10l.productId === "fuel10l_50", "Должно побеждать более новое промо");
assert(active.fuel10l.discountPercent === 50, "discount_factor должен стать процентом скидки");
assert(
  getBoosterProductId(boosters[0], active) === "fuel10l_50",
  "Для цены и покупки должен использоваться промо-ID"
);

const lookup = buildProductBoosterLookup(boosters, items);
assert(lookup.fuel10l === "6", "Обычный ID товара должен находить бустер");
assert(lookup.fuel10l_25 === "6", "Истёкший промо-ID должен находиться при восстановлении");
assert(lookup.fuel10l_50 === "6", "Активный промо-ID должен находить бустер");

const empty = normalizeBoosterInventory(null);
const firstCredit = creditPurchaseToInventory(empty, "6", "token-1");
assert(firstCredit.credited, "Новая покупка должна начисляться");
assert(firstCredit.inventory.counts["6"] === 1, "Бустер должен появиться в инвентаре");
const duplicateCredit = creditPurchaseToInventory(firstCredit.inventory, "6", "token-1");
assert(!duplicateCredit.credited, "Один purchaseToken нельзя начислять дважды");
assert(duplicateCredit.inventory.counts["6"] === 1, "Повтор не должен менять остаток");
const spent = changeBoosterInventoryCount(duplicateCredit.inventory, "6", -1);
assert(spent !== null, "Доступный бустер должен списываться");
assert(spent.counts["6"] === undefined, "Активация должна списывать один бустер");
assert(
  changeBoosterInventoryCount(spent, "6", -1) === null,
  "Инвентарь не должен уходить в минус"
);

console.info("Промо, каталог и идемпотентный инвентарь бустеров: OK");
