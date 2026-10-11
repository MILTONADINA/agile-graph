import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      ".graph/",
      ".serena/",
      // Third-party files vendored unmodified; their bytes are sha256-pinned.
      "packages/engine/vendor/",
      // Frozen historical runtimes whose bytes are pinned by retained receipts.
      "evaluation/infrastructure-runtime/",
      "evaluation/retry-visibility-runtime/",
      "evaluation/replays/",
      // Fixture programs that run inside native language containers.
      "packages/*/tests/fixtures/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      // Untyped JSON boundaries use `any` and are validated with zod.
      "@typescript-eslint/no-explicit-any": "off",
      // Secret and path sanitizers match control characters on purpose.
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Existing hits include hash-pinned evaluation files; report, don't block.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "no-unsafe-finally": "warn",
      "no-sparse-arrays": "warn",
      "preserve-caught-error": "warn",
    },
  },
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
