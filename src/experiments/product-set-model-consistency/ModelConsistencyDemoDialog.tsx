/* eslint-disable @next/next/no-img-element -- private authenticated image routes are not Next image sources. */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type {
  ConsistencyRun,
  ExperimentCatalog,
  ExperimentSlotId,
  IdentityGroupId,
  ModelPair,
} from "./types";

const apiRoot = "/api/experiments/model-consistency";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "实验请求失败");
  return payload as T;
}

function imageUrl(kind: "profile" | "run", id: string, name: string) {
  return `${apiRoot}/images/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

function profileLabel(profile: ExperimentCatalog["profiles"][number]) {
  return `${profile.displayName} · ${profile.sourceCandidateId}`;
}

export function ModelConsistencyDemoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [catalog, setCatalog] = useState<ExperimentCatalog>();
  const [run, setRun] = useState<ConsistencyRun>();
  const [modelPairId, setModelPairId] = useState("");
  const [productId, setProductId] = useState("");
  const [productReferenceNames, setProductReferenceNames] = useState<string[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [showPairCreator, setShowPairCreator] = useState(false);
  const [pairName, setPairName] = useState("模特组合 01");
  const [pairProfileIds, setPairProfileIds] = useState<Partial<Record<IdentityGroupId, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const paidActionLock = useRef(false);

  useEffect(() => {
    if (!open) return;
    void requestJson<ExperimentCatalog>(`${apiRoot}/catalog`).then((next) => {
      setCatalog(next);
      setModelPairId((current) => current || next.modelPairs[0]?.id || "");
      setProductId((current) => current || next.products[0]?.id || "");
      setProductReferenceNames((current) => current.length === 3
        ? current
        : next.products[0]?.masterImageNames.slice(0, 3) ?? []);
      setWorkflowId((current) => current || next.workflows[0]?.id || "");
      setPairProfileIds((current) => ({
        female: current.female || next.profiles.find((profile) => profile.groupId === "female")?.id,
        male: current.male || next.profiles.find((profile) => profile.groupId === "male")?.id,
      }));
    }).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "无法读取实验目录"));
  // `open` is the only trigger: no render, refresh, or dialog entry can create images.
  }, [open]);

  const runId = run?.id;
  const runStatus = run?.status;
  useEffect(() => {
    if (!open || !runId || !runStatus || !["queued", "running"].includes(runStatus)) return;
    const timer = setInterval(() => {
      void requestJson<{ run: ConsistencyRun }>(`${apiRoot}/runs?id=${encodeURIComponent(runId)}`)
        .then((payload) => setRun(payload.run))
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "运行状态读取失败"));
    }, 1500);
    return () => clearInterval(timer);
  }, [open, runId, runStatus]);

  const pairs = catalog?.modelPairs ?? [];
  const selectedPair = pairs.find((pair) => pair.id === modelPairId);
  const selectedProduct = catalog?.products.find((product) => product.id === productId);
  const availableReferenceNames = selectedProduct?.masterImageNames ?? [];
  const profilesFor = (group: IdentityGroupId) =>
    catalog?.profiles.filter((profile) => profile.groupId === group) ?? [];

  const savePair = async () => {
    if (!pairName.trim() || !pairProfileIds.female || !pairProfileIds.male || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const payload = await requestJson<{ modelPair: ModelPair }>(`${apiRoot}/pairs`, {
        method: "POST",
        body: JSON.stringify({ displayName: pairName.trim(), profileIds: pairProfileIds }),
      });
      setCatalog((current) => current ? {
        ...current,
        modelPairs: [payload.modelPair, ...current.modelPairs],
      } : current);
      setModelPairId(payload.modelPair.id);
      setShowPairCreator(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存模特组合失败");
    } finally {
      setBusy(false);
    }
  };

  const startRun = async () => {
    if (!modelPairId || !productId || !workflowId || productReferenceNames.length !== 3) return;
    if (new Set(productReferenceNames).size !== 3 || paidActionLock.current) return;
    if (!window.confirm(
      "将用当前模特组合生成 2 张实验套图，并发起 2 次付费生图请求。确认后才会开始。是否继续？",
    )) return;
    paidActionLock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const payload = await requestJson<{ run: ConsistencyRun }>(`${apiRoot}/runs`, {
        method: "POST",
        body: JSON.stringify({ productId, workflowId, modelPairId, productReferenceNames }),
      });
      setRun(payload.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "七张套图启动失败");
    } finally {
      paidActionLock.current = false;
      setBusy(false);
    }
  };

  const setReview = (slotId: ExperimentSlotId, field: "identity" | "product", passed: boolean) => {
    setRun((current) => current ? {
      ...current,
      slots: current.slots.map((slot) => slot.id === slotId
        ? { ...slot, review: { ...slot.review, [field]: passed ? "passed" : "failed" } }
        : slot),
    } : current);
  };

  const saveReview = async () => {
    if (!run) return;
    const succeeded = run.slots.filter((slot) => slot.status === "succeeded");
    setBusy(true);
    try {
      const payload = await requestJson<{ run: ConsistencyRun }>(`${apiRoot}/runs/${run.id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ slots: succeeded.map((slot) => ({ id: slot.id, ...slot.review })) }),
      });
      setRun(payload.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审核保存失败");
    } finally {
      setBusy(false);
    }
  };

  const retryable = useMemo(() => run?.slots.filter((slot) =>
    slot.status === "failed" || slot.review.identity === "failed" || slot.review.product === "failed",
  ).map((slot) => slot.id) ?? [], [run]);

  const retryRejected = async () => {
    if (!run || retryable.length === 0 || paidActionLock.current) return;
    if (!window.confirm(`将只重跑 ${retryable.length} 个未通过槽位，并产生对应付费请求。是否继续？`)) return;
    paidActionLock.current = true;
    setBusy(true);
    try {
      const payload = await requestJson<{ run: ConsistencyRun }>(`${apiRoot}/runs/${run.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ slots: retryable }),
      });
      setRun(payload.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重跑失败");
    } finally {
      paidActionLock.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            商品套图 · 模特组合
            <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">实验</span>
          </DialogTitle>
          <DialogDescription>仅写入 test/model-consistency；当前基线生成 01、04 两张，不进入正式商品任务。</DialogDescription>
        </DialogHeader>

        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">1. 选择模特组合</h3>
              <p className="text-muted-foreground text-xs">A/C 固定使用女模特，B 固定使用男模特。</p>
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setShowPairCreator((current) => !current)}>
              {showPairCreator ? "收起" : pairs.length ? "新建组合" : "创建第一组"}
            </Button>
          </div>

          {pairs.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {pairs.map((pair) => {
                const female = catalog?.profiles.find((profile) => profile.id === pair.profileIds.female);
                const male = catalog?.profiles.find((profile) => profile.id === pair.profileIds.male);
                const selected = pair.id === modelPairId;
                return (
                  <button
                    key={pair.id}
                    type="button"
                    onClick={() => setModelPairId(pair.id)}
                    className={`flex items-center gap-3 rounded-md border-2 p-2 text-left ${selected ? "border-primary" : "border-transparent bg-muted/40"}`}
                  >
                    {female ? <img className="h-14 w-12 rounded object-cover" src={imageUrl("profile", female.id, female.anchorImageName)} alt="女模特" /> : null}
                    {male ? <img className="h-14 w-12 rounded object-cover" src={imageUrl("profile", male.id, male.anchorImageName)} alt="男模特" /> : null}
                    <span className="min-w-0">
                      <strong className="block truncate text-sm">{pair.displayName}</strong>
                      <span className="text-muted-foreground text-xs">女 {female?.sourceCandidateId ?? "-"} · 男 {male?.sourceCandidateId ?? "-"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">还没有模特组合。创建一次后，之后只需在这里点选即可。</p>
          )}

          {showPairCreator ? (
            <div className="space-y-3 rounded-md bg-muted/40 p-3">
              <p className="text-sm font-medium">新建模特组合（不生图、不收费）</p>
              <input
                className="border-input bg-background w-full rounded-md border px-2 py-2 text-sm"
                value={pairName}
                maxLength={40}
                onChange={(event) => setPairName(event.target.value)}
                placeholder="组合名称，例如 Y2K 组合 01"
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {(["female", "male"] as const).map((group) => (
                  <select
                    key={group}
                    className="border-input bg-background rounded-md border px-2 py-2 text-sm"
                    value={pairProfileIds[group] ?? ""}
                    onChange={(event) => setPairProfileIds((current) => ({ ...current, [group]: event.target.value }))}
                  >
                    <option value="">选择{group === "female" ? "女" : "男"}模特</option>
                    {profilesFor(group).map((profile) => <option key={profile.id} value={profile.id}>{profileLabel(profile)}</option>)}
                  </select>
                ))}
              </div>
              <Button disabled={busy || !pairName.trim() || !pairProfileIds.female || !pairProfileIds.male} onClick={savePair}>保存组合</Button>
            </div>
          ) : null}
        </section>

        <section className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">2. 选择商品并生成套图</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <select
              className="border-input bg-background rounded-md border px-2 py-2"
              value={productId}
              onChange={(event) => {
                const nextProductId = event.target.value;
                setProductId(nextProductId);
                const product = catalog?.products.find((item) => item.id === nextProductId);
                setProductReferenceNames(product?.masterImageNames.slice(0, 3) ?? []);
              }}
            >
              <option value="">选择 test 中的货号</option>
              {catalog?.products.map((product) => <option key={product.id} value={product.id}>{product.name}（主图 {product.masterCount}）</option>)}
            </select>
            <select className="border-input bg-background rounded-md border px-2 py-2" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
              <option value="">选择商品模板</option>
              {catalog?.workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.label}</option>)}
            </select>
          </div>

          {selectedProduct ? (
            <details className="rounded-md bg-muted/40 p-3 text-sm">
              <summary className="cursor-pointer font-medium">商品参考图（默认已选同色前三张；需要时再调整）</summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {[0, 1, 2].map((index) => (
                  <select
                    key={index}
                    className="border-input bg-background rounded-md border px-2 py-2 text-sm"
                    value={productReferenceNames[index] ?? ""}
                    onChange={(event) => setProductReferenceNames((current) => {
                      const next = [...current];
                      next[index] = event.target.value;
                      return next;
                    })}
                  >
                    <option value="">选择参考图 {index + 1}</option>
                    {availableReferenceNames.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                ))}
              </div>
            </details>
          ) : null}

          <Button
            disabled={busy || !selectedPair || !productId || !workflowId || productReferenceNames.length !== 3 || new Set(productReferenceNames).size !== 3}
            onClick={startRun}
          >
            用“{selectedPair?.displayName ?? "未选择组合"}”生成七张实验套图（付费）
          </Button>
        </section>

        {run ? (
          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">3. 逐张审核</h3>
              <span className="text-muted-foreground text-sm">{run.stage} · {run.status}</span>
            </div>
            {run.error ? <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{run.error}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {run.slots.map((slot) => (
                <article key={slot.id} className="space-y-2 rounded-md border p-2">
                  <div className="flex items-center justify-between text-sm"><strong>{slot.id}</strong><span>{slot.lookId} · {slot.identityGroupId} · {slot.status}</span></div>
                  {slot.status === "succeeded"
                    ? <img className="aspect-[3/4] w-full rounded object-cover" src={imageUrl("run", run.id, slot.imageName)} alt={`槽位 ${slot.id}`} />
                    : <div className="bg-muted flex aspect-[3/4] items-center justify-center rounded px-3 text-center text-xs">{slot.error ?? slot.status}</div>}
                  {slot.status === "succeeded" ? (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {(["identity", "product"] as const).map((field) => (
                        <div key={field} className="space-y-1">
                          <p>{field === "identity" ? "人物一致" : "商品正确"}</p>
                          <div className="flex gap-1">
                            <Button size="sm" variant={slot.review[field] === "passed" ? "default" : "outline"} onClick={() => setReview(slot.id, field, true)}>通过</Button>
                            <Button size="sm" variant={slot.review[field] === "failed" ? "destructive" : "outline"} onClick={() => setReview(slot.id, field, false)}>拒绝</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || run.slots.every((slot) => slot.status !== "succeeded")} onClick={saveReview}>保存审核</Button>
              <Button variant="outline" disabled={busy || retryable.length === 0} onClick={retryRejected}>只重跑未通过槽位（{retryable.length}）</Button>
            </div>
          </section>
        ) : null}

        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
