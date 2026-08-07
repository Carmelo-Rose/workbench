import { describe, expect, it } from "vitest";
import { capabilityName, chainTargets } from "./types";

describe("chainTargets", () => {
  it("only offers ready, non-interactive capabilities other than the current one", () => {
    expect(chainTargets("smart_erase").map((c) => c.id)).toEqual(["video_enhance", "matting"]);
    expect(chainTargets("video_enhance").map((c) => c.id)).toEqual(["matting"]);
    expect(chainTargets("matting").map((c) => c.id)).toEqual(["video_enhance"]);
  });

  it("never surfaces interactive or planned capabilities as a chain target", () => {
    const allTargetIds = new Set(
      ["smart_erase", "video_enhance", "matting"].flatMap((id) => chainTargets(id).map((c) => c.id)),
    );
    expect(allTargetIds.has("smart_erase")).toBe(false);
    expect(allTargetIds.has("translate_dub")).toBe(false);
    expect(allTargetIds.has("lip_sync")).toBe(false);
    expect(allTargetIds.has("motion_transfer")).toBe(false);
  });
});

describe("capabilityName", () => {
  it("resolves known ids to their display name and falls back to the id itself", () => {
    expect(capabilityName("matting")).toBe("抠像换背景");
    expect(capabilityName("unknown_id")).toBe("unknown_id");
  });
});
