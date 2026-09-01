import { buildCity, WORLD, ROAD, SIDEWALK, BLOCK, GRID, CANISTER_R } from "./world";
import type { City, Rect, Billboard, Tree, Lamp, Station, Canister } from "./world";
import type { Client } from "./clients";
import { sfx } from "./audio";
import { createBot, createBots, stepBot } from "./bots";
import type { Bot } from "./bots";
import { ACC, BRAKE, CAR_R, KMH, MAX_SPEED, TURN_RATE, alignStep, grip, stepSteering } from "./car";
import { CONFIG } from "./config";
import { SnapshotTimeline, angleDelta, pushSample, sampleTimeline } from "./netclock";
import type { RemoteSample } from "./netclock";
import { PredictionSmoother } from "./reconcile";
import type {
  CollisionEvent,
  EntitySnapshot,
  RefuelEvent,
  InteractionResult,
  OnlineGameTransport,
  PublicPlayerState,
  RemoteEntityState,
  ServerHello,
  ServerCity,
  ServerLeaderboardEntry,
  WorldObjects,
} from "./online";

export interface HudData {
  speed: number;
  speedMax: number;
  found: number;
  total: number;
  time: number;
  top: number;
  fuel: number;
  fuelMax: number;
  refueling: boolean;
  stationsActive: number;
  stationsTotal: number;
  canisters: number;
  money: number;
  /** цена литра на колонке, под которой стоим, — только во время заправки */
  refuelPrice: number;
  /** сколько рублей уже отдали в текущей заправке */
  refuelSpent: number;
  /** остаток лимита колонки в литрах; null — колонка без ограничения */
  refuelLeft: number | null;
}

export interface LeaderboardEntry {
  position: number;
  name: string;
  liters: number;
  isPlayer: boolean;
  color: string;
}

export interface GameCallbacks {
  onHud(h: HudData): void;
  onLeaderboard(entries: LeaderboardEntry[]): void;
  onBillboardAd(client: Client, index: number, complete: (wasShown: boolean) => void): void;
  onWin(stats: { time: number; top: number }): void;
  onGameOver(stats: { time: number; found: number }): void;
  onBillboardUnavailable(): void;
  onStationUnlock(active: number, total: number, origin: "timer" | "ad"): void;
  onStationLock(active: number, total: number): void;
  /**
   * Рядом закрытая АЗС. `inReach` — машина уже на её площадке, то есть
   * достаточно близко, чтобы сервер принял активацию.
   */
  onInactiveStationNearby(nearby: boolean, inReach: boolean): void;
  onCanister(count: number, liters: number): void;
  onCanisterLost(count: number, left: number): void;
  /** заправка прервалась не из-за полного бака */
  onRefuelStop(reason: "limit" | "money"): void;
  /** машина заехала на базу нелегальной скупки — игроку предлагают продать бензин */
  onBase(fuel: number, price: number): void;
}

/**
 * Что вышло из попытки активировать закрытую АЗС бустером. `pending` — запрос
 * ушёл на сервер, и до его ответа бустер ещё не потрачен.
 */
export type StationActivation =
  | { status: "activated" }
  | { status: "pending"; requestId: string }
  | { status: "too-far" }
  | { status: "unavailable" };

type ParticleKind = "smoke" | "spark" | "confetti" | "leaf";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: ParticleKind;
  rot: number;
}

interface Skid {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  a: number;
}

/**
 * Что делать с положением из серверного состояния: перенести машину мгновенно
 * (честный телепорт), разобрать по правилам обычной езды или не трогать вовсе —
 * последнее для ответов на игровые действия, они приходят с устаревшими
 * координатами.
 */
type PositionMode = "snap" | "reconcile" | "stats";

/**
 * Чужая машина в онлайне: `bot` — то, что реально рисуется, `buffer` — история
 * серверных кадров, между которыми идёт интерполяция.
 */
interface RemoteEntity {
  bot: Bot;
  buffer: RemoteSample[];
}

const REV_MAX = 215;
const MM = 640;
// Онлайн: своя машина считается локально каждый кадр (клиентское предсказание),
// а серверное состояние вливается в картинку плавно — иначе машина дёргается на
// каждом пакете.
const RECONCILE_BOOST_S = 0.4; // сколько секунд держим ускоренную сходимость
const RECONCILE_MAX_LEAD = 0.3; // на сколько максимум продлеваем серверное состояние, с
// Положение своей машины ведёт клиент, он же сообщает его серверу. Сервер
// перебивает клиента только там, где он действительно главный, — и даже тогда
// не рывком, а через корректор.
const MOVE_SEND_RATE = 20; // как часто отправляем серверу своё положение, 1/с
const AUTHORITY_TOLERANCE = 260; // насколько сервер вправе расходиться с нами, px
const AUTHORITY_PATIENCE = 6; // столько снапшотов подряд терпим расхождение
const MOVE_REJECT_LIMIT = 5; // столько отказов — и руль возвращается серверу
const OVERRIDE_HOLD = 2; // сколько секунд после отказа слушаемся сервера, с
// Чужие машины рисуются не «последним пришедшим кадром», а интерполяцией между
// двумя уже полученными: отрисовка идёт с небольшим отставанием от сети.
const REMOTE_SNAP = 260; // прыжок больше — это телепорт (респавн, новая карта)
const REMOTE_BUFFER = 24; // сколько серверных кадров держим на каждую машину
const PLAYERS = 1 + CONFIG.botCount; // участников заезда: игрок и боты
const CANISTERS_ON_MAP = PLAYERS + 1; // канистр по карте: участников + 1
const CANISTER_L = CONFIG.canisterTankBonus;
const INACTIVE_STATION_PROXIMITY = 120; // расстояние от края площадки для показа контекстного бустера
// А вот активацию сервер принимает только у самой площадки: у него свой радиус,
// и на дальнем нажатии он отвечает «too-far», а бустер уже потрачен. Просим
// заехать на площадку — с этого места сервер сам начинает заправку на открытой
// АЗС, значит станцию рядом с собой он там точно видит. Допуск тот же, что и у
// заправки.
const INACTIVE_STATION_REACH = 6;
const REFUELING_HEARING_DISTANCE = 800; // дальше этого расстояния чужую АЗС не слышно
// Сервер проверяет дистанцию по последнему player:move, и на скорости он успевает
// отстать: щит под колёсами для него ещё далеко. Такой отказ не окончательный —
// досылаем позицию и пробуем снова, не сходя с места.
const BILLBOARD_RETRY_DELAY = 0.4; // пауза между повторами, с
const BILLBOARD_RETRY_LIMIT = 4; // столько попыток на одно касание
// T = базовый таймаут + надбавка за каждую канистру, оба значения из config.ts
const refuelDuration = (canisters: number): number =>
  Math.max(0, CONFIG.stationTimeoutBase + CONFIG.stationTimeoutPerCanister * Math.max(0, canisters));
const M_PER_PX = 0.35; // метров в мировом пикселе — для подписей с дистанцией

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const PLAYER_COLOR = "#e5472f"; // машина игрока — единственная красная

const PLAYER_ADJECTIVES = ["Ночной", "Красный", "Быстрый", "Дерзкий", "Точный", "Шустрый"];
const PLAYER_NOUNS = ["Курьер", "Пилот", "Лис", "Филин", "Раллист", "Навигатор"];

function makePlayerName(): string {
  const adjective = PLAYER_ADJECTIVES[Math.floor(Math.random() * PLAYER_ADJECTIVES.length)];
  const noun = PLAYER_NOUNS[Math.floor(Math.random() * PLAYER_NOUNS.length)];
  const number = 10 + Math.floor(Math.random() * 90);
  return `${adjective}_${noun}${number}`;
}

// точка старта: средняя вертикальная улица, чуть ниже центра города
const START = { x: ROAD / 2 + Math.floor(GRID / 2) * (BLOCK + ROAD), y: WORLD * 0.62 };

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(Math.round(((n >> 16) & 255) * f), 0, 255);
  const g = clamp(Math.round(((n >> 8) & 255) * f), 0, 255);
  const b = clamp(Math.round((n & 255) * f), 0, 255);
  return `rgb(${r},${g},${b})`;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const inView = (r: Rect, v: Rect, pad = 0) =>
  r.x + r.w >= v.x - pad && r.x <= v.x + v.w + pad && r.y + r.h >= v.y - pad && r.y <= v.y + v.h + pad;

