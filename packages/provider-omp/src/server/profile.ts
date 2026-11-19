// t3code owns an isolated omp profile (auth, sessions, settings, caches under
// ~/.omp/profiles/<name>/) so its state never mixes with other omp frontends sharing the
// binary — Tern-managed or standalone (docs/fork/omp-profile.md).
export const OMP_PROFILE_NAME = "t3code";
export const OMP_PROFILE_ARGS: ReadonlyArray<string> = ["--profile", OMP_PROFILE_NAME];
