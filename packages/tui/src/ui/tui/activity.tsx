import { Box, Text } from "ink";
import type { ProviderFailure } from "@weiguangchao/susan-harness";
import {
  formatProviderFailure,
  type TuiRetry,
  type TuiState,
} from "../state";
import {
  resolveSlashCommandMenu,
  type SlashCommandMenu,
} from "../slash-command-menu";

type ActivitySlot =
  | { readonly kind: "retry"; readonly retry: TuiRetry }
  | { readonly kind: "failure"; readonly failure: ProviderFailure }
  | { readonly kind: "hidden" }
  | { readonly kind: "menu"; readonly menu: SlashCommandMenu }
  | { readonly kind: "notice"; readonly message: string }
  | { readonly kind: "empty" };

function resolveActivitySlot(state: TuiState): ActivitySlot {
  if (state.retry !== null) {
    return { kind: "retry", retry: state.retry };
  }
  if (state.failure !== null) {
    return { kind: "failure", failure: state.failure };
  }
  if (state.status === "running") {
    return { kind: "hidden" };
  }
  const menu = resolveSlashCommandMenu(state);
  if (menu.visible) {
    return { kind: "menu", menu };
  }
  if (state.notice !== null) {
    return { kind: "notice", message: state.notice };
  }
  return { kind: "empty" };
}

export function activitySlotRowCount(state: TuiState): number {
  const slot = resolveActivitySlot(state);
  if (slot.kind === "retry" || slot.kind === "failure" || slot.kind === "notice") {
    return 1;
  }
  if (slot.kind === "menu") {
    return Math.max(1, slot.menu.candidates.length);
  }
  return 0;
}

export function PendingBanner({
  notice,
  allowRetry,
}: {
  readonly notice: string | null;
  readonly allowRetry: boolean;
}) {
  return (
    <Box paddingLeft={1}>
      <Text color="yellow">
        ⚠ {notice ?? "上次响应未完成（Pending Agent Loop）"} ·{" "}
        {allowRetry ? "r 重试 · n 新对话" : "n 新对话"}
      </Text>
    </Box>
  );
}

export function ActivityLine({
  state,
  now,
}: {
  readonly state: TuiState;
  readonly now: number;
}) {
  const slot = resolveActivitySlot(state);
  if (slot.kind === "retry") {
    const remainingMs = Math.max(
      0,
      slot.retry.startedAt + slot.retry.delayMs - now,
    );
    return (
      <Box paddingLeft={1}>
        <Text color="yellow">
          ⏳ {slot.retry.reason} · {(remainingMs / 1000).toFixed(1)} 秒后重试（
          {slot.retry.retry}/{slot.retry.maxRetries}）
        </Text>
      </Box>
    );
  }
  if (slot.kind === "failure") {
    return (
      <Box paddingLeft={1}>
        <Text color="red">
          ⚠ Provider 请求失败 · {formatProviderFailure(slot.failure)}
        </Text>
      </Box>
    );
  }
  if (slot.kind === "hidden") {
    return null;
  }
  if (slot.kind === "menu") {
    return <SlashCommandMenuView menu={slot.menu} />;
  }
  if (slot.kind === "notice") {
    return (
      <Box paddingLeft={1}>
        <Text color="yellow">ⓘ {slot.message}</Text>
      </Box>
    );
  }
  return null;
}

export function SlashCommandMenuView({
  menu,
}: {
  readonly menu: SlashCommandMenu;
}) {
  if (menu.candidates.length === 0) {
    return (
      <Box paddingLeft={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">无匹配</Text>
      </Box>
    );
  }

  const query = menu.query ?? "/";
  const matchLength = query === "/" ? 0 : query.length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {menu.candidates.map((command, index) => (
        <Box key={command.name} paddingLeft={1} paddingRight={1}>
          <Text wrap="truncate-end">
            <Text color={index === menu.selectedIndex ? "cyanBright" : undefined}>
              {index === menu.selectedIndex ? "›" : " "}
            </Text>{" "}
            {matchLength === 0 ? (
              command.name
            ) : (
              <>
                <Text color="cyanBright" bold>
                  {command.name.slice(0, matchLength)}
                </Text>
                {command.name.slice(matchLength)}
              </>
            )}{" "}
            <Text dimColor>{command.label}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
