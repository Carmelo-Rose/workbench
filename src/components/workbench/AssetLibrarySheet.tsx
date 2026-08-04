"use client";

import { useEffect, useState } from "react";
import { DownloadIcon, ImageIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAssetLibrary } from "@/lib/mono/asset-library";
import { downloadImageSource } from "@/lib/mono/subject-client";

type GeneratedAsset = {
  assetId: string;
  jobId: string;
  role: string;
  slotKey: string;
  name?: string;
  mimeType?: string;
  createdAt: number;
  previewUrl: string;
};

const PAGE_SIZE = 24;

export function AssetLibrarySheet() {
  const open = useAssetLibrary((state) => state.open);
  const close = useAssetLibrary((state) => state.closeLibrary);
  const aui = useAui();
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [hasMore, setHasMore] = useState(true);
  const [insertingId, setInsertingId] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const load = async () => {
      setLoading(true);
      setError(undefined);
      try {
        const response = await fetch(`/api/workbench/mono/assets?origin=generated&limit=${PAGE_SIZE}`, { cache: "no-store" });
        const payload = (await response.json()) as { assets?: GeneratedAsset[] };
        if (disposed) return;
        const list = payload.assets ?? [];
        setAssets(list);
        setHasMore(list.length >= PAGE_SIZE);
      } catch {
        if (!disposed) setError("作品库加载失败");
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => { disposed = true; };
  }, [open]);

  const loadMore = async () => {
    const oldest = assets.at(-1);
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/workbench/mono/assets?origin=generated&limit=${PAGE_SIZE}&before=${oldest.createdAt}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as { assets?: GeneratedAsset[] };
      const list = payload.assets ?? [];
      setAssets((current) => [...current, ...list]);
      setHasMore(list.length >= PAGE_SIZE);
    } catch {
      setError("加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  };

  const insert = async (asset: GeneratedAsset) => {
    setInsertingId(asset.assetId);
    try {
      const file = await downloadImageSource(asset.previewUrl, asset.name || "作品.jpg", asset.mimeType || "image/jpeg");
      await aui.composer().addAttachment(file);
      close();
    } catch {
      setError("插入失败，请重试");
    } finally {
      setInsertingId(undefined);
    }
  };

  const download = async (asset: GeneratedAsset) => {
    try {
      const response = await fetch(asset.previewUrl);
      if (!response.ok) throw new Error("下载失败");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = asset.name || "作品";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("下载失败，请重试");
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="pb-2">
          <SheetTitle>作品库</SheetTitle>
          <SheetDescription>最近生成的图片与视频，点击插入到当前消息，或单独下载。</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && assets.length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" />正在加载作品…
            </p>
          ) : assets.length === 0 ? (
            <p className="text-muted-foreground py-8 text-sm">还没有生成过作品。</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {assets.map((asset) => (
                  <AssetCard
                    key={asset.assetId}
                    asset={asset}
                    inserting={insertingId === asset.assetId}
                    onInsert={() => void insert(asset)}
                    onDownload={() => void download(asset)}
                  />
                ))}
              </div>
              {hasMore ? (
                <Button variant="outline" className="mt-3 w-full" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? <LoaderCircleIcon className="animate-spin" /> : null}加载更多
                </Button>
              ) : null}
            </>
          )}
          {error ? <p className="text-destructive mt-3 text-sm">{error}</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AssetCard({ asset, inserting, onInsert, onDownload }: {
  asset: GeneratedAsset;
  inserting: boolean;
  onInsert: () => void;
  onDownload: () => void;
}) {
  const isVideo = asset.mimeType?.toLowerCase().startsWith("video/");
  return (
    <div className="group relative overflow-hidden rounded-xl border">
      {isVideo ? (
        <video src={asset.previewUrl} className="aspect-square w-full object-cover" muted playsInline preload="metadata" />
      ) : asset.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.previewUrl} alt="" className="aspect-square w-full object-cover" loading="lazy" />
      ) : (
        <div className="bg-muted flex aspect-square w-full items-center justify-center">
          <ImageIcon className="text-muted-foreground size-6" />
        </div>
      )}
      <div className="absolute inset-0 flex items-end justify-end gap-1 bg-gradient-to-t from-black/50 via-transparent to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="secondary" size="icon-xs" title="下载" onClick={onDownload}><DownloadIcon /></Button>
        <Button variant="secondary" size="icon-xs" title="插入到消息" disabled={inserting} onClick={onInsert}>
          {inserting ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
        </Button>
      </div>
    </div>
  );
}
