import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { tr } from "./i18n.ts";
import { fromYaml } from "./schemaYaml.ts";

describe("schemaYaml helpers", () => {
  it("reports malformed YAML with safe structural diagnostics", () => {
    const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));
    const secret = "credential=secret-value";
    let error: unknown;

    try {
      decodeYaml(`name: ${secret}\n  bad-indent: nope\n`);
    } catch (cause) {
      error = cause;
    }

    expect(Schema.isSchemaError(error)).toBe(true);
    if (!Schema.isSchemaError(error)) {
      throw new Error("Expected a schema error");
    }
    expect(error.message).toBe(
      tr("Invalid YAML (code={code}{location}).", {
        code: "BLOCK_AS_IMPLICIT_KEY",
        location: "，行 1，列 7",
      }),
    );
    expect(error.message).not.toContain(secret);
  });

  it("does not expose stringify failure details", () => {
    const encodeYaml = Schema.encodeSync(fromYaml(Schema.Unknown));
    const secret = "credential=secret-value";
    let error: unknown;

    try {
      encodeYaml({
        toJSON() {
          throw new Error(secret);
        },
      });
    } catch (cause) {
      error = cause;
    }

    expect(Schema.isSchemaError(error)).toBe(true);
    if (!Schema.isSchemaError(error)) {
      throw new Error("Expected a schema error");
    }
    expect(error.message).toBe(tr("Failed to stringify YAML."));
    expect(error.message).not.toContain(secret);
  });
});