// подпись расстояния: до километра — метры с округлением до десятков
function fmtDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1).replace(".", ",")} км`
    : `${Math.round(meters / 10) * 10} м`;
}

// иконки для указателей — те же контуры, что в интерфейсе, viewBox 24x24
const FUEL_ICON_PATH =
  "M5 21V6a2 2 0 012-2h5a2 2 0 012 2v15M4 21h11M14 10h2a2 2 0 012 2v5a1.5 1.5 0 003 0v-7.5L18.5 7M7 8h5v4H7z";
const CANISTER_ICON_PATH =
  "M6 7.5A1.5 1.5 0 017.5 6h9A1.5 1.5 0 0118 7.5v11A1.5 1.5 0 0116.5 20h-9A1.5 1.5 0 016 18.5v-11zM9 6V4.5h6V6M8.5 9.5l7 7";
const iconCache = new Map<string, Path2D | null>();
function icon2d(path: string): Path2D | null {
  if (!iconCache.has(path)) {
    iconCache.set(path, typeof Path2D === "function" ? new Path2D(path) : null);
  }
  return iconCache.get(path) ?? null;
}

const COLLIDE_R = 19; // радиус кузова для столкновений машин
const KICK = 1.25; // во столько раз скорость тарана превращается в отлёт
const RAM_MIN = 70; // ниже этой скорости сближения это не таран, а тычок в пробке
const KICK_MIN = 110; // слабый тычок всё равно должен быть заметен
const KICK_MAX = 620;
const STUN_S = 0.5; // сколько протараненный бот не слушается руля
const CANISTER_COOL = 1.3; // столько выпавшую канистру нельзя подобрать
const SPILL_R = 90; // радиус разлёта канистр от места удара

const CANISTER_POINTERS = 3;
const DEAD_POINTER_S = 1.5; // сколько указатель краснеет и моргает, прежде чем исчезнуть
const DEAD_ACCENT = "#ff5340"; // сколько ближайших канистр показывать указателями

// цвета указателей: АЗС — зелёные, канистры — голубые, база — фиолетовая
const STATION_ACCENT = "#7ee08a";
const CANISTER_ACCENT = "#58c9f3";
const BASE_ACCENT = "#b98cff";
// иконка базы у крайнего указателя — знак рубля
const BASE_ICON_PATH = "M8 4h5.5C16 4 18 5.7 18 8s-2 4-4.5 4H8M8 8h6M7 15h10M7 18h8M10 12v9";

export class CityRideGame {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private mini: HTMLCanvasElement | null;
  private mctx: CanvasRenderingContext2D | null = null;
  private mmBase: HTMLCanvasElement;
  private city: City;
  private cb: GameCallbacks;
  private total: number;

  private raf = 0;
  private last = 0;
  private destroyed = false;
  private phase: "menu" | "play" = "menu";
  private paused = false;

  private car = { x: 0, y: 0, angle: -Math.PI / 2, speed: 0, steer: 0 };
  private braking = false;
  private keys = new Set<string>();

  private cam = { x: WORLD / 2, y: WORLD / 2, zoom: 0.66, shake: 0 };
  private vw = 300;
  private vh = 300;
  private dpr = 1;

  private wall = 0; // всегда идущее время (пульсации, качание деревьев)
  private time = 0; // игровое время заезда
  private topSpeed = 0;
  private found = 0;
  private won = false;
  private displaySpeed = 0;

  private fuel = CONFIG.startFuel;
  private fuelMax = CONFIG.startTankVolume; // растёт с каждой подобранной канистрой
  private canisters = 0; // канистр у игрока
  private money = CONFIG.startMoney; // рублей на счету
  private speedMultiplier = 1;
  private fuelConsumptionMultiplier = 1;
  private sessionLiters = 0; // сколько литров налили на этой колонке
  private sessionSpent = 0; // и сколько рублей за них отдали
  private sessionTargetLiters = 0; // сколько всего можно налить за текущий визит
  private sessionDuration = 0; // длительность визита по формуле из config.ts
  private sessionElapsed = 0;
  private sessionStop: "full" | "limit" | "money" = "full";
  private totalLitersFilled = 0; // рейтинг: все литры, залитые игроком за текущий заезд
  private playerName = makePlayerName();
  private leaderboardCd = 0;
  private leaderboardDirty = true;
  private atBase = false; // стоим на площадке базы — второй раз не предлагаем
  private refueling = false;
  private stalled = false;
  private gameOverSent = false;
  private warnCd = 0;
  private stationsActive = 0;
  private refuelStation: Station | null = null; // где сейчас идёт заправка
  private usedStation: Station | null = null; // площадка, с которой ещё не съехали после заправки
  private nearbyInactiveStation: Station | null = null;
  private nearbyStationInReach = false;
  // очередь отложенных открытий: каждая занятая колонка через T секунд открывает другую
  private unlockQueue: Array<{ t: number; from: Station; notify: boolean }> = [];
  private bots: Bot[] = [];
  private knock = { x: 0, y: 0 }; // отлёт машины игрока после тарана
  private crashCd = 0; // придерживает эффекты от столкновений ботов между собой
  // указатели на цели, которые только что увели: краснеют, моргают и гаснут
  private deadPointers: Array<{ x: number; y: number; iconPath: string; t: number }> = [];

  private particles: Particle[] = [];
  private skids: Skid[] = [];
  private prevWheelL: { x: number; y: number } | null = null;
  private prevWheelR: { x: number; y: number } | null = null;

  private bumpCd = 0;
  private billboardContact: Billboard | null = null;
  private leafCd = 0;

  private online: OnlineGameTransport | null = null;
  private onlinePlayerId: string | null = null;
  private onlineInputCd = 0;
  private onlineMoveCd = 0;
  // Сколько снапшотов подряд сервер держится своего вопреки нашим координатам,
  // и сколько ещё секунд слушаемся его после отклонённого перемещения.
  private serverDisagreement = 0;
  private serverOverrideCd = 0;
  private moveRejects = 0;
  private moveDisabled = false;
  private onlineContacts = new Set<string>();
  // Запросы по щитам, отправленные серверу: requestId → id щита. Пока ответа
  // нет, повторно тот же щит не дёргаем.
  private billboardRequests = new Map<string, string>();
  // Пока полноэкранная реклама открывается или показывается, другие щиты не
  // запускают новый рекламный запрос.
  private billboardAdActive = false;
  private billboardAdToken = 0;
  // Щиты, по которым сервер ответил «too-far»: ждём паузу и пробуем снова, не
  // сходя с места. Значение — сколько секунд осталось ждать.
  private billboardRetry = new Map<string, number>();
  private billboardAttempts = new Map<string, number>();
  private onlinePlayerStatus = "active";
  // Расхождение предсказанной машины с состоянием сервера. Не применяется
  // рывком: корректор подбирает его с ограниченной и плавно меняющейся
  // скоростью, поэтому приход пакета не даёт толчка.
  private smoother = new PredictionSmoother();
  private reconcileBoost = 0; // секунды ускоренной сходимости после тарана
  // Чужие машины и боты: отрисовка отдельно от того, что прислал сервер.
  private remoteEntities = new Map<string, RemoteEntity>();
  // Общая временная шкала серверных кадров и запас отрисовки по ней.
  private timeline = new SnapshotTimeline();

  private onKeyDown: (e: KeyboardEvent) => void;
  private onKeyUp: (e: KeyboardEvent) => void;
  private onBlur: () => void;
  private onResize: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    minimap: HTMLCanvasElement | null,
    clients: Client[],
    cb: GameCallbacks
  ) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.mini = minimap;
    if (minimap) {
      minimap.width = minimap.height = MM;
      this.mctx = minimap.getContext("2d");
    }
    this.city = buildCity(clients, CANISTERS_ON_MAP, { x: START.x, y: START.y });
    this.total = new Set(this.city.billboards.map((b) => b.client.id)).size;
    this.cb = cb;
    this.placeCar();
    this.initStations();
    this.bots = createBots(this.city, CONFIG.botCount, START);
    this.emitLeaderboard();

    this.mmBase = document.createElement("canvas");
    this.mmBase.width = this.mmBase.height = MM;
    this.paintMinimapBase();

    this.onKeyDown = (e) => this.keyDown(e);
    this.onKeyUp = (e) => this.keyUp(e);
    this.onBlur = () => this.keys.clear();
    this.onResize = () => this.resize();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onResize);
    this.resize();

    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------------- public API ---------------- */

  begin(): void {
    if (this.phase === "play") return;
    this.phase = "play";
    this.time = 0;
    this.topSpeed = 0;
    this.won = false;
    this.resetFuel();
    this.gameOverSent = false;
    this.initStations();
    this.emitLeaderboard();
    sfx.engineStart();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) {
      // Зажатое до паузы отпускать некому: сенсорные кнопки вместе с окном
      // пропадают с экрана, и pointerup по ним уже не придёт. Без сброса машина
      // после закрытия окна срывалась с места сама.
      this.keys.clear();
      sfx.engineIdle();
      this.online?.sendInput({
        up: false,
        down: false,
        left: false,
        right: false,
        handbrake: true,
      });
    }
  }

  setKey(k: "up" | "down" | "left" | "right" | "hb", v: boolean): void {
    if (v) this.keys.add(k);
    else this.keys.delete(k);
  }

  getPlayerName(): string {
    return this.playerName;
  }

  isOnline(): boolean {
    return this.online !== null && this.online.connected;
  }

  setOnlineTransport(transport: OnlineGameTransport | null): void {
    this.online = transport;
    this.onlineInputCd = 0;
    this.onlineMoveCd = 0;
    this.serverDisagreement = 0;
    this.serverOverrideCd = 0;
    this.moveRejects = 0;
    this.moveDisabled = false;
    this.onlineContacts.clear();
    this.forgetBillboardRequests();
    this.remoteEntities.clear();
    this.reconcileBoost = 0;
    this.timeline.reset();
    this.smoother.reset();
    if (!transport) {
      this.onlinePlayerId = null;
      this.onlinePlayerStatus = "active";
    }
  }

  /** Частоты сервера из приветствия: по ним считается буфер интерполяции. */
  setOnlineTiming(hello: ServerHello): void {
    this.timeline.configure(hello.tickRate, hello.snapshotRate);
  }

  setOnlinePlayer(playerId: string, player: PublicPlayerState): void {
    this.onlinePlayerId = playerId;
    this.applyServerPlayer(player, "snap");
  }

  applyWorldSnapshot(
    map: ServerCity,
    entities: EntitySnapshot,
    leaderboard: ServerLeaderboardEntry[]
  ): void {
    this.replaceCity(map);
    this.applyEntities(entities);
    this.applyServerLeaderboard(leaderboard);
  }

  applyEntities(snapshot: EntitySnapshot): void {
    const t = this.trackSnapshotClock(snapshot);
    const me = this.onlinePlayerId
      ? snapshot.players.find((player) => player.id === this.onlinePlayerId)
      : undefined;
    if (me) this.applyServerPlayer(me);

    const others: RemoteEntityState[] = [
      ...snapshot.bots.filter((bot) => bot.status !== "lost"),
      ...snapshot.players.filter(
        (player) => player.id !== this.onlinePlayerId && player.status === "active"
      ),
    ];
    this.syncRemoteEntities(others, t);
  }

  /** монотонные локальные часы в секундах — не зависят от системного времени */
  private netNow(): number {
    return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
  }

  /**
   * Ставит снапшот на общую временную шкалу. Сдвинулась оценка задержки — вместе
   * с ней едет и вся шкала: переносим на неё уже накопленные кадры, иначе новые
   * оказались бы «раньше» старых и буфер перестал бы принимать данные.
   */
  private trackSnapshotClock(snapshot: EntitySnapshot): number {
    const stamp = this.timeline.stamp(snapshot.tick, this.netNow());
    if (stamp.restarted) {
      for (const entity of this.remoteEntities.values()) entity.buffer.length = 0;
    } else if (stamp.shift !== 0) {
      for (const entity of this.remoteEntities.values()) {
        for (const sample of entity.buffer) sample.t += stamp.shift;
      }
    }
    return stamp.t;
  }

  /**
   * Серверный кадр не двигает чужие машины сразу: он ложится в буфер на
   * временную шкалу, а рисуем мы всегда чуть в прошлом — между двумя уже
   * полученными кадрами (updateRemoteEntities). Так пакет с любой задержкой
   * попадает ровно в своё место, и машина едет непрерывно вместо того, чтобы
   * прыгать на каждом снапшоте.
   */
  private syncRemoteEntities(entities: RemoteEntityState[], t: number): void {
    const next = new Map<string, RemoteEntity>();
    for (const entity of entities) {
      const known = this.remoteEntities.get(entity.id);
      const remote: RemoteEntity = known ?? { bot: this.toRenderBot(entity), buffer: [] };
      if (known) this.refreshRenderBot(known.bot, entity);

      const sample: RemoteSample = {
        t,
        x: entity.x,
        y: entity.y,
        angle: entity.angle,
        speed: entity.speed,
      };
      if (pushSample(remote.buffer, sample, REMOTE_SNAP, REMOTE_BUFFER)) {
        // респавн или новая карта: между «было» и «стало» интерполировать нечего
        remote.bot.x = entity.x;
        remote.bot.y = entity.y;
        remote.bot.angle = entity.angle;
        remote.bot.speed = entity.speed;
      }
      next.set(entity.id, remote);
    }
    this.remoteEntities = next;
    this.bots = [...next.values()].map((entity) => entity.bot);
  }

  /** обновляет всё, кроме положения: его ведёт интерполяция по буферу */
  private refreshRenderBot(bot: Bot, entity: RemoteEntityState): void {
    const fresh = this.toRenderBot(entity);
    fresh.x = bot.x;
    fresh.y = bot.y;
    fresh.angle = bot.angle;
    fresh.speed = bot.speed;
    Object.assign(bot, fresh);
  }

  /**
   * Каждый кадр ставим чужие машины туда, где они были по часам отрисовки —
   * те идут с небольшим отставанием от сети. Положение считается линейно между
   * двумя серверными кадрами, угол — по кратчайшей дуге. Данные для этого уже
   * пришли, поэтому движение выходит непрерывным при любом джиттере.
   */
  private updateRemoteEntities(dt: number): void {
    const render = this.timeline.advance(dt, this.netNow());
    for (const entity of this.remoteEntities.values()) {
      const at = sampleTimeline(entity.buffer, render);
      if (!at) continue;
      entity.bot.x = at.x;
      entity.bot.y = at.y;
      entity.bot.angle = at.angle;
      entity.bot.speed = at.speed;
    }
  }

  /**
   * Столкновение, посчитанное сервером. Сама физика (отскок, стан, выпавшие
   * канистры) приезжает следом снапшотом — здесь только то, что снапшот
   * передать не может: искры, тряска камеры, звук удара и сообщение игроку.
   */
  applyCollision(event: CollisionEvent): void {
    const mine =
      !!this.onlinePlayerId &&
      ((event.rammerIsPlayer && event.rammerId === this.onlinePlayerId) ||
        (event.victimIsPlayer && event.victimId === this.onlinePlayerId));

    // Чужие машины телепортировать не нужно: принудительный снимок после удара
    // приедет обычным кадром и ляжет на ту же временную шкалу, что остальные,
    // так что отскок отрисуется сам — непрерывно. Своей машине лишь ненадолго
    // ускоряем сходимость с сервером: удар меняет её резче, чем обычная езда.
    if (mine) this.reconcileBoost = RECONCILE_BOOST_S;

    this.crashEffects(event.x, event.y, event.force, mine);
    if (!mine) return;

    const victimIsMe = event.victimIsPlayer && event.victimId === this.onlinePlayerId;
    // моя машина участвовала — тряхнём камеру так же, как в офлайне
    const impulse = victimIsMe ? event.force : event.force * 0.16;
    this.cam.shake = Math.min(18, this.cam.shake + impulse / 42);

    if (victimIsMe && event.spilled > 0) {
      // сервер уже уменьшил счётчик; сюда приходит только сообщение игроку
      for (let i = 0; i < event.spilled * 8; i++) {
        this.spawn(event.x, event.y, "spark", i % 2 ? CANISTER_ACCENT : "#d8f2ff", 0.5, 110);
      }
      this.cb.onCanisterLost(event.spilled, Math.max(0, this.canisters - event.spilled));
    }
  }

  /**
   * Заправка в онлайне идёт на сервере, поэтому конфетти на полном баке и
   * сообщение о прерванной заправке приезжают событием.
   */
  applyRefuelEvent(event: RefuelEvent): void {
    if (!this.onlinePlayerId || event.playerId !== this.onlinePlayerId) return;

    if (event.state === "started") {
      this.cam.shake = Math.min(12, this.cam.shake + 6);
      for (let i = 0; i < 8; i++) {
        this.spawn(this.car.x, this.car.y, "smoke", "rgba(150,160,178,0.35)", 0.7, 40);
      }
      const station = this.city.stations.find((value) => value.id === event.stationId);
      if (station) {
        this.stationsActive = Math.max(0, this.stationsActive - 1);
        this.cb.onStationLock(this.stationsActive, this.city.stations.length);
      }
      return;
    }

    if (event.reason === "full") {
      sfx.tankFull();
      for (let i = 0; i < 22; i++) {
        this.spawn(this.car.x, this.car.y - 10, "confetti", i % 2 ? "#7ee08a" : "#ffe08a", 0.9, 300);
      }
    } else if (event.reason === "limit" || event.reason === "money") {
      this.cb.onRefuelStop(event.reason);
    }
  }

  /** Пока идёт серверная заправка, отыгрываем её визуально так же, как офлайн. */
  private updateOnlineRefuelEffects(dt: number): void {
    if (!this.refueling) return;
    if (Math.random() < dt * 24) {
      this.spawn(
        this.car.x + (Math.random() - 0.5) * 26,
        this.car.y + (Math.random() - 0.5) * 26,
        "spark",
        "#7ee08a",
        0.6,
        70
      );
    }
  }

  applyWorldObjects(objects: WorldObjects): void {
    this.city.stations = objects.stations;
    this.city.billboards = objects.billboards;
    this.city.canisters = objects.canisters;
    this.afterObjectsChanged();
  }

  applyMapUpdate(map: ServerCity): void {
    this.replaceCity(map);
  }

  applyServerLeaderboard(rows: ServerLeaderboardEntry[]): void {
    this.cb.onLeaderboard(
      rows.map(({ entityId, position, name, liters, color }) => ({
        position,
        name,
        liters,
        isPlayer: entityId === this.onlinePlayerId,
        color,
      }))
    );
  }

  /**
   * Ответ сервера на игровое действие. Возвращает true, если движок сам всё
   * объяснил игроку и показывать сообщение об ошибке не нужно.
   */
  applyInteractionResult(result: InteractionResult): boolean {
    if (result.player) this.applyServerPlayer(result.player, "stats");
    if (this.billboardRequests.has(result.requestId)) {
      return this.applyBillboardResult(result.requestId, result.ok, result.code);
    }
    if (!result.ok || !result.details) return false;
    // бустер «Активировать эту АЗС»: сервер открыл именно ту колонку, у которой стоим
    if (result.details.activated === true) {
      const active = Number(result.details.stationsActive);
      const total = Number(result.details.stationsTotal) || this.city.stations.length;
      const station = this.city.stations.find((value) => value.id === result.details?.stationId);
      if (station) {
        station.state = "active";
        station.origin = "ad";
        if (typeof result.details.price === "number") station.price = result.details.price;
        station.limit =
          typeof result.details.limit === "number" ? result.details.limit : null;
        const cx = station.x + station.w / 2;
        const cy = station.y + station.h / 2;
        for (let i = 0; i < 18; i++) {
          this.spawn(cx, cy, "spark", i % 2 ? "#ffd27a" : "#7ee08a", 0.8, 260);
        }
      }
      this.stationsActive = Number.isFinite(active) ? active : this.stationsActive + 1;
      this.setNearbyInactiveStation(null);
      sfx.unlock();
      this.cb.onStationUnlock(this.stationsActive, total, "ad");
      this.updateNearbyInactiveStation();
      this.emitHud();
    }
    return false;
  }

  /**
   * Ответ по рекламному щиту. Эффекты и таймаут показываем только на
   * подтверждение сервера: раньше клиент рисовал их сразу после отправки, и
   * отказ выглядел как сработавшее взаимодействие, после которого ничего не
   * происходит. Отказ «too-far» не окончательный — сервер мерил по устаревшей
   * позиции, поэтому пробуем ещё раз, не сходя со щита.
   */
  private applyBillboardResult(requestId: string, ok: boolean, code: string): boolean {
    const id = this.billboardRequests.get(requestId);
    this.billboardRequests.delete(requestId);
    if (!id) return false;

    const billboard = this.city.billboards.find((value) => value.id === id);
    if (!ok) {
      const attempts = this.billboardAttempts.get(id) ?? 0;
      if (code === "too-far" && attempts < BILLBOARD_RETRY_LIMIT) {
        this.billboardRetry.set(id, BILLBOARD_RETRY_DELAY);
        return true;
      }
      this.billboardAttempts.delete(id);
      this.billboardRetry.delete(id);
      if (code === "all-stations-active") {
        this.cb.onBillboardUnavailable();
        return true;
      }
      return false;
    }

    this.billboardAttempts.delete(id);
    this.billboardRetry.delete(id);
    if (!billboard) return false;

    // Своё состояние щита ставим сразу, не дожидаясь world:objects: иначе тот
    // же щит успеет уйти на сервер повторным запросом.
    billboard.discovered = true;
    billboard.state = "done";
    billboard.cooldown = CONFIG.billboardTimeout;
    const cx = billboard.x + billboard.w / 2;
    const cy = billboard.y + billboard.h / 2 - 20;
    const colors = [billboard.client.color, "#fdf3e0", "#ffd27a", shade(billboard.client.color, 0.75)];
    for (let i = 0; i < 30; i++) {
      this.spawn(cx, cy, "confetti", colors[i % colors.length], 0.95, 330);
    }
    sfx.chime();
    return true;
  }

  /**
   * Отказ пришёл отдельным server:error, а не ответом на действие. Разбираем
   * его так же: по нашему щиту это тот же самый отказ.
   */
  applyRequestFailure(requestId: string, code: string): boolean {
    if (!this.billboardRequests.has(requestId)) return false;
    return this.applyBillboardResult(requestId, false, code);
  }

  applyRespawn(player: PublicPlayerState): void {
    this.gameOverSent = false;
    this.stalled = false;
    this.onlinePlayerStatus = "active";
    this.applyServerPlayer(player, "snap");
  }

  requestOnlineRespawn(): boolean {
    if (!this.online?.connected) return false;
    return this.online.respawn() !== null;
  }

  getMoney(): number {
    return this.money;
  }

  /**
   * Атомарно списывает игровую валюту, если на счету хватает денег. В онлайне
   * деньги — состояние сервера: здесь только проверяем баланс, списание уйдёт
   * вместе с бустером, иначе ближайший снапшот вернул бы потраченное.
   */
  trySpendMoney(amount: number): boolean {
    const cost = Math.max(0, Math.floor(amount));
    if (!Number.isFinite(cost) || this.money < cost) return false;
    if (this.online?.connected) return true;
    this.money -= cost;
    this.emitHud();
    return true;
  }

  /**
   * Применяет игровой эффект уже полученного бустера. В онлайне скорость,
   * расход, топливо и деньги считает сервер, поэтому эффект уходит ему:
   * начисленное себе локально всё равно затёр бы ближайший снапшот.
   */
  applyBooster(
    systemName: string,
    cost = 0
  ): { applied: boolean; revived: boolean; requestId?: string } {
    if (this.online?.connected) {
      // Ответ придёт событием booster-applied: деньги, топливо и множители
      // приедут в снапшоте, оживление — сообщением player:respawned.
      const requestId = this.online.booster(systemName, cost);
      return {
        applied: requestId !== null,
        revived: false,
        ...(requestId ? { requestId } : {}),
      };
    }

    const speed = /^speed(\d+(?:\.\d+)?)$/.exec(systemName);
    if (speed) {
      const percent = Number(speed[1]);
      if (!Number.isFinite(percent) || percent < 0) return { applied: false, revived: false };
      this.speedMultiplier = Math.max(this.speedMultiplier, 1 + percent / 100);
      this.emitHud();
      return { applied: true, revived: false };
    }

    const consumption = /^consumption(\d+(?:\.\d+)?)$/.exec(systemName);
    if (consumption) {
      const percent = Number(consumption[1]);
      if (!Number.isFinite(percent) || percent < 0) return { applied: false, revived: false };
      this.fuelConsumptionMultiplier = Math.min(
        this.fuelConsumptionMultiplier,
        Math.max(0, 1 - percent / 100)
      );
      this.emitHud();
      return { applied: true, revived: false };
    }

    const fuel = /^fuel(\d+(?:\.\d+)?)l$/.exec(systemName);
    if (fuel) {
      const liters = Number(fuel[1]);
      if (!Number.isFinite(liters) || liters <= 0) return { applied: false, revived: false };
      this.fuel = Math.min(this.fuelMax, this.fuel + liters);
      const revived = this.stalled && this.fuel > 0;
      if (revived) {
        this.stalled = false;
        this.gameOverSent = false;
        this.car.speed = 0;
        sfx.engineStart();
      }
      this.emitHud();
      return { applied: true, revived };
    }

    const money = /^money(\d+(?:\.\d+)?)$/.exec(systemName);
    if (money) {
      const coefficient = Number(money[1]);
      if (!Number.isFinite(coefficient) || coefficient <= 0) {
        return { applied: false, revived: false };
      }
      this.money += Math.floor(CONFIG.startMoney * coefficient);
      this.emitHud();
      return { applied: true, revived: false };
    }

    return { applied: false, revived: false };
  }

  /**
   * Активирует именно ту закрытую АЗС, рядом с которой сейчас находится игрок.
   * В онлайне решение за сервером, поэтому здесь возвращается только номер
   * запроса: списывать бустер можно лишь после ответа `interaction:result`.
   */
  activateNearbyInactiveStation(): StationActivation {
    const station = this.nearbyInactiveStation;
    if (!station || station.state !== "locked") {
      this.updateNearbyInactiveStation();
      return { status: "unavailable" };
    }
    if (this.online?.connected && !this.nearbyStationInReach) {
      // Сервер проверяет расстояние сам: отправить запрос с этой дистанции —
      // значит получить «too-far» в ответ, уже потратив бустер.
      return { status: "too-far" };
    }
    if (this.online?.connected) {
      if (!station.id) return { status: "unavailable" };
      // Сервер сверяет расстояние по последнему player:move, а он уходит 20 раз
      // в секунду и на скорости успевает отстать на полкорпуса. Досылаем
      // текущую позицию перед проверкой.
      this.pushPositionToServer();
      const requestId = this.online.interact("station", station.id);
      return requestId ? { status: "pending", requestId } : { status: "unavailable" };
    }
    const activated = this.activateStation(station, "ad", true);
    if (activated) this.setNearbyInactiveStation(null);
    return activated ? { status: "activated" } : { status: "unavailable" };
  }

  reset(): void {
    for (const b of this.city.billboards) {
      b.discovered = false;
      b.state = "ready";
      b.cooldown = 0;
    }
    this.found = 0;
    this.won = false;
    this.time = 0;
    this.topSpeed = 0;
    this.resetFuel();
    this.gameOverSent = false;
    this.particles = [];
    this.skids = [];
    this.placeCar();
    this.initStations();
    this.emitLeaderboard();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("resize", this.onResize);
    sfx.stopAllRefueling();
    sfx.engineIdle();
  }

  private replaceCity(map: ServerCity): void {
    this.city = map;
    this.total = new Set(map.billboards.map((billboard) => billboard.client.id)).size;
    this.refuelStation = null;
    this.usedStation = null;
    this.billboardContact = null;
    this.cancelBillboardAd();
    this.onlineContacts.clear();
    this.forgetBillboardRequests();
    this.afterObjectsChanged();
    this.paintMinimapBase();
  }

  private afterObjectsChanged(): void {
    this.stationsActive = this.city.stations.filter((station) => station.state === "active").length;
    this.found = new Set(
      this.city.billboards
        .filter((billboard) =>
          this.onlinePlayerId && billboard.discoveredBy
            ? billboard.discoveredBy.includes(this.onlinePlayerId)
            : billboard.discovered
        )
        .map((billboard) => billboard.client.id)
    ).size;
    this.updateNearbyInactiveStation();
  }

  private applyServerPlayer(
    player: PublicPlayerState,
    mode: PositionMode = "reconcile"
  ): void {
    if (this.onlinePlayerId && player.id !== this.onlinePlayerId) return;

    const oldCanisters = this.canisters;

    this.playerName = player.name;
    // Отскок после тарана считает сервер, а гасим мы его локально каждый кадр.
    // Переписывать его целиком на каждом снапшоте нельзя: затухание начиналось
    // бы заново и машину волокло бы рывками. Берём только новый импульс — то,
    // что сервер добавил сверх уже отыгранного.
    const kx = player.kx ?? 0;
    const ky = player.ky ?? 0;
    if (Math.hypot(kx, ky) > Math.hypot(this.knock.x, this.knock.y) + 1) {
      this.knock.x = kx;
      this.knock.y = ky;
    }
    this.applyServerPosition(player, mode);
    this.fuel = player.fuel;
    this.fuelMax = player.tankVolume;
    this.money = player.money;
    this.canisters = player.canisters;
    this.totalLitersFilled = player.filledLiters;
    this.onlinePlayerStatus = player.status;
    this.stalled = player.status !== "active" || player.fuel <= 0;

    // Заправку ведёт сервер: он же присылает флаг, колонку и итоги сессии —
    // раньше клиент угадывал их по приросту топлива, и на мгновенной серверной
    // заправке это давало заправку «в один кадр».
    this.refueling = player.refueling === true;
    this.refuelStation = this.refueling
      ? this.city.stations.find((station) => station.id === player.refuelStationId) ?? null
      : null;
    this.sessionLiters = player.refuelLiters ?? 0;
    this.sessionSpent = player.refuelSpent ?? 0;
    this.sessionDuration = player.refuelDuration ?? 0;
    this.sessionElapsed = Math.max(0, this.sessionDuration - (player.refuelRemaining ?? 0));
    if (typeof player.speedMultiplier === "number") this.speedMultiplier = player.speedMultiplier;
    if (typeof player.fuelConsumptionMultiplier === "number") {
      this.fuelConsumptionMultiplier = player.fuelConsumptionMultiplier;
    }
    if (player.canisters > oldCanisters) {
      this.cb.onCanister(player.canisters, CANISTER_L);
      sfx.canisterPickup();
    }

    const speed = Math.abs(player.speed);
    this.topSpeed = Math.max(this.topSpeed, speed);
    if (player.status !== "active" && !this.gameOverSent) {
      this.gameOverSent = true;
      this.cb.onGameOver({ time: this.time, found: this.found });
    } else if (player.status === "active") {
      this.gameOverSent = false;
    }
    this.emitHud();
  }

  /**
   * Кладёт серверное положение на машину игрока.
   *
   * В обычной езде положение своей машины ведёт клиент: он считает физику
   * каждый кадр и сам сообщает результат серверу (player:move). Поэтому снапшот
   * положение не трогает вовсе — иначе каждый пакет спорил бы с тем, что игрок
   * уже видит на экране, и спор этот виден как рывок.
   *
   * Сервер перебивает клиента только там, где он действительно главный: вход в
   * игру, респавн, гибель, смена карты, заправка (машину под колонкой держит
   * он), отклонённое перемещение и затяжное расхождение — если наши координаты
   * до него почему-то не доходят. Всё это, кроме честных телепортов, идёт через
   * корректор и выглядит как подъезд, а не как прыжок.
   */
  private applyServerPosition(player: PublicPlayerState, mode: PositionMode): void {
    const c = this.car;
    const teleport =
      mode === "snap" ||
      this.phase !== "play" ||
      player.status !== "active" ||
      !this.online?.connected;

    if (teleport) {
      // Вход в заезд, респавн, гибель, оффлайн: предсказывать тут нечего, и
      // мгновенный перенос здесь и есть правильная картинка.
      c.x = player.x;
      c.y = player.y;
      c.angle = player.angle;
      c.speed = player.speed;
      this.smoother.reset();
      this.reconcileBoost = 0;
      this.serverDisagreement = 0;
      return;
    }

    // Ответ на игровое действие несёт состояние на момент, когда сервер его
    // обработал, — оно старее последнего снапшота. Двигать по нему машину нельзя,
    // и считать по нему расхождение тоже: из-за череды подобранных канистр мы
    // решили бы, что сервер нас не слышит.
    if (mode === "stats") return;

    // Снапшот показывает машину такой, какой она была примерно RTT назад: наши
    // команды ещё летели до сервера, ответ летел обратно. Прежде чем сравнивать
    // его с нашим положением, продлеваем серверное состояние на задержку вперёд.
    const lead = clamp(this.online?.latency ?? 0, 0, RECONCILE_MAX_LEAD);
    const ax = player.x + Math.cos(player.angle) * player.speed * lead;
    const ay = player.y + Math.sin(player.angle) * player.speed * lead;
    const drift = Math.hypot(ax - c.x, ay - c.y);

    // Заправка: машину под колонкой держит сервер, своей физики в этот момент
    // нет. Отклонённое перемещение и выключенный player:move: сервер нас не
    // слышит, значит рулит он.
    const serverDrives = player.refueling === true || this.serverOverrideCd > 0 || this.moveDisabled;

    if (!serverDrives) {
      // Обычная езда. Считаем лишь, насколько сервер с нами согласен: если он
      // долго держится своего, наши координаты до него не доходят и придётся
      // подчиниться.
      this.serverDisagreement = drift > AUTHORITY_TOLERANCE ? this.serverDisagreement + 1 : 0;
      if (this.serverDisagreement < AUTHORITY_PATIENCE) {
        // Цель обнуляем, но корректор не сбрасываем: недоделанную поправку он
        // должен свести к нулю сам, иначе обрыв поправки и будет рывком.
        this.smoother.set(0, 0, 0, 0);
        return;
      }
    }

    this.smoother.set(ax - c.x, ay - c.y, angleDelta(player.angle, c.angle), player.speed - c.speed);
  }

  /**
   * Сервер не принял наше перемещение. Пока разбирается — руль его; если
   * отказы идут подряд, значит player:move он не поддерживает, и мы совсем
   * возвращаемся к предсказанию с ведущим сервером.
   */
  onServerMovementRejected(): void {
    this.serverOverrideCd = OVERRIDE_HOLD;
    if (++this.moveRejects >= MOVE_REJECT_LIMIT) this.moveDisabled = true;
  }

  /** подбирает расхождение с сервером понемногу каждый кадр */
  private reconcilePrediction(dt: number): void {
    if (this.reconcileBoost > 0) this.reconcileBoost = Math.max(0, this.reconcileBoost - dt);
    const fix = this.smoother.advance(dt, Math.abs(this.car.speed), this.reconcileBoost > 0);
    this.car.x += fix.dx;
    this.car.y += fix.dy;
    this.car.angle += fix.dAngle;
    this.car.speed += fix.dSpeed;
  }

  private toRenderBot(entity: RemoteEntityState): Bot {
    return {
      x: entity.x,
      y: entity.y,
      angle: entity.angle,
      speed: entity.speed,
      color: entity.color,
      name: entity.name,
      fuel: entity.fuel ?? CONFIG.startFuel,
      tankVolume: entity.tankVolume ?? CONFIG.startTankVolume,
      money: entity.money ?? CONFIG.startMoney,
      status: entity.status === "lost" ? "lost" : "active",
      filledLiters: entity.filledLiters,
      plan: "station",
      goal: null,
      gotCanister: false,
      refuelled: false,
      wait: entity.refuelRemaining ?? entity.wait ?? 0,
      refuelTotal: entity.refuelDuration ?? entity.wait ?? 0,
      refuelTargetLiters: entity.refuelTargetLiters ?? 0,
      refuelLiters: entity.refuelLiters ?? 0,
      refuelSpent: entity.refuelSpent ?? 0,
      at:
        entity.refuelStationId
          ? this.city.stations.find((station) => station.id === entity.refuelStationId) ?? null
          : null,
      respawnRemaining: entity.respawnRemaining ?? 0,
      think: 0,
      taken: entity.taken ?? entity.canisters ?? 0,
      kx: entity.kx ?? 0,
      ky: entity.ky ?? 0,
      stun: entity.stun ?? 0,
      style: entity.style ?? 0.9,
      lane: entity.lane ?? 0,
      wob: entity.wobble ?? 0,
      lazy: 0,
      lazyCd: 4,
      aggro: 0,
      aggroCd: 12,
    };
  }

  private insideRect(x: number, y: number, rect: Rect, pad = 0): boolean {
    return (
      x > rect.x - pad &&
      x < rect.x + rect.w + pad &&
      y > rect.y - pad &&
      y < rect.y + rect.h + pad
    );
  }

  /** бак, деньги, канистры и разложенные по городу канистры — в исходное состояние */
  private resetFuel(): void {
    this.fuelMax = CONFIG.startTankVolume;
    this.fuel = Math.min(CONFIG.startFuel, this.fuelMax);
    this.money = CONFIG.startMoney;
    this.speedMultiplier = 1;
    this.fuelConsumptionMultiplier = 1;
    this.sessionLiters = 0;
    this.sessionSpent = 0;
    this.sessionTargetLiters = 0;
    this.sessionDuration = 0;
    this.sessionElapsed = 0;
    this.sessionStop = "full";
    this.totalLitersFilled = 0;
    this.playerName = makePlayerName();
    this.leaderboardCd = 0;
    this.leaderboardDirty = true;
    this.atBase = false;
    this.canisters = 0;
    this.stalled = false;
    this.refueling = false;
    this.refuelStation = null;
    this.usedStation = null;
    this.setNearbyInactiveStation(null);
    this.unlockQueue = [];
    this.knock.x = 0;
    this.knock.y = 0;
    this.deadPointers = [];
    this.billboardContact = null;
    this.cancelBillboardAd();
    for (const k of this.city.canisters) {
      k.taken = false;
      k.cool = 0;
    }
    this.bots = createBots(this.city, CONFIG.botCount, START);
  }

  private placeCar(): void {
    this.car.x = START.x;
    this.car.y = START.y;
    this.car.angle = -Math.PI / 2;
    this.car.speed = 0;
    this.cam.x = this.car.x;
    this.cam.y = this.car.y;
  }

  private getPlayerMaxSpeed(): number {
    return MAX_SPEED * this.speedMultiplier;
  }

  /**
   * Новая смена на колонке: цена литра берётся случайно между границами из
   * конфига, а ограничение на отпуск выпадает с указанной там вероятностью.
   * Крутится при каждой активации станции — цены по городу живые.
   */
  private rollStationOffer(st: Station): void {
    const lo = CONFIG.stationPriceMin;
    const hi = Math.max(lo, CONFIG.stationPriceMax);
    st.price = Math.round(lo + Math.random() * (hi - lo));
    st.limit = Math.random() < CONFIG.stationLimitChance ? CONFIG.stationFuelLimit : null;
  }

  /** по умолчанию работает одна АЗС — ближайшая к старту */
  private initStations(): void {
    let best: Station | null = null;
    let bd = Infinity;
    for (const s of this.city.stations) {
      s.state = "locked";
      const d = Math.hypot(s.x + s.w / 2 - this.car.x, s.y + s.h / 2 - this.car.y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (best) {
      best.state = "active";
      best.origin = "start";
      this.rollStationOffer(best);
    }
    this.stationsActive = best ? 1 : 0;
  }

  /* ---------------- input ---------------- */

  private keyDown(e: KeyboardEvent): void {
    const map: Record<string, string> = {
      KeyW: "up",
      ArrowUp: "up",
      KeyS: "down",
      ArrowDown: "down",
      KeyA: "left",
      ArrowLeft: "left",
      KeyD: "right",
      ArrowRight: "right",
      Space: "hb",
    };
    const k = map[e.code];
    if (k) {
      e.preventDefault();
      if (!e.repeat) this.keys.add(k);
    }
  }

  private keyUp(e: KeyboardEvent): void {
    const map: Record<string, string> = {
      KeyW: "up",
      ArrowUp: "up",
      KeyS: "down",
      ArrowDown: "down",
      KeyA: "left",
      ArrowLeft: "left",
      KeyD: "right",
      ArrowRight: "right",
      Space: "hb",
    };
    const k = map[e.code];
    if (k) this.keys.delete(k);
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.vw = this.cv.clientWidth || 300;
    this.vh = this.cv.clientHeight || 300;
    this.cv.width = Math.round(this.vw * this.dpr);
    this.cv.height = Math.round(this.vh * this.dpr);
  }

  /* ---------------- loop ---------------- */

  private loop = (ts: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = clamp((ts - this.last) / 1000 || 0.016, 0.001, 0.033);
    this.last = ts;
    this.wall += dt;
    if (this.phase === "play") {
      // Таймауты билбордов идут по реальному времени, в том числе пока открыто
      // окно клиента или карта и основная симуляция поставлена на паузу.
      if (!this.online) this.updateBillboards(dt);
      if (!this.paused) this.update(dt);
      // Серверные данные вливаются в картинку каждый кадр — в том числе на
      // паузе, когда своё предсказание не крутится.
      if (this.online?.connected) {
        this.reconcilePrediction(dt);
        this.updateRemoteEntities(dt);
      }
      this.syncRefuelingSounds();
    }
    this.render(dt);
  };

  /* ---------------- simulation ---------------- */

  private updateBillboards(dt: number): void {
    for (const billboard of this.city.billboards) {
      if (billboard.state !== "done") continue;
      billboard.cooldown = Math.max(0, billboard.cooldown - dt);
      if (billboard.cooldown <= 0) {
        billboard.state = "ready";
      }
    }
  }

  /**
   * Отправляет серверу текущее положение машины. Вызывается по таймеру из
   * updateOnline и внеочередно перед запросами, где сервер сверяет дистанцию.
   */
  private pushPositionToServer(): void {
    const transport = this.online;
    if (!transport?.connected || this.moveDisabled) return;
    if (this.refueling || this.onlinePlayerStatus !== "active") return;
    const c = this.car;
    transport.sendMove({ x: c.x, y: c.y, angle: c.angle, speed: c.speed });
    this.onlineMoveCd = 1 / MOVE_SEND_RATE;
  }

  private updateOnline(dt: number): void {
    const transport = this.online;
    if (!transport?.connected) return;

    this.time += dt;
    this.bumpCd -= dt;
    this.leafCd -= dt;
    this.crashCd -= dt;
    this.onlineInputCd -= dt;
    this.onlineMoveCd -= dt;
    this.serverOverrideCd = Math.max(0, this.serverOverrideCd - dt);

    const up = this.keys.has("up") && !this.stalled;
    const down = this.keys.has("down");
    const left = this.keys.has("left");
    const right = this.keys.has("right");
    const handbrake = this.keys.has("hb");

    if (this.onlineInputCd <= 0) {
      transport.sendInput({ up, down, left, right, handbrake });
      this.onlineInputCd = 1 / 30;
    }

    // Положение своей машины ведёт клиент, поэтому его надо не только нарисовать,
    // но и сообщить: по этим координатам сервер считает столкновения и показывает
    // нас остальным. Под колонкой машину держит он сам — там молчим.
    if (this.onlineMoveCd <= 0) this.pushPositionToServer();

    // Движение считаем сами, кадр в кадр: сеть нужна лишь там, где сервер
    // главный, и это разбирает applyServerPosition().
    let throttle = 0;
    if (this.refueling || this.onlinePlayerStatus !== "active") {
      // под колонкой и после вылета машина стоит: предсказывать нечего
      this.car.speed = 0;
      this.braking = false;
      this.prevWheelL = this.prevWheelR = null;
    } else {
      throttle = this.stepCar(dt, false);
    }

    const speed = Math.abs(this.car.speed);
    this.displaySpeed += (speed - this.displaySpeed) * Math.min(1, 10 * dt);
    this.topSpeed = Math.max(this.topSpeed, speed);
    this.updateParticles(dt);
    this.fadeSkids(dt);
    this.updateOnlineRefuelEffects(dt);
    this.tickBillboardRetries(dt);
    this.updateOnlineInteractions();
    this.updateNearbyInactiveStation();

    if (this.stalled || this.onlinePlayerStatus !== "active") {
      sfx.engineIdle();
    } else {
      sfx.engine(speed / this.getPlayerMaxSpeed(), throttle);
    }

    if (
      this.fuel <= 0 &&
      speed < 24 &&
      this.onlinePlayerStatus === "active" &&
      !this.gameOverSent
    ) {
      this.gameOverSent = true;
      transport.playerLost("fuel-empty");
      this.cb.onGameOver({ time: this.time, found: this.found });
    }
    this.emitHud();
  }

  private updateOnlineInteractions(): void {
    const transport = this.online;
    if (!transport?.connected || this.onlinePlayerStatus !== "active") return;

    const contacts = new Set<string>();
    const touchRect = (rect: Rect, pad = CAR_R + 2) => {
      const closestX = clamp(this.car.x, rect.x, rect.x + rect.w);
      const closestY = clamp(this.car.y, rect.y, rect.y + rect.h);
      return Math.hypot(this.car.x - closestX, this.car.y - closestY) <= pad;
    };

    for (const canister of this.city.canisters) {
      if (canister.taken || !canister.id) continue;
      if (Math.hypot(this.car.x - canister.x, this.car.y - canister.y) > CAR_R + CANISTER_R) continue;
      const key = `canister:${canister.id}`;
      contacts.add(key);
      if (!this.onlineContacts.has(key)) {
        // Дистанцию сервер меряет по последней присланной позиции — досылаем её.
        this.pushPositionToServer();
        transport.interact("canister", canister.id);
      }
    }

    for (const billboard of this.city.billboards) {
      if (!billboard.id || !touchRect(billboard)) continue;
      const key = `billboard:${billboard.id}`;
      const id = billboard.id;
      contacts.add(key);
      // Ответа по этому щиту ещё нет либо ждём паузу перед повтором.
      if (this.billboardRetry.has(id)) continue;
      if (this.onlineContacts.has(key) || billboard.state !== "ready") continue;
      // После too-far повторяем только серверный запрос: реклама уже была
      // просмотрена и не должна открываться ещё раз из-за сетевой рассинхронизации.
      if (this.billboardAttempts.has(id)) this.sendBillboardInteraction(id);
      else {
        this.requestBillboardAd(billboard, (wasShown) => {
          if (wasShown) this.sendBillboardInteraction(id);
        });
      }
    }

    const base = this.city.base;
    if (base.id && this.insideRect(this.car.x, this.car.y, base, 6)) {
      const key = `base:${base.id}`;
      contacts.add(key);
      if (!this.onlineContacts.has(key) && this.fuel >= 0.5) {
        this.cb.onBase(this.fuel, CONFIG.fuelSellPrice);
      }
    }

    this.onlineContacts = contacts;

    // Съехали со щита — счётчик попыток и пауза больше не нужны. Сам запрос
    // ждёт ответа и после отъезда: сервер мог его принять, и карточку клиента
    // игрок увидит, даже если уже проехал мимо.
    for (const id of [...this.billboardAttempts.keys()]) {
      if (contacts.has(`billboard:${id}`)) continue;
      this.billboardAttempts.delete(id);
      this.billboardRetry.delete(id);
    }
  }

  /** Забывает незакрытые запросы по щитам: карта или соединение сменились. */
  private forgetBillboardRequests(): void {
    this.billboardRequests.clear();
    this.billboardRetry.clear();
    this.billboardAttempts.clear();
  }

  private requestBillboardAd(
    billboard: Billboard,
    complete: (wasShown: boolean) => void
  ): void {
    if (this.billboardAdActive) return;
    this.billboardAdActive = true;
    const token = ++this.billboardAdToken;
    const finish = (wasShown: boolean) => {
      if (token !== this.billboardAdToken) return;
      this.billboardAdActive = false;
      complete(wasShown);
    };

    try {
      this.cb.onBillboardAd(
        billboard.client,
        this.city.billboards.indexOf(billboard) + 1,
        finish
      );
    } catch {
      finish(false);
    }
  }

  private cancelBillboardAd(): void {
    this.billboardAdToken += 1;
    this.billboardAdActive = false;
  }

  private sendBillboardInteraction(id: string): void {
    const activeTransport = this.online;
    const activeBillboard = this.city.billboards.find((value) => value.id === id);
    if (!activeTransport || activeBillboard?.state !== "ready") return;
    // Занята ли ещё хоть одна АЗС, решает сервер: у него состояние заправок
    // свежее нашего, а отказ он объяснит кодом all-stations-active.
    this.pushPositionToServer();
    const requestId = activeTransport.interact("billboard", id);
    if (!requestId) return;
    this.billboardRequests.set(requestId, id);
    this.billboardAttempts.set(id, (this.billboardAttempts.get(id) ?? 0) + 1);
  }

  /** Отсчитывает паузы перед повторными запросами по щитам. */
  private tickBillboardRetries(dt: number): void {
    for (const [id, left] of [...this.billboardRetry]) {
      const remaining = left - dt;
      if (remaining > 0) {
        this.billboardRetry.set(id, remaining);
        continue;
      }
      this.billboardRetry.delete(id);
      // Машина со щита не съезжала, поэтому касание надо «переоткрыть» — иначе
      // повтор пойдёт только после нового наезда.
      this.onlineContacts.delete(`billboard:${id}`);
    }
  }

  private update(dt: number): void {
    if (this.online?.connected) {
      this.updateOnline(dt);
      return;
    }

    this.time += dt;
    this.leaderboardCd -= dt;
    this.bumpCd -= dt;
    this.leafCd -= dt;
    this.crashCd -= dt;

    const c = this.car;
    const maxSpeed = this.getPlayerMaxSpeed();

    // на время заправки машина замирает и не слушается руля
    if (this.refueling) {
      c.speed = 0;
      this.braking = false;
      this.prevWheelL = this.prevWheelR = null;
      this.updateNearbyInactiveStation();
      this.displaySpeed += (0 - this.displaySpeed) * Math.min(1, 8 * dt);
      this.updateFuel(dt);
      this.updateBots(dt);
      this.carCollisions(dt);
      this.coolCanisters(dt);
      this.updateParticles(dt);
      this.fadeSkids(dt);
      sfx.engineIdle();
      this.maybeEmitLeaderboard();
      this.emitHud();
      return;
    }

    const throttle = this.stepCar(dt, true);

    this.checkBase();
    this.updateFuel(dt);
    this.updateBots(dt);
    this.carCollisions(dt);
    this.coolCanisters(dt);
    this.pickCanisters();
    this.updateNearbyInactiveStation();
    this.updateParticles(dt);
    this.fadeSkids(dt);

    const sp = Math.abs(c.speed);
    this.topSpeed = Math.max(this.topSpeed, sp);
    this.displaySpeed += (sp - this.displaySpeed) * Math.min(1, 8 * dt);

    if (this.stalled) sfx.engineIdle();
    else sfx.engine(sp / maxSpeed, throttle);
    this.maybeEmitLeaderboard();
    this.emitHud();
  }

  /**
   * Физика кузова игрока за кадр: газ, тормоз, руль, снос на траве, следы юза и
   * упор в стены. В онлайне это же и есть локальное предсказание — движение
   * рисуется сразу, не дожидаясь снапшота, а расхождение потом гасит
   * reconcilePrediction(). Возвращает текущую «долю газа» для звука мотора.
   */
  private stepCar(dt: number, interactive: boolean): number {
    const c = this.car;
    const maxSpeed = this.getPlayerMaxSpeed();
    const up = this.keys.has("up");
    const down = this.keys.has("down");
    const left = this.keys.has("left");
    const right = this.keys.has("right");
    const hb = this.keys.has("hb");
    let throttle = 0;

    if (up && !this.stalled) {
      c.speed += ACC * dt;
      throttle = 1;
    }
    if (down) {
      if (c.speed > 1) {
        c.speed -= BRAKE * dt;
        this.braking = true;
      } else if (!this.stalled) {
        c.speed -= ACC * 0.55 * dt;
        this.braking = false;
        throttle = 0.5;
      } else {
        this.braking = false;
      }
    } else {
      this.braking = false;
    }
    if (!up && !down) {
      const s = c.speed;
      c.speed = s - Math.sign(s) * Math.min(Math.abs(s), (55 + Math.abs(s) * 0.85) * dt);
    }
    if (hb) c.speed -= c.speed * 2.4 * dt;
    // заглохший мотор: машина докатывается
    if (this.stalled) c.speed -= c.speed * Math.min(1, 1.5 * dt);

    // трава тормозит
    if (!this.isOnRoad(c.x, c.y)) {
      const s = c.speed;
      if (Math.abs(s) > 250) c.speed = s - Math.sign(s) * 560 * dt;
      else c.speed = s - Math.sign(s) * Math.min(Math.abs(s), 150 * dt);
      if (Math.abs(s) > 70 && Math.random() < 0.4) {
        this.spawn(c.x - Math.cos(c.angle) * 16, c.y - Math.sin(c.angle) * 16, "smoke", "rgba(128,138,116,0.4)", 1, 50);
      }
    }
    c.speed = clamp(c.speed, -REV_MAX, maxSpeed);

    // Руль. Поворачивает не сама клавиша, а положение руля: оно доходит до упора
    // за доли секунды и так же возвращается к нулю. Из-за этого короткое нажатие
    // даёт аккуратный доворот, а не рывок на весь угол.
    const dir = (left ? -1 : 0) + (right ? 1 : 0);
    const sp = Math.abs(c.speed);
    c.steer = stepSteering(c.steer, dir, dt);
    let hold = grip(c.speed, maxSpeed);
    if (hb) hold *= 1.75;
    c.angle += c.steer * TURN_RATE * hold * (c.speed < -1 ? -1 : 1) * dt;

    // Выравнивание после поворота: руль отпущен — значит игрок хочет ехать
    // прямо, и остаток от поворота машина добирает сама, вдоль улицы. Пока за
    // руль держатся или срывают машину ручником, никакой самодеятельности.
    if (dir === 0 && !hb && Math.abs(c.steer) < 0.05) c.angle += alignStep(c.angle, c.speed, dt);

    // следы юза
    const skidding = (hb && sp > 140) || (dir !== 0 && sp > maxSpeed * 0.68);
    const hx = Math.cos(c.angle);
    const hy = Math.sin(c.angle);
    const px = -hy;
    const py = hx;
    if (skidding) {
      const rl = { x: c.x - hx * 13 + px * 8, y: c.y - hy * 13 + py * 8 };
      const rr = { x: c.x - hx * 13 - px * 8, y: c.y - hy * 13 - py * 8 };
      if (this.prevWheelL && this.prevWheelR) {
        this.pushSkid(this.prevWheelL, rl);
        this.pushSkid(this.prevWheelR, rr);
      }
      this.prevWheelL = rl;
      this.prevWheelR = rr;
    } else {
      this.prevWheelL = this.prevWheelR = null;
    }

    // движение
    c.x += hx * c.speed * dt;
    c.y += hy * c.speed * dt;

    // выхлоп
    if (up && Math.random() < 0.55) {
      this.spawn(
        c.x - hx * 22 + (Math.random() - 0.5) * 6,
        c.y - hy * 22 + (Math.random() - 0.5) * 6,
        "smoke",
        "rgba(150,160,178,0.4)",
        0.6,
        34
      );
    }

    this.applyKnock(dt);
    this.collide(interactive);
    return throttle;
  }

  private maybeEmitLeaderboard(): void {
    if (!this.leaderboardDirty || this.leaderboardCd > 0) return;
    this.emitLeaderboard();
    this.leaderboardCd = 0.2;
  }

  private emitLeaderboard(): void {
    const rows = [
      {
        name: this.playerName,
        liters: this.totalLitersFilled,
        isPlayer: true,
        color: PLAYER_COLOR,
        order: 0,
      },
      ...this.bots.map((b, index) => ({
        name: b.name,
        liters: b.filledLiters,
        isPlayer: false,
        color: b.color,
        order: index + 1,
      })),
    ]
      .sort((a, b) => b.liters - a.liters || a.order - b.order)
      .map(({ order: _order, ...row }, index) => ({ ...row, position: index + 1 }));

    this.leaderboardDirty = false;
    this.cb.onLeaderboard(rows);
  }

  private emitHud(): void {
    this.cb.onHud({
      speed: Math.round(this.displaySpeed * KMH),
      speedMax: Math.round(this.getPlayerMaxSpeed() * KMH),
      found: this.found,
      total: this.total,
      time: this.time,
      top: Math.round(this.topSpeed * KMH),
      fuel: this.fuel,
      fuelMax: this.fuelMax,
      refueling: this.refueling,
      stationsActive: this.stationsActive,
      stationsTotal: this.city.stations.length,
      canisters: this.canisters,
      money: this.money,
      refuelPrice: this.refuelStation ? this.refuelStation.price : 0,
      refuelSpent: this.sessionSpent,
      refuelLeft:
        this.refuelStation && this.refuelStation.limit !== null
          ? Math.max(0, this.refuelStation.limit - this.sessionLiters)
          : null,
    });
  }

  private fadeSkids(dt: number): void {
    for (let i = this.skids.length - 1; i >= 0; i--) {
      this.skids[i].a -= dt * 0.05;
      if (this.skids[i].a <= 0) this.skids.splice(i, 1);
    }
  }

  /* -------- база нелегальной скупки -------- */

  /** въехали на площадку базы — предлагаем продать бензин (один раз за заезд на неё) */
  private checkBase(): void {
    const b = this.city.base;
    const c = this.car;
    const inside = c.x > b.x - 6 && c.x < b.x + b.w + 6 && c.y > b.y - 6 && c.y < b.y + b.h + 6;
    if (!inside) {
      this.atBase = false;
      return;
    }
    if (this.atBase || this.stalled) return;
    this.atBase = true;
    if (this.fuel < 0.5) return; // сливать нечего
    this.cb.onBase(this.fuel, CONFIG.fuelSellPrice);
  }

  /** продать литры базе: возвращает, сколько рублей выручили */
  sellFuel(liters: number): number {
    // Приёмщик никогда не оставляет игрока без большей части запаса:
    // за один визит можно слить не более половины текущего топлива.
    const sold = clamp(liters, 0, this.fuel / 2);
    if (sold <= 0) return 0;
    if (this.online?.connected) {
      const id = this.city.base.id;
      if (!id || this.online.interact("base", id, sold) === null) return 0;
      sfx.gasolineSale();
      return Math.round(sold * CONFIG.fuelSellPrice);
    }
    this.fuel -= sold;
    const paid = Math.round(sold * CONFIG.fuelSellPrice);
    this.money += paid;
    const b = this.city.base;
    for (let i = 0; i < 20; i++) {
      this.spawn(b.x + b.w / 2, b.y + b.h / 2, "confetti", i % 2 ? "#ffd27a" : "#7ee08a", 0.9, 240);
    }
    sfx.chime();
    sfx.gasolineSale();
    this.emitHud();
    return paid;
  }

  /* -------- канистры: наезд = подбор, бак становится больше -------- */

  private pickCanisters(): void {
    const c = this.car;
    const rr = (CAR_R + CANISTER_R) * (CAR_R + CANISTER_R);
    for (const k of this.city.canisters) {
      if (k.taken || k.cool > 0) continue;
      const dx = c.x - k.x;
      const dy = c.y - k.y;
      if (dx * dx + dy * dy > rr) continue;
      k.taken = true;
      this.canisters += 1;
      // канистра увеличивает только объём бака: топлива в нём не прибавляется
      this.fuelMax += CANISTER_L;
      for (let i = 0; i < 18; i++) {
        this.spawn(k.x, k.y, "spark", i % 2 ? CANISTER_ACCENT : "#d8f2ff", 0.7, 150);
      }
      sfx.canisterPickup();
      this.cb.onCanister(this.canisters, CANISTER_L);
    }
  }

  /* -------- столкновения машин -------- */

  /** отлёт машины игрока: живёт своей жизнью поверх газа и руля */
  private applyKnock(dt: number): void {
    if (!this.knock.x && !this.knock.y) return;
    this.car.x += this.knock.x * dt;
    this.car.y += this.knock.y * dt;
    const decay = Math.exp(-3.4 * dt);
    this.knock.x *= decay;
    this.knock.y *= decay;
    if (Math.hypot(this.knock.x, this.knock.y) < 4) {
      this.knock.x = 0;
      this.knock.y = 0;
    }
  }

  private coolCanisters(dt: number): void {
    for (const k of this.city.canisters) if (k.cool > 0) k.cool -= dt;
    for (let i = this.deadPointers.length - 1; i >= 0; i--) {
      this.deadPointers[i].t -= dt;
      if (this.deadPointers[i].t <= 0) this.deadPointers.splice(i, 1);
    }
  }

  /** цель увели: указатель на неё доживает пару мгновений красным */
  private killPointer(x: number, y: number, iconPath: string): void {
    this.deadPointers.push({ x, y, iconPath, t: DEAD_POINTER_S });
  }

  /**
   * Машины таранят друг друга: пару расталкиваем, а тому, кого протаранили,
   * добавляем отлёт «как пнули мячик». Машина, стоящая под колонкой, работает
   * как стенка — её саму не сдвинуть.
   */
  private carCollisions(dt: number): void {
    const cars: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      fixed: boolean;
      bot: Bot | null;
    }> = [
      {
        x: this.car.x,
        y: this.car.y,
        vx: Math.cos(this.car.angle) * this.car.speed + this.knock.x,
        vy: Math.sin(this.car.angle) * this.car.speed + this.knock.y,
        fixed: this.refueling,
        bot: null,
      },
    ];
    for (const b of this.bots) {
      if (b.status !== "active") continue;
      cars.push({
        x: b.x,
        y: b.y,
        vx: Math.cos(b.angle) * b.speed + b.kx,
        vy: Math.sin(b.angle) * b.speed + b.ky,
        fixed: b.wait > 0,
        bot: b,
      });
    }

    const contact = COLLIDE_R * 2;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= contact) continue;
        if (d < 0.001) {
          dx = 1;
          dy = 0;
          d = 0.001;
        }
        const nx = dx / d;
        const ny = dy / d;

        // расталкиваем, чтобы кузова не слипались
        const push = contact - d;
        const wa = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        const wb = b.fixed ? 0 : a.fixed ? 1 : 0.5;
        this.moveCar(a, -nx * push * wa, -ny * push * wa);
        this.moveCar(b, nx * push * wb, ny * push * wb);

        // кто в кого въехал: сравниваем сближение вдоль оси удара
        const intoB = a.vx * nx + a.vy * ny;
        const intoA = -(b.vx * nx + b.vy * ny);
        // едут рядом и лишь коснулись боками — просто разъезжаются, без тарана,
        // иначе машины в потоке бесконечно пинали бы друг друга
        if (Math.max(intoB, intoA) < RAM_MIN) continue;
        const aRams = intoB >= intoA;
        const rammer = aRams ? a : b;
        const victim = aRams ? b : a;
        const dirX = aRams ? nx : -nx;
        const dirY = aRams ? ny : -ny;
        const force = clamp(Math.max(intoB, intoA) * KICK, KICK_MIN, KICK_MAX);

        const cx = a.x + nx * COLLIDE_R;
        const cy = a.y + ny * COLLIDE_R;
        const withPlayer = a.bot === null || b.bot === null;
        this.brakeRammer(rammer, -dirX * force * 0.16, -dirY * force * 0.16);
        this.crashEffects(cx, cy, force, withPlayer);
        // догнал и протаранил игрока — на этом охота заканчивается
        if (rammer.bot && !victim.bot) {
          rammer.bot.aggro = 0;
          rammer.bot.aggroCd = 16 + Math.random() * 10;
        }
        // машина под колонкой — стенка: её не отбросить и канистры из неё не выбить
        if (victim.fixed) continue;
        this.kick(victim, dirX * force, dirY * force);
        // канистры вылетают из протараненной машины
        const carried = victim.bot ? victim.bot.taken : this.canisters;
        if (carried > 0) this.spillCanisters(victim, carried, cx, cy);
      }
    }
  }

  private moveCar(c: { x: number; y: number; bot: Bot | null }, dx: number, dy: number): void {
    if (!dx && !dy) return;
    c.x += dx;
    c.y += dy;
    if (c.bot) {
      c.bot.x = c.x;
      c.bot.y = c.y;
    } else {
      this.car.x = c.x;
      this.car.y = c.y;
    }
  }

  private kick(c: { fixed: boolean; bot: Bot | null }, kx: number, ky: number): void {
    if (c.fixed) return;
    if (c.bot) {
      c.bot.kx += kx;
      c.bot.ky += ky;
      c.bot.stun = STUN_S;
      c.bot.speed *= 0.4;
      c.bot.angle += (Math.random() - 0.5) * 0.9;
      c.bot.think = 0;
      // получил сдачи — охота окончена
      c.bot.aggro = 0;
      c.bot.aggroCd = 8 + Math.random() * 8;
    } else {
      this.knock.x += kx;
      this.knock.y += ky;
      this.car.speed *= 0.45;
      this.cam.shake = Math.min(18, this.cam.shake + Math.hypot(kx, ky) / 42);
    }
  }

  private brakeRammer(c: { fixed: boolean; bot: Bot | null }, kx: number, ky: number): void {
    if (c.fixed) return;
    if (c.bot) {
      c.bot.kx += kx;
      c.bot.ky += ky;
      c.bot.speed *= 0.55;
    } else {
      this.knock.x += kx;
      this.knock.y += ky;
      this.car.speed *= 0.6;
      this.cam.shake = Math.min(14, this.cam.shake + 4);
    }
  }

  private crashEffects(x: number, y: number, force: number, playerInvolved: boolean): void {
    if (!playerInvolved) {
      // столкновений ботов между собой может быть много — эффекты придерживаем
      if (this.crashCd > 0) return;
      this.crashCd = 0.25;
    }
    const n = force > 300 ? 12 : 7;
    for (let i = 0; i < n; i++) {
      this.spawn(x, y, "spark", i % 2 ? "#ffd27a" : "#fff2cf", 0.5, 130);
      this.spawn(x, y, "smoke", "rgba(150,158,175,0.4)", 0.6, 45);
    }
    if (playerInvolved) sfx.thud();
  }

  /** канистры протараненной машины разлетаются вокруг места удара */
  private spillCanisters(
    victim: { bot: Bot | null },
    count: number,
    x: number,
    y: number
  ): void {
    const pool = this.city.canisters.filter((k) => k.taken);
    const drop = Math.min(count, pool.length);
    if (drop <= 0) return;
    for (let i = 0; i < drop; i++) {
      const k = pool[i];
      const spot = this.spillSpot(x, y);
      k.x = spot.x;
      k.y = spot.y;
      k.taken = false;
      k.cool = CANISTER_COOL;
      for (let s = 0; s < 8; s++) {
        this.spawn(k.x, k.y, "spark", s % 2 ? CANISTER_ACCENT : "#d8f2ff", 0.5, 110);
      }
    }
    if (victim.bot) {
      victim.bot.taken -= drop;
      victim.bot.tankVolume = Math.max(
        CONFIG.startTankVolume,
        victim.bot.tankVolume - drop * CONFIG.canisterTankBonus
      );
      victim.bot.fuel = Math.min(victim.bot.fuel, victim.bot.tankVolume);
      victim.bot.gotCanister = victim.bot.taken > 0;
      victim.bot.think = 0;
    } else {
      // у игрока канистра — это ещё и +10 л к баку, значит бак сдувается обратно
      this.canisters -= drop;
      this.fuelMax = Math.max(CONFIG.startTankVolume, this.fuelMax - drop * CANISTER_L);
      this.fuel = Math.min(this.fuel, this.fuelMax);
      this.cb.onCanisterLost(drop, this.canisters);
    }
  }

  /** точка для выпавшей канистры: рядом с ударом, но не внутри здания */
  private spillSpot(x: number, y: number): { x: number; y: number } {
    for (let tries = 0; tries < 12; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = SPILL_R * (0.35 + Math.random() * 0.65);
      const px = clamp(x + Math.cos(a) * r, 40, WORLD - 40);
      const py = clamp(y + Math.sin(a) * r, 40, WORLD - 40);
      const blocked = this.city.buildings.some(
        (q) => px > q.x - 6 && px < q.x + q.w + 6 && py > q.y - 6 && py < q.y + q.h + 6
      );
      if (!blocked) return { x: px, y: py };
    }
    return { x: clamp(x, 40, WORLD - 40), y: clamp(y, 40, WORLD - 40) };
  }

  /* -------- боты-конкуренты -------- */

  private updateBots(dt: number): void {
    for (let index = 0; index < this.bots.length; index++) {
      let b = this.bots[index];
      const step = stepBot(b, this.city, dt, this.car, refuelDuration(b.taken));
      if (step.respawn) {
        const occupied = this.bots.filter((other, otherIndex) => otherIndex !== index && other.status === "active");
        b = createBot(this.city, index, START, occupied);
        this.bots[index] = b;
        this.leaderboardDirty = true;
        continue;
      }
      if (step.lost) {
        this.leaderboardDirty = true;
        continue;
      }
      this.keepBotOutOfWalls(b);
      if (step.took) {
        for (let i = 0; i < 12; i++) {
          this.spawn(b.x, b.y, "spark", i % 2 ? CANISTER_ACCENT : "#d8f2ff", 0.6, 120);
        }
        // указатель на эту канистру гаснет красным — её увели из-под носа
        this.killPointer(step.took.x, step.took.y, CANISTER_ICON_PATH);
      }
      // бот встал под колонку — она блокируется по тем же правилам, что и у игрока,
      // но без сообщений игроку: боты иначе завалят экран тостами
      if (step.soldAt) {
        for (let i = 0; i < 10; i++) {
          this.spawn(step.soldAt.x, step.soldAt.y, "confetti", i % 2 ? "#ffd27a" : BASE_ACCENT, 0.8, 200);
        }
      }
      if (step.refuelAt) {
        this.takeStation(step.refuelAt, b.taken, false);
      }
      if (step.filledLiters > 0) this.leaderboardDirty = true;
    }
  }

  /**
   * Запись своей колонки слышна полностью. Записи колонок соперников затихают
   * по мере удаления машины игрока от площадки и неслышны за пределами радиуса.
   */
  private syncRefuelingSounds(): void {
    const sounds = new Map<string, number>();
    if (this.refueling && this.refuelStation) sounds.set("player", 1);

    if (this.online?.connected) {
      for (const [id, entity] of this.remoteEntities) {
        if (entity.bot.wait <= 0 || !entity.bot.at) continue;
        sounds.set(`remote:${id}`, this.refuelingVolumeAt(entity.bot.at));
      }
    } else {
      for (let index = 0; index < this.bots.length; index++) {
        const bot = this.bots[index];
        if (bot.wait <= 0 || !bot.at) continue;
        sounds.set(`bot:${index}`, this.refuelingVolumeAt(bot.at));
      }
    }

    sfx.syncRefueling(sounds);
  }

  private refuelingVolumeAt(station: Station): number {
    const nearestX = clamp(this.car.x, station.x, station.x + station.w);
    const nearestY = clamp(this.car.y, station.y, station.y + station.h);
    const distance = Math.hypot(this.car.x - nearestX, this.car.y - nearestY);
    const proximity = clamp(1 - distance / REFUELING_HEARING_DISTANCE, 0, 1);
    return proximity ** 1.5;
  }

  /** боты гоняют на скорости игрока, так что в стены их тоже надо не пускать */
  private keepBotOutOfWalls(b: Bot): void {
    for (const q of this.city.buildings) {
      if (b.x < q.x - CAR_R || b.x > q.x + q.w + CAR_R || b.y < q.y - CAR_R || b.y > q.y + q.h + CAR_R) continue;
      const px = clamp(b.x, q.x, q.x + q.w);
      const py = clamp(b.y, q.y, q.y + q.h);
      const dx = b.x - px;
      const dy = b.y - py;
      const d = Math.hypot(dx, dy);
      if (d >= CAR_R) continue;
      if (d < 0.001) {
        // угодил внутрь — выталкиваем через ближайшую стену
        const l = b.x - q.x;
        const r = q.x + q.w - b.x;
        const t = b.y - q.y;
        const bt = q.y + q.h - b.y;
        const m = Math.min(l, r, t, bt);
        if (m === l) b.x = q.x - CAR_R;
        else if (m === r) b.x = q.x + q.w + CAR_R;
        else if (m === t) b.y = q.y - CAR_R;
        else b.y = q.y + q.h + CAR_R;
      } else {
        const push = (CAR_R - d) / d;
        b.x += dx * push;
        b.y += dy * push;
      }
      b.speed *= 0.55;
      b.think = 0;
    }
  }

  /* -------- топливо: расход, заправка, глохнем -------- */

  private updateFuel(dt: number): void {
    const c = this.car;
    const sp = Math.abs(c.speed);
    const speed01 = sp / this.getPlayerMaxSpeed();
    const up = this.keys.has("up");
    // доли считаются от «расхода на полном газу»: холостой ход, газ и ручник
    const burn =
      CONFIG.fuelBurnPerSecond *
      this.fuelConsumptionMultiplier *
      (0.09 +
        (up && !this.stalled ? 0.42 + speed01 * 0.49 : 0) +
        (this.keys.has("hb") && sp > 250 ? 0.39 : 0));
    if (!this.stalled) {
      // под колонкой топливо не жжём — машина стоит с заглушённым мотором
      if (!this.refueling) {
        this.fuel = Math.max(0, this.fuel - burn * dt);
        if (this.fuel <= 0) {
          this.stalled = true;
          this.refueling = false;
          this.cam.shake = Math.min(14, this.cam.shake + 9);
          sfx.stall();
          for (let i = 0; i < 16; i++) {
            this.spawn(c.x, c.y, "smoke", "rgba(120,126,138,0.5)", 1.1, 60);
          }
        }
      }
    } else {
      if (sp > 30 && Math.random() < dt * 12) {
        this.spawn(
          c.x - Math.cos(c.angle) * 18,
          c.y - Math.sin(c.angle) * 18,
          "smoke",
          "rgba(105,112,124,0.5)",
          1,
          40
        );
      }
      if (sp < 24 && !this.gameOverSent) {
        this.gameOverSent = true;
        this.cb.onGameOver({ time: this.time, found: this.found });
      }
    }
    // отложенные открытия: каждая занятая колонка через свои T секунд открывает другую
    for (let i = this.unlockQueue.length - 1; i >= 0; i--) {
      const q = this.unlockQueue[i];
      q.t -= dt;
      if (q.t > 0) continue;
      this.unlockQueue.splice(i, 1);
      this.unlockRandom("timer", q.notify, q.from);
    }
    // Заправка начинается только на работающей АЗС. Доступный объём (место в
    // баке, лимит колонки и деньги) плавно наливается ровно за T из config.ts:
    // базовое время на машину + время на каждую канистру.
    let at: Station | null = null;
    if (!this.stalled) {
      for (const s of this.city.stations) {
        if (c.x > s.x - 6 && c.x < s.x + s.w + 6 && c.y > s.y - 6 && c.y < s.y + s.h + 6) {
          at = s;
          break;
        }
      }
    }
    // повторно вставать под ту же колонку, не съехав с площадки, нельзя:
    // иначе долитый до полного бак сразу тратит пару капель и заправка
    // начинается заново, а машина остаётся заблокированной навсегда
    const canStart = !!at && at.state === "active" && at !== this.usedStation;

    if (at && canStart && !this.refueling) {
      const room = this.fuelMax - this.fuel;
      const allowance = at.limit === null ? Infinity : Math.max(0, at.limit);
      const affordable = at.price > 0 ? this.money / at.price : Infinity;
      const target = Math.max(0, Math.min(room, allowance, affordable));
      if (target > 0.0005) {
        // машина клюнула носом и встала под колонку — колонка занята
        this.refuelStation = at;
        this.sessionLiters = 0;
        this.sessionSpent = 0;
        this.sessionTargetLiters = target;
        this.sessionDuration = refuelDuration(this.canisters);
        this.sessionElapsed = 0;
        this.sessionStop =
          room <= target + 0.0005 ? "full" : allowance <= target + 0.0005 ? "limit" : "money";
        this.refueling = true;
        this.takeStation(at, this.canisters, true);
        this.cam.shake = Math.min(12, this.cam.shake + Math.abs(c.speed) / 90);
        for (let i = 0; i < 8; i++) {
          this.spawn(c.x, c.y, "smoke", "rgba(150,160,178,0.35)", 0.7, 40);
        }
      }
    }

    if (this.refueling && at && at === this.refuelStation) {
      const duration = Math.max(0, this.sessionDuration);
      const nextElapsed = duration <= 0 ? duration : Math.min(duration, this.sessionElapsed + dt);
      const desiredLiters =
        duration <= 0
          ? this.sessionTargetLiters
          : this.sessionTargetLiters * (nextElapsed / duration);
      const step = Math.max(0, Math.min(this.sessionTargetLiters - this.sessionLiters, desiredLiters - this.sessionLiters));
      this.sessionElapsed = nextElapsed;
      const was = this.fuel;
      this.fuel = Math.min(this.fuelMax, this.fuel + step);
      const paid = (this.fuel - was) * at.price;
      this.money = Math.max(0, this.money - paid);
      const filled = this.fuel - was;
      this.sessionLiters += filled;
      this.totalLitersFilled += filled;
      if (filled > 0) this.leaderboardDirty = true;
      this.sessionSpent += paid;
      if (Math.random() < dt * 24) {
        this.spawn(c.x + (Math.random() - 0.5) * 26, c.y + (Math.random() - 0.5) * 26, "spark", "#7ee08a", 0.6, 70);
      }
      if (was < this.fuelMax && this.fuel >= this.fuelMax) {
        sfx.tankFull();
        for (let i = 0; i < 22; i++) {
          this.spawn(c.x, c.y - 10, "confetti", i % 2 ? "#7ee08a" : "#ffe08a", 0.9, 300);
        }
      }

      const complete =
        this.sessionLiters >= this.sessionTargetLiters - 0.0005 ||
        duration <= 0 ||
        this.sessionElapsed >= duration;
      if (!complete) {
        // предупреждение о низком баке во время заправки не проигрываем
        return;
      }

      if (this.sessionStop !== "full") this.cb.onRefuelStop(this.sessionStop);
      const completedStation = this.refuelStation;
      this.refueling = false;
      this.refuelStation = null;
      this.usedStation = completedStation;
    } else if (this.refueling) {
      // За обычной ездой уйти нельзя: управление на время обслуживания
      // заблокировано. Ветка нужна для замены карты или внешнего телепорта.
      this.refueling = false;
      this.usedStation = this.refuelStation;
      this.refuelStation = null;
    } else if (this.usedStation) {
      if (at !== this.usedStation) this.usedStation = null;
    } else if (at?.state === "active") {
      // Полный бак: площадка использована, пока машина с неё не съедет.
      this.usedStation = at;
    }
    // предупреждение о низком баке
    if (!this.stalled && this.fuel < this.fuelMax * 0.22 && this.fuel > 0) {
      this.warnCd -= dt;
      if (this.warnCd <= 0) {
        sfx.warn();
        this.warnCd = 1.7;
      }
    }
  }

  /**
   * К колонке встала машина: АЗС блокируется сразу, а через то же время T,
   * которое занимает обслуживание машины, откроется другая случайная.
   * Станция, открытая за рекламу, цепочку не запускает. notify — показывать ли
   * игроку сообщения (для ботов молчим).
   */
  private takeStation(s: Station, canisters: number, notify: boolean): void {
    if (s.state !== "active") return;
    s.state = "locked";
    this.killPointer(s.x + s.w / 2, s.y + s.h / 2, FUEL_ICON_PATH);
    this.stationsActive = Math.max(0, this.stationsActive - 1);
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2 - 20;
    for (let i = 0; i < 12; i++) {
      this.spawn(cx, cy, "smoke", "rgba(112,118,130,0.55)", 1.15, 55);
    }
    if (notify) {
      sfx.stationLock();
      this.cb.onStationLock(this.stationsActive, this.city.stations.length);
    }
    if (s.origin !== "ad") {
      const t = CONFIG.stationTimeoutBase + CONFIG.stationTimeoutPerCanister * canisters;
      this.unlockQueue.push({ t, from: s, notify });
    }
  }

  private setNearbyInactiveStation(station: Station | null, inReach = false): void {
    const reach = station !== null && inReach;
    if (this.nearbyInactiveStation === station && this.nearbyStationInReach === reach) return;
    this.nearbyInactiveStation = station;
    this.nearbyStationInReach = reach;
    this.cb.onInactiveStationNearby(station !== null, reach);
  }

  private updateNearbyInactiveStation(): void {
    if (this.refueling) {
      this.setNearbyInactiveStation(null);
      return;
    }

    let nearest: Station | null = null;
    let nearestDistance = INACTIVE_STATION_PROXIMITY;
    for (const station of this.city.stations) {
      if (
        station.state !== "locked" ||
        station === this.refuelStation ||
        station === this.usedStation
      ) {
        continue;
      }
      const closestX = clamp(this.car.x, station.x, station.x + station.w);
      const closestY = clamp(this.car.y, station.y, station.y + station.h);
      const distance = Math.hypot(this.car.x - closestX, this.car.y - closestY);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearest = station;
      }
    }
    this.setNearbyInactiveStation(nearest, nearestDistance <= INACTIVE_STATION_REACH);
  }

  private activateStation(
    station: Station,
    origin: "timer" | "ad",
    notify: boolean
  ): boolean {
    if (station.state !== "locked") return false;
    station.state = "active";
    station.origin = origin;
    this.rollStationOffer(station);
    this.stationsActive += 1;
    const cx = station.x + station.w / 2;
    const cy = station.y + station.h / 2;
    for (let i = 0; i < 18; i++) {
      this.spawn(cx, cy, "spark", i % 2 ? "#ffd27a" : "#7ee08a", 0.8, 260);
    }
    if (notify) {
      sfx.unlock();
      this.cb.onStationUnlock(this.stationsActive, this.city.stations.length, origin);
    }
    return true;
  }

  /** открыть случайную АЗС из закрытых (по таймеру или за просмотр рекламы) */
  private unlockRandom(origin: "timer" | "ad", notify = true, exclude: Station | null = null): void {
    let locked = this.city.stations.filter((x) => x.state === "locked");
    // «другая случайная»: ту же колонку не открываем, если есть из чего выбрать
    if (exclude && locked.some((x) => x !== exclude)) locked = locked.filter((x) => x !== exclude);
    if (!locked.length) return;
    const st = locked[Math.floor(Math.random() * locked.length)];
    this.activateStation(st, origin, notify);
  }

  private pushSkid(a: { x: number; y: number }, b: { x: number; y: number }): void {
    this.skids.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, a: 0.5 });
    if (this.skids.length > 640) this.skids.splice(0, this.skids.length - 640);
  }

  private isOnRoad(x: number, y: number): boolean {
    return this.city.roadCenters.some((c) => Math.abs(x - c) < ROAD / 2 || Math.abs(y - c) < ROAD / 2);
  }

  /**
   * Упор в стены и щиты. `interactive` включает локальную выдачу щита: в онлайне
   * это решает сервер (updateOnlineInteractions), а здесь остаётся только физика.
   */
  private collide(interactive = true): void {
    const c = this.car;
    const hx = Math.cos(c.angle);
    const hy = Math.sin(c.angle);
    // Насколько удар пришёлся «в лоб»: 1 — влетели в стену прямо, около нуля —
    // прошли по ней вскользь. Из всех касаний за кадр берём самое лобовое.
    let head = 0;
    const note = (n: { nx: number; ny: number } | null) => {
      if (n) head = Math.max(head, Math.abs(hx * n.nx + hy * n.ny));
    };
    let hit = false;
    let billboardContact: Billboard | null = null;

    for (const b of this.city.buildings) {
      const n = this.resolveRect(b);
      if (n) {
        hit = true;
        note(n);
      }
    }
    for (const b of this.city.billboards) {
      // щиты не тормозят: в них и надо влетать
      if (this.resolveRect(b)) {
        billboardContact = b;
        // Повторное взаимодействие возможно, но только после того, как игрок
        // отъехал от щита и снова в него въехал.
        if (interactive && this.billboardContact !== b && b.state === "ready") {
          if (this.hasInactiveStations()) {
            this.requestBillboardAd(b, (wasShown) => {
              if (wasShown && b.state === "ready" && this.hasInactiveStations()) {
                this.discover(b);
              }
            });
          }
          else this.cb.onBillboardUnavailable();
        }
      }
    }
    if (interactive) this.billboardContact = billboardContact;
    // деревья (мягко, по «стволу»)
    for (const t of this.city.trees) {
      const dx = c.x - t.x;
      const dy = c.y - t.y;
      const rr = CAR_R + t.r * 0.4;
      const d2 = dx * dx + dy * dy;
      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        c.x += (dx / d) * (rr - d);
        c.y += (dy / d) * (rr - d);
        c.speed *= 0.72;
        if (this.leafCd <= 0) {
          this.leafCd = 0.4;
          for (let i = 0; i < 6; i++) this.spawn(t.x, t.y - 10, "leaf", "#4d8a5c", 0.7, 90);
        }
      }
    }
    // границы мира
    const W = WORLD;
    if (c.x < CAR_R + 20) {
      c.x = CAR_R + 20;
      hit = true;
      note({ nx: 1, ny: 0 });
    }
    if (c.x > W - CAR_R - 20) {
      c.x = W - CAR_R - 20;
      hit = true;
      note({ nx: -1, ny: 0 });
    }
    if (c.y < CAR_R + 20) {
      c.y = CAR_R + 20;
      hit = true;
      note({ nx: 0, ny: 1 });
    }
    if (c.y > W - CAR_R - 20) {
      c.y = W - CAR_R - 20;
      hit = true;
      note({ nx: 0, ny: -1 });
    }

    if (hit) {
      const sp = Math.abs(c.speed);
      // Гасим только ту часть хода, что пришлась в стену. Раньше любое касание
      // съедало больше половины скорости, и чиркнуть о дом углом было обиднее,
      // чем врезаться: теперь по стене машина проезжает, а не встаёт.
      if (sp > 70 && head > 0.3) {
        c.speed *= 1 - 0.58 * head;
        this.cam.shake = Math.min(14, (5 + sp * 0.012) * head);
        for (let i = 0; i < 9; i++) {
          this.spawn(c.x + hx * 14, c.y + hy * 14, "spark", i % 2 ? "#ffd27a" : "#c9cdd6", 0.35, 210);
        }
        if (this.bumpCd <= 0) {
          this.bumpCd = 0.28;
          sfx.thud();
        }
      } else if (sp > 70) {
        // чирк по стене: теряем тем меньше, чем острее угол
        c.speed *= 1 - 0.6 * head;
        if (sp > 220) this.spawn(c.x + hx * 14, c.y + hy * 14, "spark", "#c9cdd6", 0.25, 150);
      } else {
        c.speed *= 0.78;
      }
    }
  }

  /**
   * Выталкивает машину из прямоугольника. Возвращает нормаль стены, в которую
   * упёрлись, — по ней видно, лобовой это удар или касание вскользь.
   */
  private resolveRect(r: Rect): { nx: number; ny: number } | null {
    const c = this.car;
    const px = clamp(c.x, r.x, r.x + r.w);
    const py = clamp(c.y, r.y, r.y + r.h);
    const dx = c.x - px;
    const dy = c.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= CAR_R * CAR_R) return null;
    const d = Math.sqrt(d2);
    if (d < 0.001) {
      const l = c.x - r.x;
      const rt = r.x + r.w - c.x;
      const t = c.y - r.y;
      const bt = r.y + r.h - c.y;
      const m = Math.min(l, rt, t, bt);
      if (m === l) {
        c.x = r.x - CAR_R;
        return { nx: -1, ny: 0 };
      }
      if (m === rt) {
        c.x = r.x + r.w + CAR_R;
        return { nx: 1, ny: 0 };
      }
      if (m === t) {
        c.y = r.y - CAR_R;
        return { nx: 0, ny: -1 };
      }
      c.y = r.y + r.h + CAR_R;
      return { nx: 0, ny: 1 };
    }
    const push = (CAR_R - d) / d;
    c.x += dx * push;
    c.y += dy * push;
    return { nx: dx / d, ny: dy / d };
  }

  private discover(b: Billboard): void {
    const firstVisit = !b.discovered;
    b.discovered = true;
    b.state = "done";
    b.cooldown = CONFIG.billboardTimeout;
    if (firstVisit) this.found += 1;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2 - 20;
    const colors = [b.client.color, "#fdf3e0", "#ffd27a", shade(b.client.color, 0.75)];
    for (let i = 0; i < 30; i++) {
      this.spawn(cx, cy, "confetti", colors[i % colors.length], 0.95, 330);
    }
    sfx.chime();
    this.unlockRandom("ad"); // просмотр рекламы активирует ещё одну АЗС
    if (firstVisit && this.found >= this.total && !this.won) {
      this.won = true;
      sfx.win();
      this.cb.onWin({ time: this.time, top: Math.round(this.topSpeed * KMH) });
    }
  }

  /* ---------------- particles ---------------- */

  private spawn(x: number, y: number, kind: ParticleKind, color: string, life: number, vel: number): void {
    if (this.particles.length > 420) this.particles.shift();
    const a = Math.random() * Math.PI * 2;
    const v = vel * (0.35 + Math.random() * 0.65);
    this.particles.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life,
      max: life,
      size: kind === "smoke" ? 5 + Math.random() * 5 : 3 + Math.random() * 4,
      color,
      kind,
      rot: Math.random() * Math.PI,
    });
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 2.4 * dt;
      p.vy *= 1 - 2.4 * dt;
      if (p.kind === "smoke") p.size += 9 * dt;
      p.rot += dt * 6;
    }
  }

  /* ---------------- render ---------------- */

  private render(dt: number): void {
    const { ctx } = this;
    const w = this.vw;
    const h = this.vh;

    // камера
    let tx: number;
    let ty: number;
    let tz: number;
    if (this.phase === "menu") {
      const t = this.wall * 0.055;
      tx = WORLD / 2 + Math.cos(t) * WORLD * 0.26;
      ty = WORLD / 2 + Math.sin(t * 0.77) * WORLD * 0.24;
      tz = 0.66;
    } else {
      const sp = Math.abs(this.car.speed);
      tx = this.car.x + Math.cos(this.car.angle) * sp * 0.33;
      ty = this.car.y + Math.sin(this.car.angle) * sp * 0.33;
      tz = 1.04 - (sp / this.getPlayerMaxSpeed()) * 0.22;
    }
    const kp = 1 - Math.exp(-6 * dt);
    const kz = 1 - Math.exp(-3 * dt);
    this.cam.x += (tx - this.cam.x) * kp;
    this.cam.y += (ty - this.cam.y) * kp;
    this.cam.zoom += (tz - this.cam.zoom) * kz;
    this.cam.shake *= Math.exp(-7 * dt);

    const zoom = this.cam.zoom;
    const shx = (Math.random() - 0.5) * this.cam.shake;
    const shy = (Math.random() - 0.5) * this.cam.shake;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0d1420";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2 + shx, h / 2 + shy);
    ctx.scale(zoom, zoom);
    ctx.translate(-this.cam.x, -this.cam.y);

    const pad = 60;
    const vis: Rect = {
      x: this.cam.x - w / 2 / zoom - pad,
      y: this.cam.y - h / 2 / zoom - pad,
      w: w / zoom + pad * 2,
      h: h / zoom + pad * 2,
    };

    this.drawGround(vis);
    this.drawRoads(vis);
    this.drawStations(vis);
    this.drawSkids(vis);
    this.drawBase(vis);
    this.drawCanisters(vis);
    this.drawBillboardsLayer(vis);
    this.drawTrees(vis);
    this.drawBuildings(vis);
    this.drawLamps(vis);
    this.drawParticles("smoke");
    this.drawBots(vis);
    this.drawCar();
    this.drawPlayerNick();
    this.drawParticles("solid");
    this.drawRefuelInfo(vis);
    this.lightPass(vis);

    // виньетка
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.72);
    vg.addColorStop(0, "rgba(4,7,18,0)");
    vg.addColorStop(1, "rgba(4,7,18,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    if (this.phase === "play") this.drawPointers(shx, shy);

    this.drawMinimap();
  }

  /** конус фар в мировых координатах (рисуется в аддитивном проходе света) */
  private paintHeadlights(x: number, y: number, angle: number, reach: number, alpha: number): void {
    const { ctx } = this;
    const hx = Math.cos(angle);
    const hy = Math.sin(angle);
    const px = -hy;
    const py = hx;
    const spread = reach * 0.2;
    for (const s of [-7, 7]) {
      const ox = x + hx * 19 + px * s;
      const oy = y + hy * 19 + py * s;
      const fx = x + hx * reach;
      const fy = y + hy * reach;
      const g = ctx.createLinearGradient(ox, oy, fx, fy);
      g.addColorStop(0, `rgba(255,224,158,${alpha})`);
      g.addColorStop(1, "rgba(255,224,158,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(fx + px * spread, fy + py * spread);
      ctx.lineTo(fx - px * spread, fy - py * spread);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(255,236,190,${Math.min(0.5, alpha * 1.7)})`;
      ctx.beginPath();
      ctx.arc(ox, oy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawGround(vis: Rect): void {
    const { ctx } = this;
    const gx = Math.max(vis.x, -80);
    const gy = Math.max(vis.y, -80);
    const gw = Math.min(vis.x + vis.w, WORLD + 80) - gx;
    const gh = Math.min(vis.y + vis.h, WORLD + 80) - gy;
    ctx.fillStyle = "#2b4233";
    ctx.fillRect(gx, gy, gw, gh);

    // кварталы: тротуар + внутренняя часть
    for (const b of this.city.blocks) {
      if (!inView(b, vis)) continue;
      ctx.fillStyle = "#49515f";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = "#5d6678";
      ctx.lineWidth = 3;
      ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
      const park = this.city.parks.find((p) => p.x === b.x && p.y === b.y);
      const ix = b.x + SIDEWALK;
      const iy = b.y + SIDEWALK;
      const iw = b.w - SIDEWALK * 2;
      if (park) {
        ctx.fillStyle = "#31513d";
        ctx.fillRect(ix, iy, iw, iw);
        ctx.fillStyle = "rgba(226,255,238,0.05)";
        for (let sy = iy; sy < iy + iw; sy += 64) ctx.fillRect(ix, sy, iw, 26);
        if (park.pond) {
          ctx.fillStyle = "#23455c";
          ctx.beginPath();
          ctx.ellipse(park.pond.x, park.pond.y, park.pond.r * 1.15, park.pond.r, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#31586e";
          ctx.lineWidth = 5;
          ctx.stroke();
          ctx.fillStyle = "rgba(120,180,210,0.14)";
          ctx.beginPath();
          ctx.ellipse(park.pond.x - park.pond.r * 0.2, park.pond.y - park.pond.r * 0.2, park.pond.r * 0.5, park.pond.r * 0.38, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = "#3e4653";
        ctx.fillRect(ix, iy, iw, iw);
      }
    }

    // граница мира
    ctx.strokeStyle = "#3f4655";
    ctx.lineWidth = 24;
    ctx.strokeRect(0, 0, WORLD, WORLD);
    ctx.strokeStyle = "#59627a";
    ctx.lineWidth = 3;
    ctx.strokeRect(14, 14, WORLD - 28, WORLD - 28);
  }

  private drawRoads(vis: Rect): void {
    const { ctx } = this;
    const centers = this.city.roadCenters;
    ctx.fillStyle = "#23272f";
    for (const c of centers) {
      if (c + ROAD / 2 >= vis.x && c - ROAD / 2 <= vis.x + vis.w) ctx.fillRect(c - ROAD / 2, 0, ROAD, WORLD);
      if (c + ROAD / 2 >= vis.y && c - ROAD / 2 <= vis.y + vis.h) ctx.fillRect(0, c - ROAD / 2, WORLD, ROAD);
    }
    // кромки
    ctx.strokeStyle = "#3a4250";
    ctx.lineWidth = 3;
    for (const c of centers) {
      if (c + ROAD / 2 >= vis.x && c - ROAD / 2 <= vis.x + vis.w) {
        this.vline(c - ROAD / 2 + 5, vis);
        this.vline(c + ROAD / 2 - 5, vis);
      }
      if (c + ROAD / 2 >= vis.y && c - ROAD / 2 <= vis.y + vis.h) {
        this.hline(c - ROAD / 2 + 5, vis);
        this.hline(c + ROAD / 2 - 5, vis);
      }
    }
    // осевая разметка (пунктир), сегментами между перекрёстками
    ctx.strokeStyle = "rgba(217,181,88,0.7)";
    ctx.lineWidth = 4;
    ctx.setLineDash([30, 36]);
    for (const c of centers) {
      for (let j = 0; j < centers.length - 1; j++) {
        const y0 = centers[j] + ROAD / 2 + 10;
        const y1 = centers[j + 1] - ROAD / 2 - 10;
        if (c >= vis.x && c <= vis.x + vis.w && y1 >= vis.y && y0 <= vis.y + vis.h) {
          ctx.beginPath();
          ctx.moveTo(c, Math.max(y0, vis.y - 40));
          ctx.lineTo(c, Math.min(y1, vis.y + vis.h + 40));
          ctx.stroke();
        }
        const x0 = centers[j] + ROAD / 2 + 10;
        const x1 = centers[j + 1] - ROAD / 2 - 10;
        if (c >= vis.y && c <= vis.y + vis.h && x1 >= vis.x && x0 <= vis.x + vis.w) {
          ctx.beginPath();
          ctx.moveTo(Math.max(x0, vis.x - 40), c);
          ctx.lineTo(Math.min(x1, vis.x + vis.w + 40), c);
          ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);

    // зебры на перекрёстках
    ctx.fillStyle = "rgba(226,232,240,0.3)";
    for (const cx of centers) {
      for (const cy of centers) {
        if (Math.abs(cx - this.cam.x) > vis.w / 2 + ROAD || Math.abs(cy - this.cam.y) > vis.h / 2 + ROAD) continue;
        const e = ROAD / 2;
        // подходы по вертикальной дороге (полосы вдоль оси Y)
        for (let k = 0; k < 7; k++) {
          const sx = cx - e + 14 + k * 21;
          ctx.fillRect(sx, cy - e - 56, 11, 44);
          ctx.fillRect(sx, cy + e + 12, 11, 44);
        }
        // подходы по горизонтальной
        for (let k = 0; k < 7; k++) {
          const sy = cy - e + 14 + k * 21;
          ctx.fillRect(cx - e - 56, sy, 44, 11);
          ctx.fillRect(cx + e + 12, sy, 44, 11);
        }
      }
    }
  }

  private vline(x: number, vis: Rect): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x, Math.max(0, vis.y - 40));
    ctx.lineTo(x, Math.min(WORLD, vis.y + vis.h + 40));
    ctx.stroke();
  }

  private hline(y: number, vis: Rect): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(Math.max(0, vis.x - 40), y);
    ctx.lineTo(Math.min(WORLD, vis.x + vis.w + 40), y);
    ctx.stroke();
  }

  private drawStations(vis: Rect): void {
    const { ctx } = this;
    for (const s of this.city.stations) {
      if (!inView(s, vis, 130)) continue;
      const active = s.state === "active";
      const left = s.corner === 0 || s.corner === 2;
      const top = s.corner === 0 || s.corner === 1;
      const cxw = s.x + s.w / 2;
      const cyw = s.y + s.h / 2;

      /* въезды через тротуар */
      ctx.fillStyle = "#262b34";
      if (left) ctx.fillRect(s.bx - 4, cyw - 46, s.x - (s.bx - 4), 92);
      else ctx.fillRect(s.x + s.w, cyw - 46, s.bx + BLOCK + 4 - (s.x + s.w), 92);
      if (top) ctx.fillRect(cxw - 46, s.by - 4, 92, s.y - (s.by - 4));
      else ctx.fillRect(cxw - 46, s.y + s.h, 92, s.by + BLOCK + 4 - (s.y + s.h));

      /* площадка */
      ctx.fillStyle = active ? "#2e343e" : "#272c34";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
      /* бордюр: рабочий — красно-белый, пустой — серый с тускло-красным */
      ctx.strokeStyle = active ? "#c8ccd2" : "#565d68";
      ctx.lineWidth = 4;
      ctx.strokeRect(s.x + 4, s.y + 4, s.w - 8, s.h - 8);
      ctx.save();
      ctx.strokeStyle = active ? "#d8452f" : "#7a3a30";
      ctx.setLineDash([14, 14]);
      ctx.strokeRect(s.x + 4, s.y + 4, s.w - 8, s.h - 8);
      ctx.restore();
      /* разметка */
      ctx.strokeStyle = active ? "rgba(230,225,210,0.22)" : "rgba(230,225,210,0.09)";
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 10]);
      ctx.strokeRect(s.x + 20, s.y + 20, s.w - 40, s.h - 40);
      ctx.setLineDash([]);

      /* колонки */
      for (let i = 0; i < 2; i++) {
        const px = s.x + s.w * (0.34 + i * 0.32);
        const py = s.y + s.h * 0.74;
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(px - 8 + 3, py - 15 + 3, 16, 30);
        ctx.fillStyle = active ? "#d8dde2" : "#5d646e";
        ctx.fillRect(px - 8, py - 15, 16, 30);
        ctx.fillStyle = active ? "#f2a93b" : "#7a5a30";
        ctx.fillRect(px - 8, py - 15, 16, 8);
        ctx.fillStyle = active ? "#3a414d" : "#232830";
        ctx.fillRect(px - 5, py - 2, 10, 9);
      }

      /* навес */
      const rw = 120;
      const rh = 72;
      const rx = cxw - rw / 2;
      const ry = cyw - rh / 2;
      ctx.fillStyle = "rgba(6,9,18,0.4)";
      ctx.fillRect(rx + 8, ry + 10, rw, rh);
      ctx.fillStyle = active ? "#8f979f" : "#4a515b";
      const posts: Array<[number, number]> = [
        [0.1, 0.14],
        [0.9, 0.14],
        [0.1, 0.86],
        [0.9, 0.86],
      ];
      for (const [fx, fy] of posts) ctx.fillRect(rx + rw * fx - 3, ry + rh * fy - 3, 6, 6);
      ctx.fillStyle = active ? "#e9edf0" : "#3b414b";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.fillStyle = active ? "#d33d2a" : "#6e3a33";
      ctx.fillRect(rx, ry, rw, 10);
      ctx.fillRect(rx, ry + rh - 10, rw, 10);
      ctx.strokeStyle = active ? "rgba(255,120,80,0.5)" : "rgba(120,80,70,0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(rx - 1, ry - 1, rw + 2, rh + 2);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (active) {
        ctx.fillStyle = "#b3402e";
        ctx.font = '17px "Russo One"';
        ctx.fillText("ОКТАН", cxw, cyw + 1);
      } else {
        ctx.fillStyle = "#d0604e";
        ctx.font = '12px "Russo One"';
        ctx.fillText("НЕТ ТОПЛИВА", cxw, cyw + 1);
      }

      /* вертикальная стела «АЗС» у въезда */
      const pulse = 0.55 + 0.45 * Math.sin(this.wall * 3.4 + s.x * 0.01);
      const bw = 20;
      const bh = 86;
      const bx = left ? s.x - 26 : s.x + s.w + 6;
      const by = cyw - bh / 2;
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(bx + 3, by + 3, bw, bh);
      ctx.fillStyle = "#14181f";
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = active ? `rgba(255,150,60,${0.45 + 0.55 * pulse})` : "rgba(120,80,70,0.4)";
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = active ? `rgba(255,176,80,${0.6 + 0.4 * pulse})` : "rgba(130,138,150,0.55)";
      ctx.font = '12px "Russo One"';
      const letters = ["А", "З", "С"];
      letters.forEach((ch, i) => ctx.fillText(ch, bx + bw / 2, by + 18 + i * 22));
      if (!active) {
        // мигающая красная точка — топлива нет
        ctx.fillStyle = `rgba(232,86,70,${0.35 + 0.65 * pulse})`;
        ctx.beginPath();
        ctx.arc(bx + bw / 2, by + bh - 12, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (active) this.drawStationOffer(s);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  private hasInactiveStations(): boolean {
    return this.city.stations.some((station) => station.state !== "active");
  }

  /** Ценник действующей АЗС: цена и условия отпуска видны прямо на карте. */
  private drawStationOffer(s: Station): void {
    const { ctx } = this;
    const priceText = `${s.price} ₽/л`;
    const limitText = s.limit === null ? "без ограничения" : `лимит ${s.limit} л`;
    const x = s.x + s.w / 2;
    const y = s.y - 20;

    ctx.save();
    ctx.font = '700 13px Rubik, system-ui, sans-serif';
    const width = Math.max(ctx.measureText(priceText).width, ctx.measureText(limitText).width) + 34;
    const height = 42;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y - height / 2, width, height, 8);
    ctx.fillStyle = "rgba(8,14,20,0.9)";
    ctx.fill();
    ctx.strokeStyle = rgba(STATION_ACCENT, 0.62);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = STATION_ACCENT;
    ctx.beginPath();
    ctx.arc(x - width / 2 + 12, y - 8, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f5d98e";
    ctx.fillText(priceText, x - width / 2 + 22, y - 8);
    ctx.font = '600 11px Rubik, system-ui, sans-serif';
    ctx.fillStyle = s.limit === null ? "#a9eab3" : "#ffae79";
    ctx.fillText(limitText, x - width / 2 + 12, y + 9);
    ctx.restore();
  }

  /** база нелегальной скупки: огороженный двор с цистернами и ценником */
  private drawBase(vis: Rect): void {
    const { ctx } = this;
    const b = this.city.base;
    if (!inView(b, vis, 120)) return;
    const pulse = 0.55 + 0.45 * Math.sin(this.wall * 2.2);
    ctx.save();
    // площадка
    ctx.fillStyle = "#241d33";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = rgba(BASE_ACCENT, 0.5);
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 3;
    ctx.strokeRect(b.x + 3, b.y + 3, b.w - 6, b.h - 6);
    ctx.setLineDash([]);
    // цистерны
    for (let i = 0; i < 3; i++) {
      const tx = b.x + 34 + i * 52;
      const ty = b.y + b.h - 58;
      ctx.fillStyle = "#3c3350";
      ctx.beginPath();
      ctx.roundRect(tx, ty, 40, 40, 12);
      ctx.fill();
      ctx.strokeStyle = "rgba(10,8,18,0.7)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = rgba(BASE_ACCENT, 0.5);
      ctx.fillRect(tx + 6, ty + 16, 28, 6);
    }
    // будка приёмщика
    ctx.fillStyle = "#33294a";
    ctx.beginPath();
    ctx.roundRect(b.x + b.w - 86, b.y + 22, 62, 54, 8);
    ctx.fill();
    ctx.fillStyle = rgba("#ffe9b0", 0.55 * pulse);
    ctx.fillRect(b.x + b.w - 74, b.y + 36, 38, 18);
    // вывеска
    ctx.font = '700 15px Rubik, system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(BASE_ACCENT, 0.85);
    ctx.fillText("БАЗА · СКУПКА ТОПЛИВА", b.x + b.w / 2, b.y + 24);
    ctx.font = '700 13px Rubik, system-ui, sans-serif';
    ctx.fillStyle = `rgba(255,233,176,${0.6 + 0.4 * pulse})`;
    ctx.fillText(`${CONFIG.fuelSellPrice} ₽ за литр`, b.x + b.w / 2, b.y + 46);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  private drawCanisters(vis: Rect): void {
    const { ctx } = this;
    for (const k of this.city.canisters) {
      if (k.taken) continue;
      if (!inView({ x: k.x - 36, y: k.y - 36, w: 72, h: 72 }, vis)) continue;
      const pulse = 0.55 + 0.45 * Math.sin(this.wall * 3 + k.x * 0.01);
      const bob = Math.sin(this.wall * 2.2 + k.y * 0.01) * 3;
      ctx.save();
      ctx.translate(k.x, k.y);

      // подсветка на асфальте
      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 34);
      g.addColorStop(0, rgba(CANISTER_ACCENT, 0.34 * pulse));
      g.addColorStop(1, rgba(CANISTER_ACCENT, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 34, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(0, 11, 13, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.translate(0, bob);
      // корпус канистры
      ctx.fillStyle = shade(CANISTER_ACCENT, 0.62);
      ctx.beginPath();
      ctx.roundRect(-11, -14, 22, 25, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(8,22,32,0.75)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // светлая грань и рёбра жёсткости
      ctx.fillStyle = rgba("#d8f2ff", 0.5);
      ctx.beginPath();
      ctx.roundRect(-8.5, -11.5, 6, 20, 2.5);
      ctx.fill();
      ctx.strokeStyle = "rgba(8,26,38,0.45)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-1, -10);
      ctx.lineTo(7.5, 7);
      ctx.stroke();
      // ручка и горловина
      ctx.strokeStyle = shade(CANISTER_ACCENT, 0.48);
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-6, -15.5);
      ctx.lineTo(6, -15.5);
      ctx.stroke();
      ctx.fillStyle = shade(CANISTER_ACCENT, 1.35);
      ctx.beginPath();
      ctx.arc(8.5, -13.5, 2.6, 0, Math.PI * 2);
      ctx.fill();

      // подпись «+10 л»
      ctx.font = "700 11px Rubik, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = rgba(CANISTER_ACCENT, 0.7 + 0.3 * pulse);
      ctx.fillText(`бак +${CANISTER_L} л`, 0, 24 - bob);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.restore();
    }
  }

  private drawSkids(vis: Rect): void {
    const { ctx } = this;
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    for (const s of this.skids) {
      if (Math.max(s.x1, s.x2) < vis.x || Math.min(s.x1, s.x2) > vis.x + vis.w) continue;
      if (Math.max(s.y1, s.y2) < vis.y || Math.min(s.y1, s.y2) > vis.y + vis.h) continue;
      ctx.strokeStyle = `rgba(16,18,24,${s.a})`;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
  }

  private drawBillboardsLayer(vis: Rect): void {
    const { ctx } = this;
    const available = this.hasInactiveStations();
    this.city.billboards.forEach((b, idx) => {
      if (!inView(b, vis, 80)) return;
      const cx = b.x + b.w / 2;
      const lift = 26;
      // тень
      ctx.fillStyle = "rgba(6,9,18,0.42)";
      ctx.beginPath();
      ctx.ellipse(cx + 9, b.y + b.h - 2, b.w * 0.52, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      // опоры
      ctx.fillStyle = "#161a23";
      ctx.fillRect(b.x + b.w * 0.24 - 3, b.y + b.h - lift, 6, lift + 2);
      ctx.fillRect(b.x + b.w * 0.76 - 3, b.y + b.h - lift, 6, lift + 2);
      // рама
      const px = b.x;
      const py = b.y - lift;
      ctx.fillStyle = "#0f1420";
      ctx.fillRect(px - 5, py - 5, b.w + 10, b.h + 10);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (b.state === "ready") {
        ctx.fillStyle = available ? "#141a26" : "#20242c";
        ctx.fillRect(px, py, b.w, b.h);
        ctx.fillStyle = available ? "#ffcf7d" : "#737b89";
        ctx.font = `${b.vertical ? 13 : 17}px "Russo One"`;
        ctx.fillText(available ? "ДОСТУПНО" : "НЕТ ЦЕЛЕЙ", cx, py + b.h / 2 - (b.vertical ? 4 : 9));
        if (!b.vertical) {
          ctx.fillStyle = available ? "rgba(255,207,125,0.6)" : "rgba(150,158,172,0.55)";
          ctx.font = "500 11px Rubik";
          ctx.fillText(available ? "откроет новую АЗС" : "все АЗС уже работают", cx, py + b.h / 2 + 13);
        }
      } else {
        const cl = b.client;
        ctx.fillStyle = cl.color;
        ctx.fillRect(px, py, b.w, b.h);
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        ctx.fillRect(px, py, b.w, 8);
        ctx.fillStyle = cl.ink;
        ctx.font = `${b.vertical ? 25 : 31}px "Russo One"`;
        ctx.fillText(cl.mark, cx, py + b.h / 2 - (b.vertical ? 22 : 9));
        // нижняя плашка с названием
        ctx.fillStyle = "rgba(8,10,18,0.3)";
        ctx.fillRect(px, py + b.h - 21, b.w, 21);
        ctx.save();
        ctx.beginPath();
        ctx.rect(px + 2, py + b.h - 21, b.w - 4, 21);
        ctx.clip();
        ctx.fillStyle = cl.ink;
        ctx.font = "600 11px Rubik";
        ctx.fillText(cl.name, cx, py + b.h - 10);
        ctx.restore();
        // зелёная отметка завершённого взаимодействия
        ctx.fillStyle = "#3ddc84";
        ctx.beginPath();
        ctx.arc(px + b.w - 1, py + 1, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#0c2b18";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(px + b.w - 6, py + 1);
        ctx.lineTo(px + b.w - 2, py + 5);
        ctx.lineTo(px + b.w + 4, py - 3);
        ctx.stroke();

        // Состояние done остаётся на щите до окончания настраиваемого таймаута.
        const seconds = Math.max(1, Math.ceil(b.cooldown));
        const chipW = Math.min(b.w - 14, 104);
        const chipH = 38;
        const chipY = py + b.h / 2 - chipH / 2;
        ctx.fillStyle = "rgba(7,10,17,0.84)";
        ctx.beginPath();
        ctx.roundRect(cx - chipW / 2, chipY, chipW, chipH, 7);
        ctx.fill();
        ctx.strokeStyle = "rgba(126,224,138,0.72)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = "#7ee08a";
        ctx.font = `700 ${b.vertical ? 9 : 10}px Rubik`;
        ctx.fillText("DONE", cx, chipY + 11);
        ctx.fillStyle = "#f2ecdf";
        ctx.font = `700 ${b.vertical ? 13 : 15}px "Russo One"`;
        ctx.fillText(`${seconds} С`, cx, chipY + 27);
      }
      const pulse = 0.5 + 0.5 * Math.sin(this.wall * 3 + idx * 1.7);
      const ready = b.state === "ready" && available;
      ctx.strokeStyle = ready
        ? `rgba(255,183,84,${0.3 + 0.55 * pulse})`
        : b.state === "done"
          ? "rgba(126,224,138,0.58)"
          : "rgba(110,118,132,0.35)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash(ready ? [10, 7] : [5, 9]);
      ctx.strokeRect(px + 5, py + 5, b.w - 10, b.h - 10);
      ctx.setLineDash([]);
    });
  }

  private drawTrees(vis: Rect): void {
    const { ctx } = this;
    for (const t of this.city.trees) {
      if (t.x < vis.x - 60 || t.x > vis.x + vis.w + 60 || t.y < vis.y - 60 || t.y > vis.y + vis.h + 60) continue;
      const sway = Math.sin(this.wall * 1.4 + t.x * 0.013) * 2;
      ctx.fillStyle = "rgba(6,10,18,0.34)";
      ctx.beginPath();
      ctx.ellipse(t.x + 7, t.y + 9, t.r * 1.02, t.r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#2c5a3c";
      ctx.beginPath();
      ctx.arc(t.x + sway, t.y, t.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3a7050";
      ctx.beginPath();
      ctx.arc(t.x + sway - t.r * 0.18, t.y - t.r * 0.2, t.r * 0.66, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(150,210,160,0.25)";
      ctx.beginPath();
      ctx.arc(t.x + sway - t.r * 0.3, t.y - t.r * 0.34, t.r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBuildings(vis: Rect): void {
    const { ctx } = this;
    for (const b of this.city.buildings) {
      if (!inView(b, vis, 90)) continue;
      const dx = -b.hgt * 0.3;
      const dy = -b.hgt * 0.42;
      // тень
      ctx.fillStyle = "rgba(7,9,18,0.34)";
      ctx.fillRect(b.x + 10, b.y + 12, b.w, b.h);
      // южный торец
      ctx.fillStyle = shade(b.c, 0.52);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y + b.h);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x + b.w + dx, b.y + b.h + dy);
      ctx.lineTo(b.x + dx, b.y + b.h + dy);
      ctx.closePath();
      ctx.fill();
      // окна на южном торце
      const n = 10;
      const step = b.w / (n + 1);
      const wh = Math.max(5, -dy * 0.56);
      for (let i = 0; i < n; i++) {
        const lit = (b.winMask >> i) & 1;
        ctx.fillStyle = lit ? "rgba(255,203,118,0.9)" : "rgba(14,19,30,0.6)";
        ctx.fillRect(b.x + step * (i + 1) - 5 + dx * 0.5, b.y + b.h + dy * 0.5 - wh / 2, 10, wh);
      }
      // восточный торец
      ctx.fillStyle = shade(b.c, 0.7);
      ctx.beginPath();
      ctx.moveTo(b.x + b.w, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x + b.w + dx, b.y + b.h + dy);
      ctx.lineTo(b.x + b.w + dx, b.y + dy);
      ctx.closePath();
      ctx.fill();
      // крыша
      ctx.fillStyle = b.c;
      ctx.fillRect(b.x + dx, b.y + dy, b.w, b.h);
      ctx.strokeStyle = shade(b.c, 1.25);
      ctx.lineWidth = 3;
      ctx.strokeRect(b.x + dx + 5, b.y + dy + 5, b.w - 10, b.h - 10);
      ctx.fillStyle = shade(b.c, 0.76);
      for (const [vx, vy, vs] of b.vents) ctx.fillRect(b.x + dx + vx, b.y + dy + vy, vs, vs);
      ctx.fillStyle = "rgba(255,214,140,0.3)";
      ctx.fillRect(b.x + dx + b.w * 0.12, b.y + dy + b.h * 0.12, 24, 24);
    }
  }

  private drawLamps(vis: Rect): void {
    const { ctx } = this;
    for (const l of this.city.lamps) {
      if (l.x < vis.x - 30 || l.x > vis.x + vis.w + 30 || l.y < vis.y - 30 || l.y > vis.y + vis.h + 30) continue;
      ctx.fillStyle = "#10151f";
      ctx.beginPath();
      ctx.arc(l.x, l.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#39435a";
      ctx.beginPath();
      ctx.arc(l.x, l.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCar(): void {
    const { ctx } = this;
    const c = this.car;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle + c.steer * 0.05);
    this.paintCar(PLAYER_COLOR, this.braking);
    ctx.restore();
  }

  /** кузов машины в её собственных координатах — общий для игрока и ботов */
  private paintCar(color: string, braking: boolean): void {
    const { ctx } = this;
    ctx.fillStyle = "rgba(5,8,16,0.42)";
    ctx.beginPath();
    ctx.ellipse(2, 6, 24, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-20, -11, 40, 22, 8);
    ctx.fill();
    ctx.fillStyle = shade(color, 1.08);
    ctx.beginPath();
    ctx.roundRect(8, -9, 10, 18, 4);
    ctx.fill();
    ctx.fillStyle = "rgba(255,244,230,0.8)";
    ctx.fillRect(-20, -2, 40, 4);
    ctx.fillStyle = "#152233";
    ctx.beginPath();
    ctx.roundRect(0, -8, 7, 16, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(-13, -7.5, 5, 15, 2.5);
    ctx.fill();
    ctx.fillStyle = shade(color, 0.85);
    ctx.beginPath();
    ctx.roundRect(-8, -9, 9, 18, 3);
    ctx.fill();
    ctx.fillStyle = "#ffe9b0";
    ctx.fillRect(17.5, -9, 3.5, 5);
    ctx.fillRect(17.5, 4, 3.5, 5);
    ctx.fillStyle = braking ? "#ff5340" : shade(color, 0.6);
    ctx.fillRect(-21.5, -9, 3, 5);
    ctx.fillRect(-21.5, 4, 3, 5);
  }

  private drawBots(vis: Rect): void {
    const { ctx } = this;
    for (const b of this.bots) {
      if (b.status !== "active") continue;
      if (!inView({ x: b.x - 26, y: b.y - 26, w: 52, h: 52 }, vis)) continue;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.angle);
      this.paintCar(b.color, b.wait > 0);
      ctx.restore();
      this.drawNick(b);
    }
  }

  /** ник над машиной бота — по двум «_» его видно с первого взгляда */
  private drawNick(b: Bot): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '700 11px Rubik, system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(b.name).width + 10;
    const y = b.y - 26;
    ctx.fillStyle = "rgba(8,12,20,0.72)";
    ctx.beginPath();
    ctx.roundRect(b.x - w / 2, y - 8, w, 16, 5);
    ctx.fill();
    ctx.fillStyle = b.color;
    ctx.fillText(b.name, b.x, y + 0.5);
    ctx.restore();
  }

  private drawPlayerNick(): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '700 11px Rubik, system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(this.playerName).width + 12;
    const y = this.car.y - 30;
    ctx.fillStyle = "rgba(8,12,20,0.82)";
    ctx.beginPath();
    ctx.roundRect(this.car.x - w / 2, y - 8, w, 16, 5);
    ctx.fill();
    ctx.strokeStyle = rgba(PLAYER_COLOR, 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ffb7a8";
    ctx.fillText(this.playerName, this.car.x, y + 0.5);
    ctx.restore();
  }

  /** сколько секунд осталось до открытия следующей АЗС из-за этой колонки */
  private unlockLeft(st: Station): number | null {
    const q = this.unlockQueue.find((e) => e.from === st);
    return q ? Math.max(0, q.t) : null;
  }

  /**
   * Информер у заправляющейся машины: сколько секунд до открытия следующей АЗС
   * и сколько канистр у того, кто стоит под колонкой.
   */
  private drawRefuelInfo(vis: Rect): void {
    if (this.refueling && this.refuelStation) {
      this.drawInfoPlate(
        this.car.x,
        this.car.y - 46,
        this.online?.connected ? Math.max(0, this.sessionDuration - this.sessionElapsed) : this.unlockLeft(this.refuelStation),
        this.sessionDuration,
        this.canisters
      );
    }
    for (const b of this.bots) {
      if (b.status !== "active") continue;
      if (b.wait <= 0 || !b.at) continue;
      if (!inView({ x: b.x - 80, y: b.y - 80, w: 160, h: 160 }, vis)) continue;
      this.drawInfoPlate(
        b.x,
        b.y - 46,
        this.online?.connected ? b.wait : this.unlockLeft(b.at),
        b.refuelTotal,
        b.taken
      );
    }
  }

  private drawInfoPlate(
    x: number,
    y: number,
    left: number | null,
    total: number,
    canisters: number
  ): void {
    const { ctx } = this;
    const timeText =
      left === null
        ? "—"
        : total > 0
          ? `${left.toFixed(1)} из ${total.toFixed(1)} с`
          : `${left.toFixed(1)} с`;
    const canText = String(canisters);
    ctx.save();
    ctx.font = '700 12px Rubik, system-ui, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const icon = 13;
    const gap = 4;
    const pad = 8;
    const tw = ctx.measureText(timeText).width;
    const cw = ctx.measureText(canText).width;
    const w = pad * 2 + icon + gap + tw + 10 + icon + gap + cw;
    const h = 22;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 7);
    ctx.fillStyle = "rgba(8,14,20,0.85)";
    ctx.fill();
    ctx.strokeStyle = "rgba(126,224,138,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    let cx = x - w / 2 + pad;
    const drawIcon = (path: string, color: string) => {
      const ic = icon2d(path);
      if (!ic) return;
      ctx.save();
      ctx.translate(cx, y - icon / 2);
      ctx.scale(icon / 24, icon / 24);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(ic);
      ctx.restore();
      cx += icon + gap;
    };
    drawIcon(FUEL_ICON_PATH, STATION_ACCENT);
    ctx.fillStyle = "#d6f7dc";
    ctx.fillText(timeText, cx, y + 0.5);
    cx += tw + 10;
    drawIcon(CANISTER_ICON_PATH, CANISTER_ACCENT);
    ctx.fillStyle = shade(CANISTER_ACCENT, 1.35);
    ctx.fillText(canText, cx, y + 0.5);
    ctx.restore();
  }

  private drawParticles(mode: "smoke" | "solid"): void {
    const { ctx } = this;
    for (const p of this.particles) {
      const isSmoke = p.kind === "smoke";
      if ((mode === "smoke") !== isSmoke) continue;
      const k = p.life / p.max;
      if (p.kind === "smoke") {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = k * 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.kind === "spark" || p.kind === "leaf") {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = p.color;
        ctx.globalAlpha = k;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, k * 1.6);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
  }

  private lightPass(vis: Rect): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = "rgba(9,13,32,0.47)";
    ctx.fillRect(vis.x, vis.y, vis.w, vis.h);
    ctx.globalCompositeOperation = "lighter";

    // фонари
    for (const l of this.city.lamps) {
      if (l.x < vis.x - 170 || l.x > vis.x + vis.w + 170 || l.y < vis.y - 170 || l.y > vis.y + vis.h + 170) continue;
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, 150);
      g.addColorStop(0, "rgba(255,199,124,0.19)");
      g.addColorStop(1, "rgba(255,199,124,0)");
      ctx.fillStyle = g;
      ctx.fillRect(l.x - 150, l.y - 150, 300, 300);
      ctx.fillStyle = "rgba(255,226,170,0.85)";
      ctx.beginPath();
      ctx.arc(l.x, l.y, 3.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // свечение билбордов
    const billboardsAvailable = this.hasInactiveStations();
    this.city.billboards.forEach((b, idx) => {
      if (!inView(b, vis, 160)) return;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2 - 22;
      if (b.state === "ready" && billboardsAvailable) {
        const pulse = 0.5 + 0.5 * Math.sin(this.wall * 3 + idx * 1.7);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 130);
        g.addColorStop(0, `rgba(255,183,84,${0.05 + 0.1 * pulse})`);
        g.addColorStop(1, "rgba(255,183,84,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - 130, cy - 130, 260, 260);
      } else {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120);
        g.addColorStop(0, rgba(b.client.color, 0.13));
        g.addColorStop(1, rgba(b.client.color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(cx - 120, cy - 120, 240, 240);
      }
    });

    // свет над работающими заправками
    for (const s of this.city.stations) {
      if (s.state !== "active") continue;
      if (!inView(s, vis, 230)) continue;
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 190);
      g.addColorStop(0, "rgba(255,205,130,0.2)");
      g.addColorStop(1, "rgba(255,205,130,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - 190, cy - 190, 380, 380);
    }

    // фары игрока и ботов
    const c = this.car;
    this.paintHeadlights(c.x, c.y, c.angle, 235, 0.3);
    for (const b of this.bots) {
      if (b.status !== "active") continue;
      if (!inView({ x: b.x - 160, y: b.y - 160, w: 320, h: 320 }, vis)) continue;
      // фары ботов короче и тусклее — множество машин иначе засветит весь квартал
      this.paintHeadlights(b.x, b.y, b.angle, 150, 0.16);
    }
    const hx = Math.cos(c.angle);
    const hy = Math.sin(c.angle);
    const px = -hy;
    const py = hx;
    // стоп-сигналы
    if (this.braking) {
      for (const s of [-7, 7]) {
        const ox = c.x - hx * 21 + px * s;
        const oy = c.y - hy * 21 + py * s;
        const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, 30);
        g.addColorStop(0, "rgba(255,64,48,0.4)");
        g.addColorStop(1, "rgba(255,64,48,0)");
        ctx.fillStyle = g;
        ctx.fillRect(ox - 30, oy - 30, 60, 60);
      }
    }
    ctx.restore();
  }

  /* ---------------- указатели на цели по краям экрана ---------------- */

  // Стрелки по краям экрана: зелёные — на работающие АЗС, голубые — на канистры.
  // Считаются каждый кадр от текущего положения камеры и машины, поэтому живут в реальном времени.
  private drawPointers(shx: number, shy: number): void {
    const w = this.vw;
    const h = this.vh;
    const zoom = this.cam.zoom;
    // отступ от края: столько места нужно стрелке, чтобы не липнуть к рамке
    const margin = clamp(Math.min(w, h) * 0.09, 26, 46);
    // снизу зарезервировано место под подсказку по управлению и легенду
    const bottom = Math.min(margin + 56, h * 0.4);
    // на время заправки сверху висит панель — уводим указатели ниже неё
    const top = this.refueling ? Math.min(margin + 104, h * 0.4) : margin;
    const l = margin;
    const r = w - margin;
    const t0 = top;
    const b0 = h - bottom;

    const targets: Array<{ x: number; y: number; accent: string; iconPath: string; note?: string }> = [];
    for (const st of this.city.stations) {
      if (st.state !== "active") continue;
      targets.push({
        x: st.x + st.w / 2,
        y: st.y + st.h / 2,
        accent: STATION_ACCENT,
        iconPath: FUEL_ICON_PATH,
        note: `${st.price} ₽/л · ${st.limit === null ? "без лимита" : `лимит ${st.limit} л`}`,
      });
    }
    // база нелегальной скупки — одна на карту, показываем всегда
    targets.push({
      x: this.city.base.x + this.city.base.w / 2,
      y: this.city.base.y + this.city.base.h / 2,
      accent: BASE_ACCENT,
      iconPath: BASE_ICON_PATH,
    });
    // канистр на карте много — показываем только ближайшие, иначе край экрана
    // превращается в частокол из стрелок
    this.city.canisters
      .filter((k) => !k.taken)
      .map((k) => ({ k, d: Math.hypot(k.x - this.car.x, k.y - this.car.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, CANISTER_POINTERS)
      .forEach(({ k }) =>
        targets.push({ x: k.x, y: k.y, accent: CANISTER_ACCENT, iconPath: CANISTER_ICON_PATH })
      );

    const dead = this.deadPointers.map((d) => ({
      x: d.x,
      y: d.y,
      accent: DEAD_ACCENT,
      iconPath: d.iconPath,
      // жёсткое мигание и затухание к концу
      alpha: (Math.sin(this.wall * 22) > -0.25 ? 1 : 0.14) * Math.min(1, d.t / 0.4),
    }));

    for (const g of [...targets.map((t) => ({ ...t, alpha: 1 })), ...dead.map((d) => ({ ...d, note: undefined }))]) {
      // экранные координаты цели (с учётом тряски камеры — как и весь кадр)
      const sx = w / 2 + shx + (g.x - this.cam.x) * zoom;
      const sy = h / 2 + shy + (g.y - this.cam.y) * zoom;
      // цель и так видна — указатель не нужен
      if (sx > l && sx < r && sy > t0 && sy < b0) continue;

      const dx = sx - w / 2;
      const dy = sy - h / 2;
      if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) continue;
      // упираем луч «центр экрана → цель» в границы безопасной зоны
      const tx = Math.abs(dx) > 0.001 ? ((dx > 0 ? r : l) - w / 2) / dx : Infinity;
      const ty = Math.abs(dy) > 0.001 ? ((dy > 0 ? b0 : t0) - h / 2) / dy : Infinity;
      const t = Math.max(Math.min(tx, ty), 0);
      const px = w / 2 + dx * t;
      const py = h / 2 + dy * t;

      const meters = Math.hypot(g.x - this.car.x, g.y - this.car.y) * M_PER_PX;
      const pulse = 0.78 + 0.22 * Math.sin(this.wall * 3 + g.x * 0.01);
      const label = g.note ? `${fmtDistance(meters)} · ${g.note}` : fmtDistance(meters);
      this.drawPointer(px, py, Math.atan2(dy, dx), label, pulse, g.accent, g.iconPath, g.alpha);
    }
  }

  private drawPointer(
    px: number,
    py: number,
    ang: number,
    label: string,
    pulse: number,
    accent: string,
    iconPath: string,
    alpha = 1
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = alpha;

    // стрелка у края, смотрит на цель
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.shadowColor = rgba(accent, 0.55 * pulse);
    ctx.shadowBlur = 12;
    ctx.fillStyle = accent;
    ctx.globalAlpha = alpha * pulse;
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(-6.5, 9.5);
    ctx.lineTo(-2.5, 0);
    ctx.lineTo(-6.5, -9.5);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(6,14,20,0.8)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // плашка: иконка цели + расстояние, всегда горизонтальная — иначе не прочитать
    const iconSize = 14;
    const padX = 7;
    const gap = 5;
    ctx.font = '700 12px Rubik, system-ui, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width;
    const bw = padX * 2 + iconSize + gap + tw;
    const bh = 22;
    // сдвигаем плашку от стрелки внутрь экрана и не даём ей вылезти за границы
    const off = 13 + Math.max(bw, bh) * 0.4;
    const bx = clamp(px - Math.cos(ang) * off, bw / 2 + 4, Math.max(bw / 2 + 4, this.vw - bw / 2 - 4));
    const by = clamp(py - Math.sin(ang) * off, bh / 2 + 4, Math.max(bh / 2 + 4, this.vh - bh / 2 - 4));
    const left = bx - bw / 2;
    const top = by - bh / 2;

    ctx.beginPath();
    ctx.roundRect(left, top, bw, bh, 7);
    ctx.fillStyle = "rgba(8,14,20,0.84)";
    ctx.fill();
    ctx.strokeStyle = rgba(accent, 0.35 + 0.25 * pulse);
    ctx.lineWidth = 1;
    ctx.stroke();

    const ic = icon2d(iconPath);
    if (ic) {
      ctx.save();
      ctx.translate(left + padX, by - iconSize / 2);
      ctx.scale(iconSize / 24, iconSize / 24);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(ic);
      ctx.restore();
    }

    ctx.fillStyle = shade(accent, 1.35);
    ctx.fillText(label, left + padX + iconSize + gap, by + 0.5);
    ctx.restore();
  }

  /* ---------------- minimap ---------------- */

  private paintMinimapBase(): void {
    const m = this.mmBase.getContext("2d");
    if (!m) return;
    const s = MM / WORLD;
    m.fillStyle = "#0f1624";
    m.fillRect(0, 0, MM, MM);
    m.fillStyle = "#1d2738";
    for (const b of this.city.blocks) m.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
    m.fillStyle = "#24402e";
    for (const p of this.city.parks) m.fillRect(p.x * s, p.y * s, p.w * s, p.h * s);
    // АЗС рисуются динамически (состояния меняются по ходу игры)
    m.fillStyle = "#3d4b64";
    for (const c of this.city.roadCenters) {
      m.fillRect((c - ROAD / 2) * s, 0, ROAD * s, MM);
      m.fillRect(0, (c - ROAD / 2) * s, MM, ROAD * s);
    }
  }

  private drawMinimap(): void {
    if (!this.mctx || !this.mini) return;
    const m = this.mctx;
    const s = MM / WORLD;
    const u = MM / 216;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, MM, MM);
    m.drawImage(this.mmBase, 0, 0);

    // Видимая сейчас область города — помогает сопоставить карту с игровым экраном.
    const viewW = (this.vw / this.cam.zoom) * s;
    const viewH = (this.vh / this.cam.zoom) * s;
    m.strokeStyle = "rgba(236,243,255,0.28)";
    m.lineWidth = Math.max(1, 0.7 * u);
    m.setLineDash([3 * u, 3 * u]);
    m.strokeRect(this.cam.x * s - viewW / 2, this.cam.y * s - viewH / 2, viewW, viewH);
    m.setLineDash([]);

    // АЗС: активные — зелёные, закрытые — серые с мерцающей красной точкой.
    for (const st of this.city.stations) {
      const pad = 0.8 * u;
      const sx = st.x * s - pad;
      const sy = st.y * s - pad;
      const sw = st.w * s + pad * 2;
      const sh = st.h * s + pad * 2;
      if (st.state === "active") {
        m.fillStyle = "#7ee08a";
        m.fillRect(sx, sy, sw, sh);
        m.strokeStyle = "rgba(214,255,220,0.88)";
        m.lineWidth = 0.8 * u;
        m.strokeRect(sx - 1.5 * u, sy - 1.5 * u, sw + 3 * u, sh + 3 * u);
      } else {
        m.fillStyle = "#333b49";
        m.fillRect(sx, sy, sw, sh);
        const blink = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(this.wall * 5 + st.x * 0.01));
        m.fillStyle = `rgba(217,93,77,${blink})`;
        m.beginPath();
        m.arc(sx + sw / 2, sy + sh / 2, (1.1 + blink * 0.7) * u, 0, Math.PI * 2);
        m.fill();
      }
    }

    // База скупки топлива.
    const base = this.city.base;
    const baseX = base.x * s;
    const baseY = base.y * s;
    const baseW = base.w * s;
    const baseH = base.h * s;
    const baseCX = baseX + baseW / 2;
    const baseCY = baseY + baseH / 2;
    m.fillStyle = "#4b356b";
    m.fillRect(baseX, baseY, baseW, baseH);
    m.strokeStyle = "#b98cff";
    m.lineWidth = 0.9 * u;
    m.strokeRect(baseX - u, baseY - u, baseW + 2 * u, baseH + 2 * u);
    m.fillStyle = "#b98cff";
    m.beginPath();
    m.arc(baseCX, baseCY, 5.4 * u, 0, Math.PI * 2);
    m.fill();
    m.fillStyle = "#120c20";
    m.font = `700 ${7 * u}px Rubik, sans-serif`;
    m.textAlign = "center";
    m.textBaseline = "middle";
    m.fillText("₽", baseCX, baseCY + 0.3 * u);

    // Билборды: статичные янтарные или серые метки без мерцания.
    const billboardsAvailable = this.hasInactiveStations();
    this.city.billboards.forEach((b) => {
      const bx = (b.x + b.w / 2) * s;
      const by = (b.y + b.h / 2) * s;
      if (b.state !== "ready" || !billboardsAvailable) {
        m.fillStyle = "#5d6880";
        m.fillRect(bx - 2.1 * u, by - 2.1 * u, 4.2 * u, 4.2 * u);
      } else {
        m.fillStyle = "#ffb754";
        m.beginPath();
        m.arc(bx, by, 3.1 * u, 0, Math.PI * 2);
        m.fill();
      }
    });

    // Канистры, которые ещё лежат на карте.
    for (const canister of this.city.canisters) {
      if (canister.taken) continue;
      const kx = canister.x * s;
      const ky = canister.y * s;
      const size = 2.6 * u;
      m.save();
      m.translate(kx, ky);
      m.rotate(Math.PI / 4);
      m.fillStyle = "#58c9f3";
      m.fillRect(-size, -size, size * 2, size * 2);
      m.restore();
    }

    // Конкуренты — маленькие точки их фирменных цветов.
    for (const bot of this.bots) {
      if (bot.status !== "active") continue;
      m.fillStyle = bot.color;
      m.beginPath();
      m.arc(bot.x * s, bot.y * s, 1.7 * u, 0, Math.PI * 2);
      m.fill();
    }

    // Машина игрока — крупная направленная метка с белой обводкой.
    const cx = this.car.x * s;
    const cy = this.car.y * s;
    m.save();
    m.translate(cx, cy);
    m.rotate(this.car.angle);
    m.fillStyle = "rgba(255,120,90,0.35)";
    m.beginPath();
    m.arc(0, 0, 7 * u, 0, Math.PI * 2);
    m.fill();
    m.fillStyle = "#e5472f";
    m.beginPath();
    m.moveTo(6.5 * u, 0);
    m.lineTo(-4.5 * u, 4.5 * u);
    m.lineTo(-4.5 * u, -4.5 * u);
    m.closePath();
    m.fill();
    m.strokeStyle = "#fff4e8";
    m.lineWidth = 1.1 * u;
    m.stroke();
    m.restore();

    m.textAlign = "left";
    m.textBaseline = "alphabetic";
  }
}

export type { Lamp, Tree };
