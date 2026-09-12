import { Box, Text } from "ink";
import {
  MODEL_PICKER_VIEWPORT,
  modelPickerWindow,
  type ModelPickerState,
} from "../core/model-picker";
import { REASONING_EFFORTS } from "../core/provider";

const HINT =
  "↑/↓ 模型 · Tab Provider · ←/→ Reasoning Effort · Enter 应用 · Esc 取消";

export function ModelPickerView({ state }: { readonly state: ModelPickerState }) {
  const provider = state.catalog.providers[state.providerIndex];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      {provider === undefined ? (
        <Text color="red">没有可用 provider</Text>
      ) : (
        <PickerBody state={state} />
      )}
      <Text dimColor wrap="truncate-end">
        {HINT}
      </Text>
    </Box>
  );
}

function PickerBody({ state }: { readonly state: ModelPickerState }) {
  const provider = state.catalog.providers[state.providerIndex];
  if (provider === undefined) {
    return null;
  }
  const total = provider.models.length;
  const start = modelPickerWindow(state.modelIndex, total);
  const visible = provider.models.slice(start, start + MODEL_PICKER_VIEWPORT);
  const above = start;
  const below = Math.max(0, total - start - MODEL_PICKER_VIEWPORT);

  return (
    <>
      <Text wrap="truncate-end">
        <Text dimColor>Provider  </Text>
        {state.catalog.providers.map((item, index) => (
          <Text key={item.alias}>
            {index > 0 ? <Text dimColor>  ·  </Text> : null}
            <Text
              color={index === state.providerIndex ? "cyanBright" : "gray"}
              bold={index === state.providerIndex}
            >
              {item.alias}
            </Text>
          </Text>
        ))}
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>type </Text>
        <Text color="yellow">{provider.type}</Text>
        {provider.baseURL === undefined ? null : (
          <>
            <Text dimColor>  ·  baseURL </Text>
            {provider.baseURL}
          </>
        )}
        <Text dimColor>  ·  models {total}</Text>
      </Text>
      {above > 0 ? (
        <Text dimColor wrap="truncate-end">
          {"  ↑ 上方还有 "}
          {above} 个
        </Text>
      ) : null}
      {visible.map((model, index) => {
        const selected = start + index === state.modelIndex;
        return (
          <Text key={model.id} wrap="truncate-end">
            <Text color={selected ? "cyanBright" : undefined} bold={selected}>
              {selected ? "› " : "  "}
              {model.id}
            </Text>
          </Text>
        );
      })}
      {below > 0 ? (
        <Text dimColor wrap="truncate-end">
          {"  ↓ 下方还有 "}
          {below} 个
        </Text>
      ) : null}
      <EffortLine state={state} />
    </>
  );
}

function EffortLine({ state }: { readonly state: ModelPickerState }) {
  const provider = state.catalog.providers[state.providerIndex];
  if (provider === undefined) {
    return null;
  }
  const efforts = REASONING_EFFORTS[provider.type];
  const effortIndex =
    state.reasoningEffort === null
      ? -1
      : efforts.indexOf(state.reasoningEffort);

  return (
    <Text wrap="truncate-end">
      <Text dimColor>Reasoning Effort  </Text>
      {efforts.length === 0 ? (
        <Text dimColor>—（{provider.type} 不支持）</Text>
      ) : (
        <>
          <Text dimColor>← </Text>
          <Text color="cyanBright" bold>
            {state.reasoningEffort ?? "未设置"}
          </Text>
          <Text dimColor>
            {effortIndex < 0
              ? " →"
              : ` →   ${effortIndex + 1}/${efforts.length}`}
          </Text>
        </>
      )}
    </Text>
  );
}
