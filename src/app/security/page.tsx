"use client";

import { AuthGate } from "@/components/workbench/auth-gate";
import { SecurityPanel } from "@/components/workbench/security-panel";

export default function SecurityPage() {
  return <AuthGate><SecurityPanel /></AuthGate>;
}
