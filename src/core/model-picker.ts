import {
  REASONING_EFFORTS,
  type ReasoningLevel,
} from "./provider.js";

export type ModelPickerProvider = {
  readonly alias: string;
  readonly type: keyof typeof REASONING_EFFORTS;
  readonly models: readonly { readonly id: string }[];
};

export type ModelPickerCatalog = {
  readonly defaultProviderAlias?: string;
  readonly preferredProviderAlias?: string;
  readonly preferredModel?: string;
  readonly preferredReasoningEffort?: ReasoningLevel;
  readonly providers: readonly ModelPickerProvider[];
};

export type ModelPickerSelection = {
  readonly providerAlias: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningLevel;
};

export type ModelPickerState = {
  readonly catalog: ModelPickerCatalog;
  readonly providerIndex: number;
  readonly modelIndex: number | null;
  readonly reasoningEffort: ReasoningLevel | null;
};

export type ModelPickerKey = {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly tab?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
};

export type ModelPickerIntent =
  | { readonly type: "move-model"; readonly delta: -1 | 1 }
  | { readonly type: "adjust-effort"; readonly delta: -1 | 1 }
  | { readonly type: "next-provider" }
  | { readonly type: "apply"; readonly selection: ModelPickerSelection }
  | { readonly type: "cancel" }
  | { readonly type: "none" };

export function createModelPickerState(
  catalog: ModelPickerCatalog,
): ModelPickerState {
  const providerIndex = initialProviderIndex(catalog);
  const provider = catalog.providers[providerIndex];
  const initialModelId = initialModel(catalog, providerIndex);
  const modelIndex =
    provider === undefined || initialModelId === undefined
      ? null
      : provider.models.findIndex((model) => model.id === initialModelId);
  const reasoningEffort = initialReasoningEffort(catalog, providerIndex);

  return {
    catalog,
    providerIndex,
    modelIndex: modelIndex === -1 ? null : modelIndex,
    reasoningEffort,
  };
}

export function resolveModelPickerIntent(
  state: ModelPickerState,
  key: ModelPickerKey,
): ModelPickerIntent {
  if (key.escape) {
    return { type: "cancel" };
  }
  if (key.return) {
    const provider = state.catalog.providers[state.providerIndex];
    const model =
      provider === undefined || state.modelIndex === null
        ? undefined
        : provider.models[state.modelIndex];
    if (
      provider === undefined ||
      model === undefined ||
      state.reasoningEffort === null
    ) {
      return { type: "none" };
    }
    return {
      type: "apply",
      selection: {
        providerAlias: provider.alias,
        model: model.id,
        reasoningEffort: state.reasoningEffort,
      },
    };
  }
  if (key.tab) {
    return { type: "next-provider" };
  }
  if (key.upArrow) {
    return { type: "move-model", delta: -1 };
  }
  if (key.downArrow) {
    return { type: "move-model", delta: 1 };
  }
  if (key.leftArrow) {
    return { type: "adjust-effort", delta: -1 };
  }
  if (key.rightArrow) {
    return { type: "adjust-effort", delta: 1 };
  }
  return { type: "none" };
}

export function reduceModelPickerState(
  state: ModelPickerState,
  intent: ModelPickerIntent,
): ModelPickerState {
  if (intent.type === "next-provider") {
    if (state.catalog.providers.length === 0) {
      return state;
    }
    const providerIndex =
      (state.providerIndex + 1) % state.catalog.providers.length;
    return providerState(state, providerIndex);
  }
  if (intent.type === "move-model") {
    const provider = state.catalog.providers[state.providerIndex];
    if (provider === undefined || provider.models.length === 0) {
      return state;
    }
    const nextIndex =
      state.modelIndex === null
        ? 0
        : state.modelIndex + intent.delta;
    return {
      ...state,
      modelIndex: Math.min(
        provider.models.length - 1,
        Math.max(0, nextIndex),
      ),
    };
  }
  if (intent.type === "adjust-effort") {
    const provider = state.catalog.providers[state.providerIndex];
    if (provider === undefined) {
      return state;
    }
    const efforts = REASONING_EFFORTS[provider.type];
    if (efforts.length === 0) {
      return state;
    }
    const current =
      state.reasoningEffort === null
        ? 0
        : Math.max(
            0,
            efforts.indexOf(state.reasoningEffort) + intent.delta,
          );
    return {
      ...state,
      reasoningEffort:
        efforts[Math.min(efforts.length - 1, current)] ?? null,
    };
  }
  return state;
}

function initialProviderIndex(catalog: ModelPickerCatalog): number {
  if (catalog.defaultProviderAlias !== undefined) {
    const index = catalog.providers.findIndex(
      (provider) => provider.alias === catalog.defaultProviderAlias,
    );
    if (index >= 0) {
      return index;
    }
  }
  if (catalog.preferredProviderAlias !== undefined) {
    const index = catalog.providers.findIndex(
      (provider) => provider.alias === catalog.preferredProviderAlias,
    );
    if (index >= 0) {
      return index;
    }
  }
  return catalog.providers.length === 0 ? -1 : 0;
}

function initialModel(
  catalog: ModelPickerCatalog,
  providerIndex: number,
): string | undefined {
  const provider = catalog.providers[providerIndex];
  if (provider === undefined) {
    return undefined;
  }
  if (
    provider.alias === catalog.defaultProviderAlias ||
    provider.alias === catalog.preferredProviderAlias
  ) {
    const preferred = catalog.preferredModel;
    if (preferred !== undefined && provider.models.some((model) => model.id === preferred)) {
      return preferred;
    }
  }
  return undefined;
}

function initialReasoningEffort(
  catalog: ModelPickerCatalog,
  providerIndex: number,
): ReasoningLevel | null {
  const provider = catalog.providers[providerIndex];
  if (provider === undefined) {
    return null;
  }
  if (
    provider.alias !== catalog.defaultProviderAlias &&
    provider.alias !== catalog.preferredProviderAlias
  ) {
    return null;
  }
  return catalog.preferredReasoningEffort === undefined ||
      !REASONING_EFFORTS[provider.type].includes(catalog.preferredReasoningEffort)
    ? null
    : catalog.preferredReasoningEffort;
}

function providerState(
  state: ModelPickerState,
  providerIndex: number,
): ModelPickerState {
  const provider = state.catalog.providers[providerIndex];
  if (provider === undefined) {
    return state;
  }
  const preferredModel =
    provider.alias === state.catalog.defaultProviderAlias
      ? state.catalog.preferredModel
      : undefined;
  const modelIndex = Math.max(
    0,
    provider.models.findIndex((model) => model.id === preferredModel),
  );
  const efforts = REASONING_EFFORTS[provider.type];
  return {
    ...state,
    providerIndex,
    modelIndex: provider.models.length === 0 ? null : modelIndex,
    reasoningEffort:
      state.reasoningEffort !== null &&
      efforts.includes(state.reasoningEffort)
        ? state.reasoningEffort
        : null,
  };
}
