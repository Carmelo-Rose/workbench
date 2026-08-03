"use client";

import { CheckIcon, ChevronDownIcon, PawPrintIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { InkKoiPet } from "@/components/workbench/pets/ink-koi";
import { InkWispPet } from "@/components/workbench/pets/ink-wisp";
import { InspirationGaugePet } from "@/components/workbench/pets/inspiration-gauge";
import { NekoPet } from "@/components/workbench/pets/neko";
import { PaperPlanePet } from "@/components/workbench/pets/paper-plane";
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
  { id: "koi", name: "墨鲤" },
  { id: "plane", name: "纸飞机" },
  { id: "inspirationGauge", name: "灵感刻度尺" },
  { id: "none", name: "无挂件" },
] as const;

export type CompanionId = (typeof COMPANIONS)[number]["id"];

const COMPANION_STORAGE_KEY = "wb:companion";

export const loadCompanion = (): CompanionId => {
  if (typeof window === "undefined") return "none";
  const stored = window.localStorage.getItem(COMPANION_STORAGE_KEY);
  return COMPANIONS.some((c) => c.id === stored)
    ? (stored as CompanionId)
    : "none";
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
  if (companion === "koi") return <InkKoiPet />;
  if (companion === "plane") return <PaperPlanePet />;
  if (companion === "inspirationGauge") {
    return <InspirationGaugePet isWorking={isWorking} />;
  }
  return null;
};

export const CompanionPicker: FC<{
  value: CompanionId;
  onChange: (id: CompanionId) => void;
}> = ({ value, onChange }) => {
  const active = COMPANIONS.find((c) => c.id === value) ?? COMPANIONS[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3 font-normal data-[state=open]:bg-accent"
        >
          <PawPrintIcon className="text-muted-foreground size-4" />
          {active.name}
          <ChevronDownIcon className="text-muted-foreground size-3.5" />
        </Button>
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
