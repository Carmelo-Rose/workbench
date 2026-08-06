/* eslint-disable @next/next/no-img-element -- images are served by the private same-origin trial route. */
"use client";

import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, LoaderCircleIcon, SearchIcon, XIcon } from "lucide-react";
import type { MonoJob } from "@/lib/mono/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Folder = {
  id: string;
  name: string;
  imageCount: number;
  detailShotCount: number;
  hasMasters: boolean;
  hasImages: boolean;
};

type Workflow = { id: string; label: string };
type ModelPair = {
  id: string;
  displayName: string;
  female: { displayName: string };
  male: { displayName: string };
};

type TrialPayload = {
  folders?: Folder[];
  workflows?: Workflow[];
  modelPairs?: ModelPair[];
  job?: MonoJob;
  error?: string;
  rootReachable?: boolean;
  root?: string;
};

type SlotMeta = { id: string; kind: "model" | "fixed" | "tiled" | "detail" };
const SLOT_META: SlotMeta[] = [
  { id: "01", kind: "model" },
  { id: "02", kind: "fixed" },
  { id: "03", kind: "model" },
  { id: "04", kind: "model" },
  { id: "05", kind: "model" },
  { id: "06", kind: "model" },
  { id: "07", kind: "model" },
  { id: "08", kind: "model" },
  { id: "09", kind: "fixed" },
  { id: "10", kind: "tiled" },
  { id: "11", kind: "detail" },
];

const stageLabel: Record<string, string> = {
  main_published: "主图已完成，正在准备详情套图",
  generating_masters: "正在生成白底主图",
  正在生成白底主图: "正在生成白底主图",
  classifying: "正在识别商品颜色和角度",
  classified: "颜色识别完成",
  generating_main: "正在生成主图背景（会调用付费生图服务）",
  publishing_main: "正在发布主图",
  rendering_sku: "正在渲染 SKU 图",
  publishing_sku: "正在发布 SKU 图",
  generating_models: "正在生成模特图（会调用付费生图服务）",
  compositing: "正在制作商品拼图",
  qa: "正在进行视觉与尺寸质检",
  publishing_images: "正在发布详情套图",
  branch_published: "已发布",
  branch_failed: "未能完成",
  queued: "排队中",
  completed: "详情套图已完成",
};

type SlotRecord = { slot: string; attempts?: number; warning?: string };
type FailedSlot = { slot: string; reason: string };
type PipelineResult = {
  stage?: string;
  progress?: number;
  slots?: SlotRecord[];
  failedSlots?: FailedSlot[];
  /** Per-branch stage and percentage, since 主图 / SKU / images now run at once. */
  branches?: Record<string, { stage?: string; progress?: number }>;
  failedBranches?: { branch: string; reason: string; label?: string }[];
  incomplete?: boolean;
  warnings?: string[];
};

const BRANCH_ORDER = ["prepare", "main", "sku", "images"] as const;
const branchLabel: Record<string, string> = {
  prepare: "白底图与颜色识别",
  main: "主图",
  sku: "SKU 图",
  images: "详情套图",
};

function resultOf(job: MonoJob | null): PipelineResult {
  return (job?.result ?? {}) as PipelineResult;
}

function imageUrl(jobId: string, slot: string, width?: number, version?: number): string {
  const params = new URLSearchParams();
  if (width) params.set("w", String(width));
  if (version) params.set("v", String(version));
  const query = params.size ? `?${params.toString()}` : "";
  return `/api/try/product-pipeline/jobs/${encodeURIComponent(jobId)}/images/${slot}${query}`;
}

function active(job: MonoJob | null): boolean {
  return job?.status === "queued" || job?.status === "running";
}

async function requestJson<T extends TrialPayload>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(payload.error ?? `请求失败（${response.status}）`);
  return payload;
}

function folderStatus(folder: Folder): string {
  const parts = [`${folder.imageCount} 张原图`];
  if (folder.detailShotCount) parts.push(`${folder.detailShotCount} 张细节图`);
  if (folder.hasMasters) parts.push("已有主图");
  if (folder.hasImages) parts.push("已有成品");
  return parts.join(" · ");
}

