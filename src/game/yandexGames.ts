export interface FullscreenAdCallbacks {
  onOpen?(): void;
  onClose?(wasShown: boolean): void;
  onError?(error: unknown): void;
}

interface YandexGamesSdk {
  adv: {
    showFullscreenAdv(options?: { callbacks?: FullscreenAdCallbacks }): void;
  };
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

/** Показывает межстраничную рекламу после готовности SDK. */
export async function showFullscreenAd(callbacks: FullscreenAdCallbacks): Promise<void> {
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
