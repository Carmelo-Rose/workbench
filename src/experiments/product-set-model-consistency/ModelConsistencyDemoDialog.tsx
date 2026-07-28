"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type {
  CastingRecord,
  ConsistencyRun,
  ExperimentCatalog,
  ExperimentSlotId,
  IdentityGroupId,
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

function imageUrl(kind: "casting" | "profile" | "run", id: string, name: string) {
  return `${apiRoot}/images/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

export function ModelConsistencyDemoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [catalog, setCatalog] = useState<ExperimentCatalog>();
  const [casting, setCasting] = useState<CastingRecord>();
  const [run, setRun] = useState<ConsistencyRun>();
  const [selectedCandidates, setSelectedCandidates] = useState<Partial<Record<IdentityGroupId, string>>>({});
  const [profileIds, setProfileIds] = useState<Partial<Record<IdentityGroupId, string>>>({});
  const [productId, setProductId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const paidActionLock = useRef(false);

  const refreshCatalog = async () => {
    const next = await requestJson<ExperimentCatalog>(`${apiRoot}/catalog`);
    setCatalog(next);
    setProductId((current) => current || next.products[0]?.id || "");
    setWorkflowId((current) => current || next.workflows[0]?.id || "");
    setProfileIds((current) => ({
      female: current.female || next.profiles.find((item) => item.groupId === "female")?.id,
      male: current.male || next.profiles.find((item) => item.groupId === "male")?.id,
    }));
    setCasting((current) => current ?? next.castings[0]);
  };

  useEffect(() => {
    if (!open) return;
    void requestJson<ExperimentCatalog>(`${apiRoot}/catalog`).then((next) => {
      setCatalog(next);
      setProductId((current) => current || next.products[0]?.id || "");
      setWorkflowId((current) => current || next.workflows[0]?.id || "");
      setProfileIds((current) => ({
        female: current.female || next.profiles.find((item) => item.groupId === "female")?.id,
        male: current.male || next.profiles.find((item) => item.groupId === "male")?.id,
      }));
      setCasting((current) => current ?? next.castings[0]);
    }).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "无法读取实验目录"));
  }, [open]);

  const castingId = casting?.id;
  const castingStatus = casting?.status;
  useEffect(() => {
    if (!open || !castingId || !castingStatus || !["queued", "running"].includes(castingStatus)) return;
    const timer = setInterval(() => {
      void requestJson<{ casting: CastingRecord }>(`${apiRoot}/castings?id=${encodeURIComponent(castingId)}`)
        .then((payload) => setCasting(payload.casting))
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "选角状态读取失败"));
    }, 1500);
    return () => clearInterval(timer);
  }, [open, castingId, castingStatus]);

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

  /** Creates only a local casting record. It never makes an image request. */
  const createCastingDraft = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const payload = await requestJson<{ casting: CastingRecord }>(`${apiRoot}/castings`, {
        method: "POST",
        body: JSON.stringify({ candidateCountPerGroup: 4 }),
      });
      setCasting(payload.casting);
      setCatalog((current) => current ? {
        ...current,
        castings: [payload.casting, ...current.castings],
      } : current);
      setSelectedCandidates({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建选角方案");
    } finally {
      setBusy(false);
    }
  };

  const continueCandidates = async (candidateIds: string[], purpose: "continue" | "retry") => {
    if (!casting || candidateIds.length === 0 || paidActionLock.current) return;
    const label = purpose === "continue" ? "继续生成未完成候选" : "重试失败候选";
    if (!window.confirm(`${label} ${candidateIds.length} 张。这将发起 ${candidateIds.length} 次付费生图请求；已成功的候选不会重新生成。是否继续？`)) {
      return;
    }
    paidActionLock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const payload = await requestJson<{ casting: CastingRecord }>(`${apiRoot}/castings/${casting.id}/continue`, {
        method: "POST",
        body: JSON.stringify({ candidateIds }),
      });
      setCasting(payload.casting);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法继续选角");
    } finally {
      paidActionLock.current = false;
      setBusy(false);
    }
  };

  const createNewCastingAfterConfirmation = async () => {
    if (!window.confirm("这会创建一套新的 8 位候选方案，不会删除任何已有候选。创建后仍需点击“开始生成”才会产生付费请求。是否创建新方案？")) {
      return;
    }
    await createCastingDraft();
  };

  const saveProfiles = async () => {
    if (!casting || !selectedCandidates.female || !selectedCandidates.male) return;
    setBusy(true);
    setError(undefined);
    try {
      const payload = await requestJson<{ profiles: ExperimentCatalog["profiles"] }>(`${apiRoot}/profiles`, {
        method: "POST",
        body: JSON.stringify({
          castingId: casting.id,
          selections: selectedCandidates,
          names: { female: "AI 女模特", male: "AI 男模特" },
        }),
      });
      setProfileIds({
        female: payload.profiles.find((item) => item.groupId === "female")?.id,
        male: payload.profiles.find((item) => item.groupId === "male")?.id,
      });
      await refreshCatalog();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模特卡保存失败");
    } finally {
      setBusy(false);
    }
  };

  const startRun = async () => {
    if (!productId || !workflowId || !profileIds.female || !profileIds.male) return;
    if (paidActionLock.current) return;
    paidActionLock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const payload = await requestJson<{ run: ConsistencyRun }>(`${apiRoot}/runs`, {
        method: "POST",
        body: JSON.stringify({ productId, workflowId, profileIds }),
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
        body: JSON.stringify({
          slots: succeeded.map((slot) => ({ id: slot.id, ...slot.review })),
        }),
      });
      setRun(payload.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审核保存失败");
    } finally {
      setBusy(false);
    }
  };

  const retryable = useMemo(() => run?.slots.filter((slot) =>
    slot.status === "failed"
    || slot.review.identity === "failed"
    || slot.review.product === "failed").map((slot) => slot.id) ?? [], [run]);

  const retryRejected = async () => {
    if (!run || retryable.length === 0) return;
    if (paidActionLock.current) return;
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

  const profilesFor = (group: IdentityGroupId) =>
    catalog?.profiles.filter((profile) => profile.groupId === group) ?? [];
  const existingCastings = catalog?.castings ?? [];
  const incompleteCandidateIds = casting?.candidates
    .filter((candidate) => candidate.status === "queued" || candidate.status === "interrupted")
    .map((candidate) => candidate.id) ?? [];
  const failedCandidateIds = casting?.candidates
    .filter((candidate) => candidate.status === "failed")
    .map((candidate) => candidate.id) ?? [];
  const generationInProgress = casting?.status === "queued" || casting?.status === "running";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            商品套图 · 模特一致性
            <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">实验</span>
          </DialogTitle>
          <DialogDescription>
            仅写入 test/model-consistency；生成 01、03–08 七张，不进入正式商品任务。
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">1. 选择男女模特卡</h3>
              <p className="text-muted-foreground text-xs">A/C 使用女模特，B 使用男模特。</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || generationInProgress}
              onClick={casting ? createNewCastingAfterConfirmation : createCastingDraft}
            >
              {casting ? "重新选角（新方案）" : "创建选角方案（不生图）"}
            </Button>
          </div>
          {existingCastings.length > 0 ? (
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">恢复已有选角方案（刷新不会重新生成）</span>
              <select
                className="border-input bg-background w-full rounded-md border px-2 py-2"
                value={casting?.id ?? ""}
                onChange={(event) => {
                  const next = existingCastings.find((item) => item.id === event.target.value);
                  setCasting(next);
                  setSelectedCandidates({});
                }}
              >
                {existingCastings.map((item) => {
                  const ready = item.candidates.filter((candidate) => candidate.status === "succeeded").length;
                  return <option key={item.id} value={item.id}>{item.id.slice(-8)} · {item.status} · 已完成 {ready}/8</option>;
                })}
              </select>
            </label>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {(["female", "male"] as const).map((group) => (
              <label key={group} className="space-y-1 text-sm">
                <span>{group === "female" ? "女模特卡" : "男模特卡"}</span>
                <select
                  className="border-input bg-background w-full rounded-md border px-2 py-2"
                  value={profileIds[group] ?? ""}
                  onChange={(event) => setProfileIds((current) => ({ ...current, [group]: event.target.value }))}
                >
                  <option value="">请选择</option>
                  {profilesFor(group).map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.displayName}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {casting ? (
            <div className="space-y-3 border-t pt-3">
              <p className="text-sm">选角状态：{casting.status}</p>
              <div className="flex flex-wrap gap-2">
                {generationInProgress ? (
                  <span className="text-muted-foreground text-sm">正在生成；刷新页面会恢复进度，不会创建新候选。</span>
                ) : null}
                {incompleteCandidateIds.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => continueCandidates(incompleteCandidateIds, "continue")}
                  >
                    {casting.status === "draft"
                      ? `开始生成 ${incompleteCandidateIds.length} 位候选（付费）`
                      : `继续未完成候选（${incompleteCandidateIds.length} 张，付费）`}
                  </Button>
                ) : null}
                {failedCandidateIds.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || generationInProgress}
                    onClick={() => continueCandidates(failedCandidateIds, "retry")}
                  >
                    重试失败候选（{failedCandidateIds.length} 张，付费）
                  </Button>
                ) : null}
              </div>
              {(["female", "male"] as const).map((group) => (
                <div key={group}>
                  <p className="mb-2 text-sm font-medium">{group === "female" ? "女模特候选" : "男模特候选"}</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {casting.candidates.filter((item) => item.groupId === group).map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        disabled={candidate.status !== "succeeded"}
                        onClick={() => setSelectedCandidates((current) => ({ ...current, [group]: candidate.id }))}
                        className={`overflow-hidden rounded-md border-2 text-left ${
                          selectedCandidates[group] === candidate.id ? "border-primary" : "border-transparent"
                        }`}
                      >
                        {candidate.status === "succeeded"
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img className="aspect-[3/4] w-full object-cover" src={imageUrl("casting", casting.id, candidate.imageName)} alt="" />
                          : <div className="bg-muted flex aspect-[3/4] items-center justify-center text-xs">{candidate.status}</div>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <Button
                disabled={busy || !selectedCandidates.female || !selectedCandidates.male}
                onClick={saveProfiles}
              >
                保存两张可复用模特卡
              </Button>
            </div>
          ) : null}
        </section>

        <section className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">2. 选择测试货号并生成七张</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <select className="border-input bg-background rounded-md border px-2 py-2" value={productId} onChange={(event) => setProductId(event.target.value)}>
              <option value="">选择 test 中的货号</option>
              {catalog?.products.map((product) => <option key={product.id} value={product.id}>{product.name}（主图 {product.masterCount}）</option>)}
            </select>
            <select className="border-input bg-background rounded-md border px-2 py-2" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
              <option value="">选择商品模板</option>
              {catalog?.workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.label}</option>)}
            </select>
          </div>
          <Button
            disabled={busy || !productId || !workflowId || !profileIds.female || !profileIds.male}
            onClick={startRun}
          >
            生成七张实验套图（付费）
          </Button>
        </section>

        {run ? (
          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">3. 逐张审核</h3>
              <span className="text-muted-foreground text-sm">{run.stage} · {run.status}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {run.slots.map((slot) => (
                <article key={slot.id} className="space-y-2 rounded-md border p-2">
                  <div className="flex items-center justify-between text-sm">
                    <strong>{slot.id}</strong><span>{slot.identityGroupId} · {slot.status}</span>
                  </div>
                  {slot.status === "succeeded"
                    // eslint-disable-next-line @next/next/no-img-element
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
              <Button variant="outline" disabled={busy || retryable.length === 0} onClick={retryRejected}>
                只重跑未通过槽位（{retryable.length}）
              </Button>
            </div>
          </section>
        ) : null}

        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
