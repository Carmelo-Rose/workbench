"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";

/**
 * 像素小猫挂件 — oneko.js 的 TypeScript/React 移植（行为强化版）。
 * Original: https://github.com/adryd325/oneko.js (MIT © 2022 adryd)
 * Sprite sheet: /pets/oneko.gif (256×128, 32px cells)
 *
 * 行为模型（不新增贴图，灵魂全在状态机里）：
 * - 精力/兴趣：energy ∈ [0,1]，追逐耗电、休息回电（睡觉回得更快）。指针动了
 *   不一定追——精力不足（≤0.35）或兴趣判定失败时只是坐着扭头看你（watch，
 *   用朝向指针的奔跑帧第 0 帧，指针方位变化超过约 45° 才换帧）。
 * - 追上指针后走 alert → 坐下 → 理毛 → 打哈欠 → 打盹 的餍足序列；餍足期内
 *   小幅移动懒得理，只有指针跑远（>260px）且持续移动才重新勾起兴趣。
 * - 指针闲置 6s 后偶尔慢速散步（stroll）到视口边缘附近的随机点，到了随机
 *   挠墙/理毛/打哈欠；散步途中按兴趣模型决定要不要理会指针。
 * - 禁入区：输入框（[data-slot="aui_composer-shell"]）boundingRect 外扩 28px，
 *   每 ~1s 与 resize 时刷新（不逐帧查询）。追逐/散步途中贴墙滑动绕行，撞死
 *   （连续 ~400ms 拉近不了距离）就放弃转 watch 隔墙看着，并短暂冷静，避免
 *   对着墙反复扑空；布局变化把猫困进禁区时，它会自己散步走出去。
 * - prefers-reduced-motion 下只在角落静置一帧，不进入动画循环。
 *
 * 状态机：
 *   idle        自主待机，随机间隔触发小动作或散步
 *   watch       坐着扭头看指针（兴趣不足时的回应），3~8s 后回 idle
 *   chase       追指针；精力耗尽会放弃（→ tired），追上进餍足序列
 *   stroll      慢速散步（wander：闲逛到边缘；evacuate：从禁区里走出来）
 *   alert       惊觉过渡帧（限时），之后消费 plan 队列
 *   sit         脚本化静坐（餍足序列专用，限时）
 *   scratchSelf / scratchWall / tired  限时小动作
 *   sleeping    睡觉，只有持续的指针动静才叫得醒（睡醒先 alert 再决定）
 *   限时状态结束后先消费 plan 队列（脚本化序列）；队列空了走默认转移：
 *   scratchSelf 偶尔接 tired，tired 大概率接 sleeping，其余回 idle。
 */

const NEKO_SPRITES = {
  idle: [[-3, -3]],
  alert: [[-7, -3]],
  scratchSelf: [
    [-5, 0],
    [-6, 0],
    [-7, 0],
  ],
  scratchWallN: [
    [0, 0],
    [0, -1],
  ],
  scratchWallS: [
    [-7, -1],
    [-6, -2],
  ],
  scratchWallE: [
    [-2, -2],
    [-2, -3],
  ],
  scratchWallW: [
    [-4, 0],
    [-4, -1],
  ],
  tired: [[-3, -2]],
  sleeping: [
    [-2, 0],
    [-2, -1],
  ],
  N: [
    [-1, -2],
    [-1, -3],
  ],
  NE: [
    [0, -2],
    [0, -3],
  ],
  E: [
    [-3, 0],
    [-3, -1],
  ],
  SE: [
    [-5, -1],
    [-5, -2],
  ],
  S: [
    [-6, -3],
    [-7, -2],
  ],
  SW: [
    [-5, -3],
    [-6, -1],
  ],
  W: [
    [-4, -2],
    [-4, -3],
  ],
  NW: [
    [-1, 0],
    [-1, -1],
  ],
} as const satisfies Record<string, readonly [number, number][]>;

