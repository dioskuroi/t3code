import { useState } from "react";
import { tr } from "@t3tools/shared/i18n";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";

export function PdfPreview(props: { readonly uri: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="flex-1 bg-card">
      {error ? (
        <FilePreviewNotice title={tr("Could not load PDF")}>{error}</FilePreviewNotice>
      ) : null}
      <WebView
        source={{ uri: props.uri }}
        originWhitelist={["*"]}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        startInLoadingState
        onError={(event) =>
          setError(event.nativeEvent.description || tr("The PDF could not be loaded."))
        }
        onHttpError={(event) =>
          setError(
            tr("The server returned HTTP {statusCode}.", {
              statusCode: event.nativeEvent.statusCode,
            }),
          )
        }
        renderLoading={() => (
          <FilePreviewLoading message={tr("Loading PDF...")} background="card" />
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
