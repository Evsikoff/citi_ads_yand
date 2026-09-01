import boosterData from "./boosters.json";

export type BoosterSalesMethod =
  | "In-game currency"
  | "In-app purchase"
  | "Video advertising"
  | string;

export interface Booster {
  id: string;
  system_name: string;
  name: string;
  display_method: string;
  sales_method: BoosterSalesMethod;
  game_currency_cost_coefficient?: string;
  parent_booster?: string;
  maximum_number_of_purchases_per_session: string;
  actual_price?: string;
  icon_filename: string;
}

export type BoosterPurchaseCounts = Record<string, number>;

const MENU_DISPLAY_METHODS = new Set([
  "Booster menu",
  "Game Over Screen and Booster menu",
]);

const BOOSTERS = boosterData as Booster[];

export const BOOSTER_MENU_ITEMS = BOOSTERS.filter((booster) =>
  MENU_DISPLAY_METHODS.has(booster.display_method)
);

export const INACTIVE_STATION_BOOSTERS = BOOSTERS.filter(
  (booster) => booster.display_method === "Next to an inactive gas station"
);

export const GAME_OVER_BOOSTERS = BOOSTERS.filter(
  (booster) => booster.display_method === "Game Over Screen and Booster menu"
);

/**
 * Вычисляет безопасное арифметическое выражение с числами, S, скобками и
 * операторами +, -, *, /. Никакой произвольный JavaScript здесь не исполняется.
 */
export function evaluateBoosterFormula(expression: string, startMoney: number): number {
  const compact = expression.replace(/\s+/g, "");
  const tokens = compact.match(/(?:\d+(?:\.\d+)?|\.\d+|S|[()+\-*/])/g) ?? [];
  if (!compact || tokens.join("") !== compact) {
    throw new Error(`Некорректная формула бустера: ${expression}`);
  }

  let position = 0;

  const peek = () => tokens[position];
  const take = () => tokens[position++];

  const parsePrimary = (): number => {
    const token = take();
    if (token === undefined) throw new Error("Неожиданный конец формулы бустера");
    if (token === "+") return parsePrimary();
    if (token === "-") return -parsePrimary();
    if (token === "S") return startMoney;
    if (token === "(") {
      const value = parseExpression();
      if (take() !== ")") throw new Error("В формуле бустера не закрыта скобка");
      return value;
    }

    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`Некорректное число в формуле: ${token}`);
    return value;
  };

  const parseTerm = (): number => {
    let value = parsePrimary();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      const right = parsePrimary();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };

  const result = parseExpression();
  if (position !== tokens.length || !Number.isFinite(result)) {
    throw new Error(`Некорректный результат формулы бустера: ${expression}`);
  }
  return result;
}

export function formatBoosterName(name: string, startMoney: number): string {
  return name.replace(/\[([^\]]+)]/g, (source, expression: string) => {
    try {
      return String(Math.floor(evaluateBoosterFormula(expression, startMoney)));
    } catch {
      return source;
    }
  });
}

export function calculateBoosterCost(booster: Booster, startMoney: number): number {
  if (booster.sales_method !== "In-game currency") return 0;
  const source = booster.game_currency_cost_coefficient?.trim();
  if (!source) return Number.POSITIVE_INFINITY;

  try {
    // В текущем JSON поле содержит коэффициент (например, 0.75). Также
    // поддерживаем полноценные выражения с S, если конфигурация их получит.
    const rawCost = source.includes("S")
      ? evaluateBoosterFormula(source, startMoney)
      : evaluateBoosterFormula(source, startMoney) * startMoney;
    return Math.max(0, Math.floor(rawCost));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function getMaximumPurchases(booster: Booster): number {
  const maximum = Number.parseInt(booster.maximum_number_of_purchases_per_session, 10);
  return Number.isFinite(maximum) ? Math.max(0, maximum) : 0;
}

export function isBoosterWithinSessionLimit(
  booster: Booster,
  purchases: BoosterPurchaseCounts
): boolean {
  return (purchases[booster.id] ?? 0) < getMaximumPurchases(booster);
}

export function isBoosterAvailable(
  booster: Booster,
  purchases: BoosterPurchaseCounts,
  balance: number,
  startMoney: number
): boolean {
  if (!isBoosterWithinSessionLimit(booster, purchases)) return false;
  if (booster.parent_booster && (purchases[booster.parent_booster] ?? 0) < 1) return false;
  if (booster.sales_method === "In-game currency") {
    return balance >= calculateBoosterCost(booster, startMoney);
  }
  return true;
}

/** Заглушки внешних интеграций, кроме подключённой видеорекламы. */
export function executeInAppPurchaseStub(_booster: Booster): boolean {
  return true;
}

export function executeOtherSaleMethodStub(_booster: Booster): boolean {
  return true;
}

export function executeExternalBoosterSale(booster: Booster): boolean {
  if (booster.sales_method === "In-app purchase") return executeInAppPurchaseStub(booster);
  // Видеореклама асинхронна и обрабатывается через showRewardedVideoAd перед
  // выдачей бустера. Не разрешаем случайно обойти её синхронной заглушкой.
  if (booster.sales_method === "Video advertising") return false;
  return executeOtherSaleMethodStub(booster);
}
