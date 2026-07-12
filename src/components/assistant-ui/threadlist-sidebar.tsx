"use client";

import type * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ImageIcon, MessagesSquare, SettingsIcon } from "lucide-react";
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
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { CONN_STATE_LABEL, StatusDot } from "@/components/workbench/backend-select";
import {
  hermesConnState,
  useAgentStatus,
  useBackendChoice,
} from "@/lib/agent-status";
import { BACKENDS } from "@/lib/backends";
import { useImage2Mode } from "@/lib/image2-mode";

export function ThreadListSidebar({
  onOpenSettings,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  onOpenSettings?: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resetImage2 = useImage2Mode((state) => state.reset);
  const isImage2 = searchParams.get("mode") === "image2";
  const exitImage2 = () => {
    resetImage2();
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
                      Mono
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Agent 工作台
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
            <SidebarMenuButton asChild isActive={isImage2} tooltip="Image2 图像生成">
              <Link href="/?mode=image2">
                <ImageIcon />
                <span>Image2 图像生成</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div
          onClickCapture={(event) => {
            if (isImage2 && (event.target as HTMLElement).closest("[data-slot='aui_thread-list-item-trigger']")) {
              exitImage2();
            }
          }}
        >
          <ThreadList onNewThread={isImage2 ? exitImage2 : undefined} />
        </div>
      </SidebarContent>
      <SidebarFooter className="aui-sidebar-footer">
        <SidebarMenu>
          <SidebarMenuItem>
            <SettingsFooterButton onClick={onOpenSettings} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function SettingsFooterButton({ onClick }: { onClick?: () => void }) {
  const backend = useBackendChoice((s) => s.backend);
  const status = useAgentStatus((s) => s.status);
  const state =
    backend === "hermes"
      ? hermesConnState(status)
      : status?.direct.configured
        ? "ok"
        : status
          ? "down"
          : "unknown";

  return (
    <SidebarMenuButton size="lg" onClick={onClick} aria-label="打开设置">
      <div className="flex aspect-square size-8 items-center justify-center rounded-lg border">
        <SettingsIcon className="size-4" />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 leading-none">
        <span className="font-medium">设置</span>
        <span className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
          <StatusDot state={state} />
          {BACKENDS[backend].name} · {CONN_STATE_LABEL[state]}
        </span>
      </div>
    </SidebarMenuButton>
  );
}
