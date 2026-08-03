"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FC } from "react";
import {
  prefersReducedMotion,
  watchPrefersReducedMotion,
} from "@/components/workbench/use-prefers-reduced-motion";

/**
 * Mono ink wash —— 浅色主题下空会话欢迎屏的"墨迹擦除"背景。
 *
 * 底下藏着一幅由 CSS 渐变构成的单色水墨山水（远山 / 雾带 / 近山 / 纸纹，
 * 全部灰阶、由浅色主题 token 派生），上面盖一层用 --background 实际颜色
 * 填满的 canvas。指针划过时以 destination-out 打出带涡边的墨团洞，短暂
 * 露出底画；墨洞按 easeOutCubic 长大并在 ~560ms 内自愈合。
 *
 * 无墨团时 rAF 循环自动停止，静止状态零开销。active=false 时整体 ~300ms
 * 淡出并停止响应指针。prefers-reduced-motion 与无 hover 的触屏设备降级为
 * 底画低不透明度静态显示（对齐 particle-field 的"静态一帧"思路）。
 */

// —— 墨团 / 自愈合参数（沿用 MimoInkReveal 验证过的手感）——
const R_START = 8; // 墨团初始半径 px
const R_END = 132; // 墨团最大半径 px（再乘 1-R_VARY..1 的随机系数）
const R_VARY = 0.46; // 最大半径的随机浮动幅度
const LIFETIME = 900; // 单个墨团从出生到愈合的时长 ms（底画淡雅，余韵稍放长）
const STAMP_STEP = 12; // 指针轨迹插值步长 px，保证快速划动不断线
const MAX_STAMPS = 150; // 同屏墨团上限，超出丢弃最旧的

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

// —— 底画（隐藏的水墨山水）——
// 全部灰阶、由浅色 token 派生；最深处（近山山脊）也只取 --foreground 的
// ~14%，保证它是"背景"而不是抢戏的主角。
const ink = (pct: number) =>
  `color-mix(in oklab, var(--foreground) ${pct}%, transparent)`;

/** 层 1 · 晕染底：左上一团天光淡墨 + 右上一轮晕月 + 自上而下渐浓的底色 */
const WASH_STYLE: CSSProperties = {
  background: [
    `radial-gradient(120% 75% at 28% 8%, ${ink(6)}, transparent 58%)`,
    // 晕月：淡墨圈出的一轮空心月，给上半区的擦除一点回报
    `radial-gradient(circle at 74% 17%, transparent 26px, ${ink(10)} 30px, ${ink(4)} 40px, transparent 58px)`,
    `linear-gradient(180deg, transparent 0%, ${ink(4)} 46%, ${ink(8)} 100%)`,
  ].join(", "),
};

/** 层 2 · 远山：clip-path 勾出山脊线，墨色向下化开、隐入雾中 */
const FAR_RIDGE_STYLE: CSSProperties = {
  inset: "24% -2% 0",
  background: `linear-gradient(180deg, ${ink(16)}, ${ink(6)} 44%, transparent 74%)`,
  clipPath:
    "polygon(0 30%, 9% 16%, 20% 26%, 33% 6%, 45% 22%, 58% 0%, 71% 18%, 83% 8%, 93% 20%, 100% 12%, 100% 100%, 0 100%)",
};

/** 层 3 · 雾带：一条背景色的横向留白，把远山山脚洗掉 */
const MIST_STYLE: CSSProperties = {
  inset: "42% 0 24%",
  background: `linear-gradient(180deg, transparent, color-mix(in oklab, var(--background) 90%, transparent) 42% 58%, transparent)`,
};

/** 层 4 · 近山：更低、稍浓的一道山脊，同样向下化开 */
const NEAR_RIDGE_STYLE: CSSProperties = {
  inset: "52% -2% 0",
  background: `linear-gradient(180deg, ${ink(24)}, ${ink(10)} 40%, transparent 82%)`,
  clipPath:
    "polygon(0 24%, 8% 36%, 18% 10%, 30% 30%, 44% 4%, 57% 26%, 68% 12%, 80% 32%, 91% 18%, 100% 28%, 100% 100%, 0 100%)",
};