const NEKO_SKIN = {
  image: "/pets/oneko.gif",
  frameSize: 32,
  sprites: NEKO_SPRITES,
} as const;

type SpriteName = keyof typeof NEKO_SPRITES;
type Direction = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
type WallDirection = "N" | "E" | "S" | "W";
type NekoMode =
  | "idle"
  | "watch"
  | "chase"
  | "stroll"
  | "alert"
  | "sit"
  | "scratchSelf"
  | "scratchWall"
  | "tired"
  | "sleeping";
type StrollReason = "wander" | "evacuate";
type PlannedStep = { mode: NekoMode; duration?: number; wall?: WallDirection };
type KeepOutZone = { left: number; top: number; right: number; bottom: number };

const FRAME_MS = 100;
const CHASE_SPEED = 8.5;
const STROLL_SPEED = 3;
const CATCH_DISTANCE = 46;
const WAKE_DISTANCE = 80;
const EDGE_MARGIN = 34;
/** 精力低于此值不追，只 watch */
const ENERGY_CHASE_MIN = 0.35;
/** 精力低于此值时中途放弃追逐 */
const ENERGY_GIVE_UP = 0.08;
const ENERGY_DRAIN_PER_S = 0.05;
const ENERGY_REGEN_PER_S = 0.03;
/** 指针闲置多久后才可能出门散步 */
const POINTER_IDLE_STROLL_MS = 6000;
/** 指针闲置多久后待机动作偏向犯困 */
const SLEEPY_AFTER_MS = 20000;
/** 餍足期内重新勾起兴趣所需的指针距离 */
const SATIATED_RENEW_DISTANCE = 260;
/** watch 换头朝向的角度阈值（约 45°） */
const WATCH_TURN_RAD = Math.PI / 4;
const KEEPOUT_SELECTOR = '[data-slot="aui_composer-shell"]';
const KEEPOUT_PAD = 28;
const KEEPOUT_REFRESH_MS = 1000;
/** 走出禁区边界后额外留出的余量 */
const KEEPOUT_EXIT_MARGIN = 6;
/** 追逐/散步连续这么久拉近不了距离就判定被墙挡住，放弃 */
const STUCK_GIVE_UP_MS = 400;

/** 这些状态下小猫会留意指针动静（兴趣模型的适用范围） */
const REACTIVE_MODES: ReadonlySet<NekoMode> = new Set([
  "idle",
  "watch",
  "stroll",
  "sleeping",
  "tired",
  "scratchSelf",
  "scratchWall",
]);

