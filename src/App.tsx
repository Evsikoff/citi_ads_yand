import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { CLIENTS } from "./game/clients";
import { CityRideGame } from "./game/engine";
import type { HudData, LeaderboardEntry } from "./game/engine";
import { sfx } from "./game/audio";
import { music } from "./game/music";
import { CONFIG } from "./game/config";
import {
  BOOSTER_MENU_ITEMS,
  GAME_OVER_BOOSTERS,
  INACTIVE_STATION_BOOSTERS,
  calculateBoosterCost,
  executeExternalBoosterSale,
  formatBoosterName,
  getMaximumPurchases,
  isBoosterAvailable,
  isBoosterWithinSessionLimit,
} from "./game/boosters";
import type { Booster } from "./game/boosters";
import boostersIcon from "./images/boosters/boosters.png";
import { showFullscreenAd, showRewardedVideoAd } from "./game/yandexGames";
import {
  GAME_SERVER_URL,
  MultiplayerClient,
  serverMessage,
} from "./game/online";
import type { ConnectionStatus } from "./game/online";

const fmtMoney = (v: number) => Math.round(v).toLocaleString("ru-RU");
const floorTenth = (v: number) => Math.floor(v * 10) / 10;
const SELL_PERCENTAGES = [12.5, 25, 37.5, 50] as const;
const boosterIconModules = import.meta.glob("./images/boosters/*.png", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const getBoosterIcon = (filename: string) => {
  const path = `./${filename.replace(/\\/g, "/").replace(/^src\//, "")}`;
  return boosterIconModules[path] ?? boostersIcon;
};

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

/* ---------- мелкие SVG-иконки ---------- */
const BillBoardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
    <rect x="3" y="4" width="18" height="11" rx="1.5" stroke="currentColor" strokeWidth="2" />
    <path d="M12 15v5M8 20h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M7 8h6M7 11h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const SpeakerIcon = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
    {muted ? (
      <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    ) : (
      <path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    )}
  </svg>
);
const MusicIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
    <path
      d="M9 18V6l10-2v12"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="6.5" cy="18" r="2.5" stroke="currentColor" strokeWidth="2" />
    <circle cx="16.5" cy="16" r="2.5" stroke="currentColor" strokeWidth="2" />
    {off && (
      <path d="M4 4L20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    )}
  </svg>
);
const FuelIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className ?? "w-5 h-5"}>
    <path
      d="M5 21V6a2 2 0 012-2h5a2 2 0 012 2v15M4 21h11M14 10h2a2 2 0 012 2v5a1.5 1.5 0 003 0v-7.5L18.5 7M7 8h5v4H7z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const MoneyIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className ?? "w-5 h-5"}>
    <rect x="3" y="7" width="18" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
    <path d="M7 7v10M17 7v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const CanisterIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className ?? "w-5 h-5"}>
    <path
      d="M6 7.5A1.5 1.5 0 017.5 6h9A1.5 1.5 0 0118 7.5v11A1.5 1.5 0 0116.5 20h-9A1.5 1.5 0 016 18.5v-11zM9 6V4.5h6V6M8.5 9.5l7 7"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const TrophyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="w-10 h-10 text-amber-glow">
    <path
      d="M7 4h10v5a5 5 0 01-10 0V4zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3M12 14v3M8 20h8M9 17h6v3H9z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const MapIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className ?? "w-5 h-5"}>
    <path
      d="M3.5 5.5l5-2 7 2 5-2v15l-5 2-7-2-5 2v-15zM8.5 3.5v15M15.5 5.5v15"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="11" r="2.2" fill="currentColor" />
  </svg>
);

