
import { tr } from "@t3tools/shared/i18n";export const PREVIEW_RECENT_URL_LIMIT = 10;

export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: tr("DNS address could not be found"),
  ERR_NAME_RESOLUTION_FAILED: tr("DNS address could not be found"),
  ERR_CONNECTION_REFUSED: tr("Connection refused"),
  ERR_CONNECTION_RESET: tr("Connection was reset"),
  ERR_CONNECTION_CLOSED: tr("Connection was closed"),
  ERR_CONNECTION_TIMED_OUT: tr("Connection timed out"),
  ERR_INTERNET_DISCONNECTED: tr("No internet connection"),
  ERR_TIMED_OUT: tr("Connection timed out"),
  ERR_CERT_AUTHORITY_INVALID: tr("Certificate authority is not trusted"),
  ERR_CERT_COMMON_NAME_INVALID: tr("Certificate hostname mismatch"),
  ERR_CERT_DATE_INVALID: tr("Certificate is expired or not yet valid"),
  ERR_TOO_MANY_REDIRECTS: tr("Too many redirects"),
});
