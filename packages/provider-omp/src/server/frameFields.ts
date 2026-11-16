// Shared frame-field accessors: every omp wire frame is an untyped JSON record (OmpRpcFrame
// = Record<string, unknown>), so the projection, the rpc_chunk reassembler, and the status
// parser all read fields through this one surface instead of four private casts.
type UnknownRecord = Record<string, unknown>;

export const frameString = (frame: UnknownRecord, key: string): string | undefined => {
  const value = frame[key];
  return typeof value === "string" ? value : undefined;
};

export const frameNumber = (frame: UnknownRecord, key: string): number | undefined => {
  const value = frame[key];
  return typeof value === "number" ? value : undefined;
};

export const frameRecord = (
  frame: UnknownRecord,
  key: string,
): Record<string, unknown> | undefined => {
  const value = frame[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
};

/**
 * Like frameString but drops blank strings — for identity-ish fields (`name`, `id`,
 * `provider`) where an empty string is no identity. The trim check keeps callers honest:
 * whitespace-only values never become catalog entries.
 */
export const frameNonBlankString = (frame: UnknownRecord, key: string): string | undefined => {
  const value = frameString(frame, key);
  return value !== undefined && value.trim() !== "" ? value : undefined;
};
