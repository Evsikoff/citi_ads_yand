export interface FullscreenAdCallbacks {
  onOpen?(): void;
  onClose?(wasShown: boolean): void;
  onError?(error: unknown): void;
}

export interface RewardedVideoAdCallbacks extends FullscreenAdCallbacks {
  onRewarded?(): void;
}

export interface YandexCatalogProduct {
  id: string;
  title: string;
  description: string;
  imageURI: string;
  price: string;
  priceValue: string;
  priceCurrencyCode: string;
  getPriceCurrencyImage(size?: "small" | "medium" | "svg"): string;
}

export interface YandexPurchase {
  productID: string;
  purchaseToken: string;
  developerPayload?: string;
}

interface YandexPayments {
  getCatalog(): Promise<YandexCatalogProduct[]>;
  getPurchases(): Promise<YandexPurchase[]>;
  purchase(data: { id: string; developerPayload?: string }): Promise<YandexPurchase>;
  consumePurchase(purchaseToken: string): Promise<void>;
}

interface YandexPlayer {
  getData(keys?: string[]): Promise<Record<string, unknown>>;
  setData(data: Record<string, unknown>, flush?: boolean): Promise<void>;
}

interface YandexGamesSdk {
  adv: {
    showFullscreenAdv(options?: { callbacks?: FullscreenAdCallbacks }): void;
    showRewardedVideo(options?: { callbacks?: RewardedVideoAdCallbacks }): void;
  };
  features?: {
    LoadingAPI?: {
      ready(): void;
    };
    GameplayAPI?: {
      start(): void;
      stop(): void;
    };
  };
  payments: YandexPayments;
  getPayments(options?: { signed?: boolean }): Promise<YandexPayments>;
  getFlags(options?: {
    defaultFlags?: Record<string, string>;
    clientFeatures?: Array<{ name: string; value: string }>;
  }): Promise<Record<string, string>> | Record<string, string>;
  getPlayer(options?: { signed?: boolean }): Promise<YandexPlayer>;
  serverTime?(): number;
}

interface YandexGamesGlobal {
  init(): Promise<YandexGamesSdk>;
}

declare global {
  interface Window {
    YaGames?: YandexGamesGlobal;
  }
}

let sdk: YandexGamesSdk | null = null;
let sdkInitialization: Promise<YandexGamesSdk | null> | null = null;
let playerInitialization: Promise<YandexPlayer> | null = null;
let gameReadySignaled = false;
let gameReadyNotification: Promise<void> | null = null;
let gameplayActive: boolean | null = null;
let gameplayTransition = 0;

/** Инициализирует SDK один раз при запуске приложения. */
export function initYandexGamesSdk(): Promise<YandexGamesSdk | null> {
  if (sdk) return Promise.resolve(sdk);
  if (sdkInitialization) return sdkInitialization;

  sdkInitialization = Promise.resolve()
    .then(() => {
      if (!window.YaGames) throw new Error("Скрипт SDK Яндекс Игр не загружен");
      return window.YaGames.init();
    })
    .then((initializedSdk) => {
      sdk = initializedSdk;
      console.info("Яндекс SDK готов к работе");
      return initializedSdk;
    })
    .catch((error: unknown) => {
      console.error("Ошибка инициализации SDK Яндекс Игр:", error);
      // Разрешаем повторную попытку, если скрипт загрузился с задержкой.
      sdkInitialization = null;
      return null;
    });

  return sdkInitialization;
}

/** Сообщает платформе, что загрузочный экран закрыт и главное меню доступно. */
export function signalYandexGameReady(): Promise<void> {
  if (gameReadySignaled) return Promise.resolve();
  if (gameReadyNotification) return gameReadyNotification;

  gameReadyNotification = (async () => {
    const initializedSdk = sdk ?? (await initYandexGamesSdk());
    const loadingApi = initializedSdk?.features?.LoadingAPI;
    if (!loadingApi || gameReadySignaled) return;

    try {
      loadingApi.ready();
      gameReadySignaled = true;
      console.info("Яндекс LoadingAPI: игра готова");
    } catch (error: unknown) {
      console.error("Не удалось отправить LoadingAPI.ready():", error);
    }
  })().finally(() => {
    gameReadyNotification = null;
  });

  return gameReadyNotification;
}

