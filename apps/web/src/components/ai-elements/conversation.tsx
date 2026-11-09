"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, SetStateAction } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { StickToBottom, useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import { useAppTranslation } from "@/i18n";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

interface ConversationDisclosure {
  work: boolean;
  diagnostics: boolean;
  tools: Record<string, boolean>;
}
const DisclosureContext = createContext<Map<string, ConversationDisclosure> | null>(null);

/** Keep user choices when a streamed turn is replaced by its saved message. */
export function useConversationDisclosure(id: string) {
  const store = useContext(DisclosureContext);
  const [held, setHeld] = useState(() => ({ id, value: store?.get(id) ?? emptyDisclosure() }));
  const state = held.id === id ? held.value : store?.get(id) ?? emptyDisclosure();
  if (held.id !== id) setHeld({ id, value: state });
  const setState = useCallback((update: SetStateAction<ConversationDisclosure>) => {
    setHeld(current => {
      const value = current.id === id ? current.value : store?.get(id) ?? emptyDisclosure();
      return { id, value: typeof update === "function" ? update(value) : update };
    });
  }, [id, store]);
  useEffect(() => {
    if (!store) return;
    store.set(id, state);
    if (store.size > 128) store.delete(store.keys().next().value!);
  }, [id, state, store]);
  return [state, setState] as const;
}

function emptyDisclosure(): ConversationDisclosure {
  return { work: false, diagnostics: false, tools: {} };
}

export const Conversation = ({ className, contextRef, onClickCapture, ...props }: ConversationProps) => {
  const disclosures = useRef(new Map<string, ConversationDisclosure>());
  const context = useRef<StickToBottomContext | null>(null);
  const captureContext = useCallback((value: StickToBottomContext | null) => {
    context.current = value;
    if (typeof contextRef === "function") contextRef(value);
    else if (contextRef) contextRef.current = value;
  }, [contextRef]);
  return <DisclosureContext.Provider value={disclosures.current}><StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    contextRef={captureContext}
    onClickCapture={event => {
      onClickCapture?.(event);
      if (event.target instanceof Element && event.target.closest('[data-conversation-disclosure], [data-slot="collapsible-trigger"]')) context.current?.stopScroll();
    }}
    {...props}
  /></DisclosureContext.Provider>;
};

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};
export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { t } = useAppTranslation();
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        aria-label={t('conversation_ui.turn.scroll_to_bottom')}
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
