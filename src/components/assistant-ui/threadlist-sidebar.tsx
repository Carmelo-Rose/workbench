"use client";

import type * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckIcon, ImageIcon, ListTodoIcon, LogOutIcon, MessagesSquare, SettingsIcon } from "lucide-react";
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
import { useJobCenter, useJobCenterActiveCount } from "@/lib/mono/job-center";
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
        <SidebarMenu className="mb-2">
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isImage2} tooltip="生成图片">
              <Link href="/?mode=image2">
                <ImageIcon />
                <span>生成图片</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div
          onClickCapture={(event) => {
            if ((isImage2 || isVideo) && (event.target as HTMLElement).closest("[data-slot='aui_thread-list-item-trigger']")) {
              exitMode();
            }
          }}
        >
          <ThreadList onNewThread={isImage2 || isVideo ? exitMode : undefined} />
        </div>
      </SidebarContent>
      <SidebarFooter className="aui-sidebar-footer">
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountFooterMenu onOpenSettings={onOpenSettings} />
          </SidebarMenuItem>
          <JobCenterFooterItem />
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
  const { session, signOut, switchWorkspace } = useWorkbenchSession();

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

/** 只在有正在跑/排队的任务时出现，避免长期占一格却永远没内容。 */
function JobCenterFooterItem() {
  const activeCount = useJobCenterActiveCount();
  const openSheet = useJobCenter((s) => s.openSheet);
  if (activeCount === 0) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" onClick={openSheet} aria-label="打开任务中心">
        <div className="flex aspect-square size-8 items-center justify-center rounded-lg border">
          <ListTodoIcon className="size-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 leading-none">
          <span className="font-medium">任务中心</span>
          <span className="text-muted-foreground truncate text-xs">{activeCount} 个任务进行中</span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
