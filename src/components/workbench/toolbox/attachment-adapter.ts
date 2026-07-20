"use client";

import type { AttachmentAdapter } from "@assistant-ui/react";

/**
 * 组合附件适配器：视频文件上传到视频工具箱网关（大文件不能走模型消息），
 * 其余文件保持 react-ai-sdk 默认行为（data URL 进消息，供视觉模型直接看）。
 *
 * 视频的处理方式：add() 阶段流式上传拿到 fileId（附件 tile 显示上传中），
 * send() 阶段只往消息里放一行文本标记——模型看到标记后即可用 fileId 调用
 * video_erase 等工具箱工具，视频字节永远不经过模型上下文。
 */

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1GB

/** add() 与 send() 之间用附件 id 关联上传结果（组件重载即失效，够用）。 */
const uploadedVideos = new Map<string, { fileId: string }>();

const isVideoFile = (file: File) =>
  file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name);

async function uploadVideo(file: File): Promise<string> {
  const res = await fetch("/api/toolbox/upload", {
    method: "POST",
    headers: {
      // header 只允许 ASCII，中文文件名必须先编码，服务端再解回来。
      "x-file-name": encodeURIComponent(file.name),
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  const data = (await res.json().catch(() => null)) as {
    file_id?: string;
    error?: string;
  } | null;
  if (!res.ok || !data?.file_id) {
    throw new Error(data?.error ?? "视频上传失败，请检查工具箱网关");
  }
  return data.file_id;
}

const getFileDataURL = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });

export function videoAttachmentMarker(name: string, fileId: string, bytes: number) {
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return `[视频附件 ${name}｜fileId=${fileId}｜${mb}MB｜已上传至视频工具箱]`;
}

export const workbenchAttachmentAdapter: AttachmentAdapter = {
  accept: "*",

  async *add({ file }) {
    const id = crypto.randomUUID();
    const base = {
      id,
      name: file.name,
      contentType: file.type,
      file,
      content: [],
    };

    if (!isVideoFile(file)) {
      // 非视频：复刻 vercelAttachmentAdapter 的默认行为，send 时才转 data URL。
      yield {
        ...base,
        type: file.type.startsWith("image/") ? "image" : "file",
        status: { type: "requires-action", reason: "composer-send" },
      };
      return;
    }

    if (file.size > MAX_VIDEO_BYTES) {
      throw new Error("视频超过 1GB 上限，请先压缩或裁剪");
    }

    yield {
      ...base,
      type: "file",
      status: { type: "running", reason: "uploading", progress: 0 },
    };

    const fileId = await uploadVideo(file);
    uploadedVideos.set(id, { fileId });

    yield {
      ...base,
      type: "file",
      status: { type: "requires-action", reason: "composer-send" },
    };
  },

  async send(attachment) {
    const uploaded = uploadedVideos.get(attachment.id);
    if (uploaded) {
      uploadedVideos.delete(attachment.id);
      return {
        ...attachment,
        status: { type: "complete" },
        content: [
          {
            type: "text",
            text: videoAttachmentMarker(
              attachment.name,
              uploaded.fileId,
              attachment.file.size,
            ),
          },
        ],
      };
    }

    return {
      ...attachment,
      status: { type: "complete" },
      content: [
        {
          type: "file",
          mimeType: attachment.contentType ?? "",
          filename: attachment.name,
          data: await getFileDataURL(attachment.file),
        },
      ],
    };
  },

  async remove(attachment) {
    uploadedVideos.delete(attachment.id);
  },
};
