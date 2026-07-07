"use client";

import { CheckIcon, PawPrintIcon } from "lucide-react";
import type { FC } from "react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { InkWispPet } from "@/components/workbench/pets/ink-wisp";
import { InspirationGaugePet } from "@/components/workbench/pets/inspiration-gauge";
import { NekoPet } from "@/components/workbench/pets/neko";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 桌面伴宠：选择持久化到 localStorage。 */

export const COMPANIONS = [
  { id: "neko", name: "像素小猫" },
  { id: "wisp", name: "墨点精灵" },
  { id: "inspirationGauge", name: "灵感刻度尺" },
  { id: "none", name: "无挂件" },
] as const;

export type CompanionId = (typeof COMPANIONS)[number]["id"];

const COMPANION_STORAGE_KEY = "wb:companion";

export const loadCompanion = (): CompanionId => {
  if (typeof window === "undefined") return "neko";
  const stored = window.localStorage.getItem(COMPANION_STORAGE_KEY);
  return COMPANIONS.some((c) => c.id === stored)
    ? (stored as CompanionId)
    : "neko";
};

export const saveCompanion = (id: CompanionId) => {
  window.localStorage.setItem(COMPANION_STORAGE_KEY, id);
};

export const CompanionLayer: FC<{
  companion: CompanionId;
  isWorking: boolean;
}> = ({
  companion,
  isWorking,
}) => {
  if (companion === "neko") return <NekoPet />;
  if (companion === "wisp") return <InkWispPet />;
  if (companion === "inspirationGauge") {
    return <InspirationGaugePet isWorking={isWorking} />;
  }
  return null;
};

export const CompanionPicker: FC<{
  value: CompanionId;
  onChange: (id: CompanionId) => void;
}> = ({ value, onChange }) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton
          variant="ghost"
          size="icon"
          tooltip="挂件"
          side="bottom"
          className="size-8 rounded-full data-[state=open]:bg-accent"
        >
          <PawPrintIcon className="size-4" />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32 rounded-xl">
        {COMPANIONS.map((c) => (
          <DropdownMenuItem
            key={c.id}
            onSelect={() => onChange(c.id)}
            className="justify-between rounded-lg"
          >
            {c.name}
            {c.id === value && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