/** 层 5 · 纸纹：两组错频点阵模拟宣纸颗粒，极淡 */
const GRAIN_STYLE: CSSProperties = {
  backgroundImage: [
    `radial-gradient(circle at 26% 38%, ${ink(10)} 0 1px, transparent 1.5px)`,
    `radial-gradient(circle at 72% 66%, ${ink(7)} 0 1px, transparent 1.5px)`,
  ].join(", "),
  backgroundSize: "44px 39px, 67px 58px",
};

/**
 * 把 var(--background) 解析成 canvas 可用的实际 rgb 颜色
 * （探针元素取 computed color + 1px canvas 回读，兼容 oklch）。
 */
const resolveBackground = (host: HTMLElement): string => {
  const probe = document.createElement("span");
  probe.style.color = "var(--background)";
  probe.style.display = "none";
  host.appendChild(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();

  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cctx = cv.getContext("2d");
  if (!cctx) return "#ffffff";
  cctx.fillStyle = css;
  cctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = cctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
};

/** 画一个多谐波 wobble 边缘的墨团（destination-out 下只有 alpha 起作用） */
const drawInk = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  alpha: number,
  seed: number,
) => {
  const gradient = ctx.createRadialGradient(x, y, radius * 0.24, x, y, radius);
  gradient.addColorStop(0, `rgba(0, 0, 0, ${0.96 * alpha})`);
  gradient.addColorStop(0.52, `rgba(0, 0, 0, ${0.82 * alpha})`);
  gradient.addColorStop(0.78, `rgba(0, 0, 0, ${0.28 * alpha})`);
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

  ctx.fillStyle = gradient;
  ctx.beginPath();

  // 三个不同频率的正弦叠加，得到不规则的"涡边"轮廓
  const segments = 36;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const wobble =
      0.8 +
      0.12 * Math.sin(angle * 3 + seed) +
      0.08 * Math.sin(angle * 7 + seed * 2.1) +
      0.05 * Math.sin(angle * 13 + seed * 0.7);
    const r = radius * wobble;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }

  ctx.closePath();
  ctx.fill();
};

type Stamp = {
  x: number;
  y: number;
  born: number;
  seed: number;
  rMax: number;
};

type Engine = {
  setActive: (active: boolean) => void;
  destroy: () => void;
};

