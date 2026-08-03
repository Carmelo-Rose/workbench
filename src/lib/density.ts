// 无 "use client"：常量供服务端 layout 内联，函数仅在浏览器中被调用。
export type DensityPref = "compact" | "standard" | "comfortable";

export const DENSITY_KEY = "wb:density";

export function loadDensityPref(): DensityPref {
  if (typeof window === "undefined") return "standard";
  const stored = window.localStorage.getItem(DENSITY_KEY);
  return stored === "compact" || stored === "comfortable" ? stored : "standard";
}

export function applyDensityPref(pref: DensityPref) {
  if (pref === "standard") {
    document.documentElement.removeAttribute("data-density");
  } else {
    document.documentElement.setAttribute("data-density", pref);
  }
}

export function saveDensityPref(pref: DensityPref) {
  window.localStorage.setItem(DENSITY_KEY, pref);
  applyDensityPref(pref);
}

/** layout.tsx 内联脚本用：首帧前套用密度，避免加载后跳一下的布局抖动。 */
export const DENSITY_INIT_SCRIPT = `try{var d=localStorage.getItem(${JSON.stringify(
  DENSITY_KEY,
)});if(d==="compact"||d==="comfortable")document.documentElement.setAttribute("data-density",d)}catch(e){}`;
