"use client";

import { AuthGate } from "@/components/workbench/auth-gate";
import { AdminConsole } from "@/components/workbench/admin-console";

export default function AdminPage() {
  return <AuthGate><AdminConsole /></AuthGate>;
}
