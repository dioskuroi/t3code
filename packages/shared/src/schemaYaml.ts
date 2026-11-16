import * as Effect from "effect/Effect";
import { tr } from "@t3tools/shared/i18n";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  YAMLParseError,
  parse as parseYamlString,
  stringify as stringifyYamlValue,
  type CreateNodeOptions,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
  type ToJSOptions,
  type ToStringOptions,
} from "yaml";

export type YamlParseOptions = ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions;
export type YamlStringifyOptions = DocumentOptions &
  SchemaOptions &
  ParseOptions &
  CreateNodeOptions &
  ToStringOptions;

function formatYamlParseError(error: unknown): string {
  if (!(error instanceof YAMLParseError)) {
    return tr("Invalid YAML.");
  }

  const position = error.linePos?.[0];
  const location = position === undefined ? "" : `，行 ${position.line}，列 ${position.col}`;
  return tr("Invalid YAML (code={code}{location}).", { code: error.code, location });
}

function parseYaml<E extends string>(options?: YamlParseOptions): SchemaGetter.Getter<unknown, E> {
  return SchemaGetter.transformEffect((input: E) =>
    Effect.try({
      try: () => parseYamlString(input, options) as unknown,
      catch: (error) => new SchemaIssue.InvalidValue({ message: formatYamlParseError(error) }),
    }),
  );
}

function stringifyYaml(options?: YamlStringifyOptions): SchemaGetter.Getter<string, unknown> {
  return SchemaGetter.transformEffect((input: unknown) =>
    Effect.try({
      try: () => stringifyYamlValue(input, options),
      catch: () => new SchemaIssue.InvalidValue({ message: tr("Failed to stringify YAML.") }),
    }),
  );
}

const fromYamlString = new SchemaTransformation.Transformation<unknown, string>(
  parseYaml(),
  stringifyYaml(),
);

export const fromYaml = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromYamlString));
