import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CAPABILITY_REGISTRY } from "./workbench/capability-registry";
import { CAPABILITY_GROUPS, capabilityAllowed } from "./workbench/capabilities";
import {
  normalizeGrants,
  permissionDefinition,
  permissionRegistry,
} from "./authorization";

describe("module permission registry", () => {
  it("has stable unique permissions and valid data-scope contracts", () => {
    expect(new Set(permissionRegistry.map((entry) => entry.id)).size).toBe(permissionRegistry.length);
    for (const entry of permissionRegistry) {
      expect(entry.id).toMatch(/^[a-z][a-z.-]+\.(view|use|create|manage|import|export)$/u);
      expect(new Set(entry.dataScopes).size).toBe(entry.dataScopes.length);
    }
    for (const permission of [
      "sessions.messages.view", "sessions.messages.manage",
      "sessions.messages.import", "sessions.messages.export",
    ]) expect(permissionDefinition(permission)?.dataScopes).toEqual(["own"]);
  });

  it("merges roles per operation and widens only the matching operation", () => {
    expect(normalizeGrants([
      { permission: "resources.assets.view", dataScope: "own" },
      { permission: "resources.assets.view", dataScope: "workspace" },
      { permission: "resources.assets.manage", dataScope: "own" },
    ])).toEqual([
      { permission: "resources.assets.manage", dataScope: "own" },
      { permission: "resources.assets.view", dataScope: "workspace" },
    ]);
  });

  it("binds every chat capability to a registered permission", () => {
    for (const capability of Object.values(CAPABILITY_REGISTRY)) {
      expect(permissionDefinition(capability.permission), capability.id).toBeDefined();
    }
  });

  it("hides feature entries when the current session lacks their grant", () => {
    const options = CAPABILITY_GROUPS.flatMap((group) => group.options);
    const option = (id: string) => options.find((item) => item.id === id)!;
    const chatOnly = (permission: string) => permission === "workbench.chat.use";
    expect(capabilityAllowed(option("generate-image"), chatOnly)).toBe(false);
    expect(capabilityAllowed(option("write-launch"), chatOnly)).toBe(true);
    expect(capabilityAllowed(option("video-translate-dub"), chatOnly)).toBe(false);
  });

  it("requires every browser workbench route to declare an enforcement point", () => {
    const root = path.join(process.cwd(), "src/app/api/workbench");
    const routeFiles = collectFiles(root).filter((file) => file.endsWith(`${path.sep}route.ts`));
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, path.relative(root, file)).toMatch(
        /actorFromWorkbenchRequest\(|workspaceActorFromWorkbenchRequest\(|requireGrant\(/u,
      );
    }
  });

  it("gives every registered permission a server enforcement point", () => {
    const roots = [
      path.join(process.cwd(), "src/app/api"),
      path.join(process.cwd(), "src/lib/server"),
    ];
    const serverSource = roots.flatMap(collectFiles)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const permission of permissionRegistry) {
      expect(serverSource, permission.id).toContain(permission.id);
    }
  });
});

function collectFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? collectFiles(file) : [file];
  });
}
