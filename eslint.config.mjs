import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/worktrees/**",
    // Vendored from assistant-ui packages/ui so Mono can run the Base shell
    // without resolving a second assistant-ui runtime from the source repo.
    "src/components/assistant-ui/**",
    "src/components/icons/**",
    "src/components/ui/**",
    "src/hooks/use-mobile.ts",
  ]),
]);

export default eslintConfig;
