export type TuiToolStatus =
  | "requested"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type TuiToolCard = {
  readonly id: string;
  readonly name: string;
  readonly invocationLabel: string;
  readonly streamIndex?: number;
  readonly argumentsText?: string;
  readonly status: TuiToolStatus;
  readonly summary: string;
  readonly supplementalLines: readonly string[];
  readonly startLine?: number;
  readonly totalLines?: number;
};

export type TuiToolResultRow = {
  readonly text: string;
  readonly gap: boolean;
  readonly lineNumber?: number;
  readonly sign?: "+" | "-" | " ";
};
