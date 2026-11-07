// PROTOTYPE, throwaway (wayfinder #8): stub driver kind 单独成文件，避免 driver ↔ adapter 循环导入。
import { ProviderDriverKind } from "@t3tools/contracts";

export const STUB_PROVIDER = ProviderDriverKind.make("stub");