const GAUGE_TICKS = [0, 0.25, 0.5, 0.75, 1].map((f) => {
  const a = ((135 + 270 * f) * Math.PI) / 180;
  return { x: 60 + 52 * Math.cos(a), y: 60 + 52 * Math.sin(a) };
});

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<CityRideGame | null>(null);
  const networkRef = useRef<MultiplayerClient | null>(null);
  const networkStatusRef = useRef<ConnectionStatus>("connecting");
  const speedTextRef = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const arcRef = useRef<SVGPathElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const fuelFillRef = useRef<HTMLDivElement>(null);
  const fuelTextRef = useRef<HTMLSpanElement>(null);
  const fuelIconRef = useRef<HTMLSpanElement>(null);
  const refuelRef = useRef<HTMLSpanElement>(null);
  const lowRef = useRef<HTMLSpanElement>(null);
  const refuelPanelRef = useRef<HTMLDivElement>(null);
  const refuelLitersRef = useRef<HTMLSpanElement>(null);
  const canisterCountRef = useRef<HTMLSpanElement>(null);
  const canisterHudRef = useRef<HTMLSpanElement>(null);
  const canisterHudCountRef = useRef<HTMLSpanElement>(null);
  const moneyRef = useRef<HTMLSpanElement>(null);
  const refuelPriceRef = useRef<HTMLSpanElement>(null);
  const refuelLimitRef = useRef<HTMLSpanElement>(null);
  const toastTimer = useRef<number>(0);
  const fullscreenAdRequest = useRef(false);
  // Активация АЗС, отправленная на сервер: пока ответа нет, бустер не потрачен.
  const pendingStationBooster = useRef<{
    requestId: string;
    boosterId: string;
    timer: number;
  } | null>(null);
  const boostersMenuRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<"loading" | "menu" | "play">("loading");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [fullscreenAdActive, setFullscreenAdActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [musicOn, setMusicOn] = useState(music.isEnabled);
  const [win, setWin] = useState<{ time: number; top: number } | null>(null);
  const [gameover, setGameover] = useState<{ time: number; found: number } | null>(null);
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null);
  const [sell, setSell] = useState<{ fuel: number; price: number } | null>(null);
  const [sellLiters, setSellLiters] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [mapOpen, setMapOpen] = useState(false);
  const [boostersOpen, setBoostersOpen] = useState(false);
  const [boosterBalance, setBoosterBalance] = useState(CONFIG.startMoney);
  const [boosterPurchases, setBoosterPurchases] = useState<Record<string, number>>({});
  const [inactiveStationNearby, setInactiveStationNearby] = useState(false);
  // Машина заехала на площадку закрытой АЗС: только с такой дистанции сервер
  // принимает активацию, поэтому дальше кнопка бустера заблокирована.
  const [inactiveStationInReach, setInactiveStationInReach] = useState(false);
  const [touch] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
  );

  const showToast = (msg: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), msg });
    toastTimer.current = window.setTimeout(() => setToast(null), 2300);
  };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (document.fonts) {
      document.fonts.load('16px "Russo One"').catch(() => {});
      document.fonts.load("600 12px Rubik").catch(() => {});
    }
    const game = new CityRideGame(cv, minimapRef.current, CLIENTS, {
      onHud: (h: HudData) => {
        if (speedTextRef.current) speedTextRef.current.textContent = String(h.speed);
        if (timerRef.current) timerRef.current.textContent = fmt(h.time);
        const pct = Math.min(h.speed / Math.max(1, h.speedMax), 1);
        if (needleRef.current) needleRef.current.style.transform = `rotate(${pct * 270}deg)`;
        if (arcRef.current) arcRef.current.style.strokeDashoffset = String(100 - pct * 100);
        const f = h.fuel;
        const fm = h.fuelMax || 50;
        const fr = f / fm;
        if (fuelFillRef.current) {
          const fp = Math.max(0, Math.min(1, fr));
          fuelFillRef.current.style.width = `${fp * 100}%`;
          fuelFillRef.current.style.background = fr < 0.22 ? "#ff6b5a" : fr < 0.5 ? "#ffb454" : "#7ee08a";
        }
        if (fuelTextRef.current) fuelTextRef.current.textContent = `${Math.round(f)} л`;
        if (fuelIconRef.current) fuelIconRef.current.style.color = fr < 0.22 ? "#ff6b5a" : "#7ee08a";
        // индикатор переключаем через display: opacity перебивается анимацией anim-blink
        if (refuelRef.current) refuelRef.current.style.display = h.refueling ? "inline" : "none";
        if (refuelPanelRef.current) refuelPanelRef.current.style.display = h.refueling ? "flex" : "none";
        if (h.refueling) {
          if (refuelLitersRef.current) refuelLitersRef.current.textContent = `${Math.round(f)} / ${Math.round(fm)} л`;
          if (canisterCountRef.current) canisterCountRef.current.textContent = String(h.canisters);
        }
        if (moneyRef.current) moneyRef.current.textContent = fmtMoney(h.money);
        setBoosterBalance((current) =>
          Math.floor(current) === Math.floor(h.money) ? current : h.money
        );
        if (h.refueling) {
          if (refuelPriceRef.current) refuelPriceRef.current.textContent = `${h.refuelPrice} ₽/л · отдано ${fmtMoney(h.refuelSpent)} ₽`;
          if (refuelLimitRef.current) {
            refuelLimitRef.current.textContent =
              h.refuelLeft === null
                ? "без ограничения на отпуск"
                : `лимит колонки: ещё ${h.refuelLeft.toFixed(1)} л`;
          }
        }
        if (canisterHudCountRef.current) canisterHudCountRef.current.textContent = String(h.canisters);
        if (canisterHudRef.current) canisterHudRef.current.style.opacity = h.canisters ? "1" : "0.45";
        if (lowRef.current) lowRef.current.style.display = !h.refueling && fr < 0.22 && f > 0 ? "inline" : "none";
      },
      onLeaderboard: setLeaderboard,
      onBillboardAd: (_client, _index, complete) => {
        if (fullscreenAdRequest.current) {
          complete(true);
          return;
        }

        fullscreenAdRequest.current = true;
        gameRef.current?.setPaused(true);
        setFullscreenAdActive(true);
        const effectsWereMuted = sfx.muted;
        const musicWasEnabled = music.isEnabled;
        let finished = false;

        const finish = (message?: string) => {
          if (finished) return;
          finished = true;
          fullscreenAdRequest.current = false;
          setFullscreenAdActive(false);
          gameRef.current?.setPaused(false);
          sfx.setMuted(effectsWereMuted);
          if (musicWasEnabled) music.play();
          // Вне Яндекс Игр, при ошибке SDK и при ограничении частоты реклама
          // недоступна. В этих случаях билборд всё равно должен сработать.
          complete(true);
          if (message) showToast(message);
        };

        void showFullscreenAd({
          onOpen: () => {
            sfx.setMuted(true);
            music.stop();
            console.info("Полноэкранная реклама открыта");
          },
          onClose: (wasShown) => {
            console.info("Полноэкранная реклама закрыта, показана:", wasShown);
            finish(wasShown ? undefined : "Реклама недоступна — билборд засчитан без показа");
          },
          onError: (error) => {
            console.error("Ошибка показа полноэкранной рекламы:", error);
            finish("Реклама недоступна — билборд засчитан без показа");
          },
        });
      },
      onWin: (stats) => setWin(stats),
      onGameOver: (stats) => setGameover(stats),
      onBillboardUnavailable: () => showToast("Все АЗС уже работают — билборды пока недоступны"),
      onStationUnlock: (active, total, origin) =>
        showToast(
          origin === "ad"
            ? `Реклама сработала: открылась ещё одна АЗС — теперь ${active} из ${total}`
            : `Подвезли топливо: новая АЗС в сети — ${active} из ${total}`
        ),
      onStationLock: (active, total) =>
        showToast(`Колонка занята — АЗС закрылась. Активных станций: ${active} из ${total}`),
      onInactiveStationNearby: (nearby, inReach) => {
        setInactiveStationNearby(nearby);
        setInactiveStationInReach(inReach);
      },
      onCanister: (count, liters) =>
        showToast(`Канистра подобрана: бак вырос на ${liters} л (топливо не прибавилось). Канистр у тебя: ${count}`),
      onRefuelStop: (reason) =>
        showToast(
          reason === "limit"
            ? `Колонка отпускает не больше ${CONFIG.stationFuelLimit} л за раз — бак долить не дали`
            : "Деньги кончились — колонка перестала лить"
        ),
      onBase: (fuel, price) => {
        setSell({ fuel, price });
        setSellLiters(floorTenth(fuel / 2));
      },
      onCanisterLost: (count, left) =>
        showToast(
          count > 1
            ? `Тебя протаранили — из багажника вылетело ${count} канистры. Осталось: ${left}`
            : `Тебя протаранили — канистра вылетела на дорогу. Осталось: ${left}`
        ),
    });
    gameRef.current = game;
    return () => {
      game.destroy();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    const network = new MultiplayerClient(GAME_SERVER_URL, {
      onStatus: (status) => {
        const wasOnline = networkStatusRef.current === "online";
        networkStatusRef.current = status;
        if (active) setConnectionStatus(status);
        if (wasOnline && status === "offline") {
          gameRef.current?.setOnlineTransport(null);
          showToast("Связь с сервером потеряна — продолжаем локально");
        }
      },
      onHello: (hello) => {
        // частоты сервера нужны движку, чтобы рассчитать буфер интерполяции
        gameRef.current?.setOnlineTiming(hello);
      },
      onWelcome: (playerId, player) => {
        gameRef.current?.setOnlinePlayer(playerId, player);
      },
      onSnapshot: (map, entities, rows) => {
        gameRef.current?.applyWorldSnapshot(map, entities, rows);
      },
      onEntities: (entities) => {
        gameRef.current?.applyEntities(entities);
      },
      onCollisions: (collisions) => {
        for (const collision of collisions) gameRef.current?.applyCollision(collision);
      },
      onRefuel: (event) => {
        gameRef.current?.applyRefuelEvent(event);
      },
      onObjects: (objects) => {
        gameRef.current?.applyWorldObjects(objects);
      },
      onMapUpdate: (map, reason, fuelBonus) => {
        gameRef.current?.applyMapUpdate(map);
        if (reason === "player-count") {
          showToast(
            fuelBonus > 0
              ? `Город перестроен под новый онлайн. Бонус топлива: ${fuelBonus} л`
              : "Город перестроен под число игроков"
          );
        }
      },
      onLeaderboard: (rows) => {
        gameRef.current?.applyServerLeaderboard(rows);
      },
      onInteractionResult: (result) => {
        // Отказы по щитам движок разбирает сам (повтор, свой текст) — тогда
        // дублировать их сообщением сервера не нужно.
        const handled = gameRef.current?.applyInteractionResult(result);
        resolveStationBooster(result.requestId, result.ok);
        if (!result.ok && !handled) showToast(serverMessage(result.code, result.message));
      },
      onGameEventResult: (result) => {
        const handled = gameRef.current?.applyInteractionResult(result);
        if (result.event === "booster-applied") {
          if (!result.ok) {
            showToast(
              result.code === "not-enough-money"
                ? "Не хватило денег на улучшение"
                : "Для этого улучшения пока не настроен игровой эффект"
            );
            return;
          }
          setBoosterBalance(gameRef.current?.getMoney() ?? 0);
          if (result.details?.revived) setGameover(null);
          return;
        }
        if (!result.ok && !handled) showToast(serverMessage(result.code, result.message));
      },
      onPlayerRespawned: (player) => {
        gameRef.current?.applyRespawn(player);
        setGameover(null);
      },
      onPlayerJoined: (player) => showToast(`${player.name} подключился к заезду`),
      onPlayerLeft: () => showToast("Игрок покинул заезд"),
      onError: (error) => {
        // Сервер не принял наши координаты: пока он разбирается, машину ведёт
        // он. Игроку об этом сообщать нечего — это разговор клиента с сервером.
        if (error.code === "movement-too-fast" || error.code === "stale-sequence") {
          gameRef.current?.onServerMovementRejected();
          return;
        }
        // Отказ мог прийти и ошибкой — тогда бустер тоже остаётся неистраченным,
        // а запрос по щиту движок повторит сам.
        let handled = false;
        if (error.requestId) {
          resolveStationBooster(error.requestId, false);
          handled = !!gameRef.current?.applyRequestFailure(error.requestId, error.code);
        }
        if (!handled && networkStatusRef.current === "online") {
          showToast(serverMessage(error.code, error.message));
        }
      },
    });
    networkRef.current = network;

    const minimumLoaderTime = new Promise<void>((resolve) => {
      window.setTimeout(resolve, 1450);
    });
    Promise.all([network.connect(5000), minimumLoaderTime]).then(() => {
      if (active) setPhase("menu");
    });

    return () => {
      active = false;
      network.destroy();
      if (networkRef.current === network) networkRef.current = null;
    };
    // Подключаемся только один раз при загрузке приложения.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    gameRef.current?.setPaused(fullscreenAdActive || !!sell);
  }, [fullscreenAdActive, sell]);

  useEffect(() => {
    if (!boostersOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!boostersMenuRef.current?.contains(event.target as Node)) setBoostersOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [boostersOpen]);

  // Браузер открывает звук только после жеста игрока: на стартовом экране ловим
  // первое касание или клавишу и включаем музыку, не дожидаясь начала заезда.
  useEffect(() => {
    if (phase !== "menu" || !musicOn) return;

    const startMusic = (event: Event) => {
      // Жест по самой кнопке музыки (или клавиша B) — это её выключение:
      // качать трек незачем, переключатель отработает сам.
      if (event instanceof KeyboardEvent && event.code === "KeyB") return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-music-toggle]")) return;
      music.play();
      window.removeEventListener("pointerdown", startMusic);
      window.removeEventListener("keydown", startMusic);
    };
    window.addEventListener("pointerdown", startMusic);
    window.addEventListener("keydown", startMusic);
    return () => {
      window.removeEventListener("pointerdown", startMusic);
      window.removeEventListener("keydown", startMusic);
    };
  }, [phase, musicOn]);

  const start = () => {
    sfx.init();
    sfx.tick();
    music.play();
    const game = gameRef.current;
    const network = networkRef.current;
    const online = connectionStatus === "online" && !!network?.connected;
    game?.setOnlineTransport(online && network ? network : null);
    game?.begin();
    if (online && network && game) network.join(game.getPlayerName());
    setMapOpen(false);
    setBoostersOpen(false);
    setBoosterBalance(CONFIG.startMoney);
    setBoosterPurchases({});
    setInactiveStationNearby(false);
    setInactiveStationInReach(false);
    dropPendingStationBooster();
    setPhase("play");
  };

  const restart = () => {
    sfx.tick();
    const game = gameRef.current;
    if (!game?.requestOnlineRespawn()) game?.reset();
    setWin(null);
    setFullscreenAdActive(false);
    setGameover(null);
    setMapOpen(false);
    setBoostersOpen(false);
    setBoosterBalance(CONFIG.startMoney);
    setBoosterPurchases({});
    setInactiveStationNearby(false);
    setInactiveStationInReach(false);
    dropPendingStationBooster();
    showToast("Новая охота: билборды снова доступны, бак полный");
  };

  /**
   * Показывает rewarded-видео и передаёт бустер только после onRewarded.
   * Если реклама или SDK недоступны, сохраняем общий fallback: действие
   * считается выполненным без показа.
   */
  const showBoosterRewardedVideo = (booster: Booster, deliver: () => void): void => {
    if (fullscreenAdRequest.current) {
      showToast("Дождитесь завершения текущей рекламы");
      return;
    }

    fullscreenAdRequest.current = true;
    gameRef.current?.setPaused(true);
    setFullscreenAdActive(true);
    const effectsWereMuted = sfx.muted;
    const musicWasEnabled = music.isEnabled;
    let finished = false;
    let rewarded = false;

    const finish = (fallback: boolean, message?: string) => {
      if (finished) return;
      finished = true;
      fullscreenAdRequest.current = false;
      setFullscreenAdActive(false);
      gameRef.current?.setPaused(false);
      sfx.setMuted(effectsWereMuted);
      if (musicWasEnabled) music.play();
      if (fallback && !rewarded) deliver();
      if (message) showToast(message);
    };

    void showRewardedVideoAd({
      onOpen: () => {
        sfx.setMuted(true);
        music.stop();
        console.info("Видео-реклама за бустер открыта:", booster.system_name);
      },
      onRewarded: () => {
        if (rewarded) return;
        rewarded = true;
        deliver();
      },
      onClose: (wasShown) => {
        console.info("Видео-реклама за бустер закрыта, показана:", wasShown);
        if (rewarded) finish(false);
        else if (!wasShown) {
          finish(true, "Реклама недоступна — бустер выдан без показа");
        } else {
          finish(false, "Видео нужно досмотреть, чтобы получить бустер");
        }
      },
      onError: (error) => {
        console.error("Ошибка показа видео-рекламы за бустер:", error);
        finish(!rewarded, rewarded ? undefined : "Реклама недоступна — бустер выдан без показа");
      },
    });
  };

  const buyBooster = (booster: Booster, videoCompleted = false): void => {
    const game = gameRef.current;
    if (!game) return;
    const balance = game.getMoney();
    if (!isBoosterAvailable(booster, boosterPurchases, balance, CONFIG.startMoney)) return;

    if (booster.sales_method === "Video advertising" && !videoCompleted) {
      showBoosterRewardedVideo(booster, () => buyBooster(booster, true));
      return;
    }

    const cost =
      booster.sales_method === "In-game currency"
        ? calculateBoosterCost(booster, CONFIG.startMoney)
        : 0;
    const completed =
      booster.sales_method === "In-game currency"
        ? game.trySpendMoney(cost)
        : booster.sales_method === "Video advertising"
          ? videoCompleted
          : executeExternalBoosterSale(booster);

    if (!completed) {
      showToast("Не удалось получить улучшение — попробуй ещё раз");
      return;
    }

    const effect = game.applyBooster(booster.system_name, cost);
    if (!effect.applied) {
      showToast("Для этого улучшения пока не настроен игровой эффект");
      return;
    }

    if (effect.revived) setGameover(null);
    setBoosterBalance(game.getMoney());
    setBoosterPurchases((current) => ({
      ...current,
      [booster.id]: (current[booster.id] ?? 0) + 1,
    }));
    sfx.tick();
    showToast(
      effect.revived
        ? `${formatBoosterName(booster.name, CONFIG.startMoney)} — можно ехать дальше`
        : `${formatBoosterName(booster.name, CONFIG.startMoney)} — получено`
    );
  };

  const countBoosterPurchase = (boosterId: string) => {
    setBoosterPurchases((current) => ({
      ...current,
      [boosterId]: (current[boosterId] ?? 0) + 1,
    }));
  };

  /** Отменяет ожидание ответа сервера — бустер при этом остаётся неистраченным. */
  const dropPendingStationBooster = () => {
    const pending = pendingStationBooster.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingStationBooster.current = null;
  };

  /**
   * Ответ сервера на активацию АЗС. Бустер списываем только если заправка
   * действительно открылась: на отказ («Нужно подъехать ближе» и прочие) он
   * остаётся у игрока, и попытку можно повторить.
   */
  const resolveStationBooster = (requestId: string | undefined, ok: boolean) => {
    const pending = pendingStationBooster.current;
    if (!pending || !requestId || pending.requestId !== requestId) return;
    dropPendingStationBooster();
    if (ok) countBoosterPurchase(pending.boosterId);
  };

  const activateInactiveStationBooster = (booster: Booster, videoCompleted = false): void => {
    if (
      !inactiveStationNearby ||
      !isBoosterWithinSessionLimit(booster, boosterPurchases)
    ) {
      return;
    }
    // Один запрос за раз: иначе двойное нажатие спишет бустер дважды за одну АЗС.
    if (pendingStationBooster.current) return;
    if (!inactiveStationInReach) {
      showToast("Нужно подъехать ближе — заедь на площадку АЗС");
      return;
    }
    if (booster.sales_method === "Video advertising" && !videoCompleted) {
      showBoosterRewardedVideo(booster, () => activateInactiveStationBooster(booster, true));
      return;
    }
    if (
      booster.sales_method !== "Video advertising" &&
      !executeExternalBoosterSale(booster)
    ) {
      showToast("Не удалось выполнить действие — попробуй ещё раз");
      return;
    }

    const request = gameRef.current?.activateNearbyInactiveStation();
    if (!request || request.status === "unavailable") return;
    if (request.status === "too-far") {
      showToast("Нужно подъехать ближе — заедь на площадку АЗС");
      return;
    }
    if (request.status === "activated") {
      countBoosterPurchase(booster.id);
      return;
    }

    // Онлайн: решение за сервером. Бустер спишем только на успешный ответ, а
    // если ответа нет вовсе — просто перестанем его ждать.
    pendingStationBooster.current = {
      requestId: request.requestId,
      boosterId: booster.id,
      timer: window.setTimeout(() => {
        if (pendingStationBooster.current?.requestId === request.requestId) {
          pendingStationBooster.current = null;
          showToast("Сервер не ответил — улучшение осталось при тебе");
        }
      }, 8000),
    };
  };

  const toggleMute = () => {
    setMuted((m) => {
      sfx.setMuted(!m);
      return !m;
    });
  };

  const toggleMusic = () => {
    setMusicOn((on) => {
      music.setEnabled(!on);
      return !on;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter") {
        if (phase === "menu") {
          e.preventDefault();
          start();
        } else if (gameover) {
          e.preventDefault();
          restart();
        }
      }
      if (e.code === "KeyM" && phase === "play" && !fullscreenAdActive && !sell && !win && !gameover) {
        e.preventDefault();
        setMapOpen((open) => !open);
      }
      if (
        e.code === "KeyE" &&
        !e.repeat &&
        phase === "play" &&
        inactiveStationNearby &&
        INACTIVE_STATION_BOOSTERS.length === 1 &&
        !fullscreenAdActive &&
        !sell &&
        !win &&
        !gameover &&
        !mapOpen
      ) {
        e.preventDefault();
        activateInactiveStationBooster(INACTIVE_STATION_BOOSTERS[0]);
      }
      if (e.code === "KeyV" && !fullscreenAdActive) toggleMute();
      if (e.code === "KeyB" && !fullscreenAdActive) toggleMusic();
      if (e.code === "Escape") {
        if (boostersOpen) setBoostersOpen(false);
        else if (mapOpen) setMapOpen(false);
        else if (win) setWin(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase,
    fullscreenAdActive,
    sell,
    win,
    gameover,
    mapOpen,
    boostersOpen,
    inactiveStationNearby,
    inactiveStationInReach,
    boosterPurchases,
  ]);

  const hold = (k: "up" | "down" | "left" | "right") => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault();
      // Палец на ходу елозит по экрану и легко съезжает с кнопки. Забираем
      // указатель себе: пока не отпустили — газ не гаснет и руль не бросает.
      e.currentTarget.setPointerCapture(e.pointerId);
      gameRef.current?.setKey(k, true);
    },
    onPointerUp: () => gameRef.current?.setKey(k, false),
    onPointerCancel: () => gameRef.current?.setKey(k, false),
    onLostPointerCapture: () => gameRef.current?.setKey(k, false),
  });

  const playerLeaderboardIndex = leaderboard.findIndex((entry) => entry.isPlayer);
  const visibleLeaderboard: Array<LeaderboardEntry | null> =
    playerLeaderboardIndex < 0
      ? []
      : playerLeaderboardIndex < 7
        ? leaderboard.slice(0, 7)
        : [
            ...leaderboard.slice(0, 3),
            null,
            leaderboard[playerLeaderboardIndex - 1],
            leaderboard[playerLeaderboardIndex],
            ...(leaderboard[playerLeaderboardIndex + 1] ? [leaderboard[playerLeaderboardIndex + 1]] : []),
          ];
  const playerLeaderboardEntry = playerLeaderboardIndex >= 0 ? leaderboard[playerLeaderboardIndex] : null;
  const maxSellLiters = sell ? floorTenth(sell.fuel / 2) : 0;

  return (
    <div className="fixed inset-0 overflow-hidden bg-night-900 no-select text-slate-200">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* ================= загрузка и проверка сервера ================= */}
      {phase === "loading" && (
        <div className="absolute inset-0 z-[100] overflow-hidden bg-[radial-gradient(circle_at_50%_45%,rgba(255,180,84,0.08),transparent_34%),linear-gradient(135deg,rgba(5,8,16,0.92),rgba(7,11,20,0.78))] backdrop-blur-[5px]">
          <div className="loader-grid absolute inset-0 opacity-35" />
          <div className="absolute left-5 top-5 flex items-center gap-2.5 text-amber-glow md:left-8 md:top-8">
            <BillBoardIcon />
            <span className="font-display text-sm tracking-[0.16em] text-[#f2ecdf]">
              ГДЕ <span className="text-amber-glow">БЕНЗ?</span>
            </span>
          </div>

          <div className="relative flex h-full items-center justify-center p-5">
            <div className="w-full max-w-lg text-center">
              <div className="loader-radar relative mx-auto h-28 w-28 rounded-full border border-night-600 bg-night-950/80 shadow-[0_0_80px_rgba(255,180,84,0.12)]">
                <div className="loader-radar-sweep absolute inset-2 rounded-full" />
                <div className="absolute inset-[29px] flex items-center justify-center rounded-full border border-amber-glow/45 bg-night-900 text-amber-glow shadow-[0_0_24px_rgba(255,180,84,0.24)]">
                  <FuelIcon className="h-7 w-7" />
                </div>
                <span className="absolute left-[21px] top-[30px] h-1.5 w-1.5 rounded-full bg-aqua-glow shadow-[0_0_10px_#59d8c9]" />
                <span className="absolute bottom-[22px] right-[27px] h-1.5 w-1.5 rounded-full bg-amber-glow shadow-[0_0_10px_#ffb454]" />
              </div>

              <div className="mt-7 text-[10px] font-bold uppercase tracking-[0.34em] text-slate-500">
                подготовка ночного заезда
              </div>
              <h1 className="mt-3 font-display text-4xl leading-none text-[#f2ecdf] md:text-5xl">
                ИЩЕМ <span className="text-amber-glow">СВЯЗЬ</span>
              </h1>
              <div className="mx-auto mt-7 h-1.5 max-w-sm overflow-hidden rounded-full bg-night-700 shadow-inner">
                <div className="loader-progress h-full rounded-full bg-[linear-gradient(90deg,#ff8f4e,#ffcc72,#59d8c9)] shadow-[0_0_14px_rgba(255,180,84,0.65)]" />
              </div>
              <div className="mt-4 flex items-center justify-center gap-2 text-sm text-slate-400" role="status" aria-live="polite">
                <span
                  className={`h-2 w-2 rounded-full ${
                    connectionStatus === "online"
                      ? "bg-[#45e68a] shadow-[0_0_12px_#45e68a]"
                      : connectionStatus === "offline"
                        ? "bg-slate-500"
                        : "bg-amber-glow anim-pulse-soft"
                  }`}
                />
                {connectionStatus === "online"
                  ? "Канал открыт — включаем онлайн-режим"
                  : connectionStatus === "offline"
                    ? "Сервер недоступен — готовим локальный заезд"
                    : "Связываемся с городским сервером…"}
              </div>
              <div className="mt-3 font-mono text-[10px] tracking-wide text-slate-600">
                WSS · PROTOCOL 01 · SECURE CHANNEL
              </div>
            </div>
          </div>

          <div className="absolute inset-x-5 bottom-5 md:inset-x-8 md:bottom-8">
            <div className="stripes-amber h-2 rounded-sm opacity-60" />
          </div>
        </div>
      )}

      {/* canvas карты всегда смонтирован, чтобы игровой движок мог обновлять его */}
      <div
        className={`absolute inset-0 z-[60] items-center justify-center bg-[rgba(4,7,14,0.88)] p-4 backdrop-blur-sm ${
          mapOpen && phase === "play" ? "flex" : "hidden"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Карта города"
        onClick={() => setMapOpen(false)}
      >
        <div
          className="flex max-h-[calc(100vh-2rem)] max-w-[1100px] flex-col gap-4 overflow-auto rounded-xl border border-night-600 bg-night-900/95 p-4 shadow-[0_30px_90px_rgba(0,0,0,0.72)] lg:flex-row"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="shrink-0">
            <canvas
              ref={minimapRef}
              width={640}
              height={640}
              className="aspect-square w-[min(70vh,92vw)] max-w-[680px] rounded-lg border border-night-600 bg-[#0f1624] shadow-[inset_0_0_40px_rgba(0,0,0,0.5)]"
            />
          </div>
          <div className="flex w-full min-w-0 flex-col lg:w-[260px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[#7ee08a]">
                  <MapIcon className="h-5 w-5" />
                  <h2 className="font-display text-xl text-[#f2ecdf]">Карта города</h2>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  Игра продолжается. Положение игрока и конкурентов обновляется в реальном времени.
                </p>
              </div>
              <button
                onClick={() => setMapOpen(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-night-600 text-xl text-slate-400 transition-colors hover:border-slate-500 hover:text-white"
                aria-label="Закрыть карту"
              >
                ×
              </button>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 lg:grid-cols-1">
              <div className="flex items-start gap-2.5">
                <span className="mt-1 h-3 w-5 shrink-0 rounded-[2px] border border-[#baf5c2] bg-[#7ee08a]" />
                <span><strong className="font-semibold text-slate-200">Работающая АЗС</strong><small className="mt-0.5 block leading-snug text-slate-500">Заправляет бак и после использования закрывается.</small></span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="relative mt-1 h-3 w-5 shrink-0 rounded-[2px] bg-[#333b49]"><span className="anim-pulse-soft absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#d95d4d] shadow-[0_0_7px_rgba(217,93,77,0.9)]" /></span>
                <span><strong className="font-semibold text-slate-200">АЗС без топлива</strong><small className="mt-0.5 block leading-snug text-slate-500">Недоступна, пока её не откроет билборд или таймер.</small></span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="mx-1 mt-1 h-3 w-3 shrink-0 rounded-full bg-amber-glow" />
                <span><strong className="font-semibold text-slate-200">Доступный билборд</strong><small className="mt-0.5 block leading-snug text-slate-500">Открывает случайную неактивную АЗС.</small></span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="mx-1 mt-1 h-3 w-3 shrink-0 rounded-sm bg-slate-500" />
                <span><strong className="font-semibold text-slate-200">Недоступный билборд</strong><small className="mt-0.5 block leading-snug text-slate-500">Заблокирован на {CONFIG.billboardTimeout} с после активации или пока все АЗС работают.</small></span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="mx-1 mt-1 h-3 w-3 shrink-0 rotate-45 rounded-[2px] bg-[#58c9f3]" />
                <span><strong className="font-semibold text-slate-200">Канистра</strong><small className="mt-0.5 block leading-snug text-slate-500">Увеличивает объём бака на 10 л, но не добавляет топливо.</small></span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="relative mt-0.5 flex h-4 w-5 shrink-0 items-center justify-center rounded-[2px] border border-[#b98cff] bg-[#4b356b]"><span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#b98cff] text-[10px] font-bold text-night-950">₽</span></span>
                <span><strong className="font-semibold text-slate-200">База скупки</strong><small className="mt-0.5 block leading-snug text-slate-500">Покупает не более 50% текущего топлива игрока.</small></span>
              </div>
              <div className="flex items-start gap-2.5">
                <svg viewBox="0 0 18 16" className="mt-0.5 h-4 w-[18px] shrink-0" aria-hidden="true"><polygon points="16,8 3,14 3,2" fill="#e5472f" stroke="#fff4e8" strokeWidth="1.5" strokeLinejoin="round" /></svg>
                <span><strong className="font-semibold text-slate-200">Твоя машина</strong><small className="mt-0.5 block leading-snug text-slate-500">Показывает положение и направление движения.</small></span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="mt-1 flex w-[18px] shrink-0 items-center justify-center gap-0.5"><span className="h-2 w-2 rounded-full bg-[#8b5cf6]" /><span className="h-2 w-2 rounded-full bg-[#3fb7a8]" /></span>
                <span><strong className="font-semibold text-slate-200">Конкуренты</strong><small className="mt-0.5 block leading-snug text-slate-500">Заправляются, занимают АЗС и участвуют в рейтинге.</small></span>
              </div>
            </div>

            <div className="mt-auto pt-5 text-xs text-slate-500">
              <span className="kbd">M</span> или <span className="kbd">ESC</span> — закрыть карту
            </div>
          </div>
        </div>
      </div>

      {/* ================= HUD ================= */}
      {phase === "play" && (
        <>
          {/* левый верх: прокачка, время и касса */}
          <div className="absolute top-4 left-4 z-10 pointer-events-none flex flex-col items-start gap-2">
            <div ref={boostersMenuRef} className="pointer-events-auto relative">
              <button
                type="button"
                onClick={() => setBoostersOpen((open) => !open)}
                aria-expanded={boostersOpen}
                aria-controls="boosters-menu"
                className="group flex items-center gap-2.5 rounded-lg pr-2 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-glow/80"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-night-600 bg-night-900/85 shadow-[0_8px_24px_rgba(0,0,0,0.4)] transition-colors group-hover:border-amber-glow/60">
                  <img src={boostersIcon} alt="" className="h-full w-full object-cover" />
                </span>
                <span className="font-display text-xs tracking-[0.12em] text-[#f2ecdf] transition-colors group-hover:text-amber-glow">
                  ПРОКАЧКА
                </span>
                <span
                  aria-hidden="true"
                  className={`text-xs text-slate-500 transition-transform ${boostersOpen ? "rotate-180" : ""}`}
                >
                  ▾
                </span>
              </button>

              {boostersOpen && (
                <div
                  id="boosters-menu"
                  className="anim-pop absolute left-0 top-[calc(100%+8px)] w-[min(360px,calc(100vw-2rem))] max-h-[min(70vh,580px)] overflow-y-auto rounded-xl border border-night-600 bg-night-900/95 p-2 shadow-[0_24px_70px_rgba(0,0,0,0.72)] backdrop-blur-md"
                >
                  <div className="sticky top-0 z-10 mb-2 rounded-lg border border-night-700 bg-night-900/95 px-3 py-2 shadow-[0_6px_16px_rgba(0,0,0,0.28)] backdrop-blur-md">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-display text-[11px] tracking-[0.14em] text-[#f2ecdf]">
                        УЛУЧШЕНИЯ
                      </div>
                      <div
                        className="flex shrink-0 items-center gap-1.5 rounded-md border border-[#ffd27a]/25 bg-[#ffd27a]/10 px-2 py-1 text-[#ffd27a]"
                        aria-label={`Баланс: ${fmtMoney(boosterBalance)} ₽`}
                      >
                        <MoneyIcon className="h-3.5 w-3.5" />
                        <span className="font-display text-xs tabular-nums">
                          {fmtMoney(boosterBalance)} ₽
                        </span>
                      </div>
                    </div>
                    <div className="mt-1 text-[10px] leading-snug text-slate-500">
                      Покупки и зависимости действуют до конца текущего заезда.
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    {BOOSTER_MENU_ITEMS.map((booster) => {
                      const purchased = boosterPurchases[booster.id] ?? 0;
                      const maximum = getMaximumPurchases(booster);
                      const cost = calculateBoosterCost(booster, CONFIG.startMoney);
                      const available = isBoosterAvailable(
                        booster,
                        boosterPurchases,
                        boosterBalance,
                        CONFIG.startMoney
                      );
                      const parent = booster.parent_booster
                        ? BOOSTER_MENU_ITEMS.find((item) => item.id === booster.parent_booster)
                        : undefined;

                      let status: string;
                      if (purchased >= maximum) {
                        status = "Лимит исчерпан";
                      } else if (parent && (boosterPurchases[parent.id] ?? 0) < 1) {
                        status = `Сначала: ${formatBoosterName(parent.name, CONFIG.startMoney)}`;
                      } else if (booster.sales_method === "In-game currency") {
                        status = !Number.isFinite(cost)
                          ? "Цена не настроена"
                          : boosterBalance >= cost
                            ? `${fmtMoney(cost)} ₽`
                            : `Не хватает ${fmtMoney(cost - boosterBalance)} ₽`;
                      } else if (booster.sales_method === "In-app purchase") {
                        status = "Покупка в приложении · заглушка";
                      } else if (booster.sales_method === "Video advertising") {
                        status = "Просмотреть видео и получить";
                      } else {
                        status = `${booster.sales_method} · заглушка`;
                      }

                      return (
                        <button
                          key={booster.id}
                          type="button"
                          disabled={!available}
                          onClick={() => buyBooster(booster)}
                          className="group/item flex min-h-[66px] w-full items-center gap-3 rounded-lg border border-night-600 bg-night-800/95 p-2 text-left shadow-[0_7px_18px_rgba(0,0,0,0.28)] transition-all enabled:hover:-translate-y-0.5 enabled:hover:border-amber-glow/60 enabled:hover:bg-[#182238] enabled:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <img
                            src={getBoosterIcon(booster.icon_filename)}
                            alt=""
                            className="h-12 w-12 shrink-0 rounded-lg border border-night-600 object-cover shadow-inner disabled:grayscale"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 font-display text-sm leading-tight text-[#f2ecdf] group-enabled/item:group-hover/item:text-amber-glow">
                              <span>{formatBoosterName(booster.name, CONFIG.startMoney)}</span>
                              {booster.sales_method === "Video advertising" && (
                                <span role="img" aria-label="Видео-реклама" title="Видео-реклама">
                                  🎥
                                </span>
                              )}
                            </span>
                            <span className="mt-1 block text-[10px] leading-tight text-slate-500">
                              {status}
                            </span>
                          </span>
                          <span className="shrink-0 self-start rounded bg-night-950/70 px-1.5 py-1 text-[9px] tabular-nums text-slate-500">
                            {purchased}/{maximum}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 bg-night-900/85 border border-night-600 rounded-md px-3 py-1.5 text-xs text-slate-400">
              <svg viewBox="0 0 24 24" fill="none" className="w-3.5 h-3.5">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              в пути <span ref={timerRef} className="text-slate-200 font-semibold tabular-nums">0:00</span>
            </div>
            <div className="flex items-center gap-2 bg-night-900/85 border border-night-600 rounded-md px-3 py-1.5 text-xs text-slate-400">
              <span className="text-[#ffd27a]">
                <MoneyIcon className="w-3.5 h-3.5" />
              </span>
              касса
              <span ref={moneyRef} className="font-display text-sm text-[#ffd27a] tabular-nums">
                {fmtMoney(CONFIG.startMoney)}
              </span>
              ₽
            </div>
          </div>

          {/* правый верх: карта, музыка и звук */}
          <div className="absolute top-4 right-4 z-10 pointer-events-auto flex items-center gap-2">
              <button
                onClick={() => setMapOpen(true)}
                className="flex h-9 items-center gap-2 rounded-md border border-night-600 bg-night-900/85 px-2.5 text-slate-400 transition-colors hover:border-[#7ee08a]/50 hover:text-[#7ee08a]"
                aria-label="Открыть карту города"
                title="Карта города (M)"
              >
                <MapIcon className="h-4 w-4" />
                <span className="hidden text-[10px] font-bold uppercase tracking-[0.12em] sm:inline">Карта</span>
                <span className="kbd hidden lg:inline">M</span>
              </button>
              <button
                onClick={toggleMusic}
                data-music-toggle
                className="w-9 h-9 rounded-md bg-night-900/85 border border-night-600 flex items-center justify-center text-slate-400 hover:text-amber-glow hover:border-night-600 transition-colors"
                aria-label={musicOn ? "Выключить музыку" : "Включить музыку"}
                aria-pressed={musicOn}
                title="Музыка (B)"
              >
                <MusicIcon off={!musicOn} />
              </button>
              <button
                onClick={toggleMute}
                className="w-9 h-9 rounded-md bg-night-900/85 border border-night-600 flex items-center justify-center text-slate-400 hover:text-amber-glow hover:border-night-600 transition-colors"
                aria-label="Звук"
                title="Звук (V)"
              >
                <SpeakerIcon muted={muted} />
              </button>
          </div>

          {/* контекстные бустеры рядом с закрытой АЗС */}
          {inactiveStationNearby && INACTIVE_STATION_BOOSTERS.length > 0 && (
            <div className="pointer-events-auto absolute left-1/2 top-4 z-20 w-[min(380px,calc(100vw-2rem))] -translate-x-1/2">
              <div className="anim-pop rounded-xl border border-[#d0604e]/45 bg-night-900/95 p-2 shadow-[0_20px_55px_rgba(0,0,0,0.62)] backdrop-blur-md">
                <div className="flex items-center justify-between gap-3 px-2 pb-2 pt-1">
                  <div>
                    <div className="font-display text-[11px] tracking-[0.12em] text-[#ff8a72]">
                      НА АЗС НЕТ ТОПЛИВА
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-500">
                      {inactiveStationInReach
                        ? "Можно активировать эту заправку"
                        : "Заедь на площадку — оттуда её можно активировать"}
                    </div>
                  </div>
                  {INACTIVE_STATION_BOOSTERS.length === 1 &&
                    inactiveStationInReach &&
                    isBoosterWithinSessionLimit(
                      INACTIVE_STATION_BOOSTERS[0],
                      boosterPurchases
                    ) && <span className="kbd shrink-0">E</span>}
                </div>

                <div className="flex flex-col gap-2">
                  {INACTIVE_STATION_BOOSTERS.map((booster) => {
                    const purchased = boosterPurchases[booster.id] ?? 0;
                    const maximum = getMaximumPurchases(booster);
                    const withinLimit = isBoosterWithinSessionLimit(booster, boosterPurchases);
                    // Вне площадки сервер активацию не примет: держим кнопку
                    // выключенной, чтобы бустер не сгорал впустую.
                    const available = withinLimit && inactiveStationInReach;

                    return (
                      <button
                        key={booster.id}
                        type="button"
                        disabled={!available}
                        onClick={() => activateInactiveStationBooster(booster)}
                        className="group/station-booster flex min-h-[66px] w-full items-center gap-3 rounded-lg border border-night-600 bg-night-800/95 p-2 text-left shadow-[0_7px_18px_rgba(0,0,0,0.28)] transition-all enabled:hover:-translate-y-0.5 enabled:hover:border-[#ff8a72]/70 enabled:hover:bg-[#182238] enabled:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <img
                          src={getBoosterIcon(booster.icon_filename)}
                          alt=""
                          className="h-12 w-12 shrink-0 rounded-lg border border-night-600 object-cover shadow-inner"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 font-display text-sm leading-tight text-[#f2ecdf]">
                            <span>{formatBoosterName(booster.name, CONFIG.startMoney)}</span>
                            {booster.sales_method === "Video advertising" && (
                              <span role="img" aria-label="Видео-реклама" title="Видео-реклама">
                                🎥
                              </span>
                            )}
                          </span>
                          <span className="mt-1 block text-[10px] leading-tight text-slate-500">
                            {!withinLimit
                              ? "Лимит исчерпан"
                              : available
                                ? "Просмотреть рекламу"
                                : "Нужно подъехать ближе"}
                          </span>
                        </span>
                        <span className="shrink-0 self-start rounded bg-night-950/70 px-1.5 py-1 text-[9px] tabular-nums text-slate-500">
                          {purchased}/{maximum}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* центр сверху: панель заправки (управление на это время заблокировано) */}
          <div
            ref={refuelPanelRef}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none flex-col items-center gap-1.5 bg-night-900/92 border border-[#7ee08a]/45 rounded-xl px-5 py-3 shadow-[0_14px_40px_rgba(0,0,0,0.55)]"
            style={{ display: "none" }}
          >
            <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[#7ee08a] font-bold anim-blink">
              <FuelIcon className="w-4 h-4" />
              идёт заправка
            </span>
            <span ref={refuelLitersRef} className="font-display text-2xl text-[#d6f7dc] tabular-nums leading-none">
              0 / 50 л
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="text-[#58c9f3]">
                <CanisterIcon className="w-4 h-4" />
              </span>
              канистр у тебя:
              <span ref={canisterCountRef} className="font-display text-slate-200 tabular-nums">
                0
              </span>
            </span>
            <span ref={refuelPriceRef} className="text-[11px] text-[#ffd27a] tabular-nums">
              0 ₽/л
            </span>
            <span ref={refuelLimitRef} className="text-[10px] text-[#ff9f6b] tabular-nums" />
            <span className="text-[10px] text-slate-500">машина стоит — управление заблокировано</span>
          </div>

          {/* левый низ: топливо и спидометр */}
          <div className="absolute bottom-4 left-4 z-10 pointer-events-none">
            <div className="bg-night-900/85 border border-night-600 rounded-lg p-3 flex flex-col gap-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.4)]">
              {/* шкала топлива */}
              <div className="w-[228px] flex items-center gap-2.5 pb-2 border-b border-night-700">
                <span ref={fuelIconRef} className="shrink-0" style={{ color: "#7ee08a" }}>
                  <FuelIcon />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="text-[9px] uppercase tracking-[0.2em] text-slate-500 font-semibold">Топливо</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span
                        ref={canisterHudRef}
                        title="Канистр у тебя"
                        className="flex items-center gap-0.5 text-[#58c9f3]"
                        style={{ opacity: 0.45 }}
                      >
                        <CanisterIcon className="w-3 h-3" />
                        <span ref={canisterHudCountRef} className="font-display text-[10px] tabular-nums leading-none">
                          0
                        </span>
                      </span>
                      <span ref={fuelTextRef} className="font-display text-[11px] text-slate-300 tabular-nums leading-none">
                        50 л
                      </span>
                    </span>
                  </div>
                  <div className="h-2.5 mt-1 bg-night-950/80 border border-night-600 rounded-sm overflow-hidden">
                    <div ref={fuelFillRef} className="h-full rounded-[1px]" style={{ width: "100%", background: "#7ee08a" }} />
                  </div>
                </div>
                <span ref={refuelRef} className="font-display text-[10px] text-[#7ee08a] anim-blink shrink-0" style={{ display: "none" }}>
                  ЗАПРАВКА
                </span>
                <span ref={lowRef} className="font-display text-[10px] text-[#ff6b5a] anim-blink shrink-0" style={{ display: "none" }}>
                  НА АЗС!
                </span>
              </div>
              <div className="flex items-center gap-3">
              <svg viewBox="0 0 120 120" className="w-[116px] h-[116px]">
                <defs>
                  <linearGradient id="speedGrad" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0%" stopColor="#59d8c9" />
                    <stop offset="55%" stopColor="#ffb454" />
                    <stop offset="100%" stopColor="#ff6b4a" />
                  </linearGradient>
                </defs>
                <path
                  d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53"
                  fill="none"
                  stroke="#232b3c"
                  strokeWidth="9"
                  strokeLinecap="round"
                />
                <path
                  ref={arcRef}
                  d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53"
                  fill="none"
                  stroke="url(#speedGrad)"
                  strokeWidth="9"
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray="100"
                  strokeDashoffset="100"
                />
                {GAUGE_TICKS.map((t, i) => (
                  <circle key={i} cx={t.x} cy={t.y} r="2" fill="#3a4661" />
                ))}
                <g ref={needleRef} style={{ transformOrigin: "60px 60px" }}>
                  <line x1="60" y1="60" x2="31.7" y2="88.3" stroke="#f2ecdf" strokeWidth="3" strokeLinecap="round" />
                </g>
                <circle cx="60" cy="60" r="6" fill="#26314a" stroke="#59627a" strokeWidth="2" />
              </svg>
              <div className="pr-1">
                <div className="flex items-baseline gap-1.5">
                  <span ref={speedTextRef} className="font-display text-4xl text-[#f2ecdf] tabular-nums leading-none">
                    0
                  </span>
                  <span className="text-[11px] text-slate-500 font-semibold">км/ч</span>
                </div>
                <div className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                  ночная смена
                </div>
              </div>
              </div>
            </div>
          </div>

          {/* правый низ: рейтинг по залитым за сеанс литрам */}
          <div
            className={`absolute ${touch ? "bottom-[12rem]" : "bottom-4"} right-4 z-10 pointer-events-none flex flex-col items-end gap-2 max-w-[calc(100vw-2rem)]`}
          >
            <div className="w-[292px] overflow-hidden rounded-lg border border-night-600 bg-night-900/90 shadow-[0_12px_34px_rgba(0,0,0,0.46)]">
              <div className="flex items-center justify-between gap-3 border-b border-night-700 px-3 py-2.5">
                <div>
                  <div className="font-display text-xs tracking-wide text-[#f2ecdf]">Лидеры смены</div>
                  <div className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-slate-500">
                    залито бензина за сеанс
                  </div>
                </div>
                <div className="max-w-[126px] truncate rounded-full border border-[#e5472f]/40 bg-[#e5472f]/10 px-2 py-1 text-[10px] text-[#ffb7a8]">
                  {playerLeaderboardEntry?.name ?? "игрок"}
                </div>
              </div>
              <table className="w-full table-fixed text-[11px] tabular-nums">
                <colgroup>
                  <col className="w-9" />
                  <col />
                  <col className="w-[74px]" />
                </colgroup>
                <thead className="text-[9px] uppercase tracking-[0.14em] text-slate-600">
                  <tr>
                    <th className="px-2 pb-1 pt-2 text-center font-semibold">№</th>
                    <th className="px-1 pb-1 pt-2 text-left font-semibold">Игрок</th>
                    <th className="px-3 pb-1 pt-2 text-right font-semibold">Литры</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLeaderboard.map((entry, index) =>
                    entry === null ? (
                      <tr key={`gap-${index}`}>
                        <td colSpan={3} className="h-5 text-center text-slate-600">
                          ···
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={entry.name}
                        className={entry.isPlayer ? "bg-[#e5472f]/20 text-[#ffe0d8]" : "text-slate-300"}
                        style={entry.isPlayer ? { boxShadow: "inset 2px 0 #ff7158" } : undefined}
                      >
                        <td className={`px-2 py-1 text-center font-display ${entry.position <= 3 ? "text-[#ffd27a]" : "text-slate-500"}`}>
                          {entry.position}
                        </td>
                        <td className="truncate px-1 py-1 font-semibold">
                          <span
                            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                            style={{ backgroundColor: entry.color }}
                          />
                          {entry.name}
                        </td>
                        <td className="px-3 py-1 text-right font-display text-[#d6f7dc]">
                          {entry.liters.toFixed(1)} л
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* подсказка по управлению */}
          {!touch && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 pointer-events-none hidden md:flex items-center gap-2 text-xs text-slate-400 bg-night-900/70 border border-night-600/60 rounded-full px-4 py-2">
              <span className="kbd">W</span>
              <span className="kbd">A</span>
              <span className="kbd">S</span>
              <span className="kbd">D</span>
              движение
               <span className="text-slate-600 mx-1">·</span>
               <span className="kbd">SPACE</span> ручник
               <span className="text-slate-600 mx-1">·</span>
               <span className="kbd">M</span> карта
               <span className="text-slate-600 mx-1">·</span>
              врезайся в янтарные щиты
            </div>
          )}

          {/* сенсорные кнопки */}
          {touch && !fullscreenAdActive && (
            <div className="absolute bottom-24 inset-x-5 z-20 flex justify-between items-end">
              <div className="flex gap-3">
                <button {...hold("left")} className="w-16 h-16 rounded-full bg-night-800/85 border border-night-600 text-amber-glow flex items-center justify-center active:bg-night-600 touch-none">
                  <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7"><path d="M14.5 5.5L8 12l6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button {...hold("right")} className="w-16 h-16 rounded-full bg-night-800/85 border border-night-600 text-amber-glow flex items-center justify-center active:bg-night-600 touch-none">
                  <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7"><path d="M9.5 5.5L16 12l-6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
              <div className="flex gap-3">
                <button {...hold("down")} className="w-16 h-16 rounded-full bg-night-800/85 border border-night-600 text-[#ff8a70] flex items-center justify-center active:bg-night-600 touch-none">
                  <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7"><path d="M5.5 9.5L12 16l6.5-6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button {...hold("up")} className="w-20 h-20 rounded-full bg-amber-glow/90 border border-[#ffd9a0] text-night-950 flex items-center justify-center active:bg-amber-glow touch-none shadow-[0_6px_20px_rgba(255,180,84,0.4)]">
                  <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8"><path d="M5.5 14.5L12 8l6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* тост */}
      {toast && (
        <div
          key={toast.id}
          className="absolute top-16 left-1/2 -translate-x-1/2 z-50 anim-toast bg-night-800/95 border border-amber-glow/40 text-amber-glow text-sm font-medium rounded-md px-4 py-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        >
          {toast.msg}
        </div>
      )}

      {/* ================= стартовый экран ================= */}
      {phase === "menu" && (
        <div className="absolute inset-0 z-30">
          <div className="absolute inset-0 bg-[linear-gradient(100deg,rgba(7,10,20,0.94)_0%,rgba(7,10,20,0.72)_42%,rgba(7,10,20,0.28)_100%)]" />
          <div className="relative h-full overflow-y-auto">
            <div className="min-h-full flex flex-col justify-between gap-6 p-4 md:p-8">
            {/* верхняя планка */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 text-amber-glow">
                <BillBoardIcon />
                <span className="font-display tracking-[0.14em] text-sm text-[#f2ecdf]">
                  ГДЕ <span className="text-amber-glow">БЕНЗ?</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                {connectionStatus === "online" && (
                  <span
                    className="inline-flex items-center gap-2 rounded-full border border-[#45e68a]/35 bg-[#45e68a]/10 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[#8ff0b8] sm:px-3"
                    title="Подключено к игровому серверу"
                  >
                    <span className="h-2 w-2 rounded-full bg-[#45e68a] shadow-[0_0_12px_#45e68a]" />
                    <span className="hidden sm:inline">онлайн</span>
                  </span>
                )}
                <span className="hidden sm:inline text-[10px] uppercase tracking-[0.2em] text-slate-500 border border-night-600 rounded-full px-3 py-1.5">
                  медиа-агентство «Щит и Пика»
                </span>
                <button
                  onClick={toggleMusic}
                  data-music-toggle
                  className="w-10 h-10 rounded-md bg-night-900/85 border border-night-600 flex items-center justify-center text-slate-400 hover:text-amber-glow transition-colors"
                  aria-label={musicOn ? "Выключить музыку" : "Включить музыку"}
                  aria-pressed={musicOn}
                  title="Музыка (B)"
                >
                  <MusicIcon off={!musicOn} />
                </button>
                <button
                  onClick={toggleMute}
                  className="w-10 h-10 rounded-md bg-night-900/85 border border-night-600 flex items-center justify-center text-slate-400 hover:text-amber-glow transition-colors"
                  aria-label="Звук"
                  title="Звук (V)"
                >
                  <SpeakerIcon muted={muted} />
                </button>
              </div>
            </div>

            {/* нижний блок */}
            <div className="flex items-end justify-between gap-6 flex-wrap md:flex-nowrap">
              <div className="max-w-xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-glow/40 bg-amber-glow/10 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-glow">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-glow anim-pulse-soft" />
                  Вид сверху · Ночь · Заправки
                </div>
                <h1 className="font-display text-[44px] md:text-[64px] lg:text-[78px] leading-[0.95] mt-4 text-[#f2ecdf]">
                  ГДЕ
                  <br />
                  <span className="text-amber-glow">БЕНЗ?</span>
                </h1>
                <div className="mt-6 flex items-center gap-5 flex-wrap">
                  <button
                    onClick={start}
                    className="rounded-md bg-amber-glow text-night-950 font-display text-base tracking-wide px-7 py-3.5 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 shadow-[0_10px_34px_rgba(255,180,84,0.4)]"
                  >
                    Выехать на охоту
                  </button>
                  <span className="text-sm text-slate-500 anim-blink">
                    или нажми <span className="kbd">ENTER</span>
                  </span>
                </div>
              </div>

              {/* карточка управления */}
              <div className="w-full md:w-[300px] shrink-0 bg-night-900/85 border border-night-600 rounded-lg p-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500 font-bold">Управление</div>
                <div className="mt-3 flex flex-col gap-2.5 text-sm text-slate-300">
                  <div className="flex items-center gap-3">
                    <span className="flex gap-1"><span className="kbd">W</span><span className="kbd">↑</span></span> газ
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex gap-1"><span className="kbd">S</span><span className="kbd">↓</span></span> тормоз и задний ход
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex gap-1"><span className="kbd">A</span><span className="kbd">D</span></span> руль
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="kbd">SPACE</span> ручник — дрифт и следы
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="kbd">M</span> карта города
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="kbd">V</span> звук вкл/выкл
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="kbd">B</span> музыка вкл/выкл
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-night-700 flex items-start gap-2.5 text-xs text-slate-400 leading-relaxed">
                  <span className="mt-1 w-2 h-2 rounded-full bg-amber-glow shrink-0 anim-pulse-soft" />
                  Свободные щиты мигают в городе. Здания — прочные, газон — медленный.
                </div>
                <div className="mt-3 pt-3 border-t border-night-700 flex items-start gap-2.5 text-xs text-slate-400 leading-relaxed">
                  <span className="mt-0.5 text-[#f2a93b] shrink-0">
                    <FuelIcon className="w-4 h-4" />
                  </span>
                  <span>
                    Бак — {CONFIG.startTankVolume} л, литр на АЗС стоит {CONFIG.stationPriceMin}–
                    {CONFIG.stationPriceMax} ₽, у каждой колонки цена своя, иногда с лимитом отпуска.
                    Заправка бака занимает {CONFIG.stationTimeoutBase} с плюс{" "}
                    {CONFIG.stationTimeoutPerCanister} с за канистру; после этого откроется другая колонка.
                    База на отшибе скупает бензин по {CONFIG.fuelSellPrice} ₽ — на этом и живём.
                  </span>
                </div>
              </div>
            </div>

              <div className="stripes-amber h-2.5 rounded-sm opacity-70 shrink-0" />
            </div>
          </div>
        </div>
      )}

      {/* ================= победа ================= */}
      {win && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(5,8,16,0.6)] anim-fade" onClick={() => setWin(null)} />
          <div className="relative bg-night-800 border border-night-600 rounded-xl p-8 max-w-md w-full text-center anim-pop shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
            <div className="flex justify-center">
              <TrophyIcon />
            </div>
            <h2 className="font-display text-3xl md:text-4xl text-[#f2ecdf] mt-4 leading-tight">
              Все билборды <span className="text-amber-glow">проданы!</span>
            </h2>
            <p className="mt-3 text-slate-400 leading-relaxed">
              {CLIENTS.length} клиентов подписали контракты за одну смену. Отдел продаж аплодирует стоя, город сияет вашей рекламой.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-aqua-glow tabular-nums">{fmt(win.time)}</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">время смены</div>
              </div>
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-amber-glow tabular-nums">{win.top} км/ч</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">макс. скорость</div>
              </div>
            </div>
            <div className="mt-7 flex items-center justify-center gap-3 flex-wrap">
              <button
                onClick={restart}
                className="rounded-md bg-amber-glow text-night-950 font-display text-sm tracking-wide px-6 py-3.5 hover:brightness-110 hover:-translate-y-0.5 transition-all duration-200 shadow-[0_8px_24px_rgba(255,180,84,0.35)]"
              >
                Новый заезд
              </button>
              <button
                onClick={() => setWin(null)}
                className="rounded-md border border-night-600 text-slate-300 font-display text-sm tracking-wide px-6 py-3.5 hover:border-slate-500 hover:text-[#f2ecdf] transition-colors"
              >
                Кататься дальше
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= кончилось топливо ================= */}
      {gameover && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(5,8,16,0.74)] anim-fade" />
          <div className="relative max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-[#5a2c24] bg-night-800 p-8 text-center shadow-[0_30px_90px_rgba(0,0,0,0.65)] anim-pop">
            <div className="flex justify-center text-[#ff6b5a]">
              <FuelIcon className="w-10 h-10" />
            </div>
            <h2 className="font-display text-3xl md:text-4xl text-[#f2ecdf] mt-4 leading-tight">
              Бензин <span className="text-[#ff6b5a]">кончился!</span>
            </h2>
            <p className="mt-3 text-slate-400 leading-relaxed">
              Машина заглохла посреди города. В следующий раз закладывай маршрут до АЗС —
              зелёная стрелка у края экрана всегда показывает направление и метры до
              работающей колонки, голубая — до канистры.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-amber-glow tabular-nums">
                  {gameover.found}
                  <span className="text-sm text-slate-500">/{CLIENTS.length}</span>
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">клиентов подписано</div>
              </div>
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-aqua-glow tabular-nums">{fmt(gameover.time)}</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">время в пути</div>
              </div>
            </div>

            {GAME_OVER_BOOSTERS.length > 0 && (
              <div className="mt-6 text-left">
                <div className="mb-2 px-1 font-display text-[11px] tracking-[0.14em] text-[#f2ecdf]">
                  БУСТЕРЫ
                </div>
                <div className="flex flex-col gap-2">
                  {GAME_OVER_BOOSTERS.map((booster) => {
                    const purchased = boosterPurchases[booster.id] ?? 0;
                    const maximum = getMaximumPurchases(booster);
                    const cost = calculateBoosterCost(booster, CONFIG.startMoney);
                    const available = isBoosterAvailable(
                      booster,
                      boosterPurchases,
                      boosterBalance,
                      CONFIG.startMoney
                    );
                    const parent = booster.parent_booster
                      ? BOOSTER_MENU_ITEMS.find((item) => item.id === booster.parent_booster)
                      : undefined;

                    let status: string;
                    if (purchased >= maximum) {
                      status = "Лимит исчерпан";
                    } else if (parent && (boosterPurchases[parent.id] ?? 0) < 1) {
                      status = `Сначала: ${formatBoosterName(parent.name, CONFIG.startMoney)}`;
                    } else if (booster.sales_method === "In-game currency") {
                      status = !Number.isFinite(cost)
                        ? "Цена не настроена"
                        : boosterBalance >= cost
                          ? `${fmtMoney(cost)} ₽`
                          : `Не хватает ${fmtMoney(cost - boosterBalance)} ₽`;
                    } else if (booster.sales_method === "In-app purchase") {
                      status = "Покупка в приложении · заглушка";
                    } else if (booster.sales_method === "Video advertising") {
                      status = "Просмотреть видео и получить";
                    } else {
                      status = `${booster.sales_method} · заглушка`;
                    }

                    return (
                      <button
                        key={booster.id}
                        type="button"
                        disabled={!available}
                        onClick={() => buyBooster(booster)}
                        className="group/gameover-booster flex min-h-[66px] w-full items-center gap-3 rounded-lg border border-night-600 bg-night-900/80 p-2 text-left shadow-[0_7px_18px_rgba(0,0,0,0.28)] transition-all enabled:hover:-translate-y-0.5 enabled:hover:border-[#ff8a72]/70 enabled:hover:bg-[#182238] enabled:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <img
                          src={getBoosterIcon(booster.icon_filename)}
                          alt=""
                          className="h-12 w-12 shrink-0 rounded-lg border border-night-600 object-cover shadow-inner"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 font-display text-sm leading-tight text-[#f2ecdf]">
                            <span>{formatBoosterName(booster.name, CONFIG.startMoney)}</span>
                            {booster.sales_method === "Video advertising" && (
                              <span role="img" aria-label="Видео-реклама" title="Видео-реклама">
                                🎥
                              </span>
                            )}
                          </span>
                          <span className="mt-1 block text-[10px] leading-tight text-slate-500">
                            {status}
                          </span>
                        </span>
                        <span className="shrink-0 self-start rounded bg-night-950/70 px-1.5 py-1 text-[9px] tabular-nums text-slate-500">
                          {purchased}/{maximum}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <button
              onClick={restart}
              className="mt-7 w-full rounded-md bg-[#ff6b5a] text-night-950 font-display text-sm tracking-wide px-6 py-4 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 shadow-[0_8px_24px_rgba(255,107,90,0.35)]"
            >
              Начать заново
            </button>
            <div className="mt-3 text-xs text-slate-500">
              или нажми <span className="kbd">ENTER</span>
            </div>
          </div>
        </div>
      )}

      {/* ================= база: продажа бензина ================= */}
      {sell && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(5,8,16,0.66)] anim-fade" />
          <div className="relative w-full max-w-md bg-night-800 border border-[#b98cff]/40 rounded-xl p-6 anim-pop shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-[#b98cff] font-bold">
              <MoneyIcon className="w-4 h-4" />
              база · скупка топлива
            </div>
            <h2 className="font-display text-2xl mt-3 text-[#f2ecdf]">Сколько сливаем?</h2>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Принимают по {sell.price} ₽ за литр. В баке{" "}
              <span className="text-slate-200 tabular-nums">{sell.fuel.toFixed(1)} л</span>, но база заберёт
              не больше половины — максимум {maxSellLiters.toFixed(1)} л.
            </p>

            <div className="mt-5 flex items-baseline justify-between">
              <span className="font-display text-4xl text-[#f2ecdf] tabular-nums">
                {sellLiters.toFixed(1)}
                <span className="text-base text-slate-500 ml-1">л</span>
              </span>
              <span className="font-display text-2xl text-[#ffd27a] tabular-nums">
                +{fmtMoney(sellLiters * sell.price)} ₽
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={maxSellLiters}
              step={0.1}
              value={sellLiters}
              onChange={(e) => setSellLiters(Number(e.target.value))}
              className="mt-3 w-full accent-[#b98cff]"
            />
            <div className="mt-3 flex gap-2">
              {SELL_PERCENTAGES.map((percent) => (
                <button
                  key={percent}
                  onClick={() => setSellLiters(floorTenth(sell.fuel * (percent / 100)))}
                  className="flex-1 rounded-md border border-night-600 bg-night-900/70 py-2 text-xs text-slate-300 hover:border-[#b98cff]/60 hover:text-[#f2ecdf] transition-colors"
                >
                  {percent.toLocaleString("ru-RU")}%
                </button>
              ))}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  const paid = gameRef.current?.sellFuel(sellLiters) ?? 0;
                  if (paid > 0) showToast(`Слито ${sellLiters.toFixed(1)} л — касса пополнилась на ${fmtMoney(paid)} ₽`);
                  setSell(null);
                }}
                disabled={sellLiters <= 0}
                className="flex-1 rounded-md bg-[#b98cff] text-night-950 font-display py-3 hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100 transition-all"
              >
                Слить и получить деньги
              </button>
              <button
                onClick={() => setSell(null)}
                className="rounded-md border border-night-600 px-5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
              >
                Уехать
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