export function ProductPipelineTrial() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [modelPairs, setModelPairs] = useState<ModelPair[]>([]);
  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string>();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>();
  const [selectedModelPairId, setSelectedModelPairId] = useState<string>();
  const [job, setJob] = useState<MonoJob | null>(null);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const [rootReachable, setRootReachable] = useState(true);
  const [root, setRoot] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoadingFolders(true);
      void requestJson(`/api/try/product-pipeline/folders?q=${encodeURIComponent(query)}`)
        .then((payload) => {
          const nextFolders = payload.folders ?? [];
          const nextWorkflows = payload.workflows ?? [];
          const nextPairs = payload.modelPairs ?? [];
          setFolders(nextFolders);
          setWorkflows(nextWorkflows);
          setModelPairs(nextPairs);
          setSelectedFolderId((current) => current && nextFolders.some((folder) => folder.id === current) ? current : undefined);
          setSelectedWorkflowId((current) => current && nextWorkflows.some((workflow) => workflow.id === current) ? current : nextWorkflows[0]?.id);
          setSelectedModelPairId((current) => current && nextPairs.some((pair) => pair.id === current) ? current : nextPairs[0]?.id);
          setRootReachable(payload.rootReachable ?? true);
          setRoot(payload.root);
          setError(undefined);
        })
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取商品文件夹"))
        .finally(() => setLoadingFolders(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, retryToken]);

  const currentJobId = job?.id;
  const currentJobStatus = job?.status;

  useEffect(() => {
    if (!currentJobId || (currentJobStatus !== "queued" && currentJobStatus !== "running")) return undefined;
    let disposed = false;
    const refresh = async () => {
      try {
        const payload = await requestJson<{ job?: MonoJob; error?: string }>(
          `/api/try/product-pipeline/jobs/${encodeURIComponent(currentJobId)}`,
        );
        if (!disposed && payload.job) setJob(payload.job);
      } catch (reason: unknown) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "任务状态读取失败");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [currentJobId, currentJobStatus]);

  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolderId),
    [folders, selectedFolderId],
  );
  const result = resultOf(job);
  const generatedSlots = result.slots?.map((slot) => slot.slot) ?? [];
  const failedSlots = new Map((result.failedSlots ?? []).map((slot) => [slot.slot, slot.reason]));
  const canStart = Boolean(selectedFolderId && selectedWorkflowId && selectedModelPairId && !starting && !active(job));

  const start = async () => {
    if (!selectedFolderId || !selectedWorkflowId || !selectedModelPairId) return;
    setStarting(true);
    setError(undefined);
    try {
      const payload = await requestJson<{ job?: MonoJob; error?: string }>("/api/try/product-pipeline/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderId: selectedFolderId,
          workflowId: selectedWorkflowId,
          modelPairId: selectedModelPairId,
        }),
      });
      if (!payload.job) throw new Error("任务创建失败");
      setJob(payload.job);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "任务创建失败");
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!job || !active(job)) return;
    setCancelling(true);
    try {
      const payload = await requestJson<{ job?: MonoJob; error?: string }>(
        `/api/try/product-pipeline/jobs/${encodeURIComponent(job.id)}`,
        { method: "DELETE" },
      );
      if (payload.job) setJob(payload.job);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "取消任务失败");
    } finally {
      setCancelling(false);
    }
  };

  const downloadAll = () => {
    if (!job) return;
    generatedSlots.forEach((slot, index) => {
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = imageUrl(job.id, slot);
        link.download = `${selectedFolder?.name.split(" / ").at(-1) ?? "product"}_${slot}.jpg`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 250);
    });
  };

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium tracking-[0.2em]">WORKBENCH · TEMPORARY PREVIEW</p>
          <h1 className="text-3xl font-semibold tracking-tight">商品套图体验</h1>
          <p className="text-muted-foreground max-w-2xl text-sm leading-6">
            选择服务端已有的商品文件夹和模特组合，生成白底图、SKU 图和详情套图。详情阶段会调用付费生图服务，结果会写回服务端商品目录。
          </p>
        </header>

        <section className="grid gap-6 rounded-2xl border bg-card p-4 shadow-sm lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] lg:p-6">
          <div className="min-w-0 space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-medium">选择商品文件夹</h2>
                <p className="text-muted-foreground mt-1 text-xs">当前展示服务端可用的全部商品文件夹。</p>
              </div>
              <label className="relative block sm:w-64">
                <SearchIcon className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4" />
                <Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品编号或文件夹" />
              </label>
            </div>

            <div className="max-h-[32rem] space-y-1 overflow-y-auto rounded-xl border p-2">
              {loadingFolders && !folders.length ? (
                <p className="text-muted-foreground flex items-center gap-2 px-3 py-8 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在读取商品文件夹…</p>
              ) : folders.length ? folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => setSelectedFolderId(folder.id)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left transition ${selectedFolderId === folder.id ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-muted"}`}
                >
                  <span className="block truncate text-sm font-medium">{folder.name}</span>
                  <span className="text-muted-foreground mt-1 block text-xs">{folderStatus(folder)}</span>
                </button>
              )) : !rootReachable ? (
                <div className="text-muted-foreground px-3 py-8 text-center text-sm">
                  <p className="text-foreground font-medium">共享盘不可达</p>
                  <p className="mt-1">连不上 {root ?? "商品原图目录"}，请检查网络或确认共享盘已挂载</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => setRetryToken((token) => token + 1)}
                  >
                    重试
                  </Button>
                </div>
              ) : query ? (
                <p className="text-muted-foreground px-3 py-8 text-center text-sm">没有匹配「{query}」的商品文件夹，换个关键词试试</p>
              ) : (
                <p className="text-muted-foreground px-3 py-8 text-center text-sm">目录下暂无商品，请让摄影师先上传原图</p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h2 className="font-medium">生成设置</h2>
              <p className="text-muted-foreground mt-1 text-xs">当前体验只开放必要选项。</p>
            </div>
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground text-xs">模特组合</span>
              <select className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={selectedModelPairId ?? ""} onChange={(event) => setSelectedModelPairId(event.target.value)}>
                {!modelPairs.length ? <option value="">暂无可用模特组合</option> : modelPairs.map((pair) => <option key={pair.id} value={pair.id}>{pair.displayName}（{pair.female.displayName} / {pair.male.displayName}）</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground text-xs">品类模板</span>
              <select className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={selectedWorkflowId ?? ""} onChange={(event) => setSelectedWorkflowId(event.target.value)} disabled={workflows.length < 2}>
                {!workflows.length ? <option value="">暂无可用模板</option> : workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.label}</option>)}
              </select>
            </label>
            <div className="bg-muted/50 rounded-xl p-3 text-xs leading-5">
              <p className="font-medium">当前选择</p>
              <p className="text-muted-foreground mt-1 break-words">{selectedFolder?.name ?? "尚未选择商品文件夹"}</p>
            </div>
            <Button className="w-full" disabled={!canStart} onClick={() => void start()}>
              {starting ? <><LoaderCircleIcon className="animate-spin" />正在创建任务…</> : "开始生成商品套图"}
            </Button>
            {active(job) ? <Button variant="outline" className="w-full" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在停止…" : "停止任务"}</Button> : null}
          </div>
        </section>

        {error ? <div role="alert" className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm">{error}</div> : null}

        {job ? (
          <section className="space-y-4 rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-medium">任务结果</h2>
                <p className="text-muted-foreground mt-1 text-xs">任务 ID：{job.id}</p>
              </div>
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                {active(job) ? <LoaderCircleIcon className="size-4 animate-spin" /> : job.status === "succeeded" ? "已完成" : job.status === "cancelled" ? "已停止" : "处理失败"}
                {active(job) ? `${stageLabel[result.stage ?? ""] ?? "正在处理"}${result.progress !== undefined ? ` · ${result.progress}%` : ""}` : null}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-11">
              {SLOT_META.map((slot) => {
                const produced = result.slots?.some((item) => item.slot === slot.id);
                const failure = failedSlots.get(slot.id);
                return (
                  <div key={`${slot.id}:${produced ? "done" : failure ? "failed" : "pending"}:${job.updatedAt}`} className="space-y-1">
                    <div className="bg-muted relative aspect-[3/4] overflow-hidden rounded-lg border">
                      {produced ? <img className="h-full w-full object-cover" src={imageUrl(job.id, slot.id, 520, job.updatedAt)} alt={`槽位 ${slot.id}`} /> : <div className="text-muted-foreground flex h-full items-center justify-center text-xs">{failure ? "失败" : slot.kind === "fixed" ? "固定页" : "等待"}</div>}
                    </div>
                    <p className="text-center text-xs font-medium">{slot.id}{failure ? <span className="text-destructive ml-1">!</span> : null}</p>
                    {failure ? <p className="text-destructive line-clamp-2 text-[10px]" title={failure}>{failure}</p> : null}
                  </div>
                );
              })}
            </div>

            {/* One stage line can only name one of the three directories now. */}
            {active(job) && result.branches ? (
              <ul className="text-muted-foreground grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                {BRANCH_ORDER.filter((id) => result.branches?.[id]).map((id) => (
                  <li key={id} className="flex items-baseline justify-between gap-2">
                    <span>{branchLabel[id]}</span>
                    <span className="tabular-nums">
                      {stageLabel[result.branches![id].stage ?? ""] ?? result.branches![id].stage ?? "排队中"}
                      {result.branches![id].progress !== undefined ? ` ${result.branches![id].progress}%` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {result.warnings?.length ? <ul className="text-muted-foreground space-y-1 text-xs">{result.warnings.map((warning, index) => <li key={index}>· {warning}</li>)}</ul> : null}
            {result.failedBranches?.length ? <p className="text-amber-700 dark:text-amber-400 text-xs">{result.failedBranches.map((item) => item.label ?? branchLabel[item.branch] ?? item.branch).join("、")}未能发布，其余目录已照常发布；请将任务 ID 发到反馈群。</p> : null}
            {result.incomplete && !result.failedBranches?.length ? <p className="text-amber-700 dark:text-amber-400 text-xs">任务已完成，但部分槽位生成失败；请将失败槽位和任务 ID 发到反馈群。</p> : null}
            {!active(job) && generatedSlots.length ? <Button variant="outline" onClick={downloadAll}><DownloadIcon />下载已生成图片</Button> : null}
            {job.status === "failed" && !generatedSlots.length ? <p className="text-destructive text-sm">{job.error ?? "任务没有生成任何图片"}</p> : null}
            {job.status === "cancelled" ? <p className="text-muted-foreground text-sm">任务已停止，已经生成的槽位仍可查看。</p> : null}
            <p className="text-muted-foreground flex items-center gap-1 text-xs"><XIcon className="size-3" />关闭页面后，任务仍会在服务端继续执行；重新打开页面不会自动恢复历史任务。</p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
