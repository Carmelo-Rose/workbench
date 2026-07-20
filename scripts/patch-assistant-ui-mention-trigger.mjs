// 放宽 @assistant-ui 的触发字符边界：上游要求触发符（@、/）前必须是空白，
// 导致「生成一只猫@」这种中文紧贴写法弹不出提及列表。对齐 Mono 插件的规则：
// 只有前一个字符是 \w（英文单词字符，如 email@domain 的场景）才拦截，
// 中文、标点等非单词字符一律放行。
//
// 上游硬编码无配置项，故在 postinstall 阶段就地改写 dist 产物（幂等）。
// 若升级 @assistant-ui 后旧代码找不到，脚本会报错提醒重新核对补丁。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OLD_BOUNDARY = "!WHITESPACE_RE.test(textUpToCursor[i - 1])";
const NEW_BOUNDARY = "/\\w/u.test(textUpToCursor[i - 1])";

const targets = [
  // 控制 @/斜杠弹层是否打开
  "node_modules/@assistant-ui/react/dist/primitives/composer/trigger/detectTrigger.js",
  // 控制选中后替换 "@query" 文本范围插入 chip
  "node_modules/@assistant-ui/react-lexical/dist/plugins/DirectivePlugin.js",
];

let failed = false;
for (const target of targets) {
  const path = resolve(process.cwd(), target);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    console.error(`[patch-mention-trigger] 文件不存在：${target}`);
    failed = true;
    continue;
  }
  if (source.includes(NEW_BOUNDARY)) {
    console.log(`[patch-mention-trigger] 已是补丁版本，跳过：${target}`);
    continue;
  }
  if (!source.includes(OLD_BOUNDARY)) {
    console.error(
      `[patch-mention-trigger] 未找到预期代码，@assistant-ui 可能已升级，请核对补丁：${target}`,
    );
    failed = true;
    continue;
  }
  writeFileSync(path, source.replace(OLD_BOUNDARY, NEW_BOUNDARY));
  console.log(`[patch-mention-trigger] 已打补丁：${target}`);
}

if (failed) process.exit(1);
