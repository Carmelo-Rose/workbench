"use client";

import { memo } from "react";
import { FilmIcon } from "lucide-react";
import type { TextMessagePartComponent } from "@assistant-ui/react";
import { Badge } from "@/components/assistant-ui/badge";
import { DirectiveText } from "@/components/assistant-ui/directive-text";
import { VIDEO_MARKER_RE } from "./attachment-adapter";

/**
 * 用户气泡里的 Text 渲染器：把视频附件标记
 * `[视频附件 xxx.mp4｜fileId=…｜2.5MB｜已上传至视频工具箱]`
 * 渲染成一枚 chip，其余片段仍交给 DirectiveText 处理 `@` 指令。
 *
 * 标记本身是给模型读 fileId 用的协议（见 attachment-adapter.ts），这里只改
 * 呈现、不动文本，所以模型侧行为完全不受影响。附件的 content 本来是独立的
 * text part，但历史消息从 SQLite 回放后可能与用户文字合并，所以按正则切分而
 * 不是整段匹配。
 */
const VideoMarkerTextImpl: TextMessagePartComponent = (props) => {
  const { text } = props;
  // 全局正则带 lastIndex 状态，每次渲染重新起一个实例避免串场。
  const re = new RegExp(VIDEO_MARKER_RE.source, "g");
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      const segment = text.slice(cursor, match.index);
      nodes.push(<DirectiveText key={cursor} {...props} text={segment} />);
    }
    const [, name, , size] = match;
    nodes.push(
      <Badge
        key={`m${match.index}`}
        variant="muted"
        size="sm"
        data-slot="video-attachment-chip"
        className="mx-0.5 max-w-full items-baseline align-middle [&_svg]:self-center"
      >
        <FilmIcon />
        <span className="truncate">{name}</span>
        <span className="opacity-60">{size}</span>
      </Badge>,
    );
    cursor = match.index + match[0].length;
  }

  if (nodes.length === 0) return <DirectiveText {...props} />;
  if (cursor < text.length) {
    nodes.push(<DirectiveText key={cursor} {...props} text={text.slice(cursor)} />);
  }
  return <>{nodes}</>;
};

VideoMarkerTextImpl.displayName = "VideoMarkerText";

export const VideoMarkerText: TextMessagePartComponent = memo(VideoMarkerTextImpl);
