import { z } from "zod";
import { REASONING_EFFORT_VALUES, type ProviderType } from "../provider";
import type { Config, ConfigIssue } from "./types";

const providerTypeSchema = z.enum([
  "anthropic",
  "openai-completion",
  "responses",
] as const satisfies readonly ProviderType[]);

const reasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);

const providerAliasSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !/^\d+$/.test(value),
    "Provider alias must not be an integer-like string",
  );

const modelEntrySchema = z.strictObject({
  input: z.array(z.enum(["text", "image"])).min(1).optional(),
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

const modelCatalogSchema = z
  .array(modelEntrySchema)
  .min(1)
  .superRefine((models, context) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      if (seen.has(model.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Duplicate model id: ${model.id}`,
        });
      }
      seen.add(model.id);
    }
  });

export const providerEntrySchema = z.strictObject({
  type: providerTypeSchema,
  apiKey: z.string().min(1).optional(),
  baseURL: z
    .string()
    .url("baseURL must be an absolute http(s) URL")
    .refine(
      (value) => value.startsWith("http:") || value.startsWith("https:"),
      "baseURL must be an absolute http(s) URL",
    )
    .optional(),
  models: modelCatalogSchema.optional(),
});

export const configSchema = z.strictObject({
  defaultProvider: providerAliasSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  defaultReasoningEffort: reasoningEffortSchema.optional(),
  providers: z
    .record(providerAliasSchema, providerEntrySchema)
    .default({}),
});

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0
    ? "(root)"
    : path.map((segment) => String(segment)).join(".");
}

export function schemaIssues(error: z.ZodError): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({
          path: issuePath([...issue.path, key]),
          code: issue.code,
          message: `Unrecognized key: ${String(key)}`,
        });
      }
      continue;
    }

    issues.push({
      path: issuePath(issue.path),
      code: issue.code,
      message: issue.message,
    });
  }

  return issues;
}

export function hasApprovalField(config: Config): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    Object.prototype.hasOwnProperty.call(config, "approval")
  );
}
