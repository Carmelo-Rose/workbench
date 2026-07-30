/* eslint-disable @next/next/no-img-element -- previews use authenticated same-origin routes. */
"use client";

import { useAui } from "@assistant-ui/react";
import { ImageIcon, SearchIcon, SparklesIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useImage2Mode } from "@/lib/image2-mode";
import { startProductPipelineRun } from "@/lib/product-pipeline-run";
import { cn } from "@/lib/utils";

type Folder = {
  id: string;
  name: string;
  imageCount: number;
  detailShotCount: number;
  hasMasters: boolean;
  hasImages: boolean;
};
type Workflow = { id: string; label: string };
type ModelProfile = {
  id: string;
  displayName: string;
  faceAssetId?: string;
  anchorAssetId: string;
};
type ModelPair = {
  id: string;
  displayName: string;
  female: ModelProfile;
  male: ModelProfile;
};

function modelProfileImage(profile: ModelProfile): string {
  return `/api/workbench/mono/assets/${encodeURIComponent(profile.faceAssetId ?? profile.anchorAssetId)}/content`;
}

function folderPreview(folder: Folder): string {
  return `/api/workbench/mono/product-pipeline/folders/${encodeURIComponent(folder.id)}/preview`;
}

function folderMarks(folder: Folder): { text: string; tone: string }[] {
  const marks: { text: string; tone: string }[] = [];
  if (folder.hasImages) marks.push({ text: "将覆盖已有套图", tone: "bg-destructive/10 text-destructive" });
  if (folder.detailShotCount > 0) {
    marks.push({ text: `${folder.detailShotCount} 张细节图`, tone: "bg-muted text-muted-foreground" });
  } else {
    marks.push({ text: "无细节图", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400" });
  }
  if (folder.hasMasters) marks.push({ text: "已有主图", tone: "bg-muted text-muted-foreground" });
  return marks;
}

export function ProductPipelineLauncher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const aui = useAui();
  const openSubjectLibrary = useImage2Mode((state) => state.openSubjectLibrary);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [modelPairs, setModelPairs] = useState<ModelPair[]>([]);
  const [fixedModel, setFixedModel] = useState(false);
  const [modelPairId, setModelPairId] = useState<string>();
  const [workflowId, setWorkflowId] = useState<string>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [modelLibraryVersion, setModelLibraryVersion] = useState(0);
  const reopenAfterLibrary = useRef(false);

  useEffect(() => {
    const refresh = () => setModelLibraryVersion((version) => version + 1);
    const returnToLauncher = () => {
      if (!reopenAfterLibrary.current) return;
      reopenAfterLibrary.current = false;
      onOpenChange(true);
    };
    window.addEventListener("workbench:model-library-changed", refresh);
    window.addEventListener("workbench:subject-library-closed", returnToLauncher);
    return () => {
      window.removeEventListener("workbench:model-library-changed", refresh);
      window.removeEventListener("workbench:subject-library-closed", returnToLauncher);
    };
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void fetch(`/api/workbench/mono/product-pipeline/folders?q=${encodeURIComponent(query)}`, { cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error);
          setFolders(payload.folders ?? []);
          const availablePairs: ModelPair[] = payload.modelPairs ?? [];
          setModelPairs(availablePairs);
          setModelPairId((current) =>
            current && availablePairs.some((item) => item.id === current) ? current : undefined);
          const installed: Workflow[] = payload.workflows ?? [];
          setWorkflows(installed);
          setWorkflowId((current) =>
            current && installed.some((item) => item.id === current) ? current : installed[0]?.id);
          setError(undefined);
        })
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : "无法读取商品文件夹"));
    }, 150);
    return () => clearTimeout(timer);
  }, [open, query, modelLibraryVersion]);

  const selectedFolder = folders.find((item) => item.id === selected);
  const selectedPair = modelPairs.find((item) => item.id === modelPairId);

  const manageModels = () => {
    reopenAfterLibrary.current = true;
    onOpenChange(false);
    window.setTimeout(() => openSubjectLibrary(undefined, "pairs"), 120);
  };

  const start = () => {
    if (!selectedFolder || !workflowId || (fixedModel && !selectedPair)) return;
    if (selectedFolder.hasImages && !window.confirm("该商品已有套图。本次生成会覆盖对应成品，是否继续？")) return;
    setStarting(true);
    setError(undefined);
    try {
      startProductPipelineRun(
        aui,
        {
          folderId: selectedFolder.id,
          workflowId,
          folderName: selectedFolder.name,
          ...(fixedModel && selectedPair ? { modelPairId: selectedPair.id } : {}),
        },
        fixedModel && selectedPair
          ? `用“${selectedPair.displayName}”生成商品套图：${selectedFolder.name}`
          : `自动生成模特并制作商品套图：${selectedFolder.name}`,
      );
      setSelected(undefined);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "启动失败");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>商品套图</DialogTitle>
          <DialogDescription>选择商品即可生成主图、SKU 与详情套图。</DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">选择商品</h3>
            <span className="text-muted-foreground text-xs">{folders.length} 个商品</span>
          </div>
          <div className="relative">
            <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索商品"
              className="pl-9"
            />
          </div>
          <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {folders.map((folder) => (
              <button
                type="button"
                key={folder.id}
                className={cn(
                  "flex min-w-0 gap-3 rounded-xl border p-2 text-left transition-colors",
                  selected === folder.id ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                )}
                onClick={() => setSelected(folder.id)}
              >
                <span className="bg-muted relative h-20 w-20 shrink-0 overflow-hidden rounded-lg">
                  <ImageIcon className="text-muted-foreground absolute inset-0 m-auto size-5" />
                  <img src={folderPreview(folder)} alt="" className="relative size-full object-cover" />
                </span>
                <span className="min-w-0 flex-1 py-1">
                  <strong className="block truncate text-sm">{folder.name}</strong>
                  <span className="text-muted-foreground text-xs">{folder.imageCount} 张原图</span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {folderMarks(folder).map((mark) => (
                      <span key={mark.text} className={cn("rounded-full px-2 py-0.5 text-[11px]", mark.tone)}>
                        {mark.text}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            ))}
            {!folders.length ? (
              <p className="text-muted-foreground col-span-full rounded-xl bg-muted/40 p-6 text-center text-sm">
                没有匹配的商品
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border">
          <button
            type="button"
            onClick={() => {
              setFixedModel((value) => !value);
              if (fixedModel) setModelPairId(undefined);
            }}
            className="flex w-full items-center gap-3 p-3 text-left"
          >
            <span className={cn(
              "grid size-9 place-items-center rounded-lg",
              fixedModel ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}>
              {fixedModel ? <UserRoundIcon className="size-4" /> : <SparklesIcon className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block text-sm">{fixedModel ? "固定模特组合" : "自动模特"}</strong>
              <span className="text-muted-foreground block text-xs">
                {fixedModel ? "套图将复用所选人物的脸部与体型倾向" : "无需选择模特，系统按画面自动生成"}
              </span>
            </span>
            <span className={cn(
              "h-6 w-11 rounded-full p-0.5 transition-colors",
              fixedModel ? "bg-primary" : "bg-muted-foreground/25",
            )}>
              <span className={cn(
                "block size-5 rounded-full bg-white shadow transition-transform",
                fixedModel && "translate-x-5",
              )} />
            </span>
          </button>

          {fixedModel ? (
            <div className="space-y-3 border-t p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">选择组合</span>
                <Button variant="ghost" size="xs" onClick={manageModels}>管理模特</Button>
              </div>
              {modelPairs.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {modelPairs.map((pair) => (
                    <button
                      key={pair.id}
                      type="button"
                      onClick={() => setModelPairId(pair.id)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-2 text-left",
                        pair.id === modelPairId ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                      )}
                    >
                      <span className="flex shrink-0 -space-x-2">
                        <img className="h-12 w-10 rounded-md object-cover ring-2 ring-background" src={modelProfileImage(pair.female)} alt="" />
                        <img className="h-12 w-10 rounded-md object-cover ring-2 ring-background" src={modelProfileImage(pair.male)} alt="" />
                      </span>
                      <span className="min-w-0">
                        <strong className="block truncate text-sm">{pair.displayName}</strong>
                        <span className="text-muted-foreground block truncate text-xs">
                          {pair.female.displayName} · {pair.male.displayName}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <button type="button" onClick={manageModels} className="text-muted-foreground w-full rounded-lg bg-muted/50 p-4 text-sm">
                  暂无模特组合，点击前往创建
                </button>
              )}
            </div>
          ) : null}
        </section>

        {workflows.length > 1 ? (
          <label className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground shrink-0">套图模板</span>
            <select
              value={workflowId ?? ""}
              onChange={(event) => setWorkflowId(event.target.value)}
              className="border-input bg-background min-w-0 flex-1 rounded-md border px-2 py-2 text-sm"
            >
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>{workflow.label}</option>
              ))}
            </select>
          </label>
        ) : null}

        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <div className="flex items-center gap-3 border-t pt-4">
          <div className="text-muted-foreground min-w-0 flex-1 text-xs">
            {selectedFolder ? `已选择：${selectedFolder.name}` : "请选择一个商品"}
          </div>
          <Button
            disabled={!selectedFolder || !workflowId || (fixedModel && !modelPairId) || starting}
            onClick={start}
          >
            <SparklesIcon />
            {starting ? "正在创建…" : "生成套图"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
