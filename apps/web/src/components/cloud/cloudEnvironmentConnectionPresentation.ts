import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { tr } from "@t3tools/shared/i18n";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: string;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: tr("Connected"),
        statusText: connectionStatusText(connection),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: tr("Connecting\u2026"),
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: tr("Reconnecting\u2026"),
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "unsupported":
      return {
        buttonLabel: tr("Client not supported"),
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "error":
      return {
        buttonLabel: tr("Connection failed"),
        statusText: connectionStatusText(connection),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: tr("Offline"),
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: tr("Not connected"),
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
  }
}
