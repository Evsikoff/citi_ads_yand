import { getBoosterEffectSystemName } from "./boosterEffects.ts";

const cases = [
  { id: "7", system_name: "renamed_first_money_booster", expected: "money0.25" },
  { id: "8", system_name: "renamed_second_money_booster", expected: "money0.5" },
  { id: "6", system_name: "fuel10l", expected: "fuel10l" },
];

for (const booster of cases) {
  const actual = getBoosterEffectSystemName(booster);
  if (actual !== booster.expected) {
    throw new Error(`Бустер ${booster.id}: ожидалось ${booster.expected}, получено ${actual}`);
  }
}

console.log("Booster effect id checks passed");
