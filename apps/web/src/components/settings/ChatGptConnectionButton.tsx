import type { ComponentProps } from "react";
import { tr } from "@t3tools/shared/i18n";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? tr("Continue with ChatGPT")}
    </Button>
  );
}
