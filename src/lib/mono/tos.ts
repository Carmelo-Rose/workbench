import { createHash, createHmac, randomUUID } from "node:crypto";
import { getConfigValue } from "@/lib/server/api-config";

/**
 * 火山引擎 TOS（S3 兼容）直传，用于超过 base64 内嵌阈值的大视频。
 * 签名算法照抄 Mono 插件 activation-server 里验证过的实现（AWS SigV4，
 * service 固定填 "s3"）——host 形如 `<bucket>.tos-s3-<region>.volces.com`，
 * 这是 TOS 独有的兼容端点格式，用标准 AWS region 会解析失败。
 */

export type TosConfig = { accessKey: string; secretKey: string; region: string; bucket: string; host: string };

export function getTosConfig(): TosConfig | null {
  const accessKey = getConfigValue("TOS_AK");
  const secretKey = getConfigValue("TOS_SK");
  const region = getConfigValue("TOS_REGION");
  const bucket = getConfigValue("TOS_BUCKET");
  if (!accessKey || !secretKey || !region || !bucket) return null;
  return { accessKey, secretKey, region, bucket, host: `${bucket}.tos-s3-${region}.volces.com` };
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKey(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

function amzDateNow(): { amzDate: string; dateStr: string } {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStr: amzDate.slice(0, 8) };
}

function buildSigningKey(config: TosConfig, dateStr: string): Buffer {
  const kDate = hmacSha256(`AWS4${config.secretKey}`, dateStr);
  const kRegion = hmacSha256(kDate, config.region);
  const kService = hmacSha256(kRegion, "s3");
  return hmacSha256(kService, "aws4_request");
}

/** 服务端直接 PUT 上传对象（header 签名，非预签名 URL）。 */
async function putObject(config: TosConfig, key: string, body: Buffer, contentType: string): Promise<void> {
  const { amzDate, dateStr } = amzDateNow();
  const scope = `${dateStr}/${config.region}/s3/aws4_request`;
  const bodyHash = sha256Hex(body);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    `content-type:${contentType}\nhost:${config.host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = ["PUT", `/${encodeKey(key)}`, "", canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256(buildSigningKey(config, dateStr), stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${config.host}/${encodeKey(key)}`, {
    method: "PUT",
    headers: {
      Host: config.host,
      "Content-Type": contentType,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": bodyHash,
      Authorization: authHeader,
    },
    body: new Uint8Array(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`TOS 上传失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
}

/** 生成带签名的临时 GET 链接，供远端视觉模型服务器直接拉取，不需要暴露 AK/SK。 */
function buildPresignedGetUrl(config: TosConfig, key: string, expiresInSeconds: number): string {
  const { amzDate, dateStr } = amzDateNow();
  const scope = `${dateStr}/${config.region}/s3/aws4_request`;
  const signedHeaders = "host";
  const canonicalHeaders = `host:${config.host}\n`;

  const queryParams: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKey}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  queryParams.sort(([a], [b]) => a.localeCompare(b));
  const canonicalQueryString = queryParams.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");

  const canonicalRequest = [
    "GET",
    `/${encodeKey(key)}`,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256(buildSigningKey(config, dateStr), stringToSign).toString("hex");

  return `https://${config.host}/${encodeKey(key)}?${canonicalQueryString}&${uriEncode("X-Amz-Signature")}=${uriEncode(signature)}`;
}

const VIDEO_OBJECT_PREFIX = "workbench-video";
const PRESIGNED_GET_TTL_SECONDS = 3600;

function inferExtension(mimeType: string): string {
  const match = /^video\/([0-9a-z]+)/i.exec(mimeType);
  return match ? `.${match[1].toLowerCase()}` : ".mp4";
}

/** 上传视频字节到 TOS，返回一个 1 小时内有效、模型可直接拉取的签名下载链接。 */
export async function uploadVideoToTosAndGetUrl(buffer: Buffer, mimeType: string): Promise<string> {
  const config = getTosConfig();
  if (!config) {
    throw new Error("大视频云存储未配置：请在设置页填写 TOS_AK / TOS_SK / TOS_REGION / TOS_BUCKET");
  }
  const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  const key = `${VIDEO_OBJECT_PREFIX}/${datePath}/${randomUUID()}${inferExtension(mimeType)}`;
  await putObject(config, key, buffer, mimeType || "video/mp4");
  return buildPresignedGetUrl(config, key, PRESIGNED_GET_TTL_SECONDS);
}
