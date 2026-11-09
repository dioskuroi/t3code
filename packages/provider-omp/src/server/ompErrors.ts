// Shared omp error-message extraction (#review standards): every failure surface — rpc frame
// errors (plain string or `{ message }`), request causes, probe failures — shows the underlying
// message when it is a usable string, so the guidance text never renders "[object Object]" and
// never diverges per call site.
export const ompErrorMessage = (cause: unknown): string | undefined => {
  if (typeof cause === "string") return cause.trim() === "" ? undefined : cause;
  const message = (cause as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
};
