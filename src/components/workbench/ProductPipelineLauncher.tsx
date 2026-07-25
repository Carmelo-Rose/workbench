"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Folder = { id: string; name: string; imageCount: number };

export function ProductPipelineLauncher({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void fetch(`/api/workbench/mono/product-pipeline/folders?q=${encodeURIComponent(query)}`).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        setFolders(payload.folders ?? []);
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取商品文件夹"));
    }, 150);
    return () => clearTimeout(timer);
  }, [open, query]);
  const start = async () => {
    if (!selected) return;
    setStarting(true); setError(undefined);
    try {
      const response = await fetch("/api/workbench/mono/product-pipeline/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folderId: selected, workflowId: "hat-62604171-v1" }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error); onOpenChange(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "启动失败"); } finally { setStarting(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>商品套图</DialogTitle><DialogDescription>仅显示包含“原图”的商品目录；开始后无需中途输入。</DialogDescription></DialogHeader><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品文件夹" /><div className="max-h-64 space-y-1 overflow-y-auto">{folders.map((folder) => <button type="button" className={`w-full rounded px-3 py-2 text-left text-sm ${selected === folder.id ? "bg-accent" : "hover:bg-muted"}`} onClick={() => setSelected(folder.id)} key={folder.id}>{folder.name}<span className="ml-2 text-muted-foreground">{folder.imageCount} 张原图</span></button>)}</div>{error ? <p className="text-sm text-destructive">{error}</p> : null}<Button disabled={!selected || starting} onClick={() => void start()}>{starting ? "正在创建任务…" : "开始生成"}</Button></DialogContent></Dialog>;
}
