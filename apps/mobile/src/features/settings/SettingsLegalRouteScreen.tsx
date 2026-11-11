import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { tr } from "@t3tools/shared/i18n";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  return <SettingsLegalDocumentRouteScreen documentName={tr("Legal")} documentUrl={LEGAL_URL} />;
}
