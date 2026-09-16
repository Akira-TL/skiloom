export type ProductError<
  Code extends string = string,
  Facts extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>
> = Readonly<{
  code: Code;
  facts: Facts;
}>;

export type Result<T, E extends ProductError = ProductError> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export function productError<
  const Code extends string,
  const Facts extends Readonly<Record<string, unknown>>
>(code: Code, facts: Facts): ProductError<Code, Facts> {
  return { code, facts };
}