const randomBetween = (min: number, max: number) =>
  min + Math.random() * (max - min);

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const NekoPet: FC = () => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const startedAt = performance.now();

    // —— 位置与指针 ——
    let posX = window.innerWidth - 64;
    let posY = window.innerHeight - 96;
    let pointerX = posX;
    let pointerY = posY;
    let lastPointerAt = startedAt;
    /** 当前这一波连续指针移动的起点（间断 >300ms 视为新的一波） */
    let pointerStreakStart = startedAt;

    // —— 状态机 ——
    let mode: NekoMode = "idle";
    /** 限时状态的截止时间；开放状态为 Infinity */
    let modeEndsAt = Number.POSITIVE_INFINITY;
    /** 脚本化序列队列：限时状态结束后依次消费 */
    let plan: PlannedStep[] = [];
    let scratchWall: WallDirection = "E";
    let frameCount = 0;
    let spriteFrame = 0;
    let lastFrame = 0;
    let lastStepAt = startedAt;
    let raf = 0;

    // —— 精力 / 兴趣 ——
    let energy = randomBetween(0.55, 0.9);
    /** 餍足期截止时间：期间小幅指针移动不再触发追逐 */
    let satiatedUntil = 0;
    /** 兴趣判定节流：避免每帧掷骰子 */
    let nextInterestCheckAt = 0;
    let nextIdleActionAt = startedAt + randomBetween(1800, 5200);
    let nextStrollAt = startedAt + randomBetween(4000, 9000);

    // —— watch 扭头 ——
    let watchDirection: Direction = "S";
    let watchAngle = Number.NaN;

    // —— 散步 ——
    let strollTarget = { x: posX, y: posY };
    let strollReason: StrollReason = "wander";

    // —— 禁入区 ——
    let keepOut: KeepOutZone | null = null;
    let nextZoneRefreshAt = 0;

    // —— 追逐/散步卡墙检测 ——
    /** 被禁区墙挡住放弃追逐后的冷静期：期间指针仍在墙后就懒得再扑 */
    let blockedUntil = 0;
    let bestApproachDistance = Number.POSITIVE_INFINITY;
    let lastApproachProgressAt = startedAt;

    const clampToViewport = () => {
      posX = clamp(posX, 16, window.innerWidth - 16);
      posY = clamp(posY, 16, window.innerHeight - 16);
      pointerX = clamp(pointerX, 0, window.innerWidth);
      pointerY = clamp(pointerY, 0, window.innerHeight);
    };

    const place = () => {
      clampToViewport();
      el.style.left = `${posX - 16}px`;
      el.style.top = `${posY - 16}px`;
    };

    const setSprite = (name: SpriteName, frame: number) => {
      const frames = NEKO_SKIN.sprites[name];
      const sprite = frames[frame % frames.length];
      el.style.backgroundPosition = `${sprite[0] * NEKO_SKIN.frameSize}px ${
        sprite[1] * NEKO_SKIN.frameSize
      }px`;
    };

    place();
    setSprite("idle", 0);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    // —— 禁入区：查询节流在 KEEPOUT_REFRESH_MS + resize，勿逐帧调用 ——

    const refreshKeepOut = () => {
      const shell = document.querySelector(KEEPOUT_SELECTOR);
      const rect = shell?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        keepOut = null;
        return;
      }
      keepOut = {
        left: rect.left - KEEPOUT_PAD,
        top: rect.top - KEEPOUT_PAD,
        right: rect.right + KEEPOUT_PAD,
        bottom: rect.bottom + KEEPOUT_PAD,
      };
    };

    const inKeepOut = (x: number, y: number) =>
      keepOut !== null &&
      x > keepOut.left &&
      x < keepOut.right &&
      y > keepOut.top &&
      y < keepOut.bottom;

    /** 禁区内的点投影到禁区外的最近点（优先选仍在视口内的出口） */
    const nearestExitPoint = (x: number, y: number) => {
      if (!keepOut || !inKeepOut(x, y)) return { x, y };
      const zone = keepOut;
      const exits = [
        { x: zone.left - KEEPOUT_EXIT_MARGIN, y, cost: x - zone.left },
        { x: zone.right + KEEPOUT_EXIT_MARGIN, y, cost: zone.right - x },
        { x, y: zone.top - KEEPOUT_EXIT_MARGIN, cost: y - zone.top },
        { x, y: zone.bottom + KEEPOUT_EXIT_MARGIN, cost: zone.bottom - y },
      ].sort((a, b) => a.cost - b.cost);
      const inViewport = exits.find(
        (p) =>
          p.x >= 16 &&
          p.x <= window.innerWidth - 16 &&
          p.y >= 16 &&
          p.y <= window.innerHeight - 16,
      );
      return inViewport ?? exits[0];
    };

    /**
     * 碰撞安全的位移：整步会踩进禁区就改成贴墙滑动（只走不越界的那根轴），
     * 两根轴都会越界（贴角）就原地不动，等下一帧方向变了再试。
     * 若当前本就在禁区内（布局刚变把猫罩住，撤离途中），不拦截以免困死。
     */
    const moveTowardWithZoneGuard = (dx: number, dy: number) => {
      if (inKeepOut(posX, posY)) {
        posX += dx;
        posY += dy;
        return;
      }
      const fullX = posX + dx;
      const fullY = posY + dy;
      if (!inKeepOut(fullX, fullY)) {
        posX = fullX;
        posY = fullY;
        return;
      }
      if (!inKeepOut(fullX, posY)) posX = fullX;
      else if (!inKeepOut(posX, fullY)) posY = fullY;
    };

    // —— 几何工具 ——

    const distanceToPointer = () =>
      Math.hypot(posX - pointerX, posY - pointerY);

    const directionTowards = (targetX: number, targetY: number): Direction => {
      const diffX = posX - targetX;
      const diffY = posY - targetY;
      const distance = Math.max(Math.hypot(diffX, diffY), 1);
      let direction = "";
      direction += diffY / distance > 0.5 ? "N" : "";
      direction += diffY / distance < -0.5 ? "S" : "";
      direction += diffX / distance > 0.5 ? "W" : "";
      direction += diffX / distance < -0.5 ? "E" : "";
      return (direction || "S") as Direction;
    };

    const getWallCandidate = (): WallDirection | null => {
      const distances: [WallDirection, number][] = [
        ["W", posX],
        ["N", posY],
        ["E", window.innerWidth - posX],
        ["S", window.innerHeight - posY],
      ];
      const [wall, distance] = distances.sort((a, b) => a[1] - b[1])[0];
      return distance < EDGE_MARGIN ? wall : null;
    };

    const scratchSprite = (): SpriteName => `scratchWall${scratchWall}`;

    // —— 状态机核心 ——

    const setMode = (
      next: NekoMode,
      timestamp: number,
      opts: { duration?: number; wall?: WallDirection } = {},
    ) => {
      mode = next;
      scratchWall = opts.wall ?? scratchWall;
      spriteFrame = 0;
      modeEndsAt =
        opts.duration === undefined
          ? Number.POSITIVE_INFINITY
          : timestamp + opts.duration;
      if (next === "idle") {
        nextIdleActionAt = timestamp + randomBetween(1800, 5200);
      }
      if (next === "chase") {
        bestApproachDistance = Number.POSITIVE_INFINITY;
        lastApproachProgressAt = timestamp;
      }
    };

    const startWatch = (timestamp: number) => {
      watchAngle = Number.NaN;
      setMode("watch", timestamp, { duration: randomBetween(3000, 8000) });
    };

    const startStroll = (
      timestamp: number,
      targetX: number,
      targetY: number,
      reason: StrollReason,
    ) => {
      plan = [];
      const safe =
        reason === "wander"
          ? nearestExitPoint(targetX, targetY)
          : { x: targetX, y: targetY };
      strollTarget = {
        x: clamp(safe.x, 16, window.innerWidth - 16),
        y: clamp(safe.y, 16, window.innerHeight - 16),
      };
      strollReason = reason;
      bestApproachDistance = Number.POSITIVE_INFINITY;
      lastApproachProgressAt = timestamp;
      // 兜底时长：路线被禁区挡死走不到时，超时自动放弃回 idle
      const distance = Math.hypot(strollTarget.x - posX, strollTarget.y - posY);
      setMode("stroll", timestamp, {
        duration: (distance / STROLL_SPEED) * FRAME_MS * 1.5 + 2000,
      });
    };

    /** 限时状态到点：先消费 plan 队列，队列空了走默认转移 */
    const finishMode = (timestamp: number) => {
      const queued = plan.shift();
      if (queued) {
        if (queued.mode === "watch") {
          startWatch(timestamp);
          return;
        }
        setMode(queued.mode, timestamp, {
          duration: queued.duration,
          wall: queued.wall,
        });
        return;
      }
      // 自然衔接：理毛后偶尔犯困，犯困后大概率睡着，其余回 idle
      if (mode === "scratchSelf" && Math.random() < 0.3) {
        setMode("tired", timestamp, { duration: randomBetween(800, 1500) });
        return;
      }
      if (mode === "tired" && Math.random() < 0.65) {
        setMode("sleeping", timestamp);
        return;
      }
      setMode("idle", timestamp);
    };

    /** 追上真指针后的餍足序列：惊觉 → 坐下 → 理毛 → 打哈欠 → 打盹 */
    const beginCatchSequence = (timestamp: number) => {
      const sitFor = randomBetween(700, 1400);
      const groomFor = randomBetween(1100, 2000);
      const yawnFor = randomBetween(800, 1400);
      plan = [
        { mode: "sit", duration: sitFor },
        { mode: "scratchSelf", duration: groomFor },
        { mode: "tired", duration: yawnFor },
        { mode: "sleeping" },
      ];
      satiatedUntil =
        timestamp + sitFor + groomFor + yawnFor + randomBetween(4000, 8000);
      setMode("alert", timestamp, { duration: randomBetween(400, 700) });
    };

    /** 对指针动静做出回应：想追就追，不想追就坐着看；睡着/犯困时先惊觉 */
    const reactToPointer = (timestamp: number, wantsChase: boolean) => {
      plan = [];
      const reachable = Math.hypot(pointerX - posX, pointerY - posY) > 24;
      const next: NekoMode = wantsChase && reachable ? "chase" : "watch";
      if (mode === "sleeping" || mode === "tired" || next === "chase") {
        plan = [{ mode: next }];
        setMode("alert", timestamp, { duration: randomBetween(280, 620) });
      } else {
        startWatch(timestamp);
      }
    };

    /**
     * 兴趣模型（节流掷骰子）：
     * - 餍足期内只有"跑远 + 持续移动"才重新勾起兴趣；
     * - 平时兴趣概率随精力升高，精力不够（≤0.35）最多 watch；
     * - 睡着与散步中要求持续移动，散步中兴趣不到位就懒得理会。
     */
    const maybeReact = (timestamp: number) => {
      if (!REACTIVE_MODES.has(mode)) return;
      const pointerActive = timestamp - lastPointerAt < 420;
      if (!pointerActive || timestamp < nextInterestCheckAt) return;
      const distance = distanceToPointer();
      const sustained = lastPointerAt - pointerStreakStart > 650;

      if (timestamp < satiatedUntil) {
        nextInterestCheckAt = timestamp + randomBetween(700, 1400);
        if (distance > SATIATED_RENEW_DISTANCE && sustained) {
          satiatedUntil = 0;
          reactToPointer(timestamp, energy > ENERGY_CHASE_MIN);
        }
        return;
      }

      if (timestamp < blockedUntil) {
        // 刚被墙挡住放弃过：指针还在墙后就懒得再扑，出来了才重新理会
        if (inKeepOut(pointerX, pointerY)) return;
        blockedUntil = 0;
      }

      if (distance <= WAKE_DISTANCE) return;
      if ((mode === "sleeping" || mode === "stroll") && !sustained) return;

      nextInterestCheckAt = timestamp + randomBetween(1400, 3600);
      const interested = Math.random() < 0.2 + energy * 0.5;
      if (mode === "stroll" && !interested) return; // 散步中懒得理会
      reactToPointer(timestamp, interested && energy > ENERGY_CHASE_MIN);
    };

    // —— 各状态的每帧行为 ——

    const stepChase = (timestamp: number) => {
      if (energy < ENERGY_GIVE_UP) {
        // 追累了，就地放弃，并且短时间懒得再理指针
        plan = [];
        nextInterestCheckAt = timestamp + randomBetween(2000, 4500);
        setMode("tired", timestamp, { duration: randomBetween(900, 1500) });
        return;
      }
      const distance = Math.max(distanceToPointer(), 1);
      if (!inKeepOut(pointerX, pointerY) && distance < CATCH_DISTANCE) {
        beginCatchSequence(timestamp);
        return;
      }
      if (distance < bestApproachDistance - 0.5) {
        bestApproachDistance = distance;
        lastApproachProgressAt = timestamp;
      } else if (timestamp - lastApproachProgressAt > STUCK_GIVE_UP_MS) {
        // 隔着禁区墙推进不了：放弃追逐，坐下隔墙看着，冷静一阵别再扑空
        plan = [];
        blockedUntil = timestamp + randomBetween(3000, 6000);
        startWatch(timestamp);
        return;
      }
      const diffX = pointerX - posX;
      const diffY = pointerY - posY;
      const speed = distance < 140 ? CHASE_SPEED * 0.72 : CHASE_SPEED;
      setSprite(directionTowards(pointerX, pointerY), frameCount);
      moveTowardWithZoneGuard(
        (diffX / distance) * speed,
        (diffY / distance) * speed,
      );
      place();
    };

    const stepStroll = (timestamp: number) => {
      const diffX = strollTarget.x - posX;
      const diffY = strollTarget.y - posY;
      const distance = Math.hypot(diffX, diffY);
      if (distance < 6) {
        if (strollReason === "wander") {
          arriveWanderAction(timestamp);
        } else {
          setMode("idle", timestamp);
        }
        return;
      }
      if (strollReason === "wander") {
        if (distance < bestApproachDistance - 0.5) {
          bestApproachDistance = distance;
          lastApproachProgressAt = timestamp;
        } else if (timestamp - lastApproachProgressAt > STUCK_GIVE_UP_MS) {
          // 被禁区墙挡住走不到目的地，放弃这次散步
          setMode("idle", timestamp);
          return;
        }
      }
      // 奔跑帧但慢速 + 慢动画，散步感
      setSprite(
        directionTowards(strollTarget.x, strollTarget.y),
        Math.floor(frameCount / 2),
      );
      const stepX = (diffX / distance) * STROLL_SPEED;
      const stepY = (diffY / distance) * STROLL_SPEED;
      if (strollReason === "wander") {
        moveTowardWithZoneGuard(stepX, stepY);
      } else {
        // 撤离禁区：目标本就在禁区外，直接走，不做碰撞拦截以免被困住
        posX += stepX;
        posY += stepY;
      }
      place();
    };

    const stepWatch = () => {
      const angle = Math.atan2(pointerY - posY, pointerX - posX);
      const delta = Math.abs(
        Math.atan2(Math.sin(angle - watchAngle), Math.cos(angle - watchAngle)),
      );
      // 指针方位变化超过约 45° 才扭头换帧
      if (!Number.isFinite(watchAngle) || delta > WATCH_TURN_RAD) {
        watchAngle = angle;
        watchDirection = directionTowards(pointerX, pointerY);
      }
      setSprite(watchDirection, 0);
    };

    const stepIdle = (timestamp: number) => {
      setSprite("idle", 0);
      if (timestamp > nextIdleActionAt) {
        nextIdleActionAt = timestamp + randomBetween(2600, 7000);
        chooseIdleAction(timestamp);
      }
    };

    const chooseIdleAction = (timestamp: number) => {
      const pointerIdleFor = timestamp - lastPointerAt;
      if (
        pointerIdleFor > POINTER_IDLE_STROLL_MS &&
        timestamp > nextStrollAt &&
        Math.random() < 0.45
      ) {
        nextStrollAt = timestamp + randomBetween(9000, 22000);
        const target = pickWanderTarget();
        startStroll(timestamp, target.x, target.y, "wander");
        return;
      }
      if (pointerIdleFor > SLEEPY_AFTER_MS && Math.random() < 0.5) {
        setMode("tired", timestamp, { duration: randomBetween(800, 1500) });
        return;
      }
      const wall = getWallCandidate();
      if (wall && Math.random() < 0.4) {
        setMode("scratchWall", timestamp, {
          duration: randomBetween(900, 1700),
          wall,
        });
        return;
      }
      if (Math.random() < 0.4) {
        setMode("scratchSelf", timestamp, {
          duration: randomBetween(900, 1700),
        });
        return;
      }
      setMode("tired", timestamp, { duration: randomBetween(800, 1500) });
    };

    /** 散步目的地：视口某条边附近的随机点 */
    const pickWanderTarget = () => {
      const inset = randomBetween(24, EDGE_MARGIN + 30);
      const alongX = randomBetween(24, window.innerWidth - 24);
      const alongY = randomBetween(24, window.innerHeight - 24);
      const edges = [
        { x: alongX, y: inset },
        { x: alongX, y: window.innerHeight - inset },
        { x: inset, y: alongY },
        { x: window.innerWidth - inset, y: alongY },
      ];
      return edges[Math.floor(Math.random() * edges.length)];
    };

    /** 散步到达后的收尾小动作 */
    const arriveWanderAction = (timestamp: number) => {
      const wall = getWallCandidate();
      if (wall && Math.random() < 0.6) {
        setMode("scratchWall", timestamp, {
          duration: randomBetween(900, 1700),
          wall,
        });
        return;
      }
      setMode(Math.random() < 0.5 ? "scratchSelf" : "tired", timestamp, {
        duration: randomBetween(900, 1600),
      });
    };

    // —— 主循环 ——

    const step = (timestamp: number) => {
      frameCount += 1;

      // 精力结算：追逐耗电，休息回电（睡觉回得更快）
      const dt = Math.min(Math.max(timestamp - lastStepAt, 0) / 1000, 0.25);
      lastStepAt = timestamp;
      const energyDelta =
        mode === "chase"
          ? -ENERGY_DRAIN_PER_S
          : ENERGY_REGEN_PER_S * (mode === "sleeping" ? 1.6 : 1);
      energy = clamp(energy + energyDelta * dt, 0, 1);

      // 禁区刷新（~1s 一次）；布局变化把猫困在禁区里时让它自己走出去
      if (timestamp >= nextZoneRefreshAt) {
        nextZoneRefreshAt = timestamp + KEEPOUT_REFRESH_MS;
        refreshKeepOut();
        if (
          inKeepOut(posX, posY) &&
          !(mode === "stroll" && strollReason === "evacuate")
        ) {
          const exit = nearestExitPoint(posX, posY);
          startStroll(timestamp, exit.x, exit.y, "evacuate");
        }
      }

      if (timestamp >= modeEndsAt) finishMode(timestamp);
      maybeReact(timestamp);

      switch (mode) {
        case "chase":
          stepChase(timestamp);
          break;
        case "stroll":
          stepStroll(timestamp);
          break;
        case "watch":
          stepWatch();
          break;
        case "idle":
          stepIdle(timestamp);
          break;
        case "alert":
          setSprite("alert", 0);
          break;
        case "sit":
          setSprite("idle", 0);
          break;
        case "scratchSelf":
          setSprite("scratchSelf", spriteFrame);
          break;
        case "scratchWall":
          setSprite(scratchSprite(), spriteFrame);
          break;
        case "tired":
          setSprite("tired", 0);
          break;
        case "sleeping":
          setSprite("sleeping", Math.floor(spriteFrame / 4));
          break;
      }

      spriteFrame += 1;
    };

    const onAnimationFrame = (timestamp: number) => {
      if (!el.isConnected) return;
      if (timestamp - lastFrame > FRAME_MS) {
        lastFrame = timestamp;
        step(timestamp);
      }
      raf = requestAnimationFrame(onAnimationFrame);
    };

    const onPointerMove = (e: PointerEvent) => {
      const now = performance.now();
      // 间断超过 300ms 记作新的一波移动（"持续移动"的判据）
      if (now - lastPointerAt > 300) pointerStreakStart = now;
      lastPointerAt = now;
      pointerX = e.clientX;
      pointerY = e.clientY;
    };

    const onResize = () => {
      clampToViewport();
      place();
      refreshKeepOut();
    };

    document.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(onAnimationFrame);

    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-slot="mono_pet-neko"
      className="pointer-events-none fixed z-40 h-8 w-8 [image-rendering:pixelated]"
      style={{
        backgroundImage: `url(${NEKO_SKIN.image})`,
        backgroundPosition: "-96px -96px",
      }}
    />
  );
};
