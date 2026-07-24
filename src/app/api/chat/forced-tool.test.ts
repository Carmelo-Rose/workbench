import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { forcedToolName, latestVideoAssetId } from "./route";

// Characterization test (Phase 1 baseline): locks in the *current*
// deterministic dispatch rules chat/route.ts uses instead of letting the
// model choose a tool — the regex-based "explicit command" layer the
// architecture plan wants to keep (just formalized), and the asset_<uuid>
// extraction the plan wants to replace with structured data-asset parts.

function userMessage(text: string, id = "msg_1"): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("forcedToolName (Phase 1 baseline)", () => {
  const cases: Array<[string, boolean, string | undefined]> = [
    ["帮我分析一下这张图的提示词", true, "image_to_prompt"],
    ["describe this image", true, "image_to_prompt"],
    // No image attachment: the "分析" keyword alone isn't enough.
    ["帮我分析一下这张图的提示词", false, undefined],

    ["反推一下这个视频的提示词 https://example.test/v.mp4", false, "mono_analyze_video"],
    ["分析视频 asset_11111111-1111-1111-1111-111111111111", false, "mono_analyze_video"],
    // Video analysis intent without a URL/asset reference doesn't force the tool.
    ["帮我分析一下这个视频", false, undefined],

    ["帮我抠像 https://example.test/a.png", false, "mono_matting"],
    ["remove background", true, "mono_matting"],
    // matting keyword without an image/url/asset reference doesn't force the tool.
    ["remove background", false, undefined],

    ["帮我生成一张猫的图片", false, "mono_generate_image"],
    ["generate an image of a cat", false, "mono_generate_image"],

    ["罗盘商品卡榜今天有什么新进榜", false, "luopan_rank_insights"],
    ["榜单最近有什么异动", false, "luopan_rank_insights"],

    ["今天天气怎么样", false, undefined],
    ["", false, undefined],
  ];

  it.each(cases)("forcedToolName(%j, hasImageAttachment=%s) -> %s", (text, hasImage, expected) => {
    expect(forcedToolName(text, hasImage)).toBe(expected);
  });

  it("prioritizes video analysis over image-generation keywords in the same sentence", () => {
    // "反推视频提示词" contains 提示词 (image trigger word) but must not be
    // misrouted to image_to_prompt or mono_generate_image.
    const text = "反推视频提示词 asset_11111111-1111-1111-1111-111111111111";
    expect(forcedToolName(text, false)).toBe("mono_analyze_video");
  });

  it("is case-insensitive on both the keyword and the URL/asset marker", () => {
    expect(forcedToolName("ANALYZE VIDEO ASSET_11111111-1111-1111-1111-111111111111", false))
      .toBe("mono_analyze_video");
  });
});

describe("latestVideoAssetId (Phase 1 baseline)", () => {
  it("extracts an asset_<uuid> reference from the latest user message", () => {
    const messages = [
      userMessage("first message", "m1"),
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "asset_00000000-0000-0000-0000-000000000000" }] } as UIMessage,
      userMessage("请分析视频素材 asset_11111111-1111-1111-1111-111111111111 的内容", "m3"),
    ];
    expect(latestVideoAssetId(messages)).toBe("asset_11111111-1111-1111-1111-111111111111");
  });

  it("ignores assistant messages and only looks at the latest user message", () => {
    const messages = [
      userMessage("asset_11111111-1111-1111-1111-111111111111", "m1"),
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "asset_22222222-2222-2222-2222-222222222222" }] } as UIMessage,
    ];
    expect(latestVideoAssetId(messages)).toBe("asset_11111111-1111-1111-1111-111111111111");
  });

  it("returns undefined when there is no asset_<uuid> reference", () => {
    expect(latestVideoAssetId([userMessage("just a plain question")])).toBeUndefined();
  });

  it("is case-insensitive on the hex digits", () => {
    const messages = [userMessage("asset_ABCDEF12-ABCD-ABCD-ABCD-ABCDEF123456")];
    expect(latestVideoAssetId(messages)).toBe("asset_ABCDEF12-ABCD-ABCD-ABCD-ABCDEF123456");
  });
});