const createEngine = (canvas: HTMLCanvasElement): Engine | null => {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;

  const stamps: Stamp[] = [];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let lastX: number | null = null;
  let lastY: number | null = null;
  let raf = 0;
  let running = false;
  let active = false;

  // 遮罩色只解析一次：主题切换时 ThreadBackdrop 会整体换组件重挂载，
  // 组件生命周期内 --background 不会变。
  let maskColor = "#ffffff";

  const fillMask = () => {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = maskColor;
    ctx.fillRect(0, 0, width, height);
  };

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fillMask(); // 重设尺寸会清空画布，立即补上遮罩
  };

  const addStamp = (x: number, y: number) => {
    if (stamps.length >= MAX_STAMPS) stamps.shift();
    stamps.push({
      x,
      y,
      born: performance.now(),
      seed: Math.random() * Math.PI * 2,
      rMax: R_END * (1 - R_VARY + Math.random() * R_VARY),
    });
  };

  /** 沿上一次指针位置到当前位置的线段插值补墨团，快速划动不断线 */
  const stampAlong = (x: number, y: number) => {
    if (lastX === null || lastY === null) {
      addStamp(x, y);
    } else {
      const dx = x - lastX;
      const dy = y - lastY;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STAMP_STEP));
      for (let i = 1; i <= steps; i++) {
        addStamp(lastX + (dx * i) / steps, lastY + (dy * i) / steps);
      }
    }
    lastX = x;
    lastY = y;
  };

  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  const loop = () => {
    const now = performance.now();
    fillMask();

    ctx.globalCompositeOperation = "destination-out";
    for (let i = stamps.length - 1; i >= 0; i--) {
      const stamp = stamps[i];
      const t = (now - stamp.born) / LIFETIME;
      if (t >= 1) {
        stamps.splice(i, 1); // 寿命到，洞完全愈合
        continue;
      }
      // 半径 easeOutCubic 长大，alpha 随 t² 衰减 → 洞先冲开再缓缓合拢
      const radius = R_START + (stamp.rMax - R_START) * easeOutCubic(t);
      drawInk(ctx, stamp.x, stamp.y, radius, 1 - t * t, stamp.seed);
    }
    ctx.globalCompositeOperation = "source-over";

    if (stamps.length > 0) {
      raf = requestAnimationFrame(loop);
    } else {
      // 全部愈合：补一帧完整遮罩后停表，静止零开销
      running = false;
      fillMask();
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(loop);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active || document.hidden) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      // 出界：断开轨迹，避免再进入时拉出一条横穿的墨线
      lastX = lastY = null;
      return;
    }
    stampAlong(x, y);
    start();
  };

  const onPointerLeave = () => {
    lastX = lastY = null;
  };

  const onVisibility = () => {
    if (document.hidden) {
      // 切走时直接清场：回来不会看到一批"冻住"的旧洞
      stop();
      stamps.length = 0;
      lastX = lastY = null;
      fillMask();
    }
  };

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("visibilitychange", onVisibility);

  maskColor = resolveBackground(canvas.parentElement ?? document.body);
  resize();

  return {
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      if (!next) {
        // 不再接受新墨团；已有的让其自然愈合（≤560ms），循环随后自停
        lastX = lastY = null;
      }
    },
    destroy() {
      stop();
      ro.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
};

/** 静态降级：reduced-motion 或无 hover 能力的触屏设备 */
const matchDegraded = () =>
  typeof window !== "undefined" &&
  (prefersReducedMotion() || window.matchMedia("(hover: none)").matches);

export const InkWashField: FC<{ active: boolean }> = ({ active }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [degraded, setDegraded] = useState(matchDegraded);

  useEffect(() => {
    const hoverQuery = window.matchMedia("(hover: none)");
    const update = () => setDegraded(matchDegraded());
    const unwatchReducedMotion = watchPrefersReducedMotion(update);
    hoverQuery.addEventListener("change", update);
    return () => {
      unwatchReducedMotion();
      hoverQuery.removeEventListener("change", update);
    };
  }, []);

  // 引擎生命周期（StrictMode 双挂载安全：2d 上下文可反复获取）
  useEffect(() => {
    if (degraded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    engineRef.current = createEngine(canvas);
    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [degraded]);

  useEffect(() => {
    engineRef.current?.setActive(active);
  }, [active, degraded]);

  return (
    <div
      data-slot="mono_ink-wash-field"
      aria-hidden="true"
      // 挂载时用入场动画淡入（替代 mounted state），后续 active 切换走 transition
      className="pointer-events-none fade-in animate-in absolute inset-0 h-full w-full transition-opacity duration-300 [mask-image:radial-gradient(115%_100%_at_50%_38%,black_30%,transparent_82%)]"
      style={{ opacity: active ? 1 : 0 }}
    >
      {/* 底画：单色水墨山水（降级模式下以低不透明度静态显示） */}
      <div className="absolute inset-0" style={{ opacity: degraded ? 0.4 : 1 }}>
        <div className="absolute inset-0" style={WASH_STYLE} />
        <div className="absolute" style={FAR_RIDGE_STYLE} />
        <div className="absolute" style={MIST_STYLE} />
        <div className="absolute" style={NEAR_RIDGE_STYLE} />
        <div className="absolute inset-0" style={GRAIN_STYLE} />
      </div>
      {/* 遮罩层：--background 实色覆盖，指针擦出墨洞后自愈合 */}
      {!degraded && (
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      )}
    </div>
  );
};
