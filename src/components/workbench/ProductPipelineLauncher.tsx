"use client";

import { useAui } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { startProductPipelineRun } from "@/lib/product-pipeline-run";
import { ModelConsistencyDemoDialog } from "@/experiments/product-set-model-consistency/ModelConsistencyDemoDialog";

type Folder = {
  id: string;
  name: string;
  imageCount: number;
  detailShotCount: number;
  hasMasters: boolean;
  hasImages: boolean;
};
type Workflow = { id: string; label: string };

/**
 * What pressing 开始生成 will actually do to this folder.
 *
 * Ordered by how much the user would regret not knowing: overwriting an
 * existing published set first, then the detail page quietly degrading because
 * nobody staged `x_` macro crops, then the merely useful news that the cutout
 * step gets skipped.
 */
function folderMarks(folder: Folder): { text: string; tone: string }[] {
  const marks: { text: string; tone: string }[] = [];
  if (folder.hasImages) marks.push({ text: "已生成过，将覆盖", tone: "bg-destructive/10 text-destructive" });
  marks.push(folder.detailShotCount > 0
    ? { text: `${folder.detailShotCount} 张细节图`, tone: "bg-muted text-muted-foreground" }
    : { text: "缺细节图，11 号页用整体图拼", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400" });
  if (folder.hasMasters) marks.push({ text: "已生成过主图", tone: "bg-muted text-muted-foreground" });
  return marks;
}

/**
 * Folder selection only. Everything past "start" — progress, gallery,
 * partial-failure retry — lives in the ProductPipelineCard that appears in
 * the conversation once the job is created; this dialog never polls a job
 * or shows one.
 */
export function ProductPipelineLauncher({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const aui = useAui();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [experimentOpen, setExperimentOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void fetch(`/api/workbench/mono/product-pipeline/folders?q=${encodeURIComponent(query)}`).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        setFolders(payload.folders ?? []);
        const installed: Workflow[] = payload.workflows ?? [];
        setWorkflows(installed);
        // Only one bundle is installed today, so there is nothing to choose;
        // the row exists so a second category needs no change here.
        setWorkflowId((current) => current && installed.some((item) => item.id === current) ? current : installed[0]?.id);
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取商品文件夹"));
    }, 150);
    return () => clearTimeout(timer);
  }, [open, query]);

  const start = () => {
    const folder = folders.find((item) => item.id === selected);
    if (!folder || !workflowId) return;
    setStarting(true);
    setError(undefined);
    try {
      startProductPipelineRun(
        aui,
        { folderId: folder.id, workflowId, folderName: folder.name },
        `生成商品套图：${folder.name}`,
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
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>商品套图</DialogTitle>
          <DialogDescription>会生成方形白底主图、每色一张的 SKU 图和 11 张详情套图；详情阶段将调用付费生图服务，任务会在对话里显示进度。</DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onOpenChange(false);
            setExperimentOpen(true);
          }}
        >
          模特一致性 Demo
          <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">实验</span>
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground shrink-0">品类模板</span>
          <select
            value={workflowId ?? ""}
            disabled={workflows.length < 2}
            onChange={(event) => setWorkflowId(event.target.value)}
            className="border-input bg-background disabled:text-muted-foreground min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm disabled:cursor-not-allowed"
          >
            {workflows.length
              ? workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.label}</option>)
              : <option value="">未安装模板</option>}
          </select>
        </label>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品文件夹" />
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {folders.map((folder) => (
            <button
              type="button"
              key={folder.id}
              className={`w-full rounded px-3 py-2 text-left text-sm ${selected === folder.id ? "bg-accent" : "hover:bg-muted"}`}
              onClick={() => setSelected(folder.id)}
            >
              <span className="flex items-baseline gap-2">
                {folder.name}
                <span className="text-muted-foreground text-xs">{folder.imageCount} 张原图</span>
              </span>
              <span className="mt-1 flex flex-wrap gap-1">
                {folderMarks(folder).map((mark) => (
                  <span key={mark.text} className={`rounded-full px-2 py-0.5 text-[11px] ${mark.tone}`}>{mark.text}</span>
                ))}
              </span>
            </button>
          ))}
          {folders.length === 0 ? <p className="text-muted-foreground px-3 py-2 text-sm">没有匹配的商品文件夹</p> : null}
        </div>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <Button disabled={!selected || !workflowId || starting} onClick={start}>
          {starting ? "正在创建任务…" : "开始生成（详情阶段付费）"}
        </Button>
      </DialogContent>
    </Dialog>
    <ModelConsistencyDemoDialog open={experimentOpen} onOpenChange={setExperimentOpen} />
    </>
  );
}
