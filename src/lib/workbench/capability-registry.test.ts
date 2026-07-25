import { afterEach, describe, expect, it } from "vitest";
import { isCapabilityBusEnabled } from "./capability-registry";

const originalDisabled = process.env.WORKBENCH_CAPABILITY_BUS_DISABLED;

afterEach(() => {
  if (originalDisabled === undefined) delete process.env.WORKBENCH_CAPABILITY_BUS_DISABLED;
  else process.env.WORKBENCH_CAPABILITY_BUS_DISABLED = originalDisabled;
});

describe("isCapabilityBusEnabled (Phase 3 rollback switch)", () => {
  it("defaults to enabled when the env var is unset or empty", () => {
    delete process.env.WORKBENCH_CAPABILITY_BUS_DISABLED;
    expect(isCapabilityBusEnabled("mono_matting")).toBe(true);
    process.env.WORKBENCH_CAPABILITY_BUS_DISABLED = "";
    expect(isCapabilityBusEnabled("mono_matting")).toBe(true);
  });

  it("disables only the listed capability ids, trimming whitespace", () => {
    process.env.WORKBENCH_CAPABILITY_BUS_DISABLED = " mono_matting, mono_analyze_video ";
    expect(isCapabilityBusEnabled("mono_matting")).toBe(false);
    expect(isCapabilityBusEnabled("mono_analyze_video")).toBe(false);
    expect(isCapabilityBusEnabled("mono_generate_image")).toBe(true);
    expect(isCapabilityBusEnabled("image_to_prompt")).toBe(true);
  });

  it("re-reads the env var on every call so tests can toggle it without re-importing", () => {
    delete process.env.WORKBENCH_CAPABILITY_BUS_DISABLED;
    expect(isCapabilityBusEnabled("mono_generate_image")).toBe(true);
    process.env.WORKBENCH_CAPABILITY_BUS_DISABLED = "mono_generate_image";
    expect(isCapabilityBusEnabled("mono_generate_image")).toBe(false);
  });
});
