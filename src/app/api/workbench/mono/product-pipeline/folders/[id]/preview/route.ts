import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import sharp from "sharp";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { resolveProductFolder } from "@/lib/mono/product-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function GET(request: Request, context: Context) {
  try {
    actorFromWorkbenchRequest(request, "image.product-set.use");
    const { id } = await context.params;
    const folder = resolveProductFolder(id);
    const originalDir = path.resolve(folder.absolutePath, "原图");
    const entries = await readdir(originalDir, { withFileTypes: true });
    const source = entries
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => {
        const aDetail = /^x_/iu.test(a.name) ? 1 : 0;
        const bDetail = /^x_/iu.test(b.name) ? 1 : 0;
        return aDetail - bDetail || a.name.localeCompare(b.name);
      })[0];
    if (!source) throw new MonoHttpError(404, "商品没有可预览的原图");
    const file = path.resolve(originalDir, source.name);
    if (path.dirname(file) !== originalDir) throw new MonoHttpError(404, "商品预览不存在");
    const body = await sharp(await readFile(file))
      .rotate()
      .resize({ width: 320, height: 240, fit: "cover" })
      .jpeg({ quality: 82 })
      .toBuffer();
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
