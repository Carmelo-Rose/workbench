const imageBlobCache = new Map<string, Promise<Blob | null>>();

function loadImageBlob(url: string): Promise<Blob | null> {
  const cached = imageBlobCache.get(url);
  if (cached) return cached;

  const request = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
      return response.blob();
    })
    .catch(() => {
      // 下载失败不缓存 null，让点击时还能重新尝试。
      imageBlobCache.delete(url);
      return null;
    });
  imageBlobCache.set(url, request);
  return request;
}

/** 在后台预热“作为参考图”所需的同源图片代理请求。 */
export function preloadImageReference(url: string): void {
  void loadImageBlob(url);
}

export async function imageReferenceToFile(url: string, name: string): Promise<File | null> {
  const blob = await loadImageBlob(url);
  if (!blob) return null;
  const extension = (blob.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
  return new File([blob], `${name}.${extension}`, { type: blob.type || "image/png" });
}
