// 无 "use client"：常量供服务端 layout 内联，函数仅在浏览器中被调用。
export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "wb:theme";

export function loadThemePref(): ThemePref {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function applyThemePref(pref: ThemePref) {
  const dark =
    pref === "dark" ||
    (pref === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function saveThemePref(pref: ThemePref) {
  window.localStorage.setItem(THEME_KEY, pref);
  applyThemePref(pref);
}

/** layout.tsx 内联脚本用：首帧前应用主题，避免闪白/闪黑。 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}`;
