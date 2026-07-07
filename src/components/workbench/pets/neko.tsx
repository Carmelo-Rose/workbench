"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";

/**
 * 像素小猫挂件 — oneko.js 的 TypeScript/React 移植。
 * Original: https://github.com/adryd325/oneko.js (MIT © 2022 adryd)
 * Sprite sheet: /pets/oneko.gif (256×128, 32px cells)
 *
 * 猫会追逐指针，追上后 alert -> idle；长时间无指针活动后进入 waiting / sleeping。
 * prefers-reduced-motion 下只在角落静置一帧，不进入动画循环。
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
  | "chase"
  | "alert"
  | "idle"
  | "scratchSelf"
  | "scratchWall"
  | "tired"
  | "sleeping"
  | "waiting";

const FRAME_MS = 100;
const CHASE_SPEED = 8.5;
const CATCH_DISTANCE = 46;
const WAKE_DISTANCE = 80;
const EDGE_MARGIN = 34;
const WAITING_AFTER_MS = 9000;
const SLEEP_AFTER_MS = 17000;

const randomBetween = (min: number, max: number) =>
  min + Math.random() * (max - min);

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const NekoPet: FC = () => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let posX = window.innerWidth - 64;
    let posY = window.innerHeight - 96;
    let pointerX = posX;
    let pointerY = posY;
    let frameCount = 0;
    let spriteFrame = 0;
    let mode: NekoMode = "idle";
    let modeStartedAt = performance.now();
    let nextIdleActionAt = modeStartedAt + randomBetween(1800, 4200);
    let lastPointerAt = modeStartedAt;
    let scratchWall: WallDirection = "E";
    let lastFrame = 0;
    let raf = 0;

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

    const setMode = (
      nextMode: NekoMode,
      timestamp: number,
      wall: WallDirection = scratchWall,
    ) => {
      if (mode === nextMode && wall === scratchWall) return;
      mode = nextMode;
      scratchWall = wall;
      spriteFrame = 0;
      modeStartedAt = timestamp;
    };

    place();
    setSprite("idle", 0);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const distanceToPointer = () =>
      Math.hypot(posX - pointerX, posY - pointerY);

    const getDirection = (): Direction => {
      const diffX = posX - pointerX;
      const diffY = posY - pointerY;
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

    const chooseIdleAction = (timestamp: number) => {
      const wall = getWallCandidate();
      if (wall && Math.random() < 0.55) {
        setMode("scratchWall", timestamp, wall);
        return;
      }
      if (Math.random() < 0.42) {
        setMode("scratchSelf", timestamp);
        return;
      }
      setMode("tired", timestamp);
    };

    const stepChase = (timestamp: number) => {
      const diffX = posX - pointerX;
      const diffY = posY - pointerY;
      const distance = Math.max(Math.hypot(diffX, diffY), 1);

      if (distance < CATCH_DISTANCE) {
        setMode("alert", timestamp);
        return;
      }

      const speed = distance < 140 ? CHASE_SPEED * 0.72 : CHASE_SPEED;
      setSprite(getDirection(), frameCount);
      posX -= (diffX / distance) * speed;
      posY -= (diffY / distance) * speed;
      place();
    };

    const stepIdle = (timestamp: number) => {
      const inactiveFor = timestamp - lastPointerAt;
      if (inactiveFor > SLEEP_AFTER_MS) {
        setMode("sleeping", timestamp);
        return;
      }
      if (inactiveFor > WAITING_AFTER_MS) {
        setMode("waiting", timestamp);
        return;
      }
      if (timestamp > nextIdleActionAt) {
        nextIdleActionAt = timestamp + randomBetween(2400, 6200);
        chooseIdleAction(timestamp);
        return;
      }
      setSprite("idle", 0);
    };

    const step = (timestamp: number) => {
      frameCount += 1;
      const modeAge = timestamp - modeStartedAt;
      const recentlyActive = timestamp - lastPointerAt < SLEEP_AFTER_MS;
      const shouldChase = distanceToPointer() > WAKE_DISTANCE && recentlyActive;

      if (shouldChase && mode !== "chase" && mode !== "alert") {
        setMode("alert", timestamp);
      }

      switch (mode) {
        case "chase":
          stepChase(timestamp);
          break;
        case "alert":
          setSprite("alert", 0);
          if (modeAge > 420) setMode(shouldChase ? "chase" : "idle", timestamp);
          break;
        case "scratchSelf":
          setSprite("scratchSelf", spriteFrame);
          if (modeAge > 950) setMode("idle", timestamp);
          break;
        case "scratchWall":
          setSprite(scratchSprite(), spriteFrame);
          if (modeAge > 950) setMode("idle", timestamp);
          break;
        case "tired":
          setSprite("tired", 0);
          if (modeAge > 950) setMode("sleeping", timestamp);
          break;
        case "sleeping":
          setSprite("sleeping", Math.floor(spriteFrame / 4));
          break;
        case "waiting":
          setSprite(
            Math.floor(spriteFrame / 12) % 2 === 0 ? "alert" : "idle",
            0,
          );
          if (timestamp - lastPointerAt > SLEEP_AFTER_MS + 5200) {
            setMode("tired", timestamp);
          }
          break;
        case "idle":
        default:
          stepIdle(timestamp);
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
      pointerX = e.clientX;
      pointerY = e.clientY;
      lastPointerAt = performance.now();
      if (
        mode === "sleeping" ||
        mode === "waiting" ||
        mode === "tired" ||
        mode === "scratchSelf" ||
        mode === "scratchWall"
      ) {
        setMode("alert", lastPointerAt);
      }
    };

    const onResize = () => {
      clampToViewport();
      place();
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
