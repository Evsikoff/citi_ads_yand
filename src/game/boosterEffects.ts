export interface BoosterIdentity {
  id: string;
  system_name: string;
}

/**
 * Игровые эффекты денежных бустеров привязаны к стабильным id, а не к
 * редактируемым системным именам из boosters.json. Канонические имена нужны
 * движку и текущему серверному протоколу, которые извлекают коэффициент из
 * суффикса `money...`.
 */
const CANONICAL_EFFECT_NAME_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  "7": "money0.25",
  "8": "money0.5",
});

export function getBoosterEffectSystemName(booster: BoosterIdentity): string {
  return CANONICAL_EFFECT_NAME_BY_ID[booster.id] ?? booster.system_name;
}
