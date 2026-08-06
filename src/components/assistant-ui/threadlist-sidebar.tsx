"use client";

import type * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckIcon, ImageIcon, LayoutDashboardIcon, LogOutIcon, MessagesSquare, SettingsIcon, ShieldCheckIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";
import { useImage2Mode } from "@/lib/image2-mode";
import { useVideoGenerationMode } from "@/lib/video-generation-mode";

export function ThreadListSidebar({
  onOpenSettings,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  onOpenSettings?: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resetImage2 = useImage2Mode((state) => state.reset);
  const resetVideoGeneration = useVideoGenerationMode((state) => state.reset);
  const { canGrant } = useWorkbenchSession();
  const isImage2 = searchParams.get("mode") === "image2";
  const isVideo = searchParams.get("mode") === "video";
  // New Thread / picking another thread both leave the current conversation,
  // so any composer mode tied to "this" conversation needs to drop too —
  // otherwise the video/image2 composer (and, for video, its job pointer)
  // rides along into a thread that never opted into it.
  const exitMode = () => {
    if (isImage2) resetImage2();
    if (isVideo) resetVideoGeneration();
    router.push("/");
  };
  return (
    <Sidebar {...props}>
      <SidebarHeader className="aui-sidebar-header mb-2">
        <div className="aui-sidebar-header-content flex items-center justify-between">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <a href="/">
                  <div className="aui-sidebar-header-icon-wrapper bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                    <MessagesSquare className="aui-sidebar-header-icon size-4" />
                  </div>
                  <div className="aui-sidebar-header-heading me-6 flex flex-col gap-0.5 leading-none">
                    <span className="aui-sidebar-header-title font-semibold">
                      Workbench
                    </span>
                    <span className="text-muted-foreground text-xs">
                      AI 创作工作台
                    </span>
                  </div>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarHeader>
      <SidebarContent className="aui-sidebar-content px-2">
        {canGrant("image.generate.use") && <SidebarMenu className="mb-2">
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isImage2} tooltip="生成图片">
              <Link href="/?mode=image2">
                <ImageIcon />
                <span>生成图片</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>}
        <div
          onClickCapture={(event) => {
            if ((isImage2 || isVideo) && (event.target as HTMLElement).closest("[data-slot='aui_thread-list-item-trigger']")) {
              exitMode();
            }
          }}
        >
          {canGrant("sessions.messages.view") && <ThreadList onNewThread={isImage2 || isVideo ? exitMode : undefined} />}
        </div>
      </SidebarContent>
      <SidebarFooter className="aui-sidebar-footer">
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountFooterMenu onOpenSettings={onOpenSettings} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
/**
 * 侧边栏永远可达（移动端通过顶部触发器打开为抽屉），所以账号/工作区切换
 * 放在这里而不是仅在桌面头部展示——否则窄屏下退出登录会完全没有入口。
 */
function AccountFooterMenu({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { session, signOut, switchWorkspace, isAdministrator } = useWorkbenchSession();

  const selectWorkspace = async (workspaceId: string) => {
    if (workspaceId === session.workspace.id) return;
    await switchWorkspace(workspaceId);
    window.location.reload();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" aria-label="账号与工作区">
          <div className="bg-muted text-muted-foreground flex aspect-square size-8 items-center justify-center rounded-lg border text-sm font-medium">
            {session.actor.displayName.slice(0, 1)}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 leading-none">
            <span className="truncate font-medium">{session.actor.displayName}</span>
            <span className="text-muted-foreground truncate text-xs">
              {session.workspace.name}
            </span>
          </div>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-52 rounded-xl">
        <p className="text-muted-foreground px-2 py-1.5 text-xs">
          {session.actor.displayName}
        </p>
        {session.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => void selectWorkspace(workspace.id)}
            className="justify-between rounded-lg"
          >
            <span className="truncate">{workspace.name}</span>
            {workspace.id === session.workspace.id && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem asChild className="rounded-lg">
          <Link href="/security">
            <ShieldCheckIcon className="size-4" />
            账号安全
          </Link>
        </DropdownMenuItem>
        {isAdministrator && (
          <DropdownMenuItem asChild className="rounded-lg">
            <Link href="/admin">
              <LayoutDashboardIcon className="size-4" />
              管理后台
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onOpenSettings?.()} className="rounded-lg">
          <SettingsIcon className="size-4" />
          设置
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut()} className="rounded-lg">
          <LogOutIcon className="size-4" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
