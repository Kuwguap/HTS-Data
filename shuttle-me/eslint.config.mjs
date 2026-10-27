import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/sw.js",
    // vendored MapLibre worker (minified third-party code, see scripts/vendor-maplibre-worker.mjs)
    "public/vendor/**",
    "node_modules/**",
    "playwright-report/**",
    "test-results/**",
    // session scratch (gitignored): screenshot helpers and orchestration scripts
    ".ui-shots/**",
    ".workflows/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
