export type ParsedCliSearch = Readonly<{
  query: string;
  json: boolean;
}>;

export type ParseCliSearchResult =
  | Readonly<{ ok: true; value: ParsedCliSearch }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliSearchArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliSearchResult {
  const query = argv[0];
  if (
    argv.length !== 1 ||
    query === undefined ||
    query.startsWith("-")
  ) {
    return {
      ok: false,
      reason: "search requires exactly one query"
    };
  }
  if (query.trim().length === 0) {
    return {
      ok: false,
      reason: "search query must not be empty"
    };
  }
  return {
    ok: true,
    value: {
      query,
      json
    }
  };
}
