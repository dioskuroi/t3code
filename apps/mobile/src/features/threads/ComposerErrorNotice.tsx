import { View } from "react-native";
import { tr } from "@t3tools/shared/i18n";
import { Notice } from "../../components/ui/Notice";

export function ComposerErrorNotice(props: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <View className="px-4 pb-3">
      <Notice
        message={props.message}
        icon="exclamationmark.circle"
        iconTone="danger"
        floating
        onDismiss={props.onDismiss}
        dismissLabel={tr("Dismiss error")}
      />
    </View>
  );
}
