import { Box, Text } from "ink";
import type { ModelPickerState } from "../core/model-picker.js";

export function ModelPickerView({ state }: { readonly state: ModelPickerState }) {
  const provider = state.catalog.providers[state.providerIndex];
  const model =
    provider === undefined || state.modelIndex === null
      ? undefined
      : provider.models[state.modelIndex];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <Text>模型选择</Text>
      {provider === undefined ? (
        <Text color="red">没有可用 provider</Text>
      ) : (
        <>
          <Text color="cyan">
            ▸ {provider.alias} · {provider.type}
          </Text>
          <Text>
            模型：{model?.id ?? "未设置"}
          </Text>
          <Text>
            Reasoning Effort：{state.reasoningEffort ?? "未设置"}
          </Text>
        </>
      )}
      <Text dimColor>
        ↑/↓ 模型 · Tab Provider · ←/→ Reasoning Effort · Enter 应用 · Esc 取消
      </Text>
    </Box>
  );
}
