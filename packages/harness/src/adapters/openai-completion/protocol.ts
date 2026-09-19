export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function protocolError(message: string): never {
  throw new ProviderProtocolError(message);
}

export function optionalString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    protocolError(`Provider returned an invalid ${field} field.`);
  }

  return value;
}
