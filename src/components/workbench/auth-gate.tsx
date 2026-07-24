"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type PropsWithChildren,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type WorkbenchWorkspace = {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "viewer";
};

export type WorkbenchSession = {
  actor: {
    userId: string;
    organizationId: string;
    workspaceId: string;
    email: string;
    displayName: string;
    role: "owner" | "admin" | "member" | "viewer";
  };
  workspace: WorkbenchWorkspace;
  workspaces: WorkbenchWorkspace[];
};

type SessionContextValue = {
  session: WorkbenchSession;
  refresh: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function useWorkbenchSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useWorkbenchSession must be used inside AuthGate");
  return value;
}

async function jsonOrError<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export function AuthGate({ children }: PropsWithChildren) {
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (response.status === 401) {
      setSession(null);
      return;
    }
    const next = await jsonOrError<WorkbenchSession>(response);
    setSession(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (response.status === 401) return;
        const next = await jsonOrError<WorkbenchSession>(response);
        if (!cancelled) setSession(next);
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "无法连接身份服务");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const next = await jsonOrError<WorkbenchSession>(response);
      setSession(next);
      setPassword("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  };

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    const response = await fetch("/api/auth/switch-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const next = await jsonOrError<WorkbenchSession>(response);
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/session", { method: "DELETE" });
    setSession(null);
  }, []);

  const value = useMemo<SessionContextValue | null>(() => session ? {
    session,
    refresh,
    switchWorkspace,
    signOut,
  } : null, [refresh, session, signOut, switchWorkspace]);

  if (loading) {
    return (
      <main className="bg-background flex min-h-dvh items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">正在验证工作区身份…</p>
      </main>
    );
  }

  if (!session || !value) {
    return (
      <main className="bg-background flex min-h-dvh items-center justify-center p-6">
        <form
          onSubmit={signIn}
          className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm"
        >
          <p className="text-muted-foreground text-xs">WORKBENCH</p>
          <h1 className="mt-1 text-xl font-semibold">登录工作区</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            使用管理员为你创建的员工账号登录。
          </p>
          <div className="mt-6 grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium">
              邮箱
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              密码
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="text-destructive mt-3 text-sm">{error}</p>
          )}
          <Button type="submit" className="mt-5 w-full" disabled={submitting}>
            {submitting ? "登录中…" : "登录"}
          </Button>
        </form>
      </main>
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
