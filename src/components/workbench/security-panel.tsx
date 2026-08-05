"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeftIcon, KeyRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";

export function SecurityPanel() {
  const { session, signOut } = useWorkbenchSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "密码更新失败");
      await signOut();
      window.location.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "密码更新失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="bg-background min-h-dvh p-6 sm:p-10">
      <div className="mx-auto max-w-xl">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-6">
          <Link href="/"><ArrowLeftIcon /> 返回工作台</Link>
        </Button>
        <section className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="bg-muted flex size-10 items-center justify-center rounded-xl"><KeyRoundIcon className="size-5" /></span>
            <div><h1 className="text-lg font-semibold">账号安全</h1><p className="text-muted-foreground text-sm">管理你的登录凭据</p></div>
          </div>
          <dl className="mt-6 grid gap-3 rounded-xl bg-muted/50 p-4 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground text-xs">账号/工号</dt><dd className="mt-1 font-medium">{session.actor.account}</dd></div>
            <div><dt className="text-muted-foreground text-xs">姓名</dt><dd className="mt-1 font-medium">{session.actor.displayName}</dd></div>
          </dl>
          <form className="mt-6 grid gap-4" onSubmit={submit}>
            <label className="grid gap-1.5 text-sm font-medium">当前密码<Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
            <label className="grid gap-1.5 text-sm font-medium">新密码<Input type="password" autoComplete="new-password" minLength={6} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
            <p className="text-muted-foreground text-xs">密码修改后会撤销该账号的全部会话，并要求重新登录。</p>
            {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
            <Button type="submit" disabled={saving}>{saving ? "正在更新…" : "更新密码"}</Button>
          </form>
        </section>
      </div>
    </main>
  );
}