/**
 * Синхронизирует разметку GameplayAPI с фактической паузой игры.
 * Номер перехода не даёт запоздавшей инициализации SDK применить устаревшее
 * состояние, если игрок успел открыть и закрыть окно во время загрузки SDK.
 */
export async function setYandexGameplayActive(active: boolean): Promise<void> {
  const transition = ++gameplayTransition;
  const initializedSdk = sdk ?? (await initYandexGamesSdk());
  if (!initializedSdk || transition !== gameplayTransition || gameplayActive === active) return;

  const gameplayApi = initializedSdk.features?.GameplayAPI;
  if (!gameplayApi) return;

  try {
    if (active) gameplayApi.start();
    else gameplayApi.stop();
    gameplayActive = active;
    console.info(`Яндекс GameplayAPI: ${active ? "start" : "stop"}`);
  } catch (error: unknown) {
    console.error(`Не удалось отправить GameplayAPI.${active ? "start" : "stop"}():`, error);
  }
}

async function requireYandexGamesSdk(): Promise<YandexGamesSdk> {
  const initializedSdk = sdk ?? (await initYandexGamesSdk());
  if (!initializedSdk) throw new Error("SDK Яндекс Игр недоступен");
  return initializedSdk;
}

async function getYandexPlayer(): Promise<YandexPlayer> {
  if (playerInitialization) return playerInitialization;
  playerInitialization = requireYandexGamesSdk()
    .then((initializedSdk) => initializedSdk.getPlayer())
    .catch((error: unknown) => {
      playerInitialization = null;
      throw error;
    });
  return playerInitialization;
}

/** Читает строковые флаги Remote Config. */
export async function getYandexFlags(
  defaultFlags: Record<string, string> = {}
): Promise<Record<string, string>> {
  const initializedSdk = await requireYandexGamesSdk();
  return initializedSdk.getFlags({ defaultFlags });
}

/** Возвращает серверное время SDK, если оно доступно. */
export async function getYandexServerTime(): Promise<number> {
  const initializedSdk = await requireYandexGamesSdk();
  const value = initializedSdk.serverTime?.();
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

export async function getYandexCatalog(): Promise<YandexCatalogProduct[]> {
  const initializedSdk = await requireYandexGamesSdk();
  return initializedSdk.payments.getCatalog();
}

export async function getYandexPurchases(): Promise<YandexPurchase[]> {
  const initializedSdk = await requireYandexGamesSdk();
  return initializedSdk.payments.getPurchases();
}

export async function purchaseYandexProduct(productId: string): Promise<YandexPurchase> {
  const initializedSdk = await requireYandexGamesSdk();
  return initializedSdk.payments.purchase({ id: productId });
}

export async function consumeYandexPurchase(purchaseToken: string): Promise<void> {
  const initializedSdk = await requireYandexGamesSdk();
  await initializedSdk.payments.consumePurchase(purchaseToken);
}

export async function getYandexPlayerData(keys: string[]): Promise<Record<string, unknown>> {
  const player = await getYandexPlayer();
  return player.getData(keys);
}

/** Сохраняет инвентарь немедленно: только после этого покупку можно consume-ить. */
export async function setYandexPlayerData(data: Record<string, unknown>): Promise<void> {
  const player = await getYandexPlayer();
  await player.setData(data, true);
}

/** Показывает межстраничную рекламу после готовности SDK. */
export async function showFullscreenAd(callbacks: FullscreenAdCallbacks): Promise<void> {
  await setYandexGameplayActive(false);
  const initializedSdk = sdk ?? (await initYandexGamesSdk());
  if (!initializedSdk) {
    callbacks.onError?.(new Error("SDK Яндекс Игр недоступен"));
    return;
  }

  try {
    initializedSdk.adv.showFullscreenAdv({ callbacks });
  } catch (error: unknown) {
    callbacks.onError?.(error);
  }
}

/** Показывает видеорекламу с вознаграждением после готовности SDK. */
export async function showRewardedVideoAd(callbacks: RewardedVideoAdCallbacks): Promise<void> {
  await setYandexGameplayActive(false);
  const initializedSdk = sdk ?? (await initYandexGamesSdk());
  if (!initializedSdk) {
    callbacks.onError?.(new Error("SDK Яндекс Игр недоступен"));
    return;
  }

  try {
    initializedSdk.adv.showRewardedVideo({ callbacks });
  } catch (error: unknown) {
    callbacks.onError?.(error);
  }
}
