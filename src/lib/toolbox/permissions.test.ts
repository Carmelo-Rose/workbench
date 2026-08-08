import { describe, expect, it } from "vitest";
import { permissionRegistry } from "@/lib/authorization";
import { TOOLBOX_CAPABILITIES } from "./types";
import { toolboxCapabilityPermissions } from "./permissions";

describe("toolbox capability permissions", () => {
  it("maps every ready local capability to a registered permission", () => {
    const registered = new Set(permissionRegistry.map((permission) => permission.id));
    for (const capability of TOOLBOX_CAPABILITIES.filter((item) => item.status === "ready")) {
      const permission = toolboxCapabilityPermissions[capability.id];
      expect(permission, `${capability.id} needs a permission mapping`).toBeTruthy();
      expect(registered.has(permission)).toBe(true);
    }
  });
});
