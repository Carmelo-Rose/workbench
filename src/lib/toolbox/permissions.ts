import type { Permission } from "@/lib/authorization";

/** Canonical capability-to-permission mapping shared by all toolbox entry points. */
export const toolboxCapabilityPermissions: Record<string, Permission> = {
  product_cutout: "image.cutout.use",
  smart_erase: "video.erase.use",
  video_enhance: "video.enhance.use",
  image_enhance: "image.enhance.use",
  matting: "video.cutout.use",
};
