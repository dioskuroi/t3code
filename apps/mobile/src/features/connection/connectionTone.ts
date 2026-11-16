import type { StatusTone } from "../../components/StatusPill";
import { tr } from "@t3tools/shared/i18n";
import type { RemoteClientConnectionState } from "../../lib/connection";

export function connectionTone(state: RemoteClientConnectionState): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: tr("Connected"),
        pillClassName: "bg-adaptive-emerald-500-a12-a16",
        textClassName: "text-adaptive-emerald-700-300",
      };
    case "reconnecting":
      return {
        label: tr("Reconnecting"),
        pillClassName: "bg-warning",
        textClassName: "text-warning-foreground",
      };
    case "connecting":
      return {
        label: tr("Connecting"),
        pillClassName: "bg-update",
        textClassName: "text-update-foreground",
      };
    case "unsupported":
      return {
        label: tr("Client not supported"),
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-secondary",
      };
    case "error":
      return {
        label: tr("Connection failed"),
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "offline":
      return {
        label: tr("Offline"),
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "available":
      return {
        label: tr("Available"),
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-secondary",
      };
  }
}
