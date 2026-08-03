"use client";

import { create } from "zustand";

/**
 * ⌘K 面板的开关与查询字符串，独立于组件树——侧边栏搜索框的
 * "在全部消息中搜索" 跳转和全局快捷键都要能触达同一份状态。
 */
type CommandPaletteState = {
  open: boolean;
  query: string;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  /** 带着已输入的查询词打开，用于侧边栏搜索框的"深入全文搜索"跳转。 */
  openWithQuery: (query: string) => void;
};

export const useCommandPalette = create<CommandPaletteState>((set) => ({
  open: false,
  query: "",
  setOpen: (open) => set((state) => ({ open, query: open ? state.query : "" })),
  setQuery: (query) => set({ query }),
  openWithQuery: (query) => set({ open: true, query }),
}));
