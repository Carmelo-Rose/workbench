"use client";

import { create } from "zustand";

type AssetLibraryStore = {
  open: boolean;
  openLibrary: () => void;
  closeLibrary: () => void;
};

/** composer 的「+」菜单和 ⌘K 命令面板共享同一个开关，打开同一个 Sheet。 */
export const useAssetLibrary = create<AssetLibraryStore>((set) => ({
  open: false,
  openLibrary: () => set({ open: true }),
  closeLibrary: () => set({ open: false }),
}));
