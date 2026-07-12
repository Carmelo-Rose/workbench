export const monoImage2TemplateIds = [
  "tpl-ecommerce",
  "tpl-replace-product",
  "tpl-ref-gen",
  "tpl-night-flash",
  "tpl-mid-century",
  "tpl-triptych",
] as const;

export type MonoImage2TemplateId = (typeof monoImage2TemplateIds)[number];
export type MonoImage2StructuredMode = "replace-product" | "reference-generate";

export type MonoImage2Template = {
  id: MonoImage2TemplateId;
  title: string;
  description: string;
  thumbnailUrl: string;
  referenceImageUrl?: string;
  prompt: string;
  aspectRatio?: "1:1" | "3:4" | "9:16" | "4:3" | "16:9";
  model?: string;
  structuredMode?: MonoImage2StructuredMode;
};

export const MONO_IMAGE2_TEMPLATES: readonly MonoImage2Template[] = [
  {
    id: "tpl-ecommerce",
    title: "电商详情页",
    description: "产品营销级长图",
    thumbnailUrl: "/mono/image2/templates/03.png",
    referenceImageUrl: "/mono/image2/references/ecommerce.png",
    prompt: "生成这个产品的电商详情页",
  },
  {
    id: "tpl-replace-product",
    title: "替换产品",
    description: "将产品放入指定场景",
    thumbnailUrl: "/mono/image2/templates/05.png",
    prompt: "参考图1是产品图，参考图2是场景参考图。使用参考图2作为最终画面的背景、构图、机位、视角、光线、色调和画幅。将参考图1中的产品完整替换到参考图2里原本对应的产品位置，只替换产品本身，不改变参考图2的背景、空间结构、人物姿态、道具关系和整体构图。保持产品外观、材质、颜色、logo和关键细节准确，边缘融合自然，阴影、透视、接触关系与参考图2一致，输出真实商业摄影质感。",
    model: "gpt-image-2",
    structuredMode: "replace-product",
  },
  {
    id: "tpl-ref-gen",
    title: "参考生成",
    description: "上传参考图，AI 生成风格化图片",
    thumbnailUrl: "/mono/image2/templates/06.png",
    prompt: "参考图1是产品图，参考图2是人物/场景灵感参考图。先识别参考图1中的产品类型（例如帽子、手套、鞋子、衣服、包、配饰等），再参考图2里人物的穿戴位置、姿势动态、生活方式场景、镜头角度、色彩氛围和画面质感，重新生成一张新的完整生活方式场景图。生成结果必须让参考图1的产品自然穿戴或使用在人物身上：如果是帽子就戴在头上，如果是手套就戴在手上，如果是鞋子就穿在脚上，如果是衣服就成为人物对应衣物。准确保留参考图1产品的外观、材质、颜色、纹理、logo、文字和关键细节。参考图2只作为姿势、场景、构图和氛围方向，不要逐像素复制参考图2，不要求保留原人物、原背景、原衣服或原产品；可以重构人物、背景、服装搭配和画面细节，让整体更像新的商业生活方式大片。不要生成孤立产品图，不要把产品放到桌面展示，必须生成有人物穿戴/使用该产品的完整场景图。",
    model: "gpt-image-2",
    structuredMode: "reference-generate",
  },
  {
    id: "tpl-night-flash",
    title: "夜间直闪人像",
    description: "时髦杂志大片感",
    thumbnailUrl: "/mono/image2/templates/01.png",
    referenceImageUrl: "/mono/image2/references/night-flash.jpg",
    prompt: "把这张照片变成夜间时髦直闪摄影风格。使用强烈的机顶直闪，让主体有明显高光、深阴影，并略微过曝。场景设在夜晚，背景昏暗、有氛围感，同时保持真实的色彩和纹理。加入抓拍般的杂志大片感、略带瑕疵的构图、运动感和自然流露的表情。突出高对比、皮肤的光泽高光和细微胶片颗粒，呈现生猛的时尚夜生活美学。",
  },
  {
    id: "tpl-mid-century",
    title: "中世纪现代风室内",
    description: "电影感自然光家居",
    thumbnailUrl: "/mono/image2/templates/02.jpg",
    referenceImageUrl: "/mono/image2/references/mid-century.jpg",
    prompt: "把这张图变成一个逼真的中世纪现代风室内空间：线条利落，材质温暖天然，家具富有雕塑感，并用明亮、自然、富有电影感的光线突出房间肌理。保持空间为照片级写实效果，像一张高端编辑风室内摄影作品。",
  },
  {
    id: "tpl-triptych",
    title: "电影感三联剧照",
    description: "胶片质感连续剧照",
    thumbnailUrl: "/mono/image2/templates/04.png",
    referenceImageUrl: "/mono/image2/references/triptych.jpg",
    prompt: "把上传的图片转成电影感的三联连续剧照（横向画幅纵向堆叠），全出血铺满边缘。每一帧都呈现同一场景中的不同时刻，并有清晰推进。通过变化构图、机位和景别来营造运动感与叙事感。采用电影感、偏冷调、高对比、黑位深邃的胶片质感，并保持自然调色。加入细微胶片颗粒、轻微动态模糊和自然瑕疵，模拟胶片摄影。保持抓拍式、情绪真实的构图，带有运动感和安静叙事。整体美学：电影感、怀旧、自然，像未经修饰的原始胶片剧照。",
  },
] as const;

export function getMonoImage2Template(id?: string | null): MonoImage2Template | undefined {
  return MONO_IMAGE2_TEMPLATES.find((template) => template.id === id);
}
