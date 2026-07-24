"use client";

import dynamic from "next/dynamic";
import { AuthGate } from "@/components/workbench/auth-gate";

const Assistant = dynamic(
  () => import("./assistant").then((mod) => mod.Assistant),
  { ssr: false },
);

export default function Home() {
  return (
    <AuthGate>
      <Assistant />
    </AuthGate>
  );
}
