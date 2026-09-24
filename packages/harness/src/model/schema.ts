import { z } from "zod";

export const modelSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  outputToken: z.number().int().positive(),
  /** Levels the model supports; replaces the provider type's built-in levels. */
  reasoningLevels: z.array(z.string().min(1)).optional(),
  reasoningEffort: z.record(z.string(), z.string().nullable()).optional(),
});

export const providerSchema = z.object({
  baseUrl: z.string().url(),
  type: z.enum(["openai-completion", "responses", "anthropic"]),
  apiKey: z.string(),
  model: z.union([modelSchema, z.array(modelSchema).min(1)]).optional(),
});

export const configSchema = z.object({
  providers: z.record(z.string(), providerSchema),
});

export type ModelConfig = z.infer<typeof modelSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type SusanConfig = z.infer<typeof configSchema>;

export interface ModelChoice {
  providerName: string;
  provider: ProviderConfig;
  model: ModelConfig;
  efforts: Record<string, string>;
}
