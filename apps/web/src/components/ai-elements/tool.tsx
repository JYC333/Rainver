"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ArrowRightLeftIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  FilePenIcon,
  FileSearchIcon,
  GlobeIcon,
  HammerIcon,
  LoaderCircleIcon,
  TerminalIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose w-full", className)}
    {...props}
  />
);

/**
 * A tool call's lifecycle, declared here rather than imported from the AI SDK.
 *
 * These components render from props; taking the SDK as a dependency for
 * three type aliases would put a whole runtime in the tree for nothing.
 */
export type ToolState =
  | "approval-requested"
  | "approval-responded"
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-denied"
  | "output-error";

export type ToolPart = {
  type: string;
  state: ToolState;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ToolHeaderProps = {
  title?: string;
  className?: string;
  type: string;
  state: ToolState;
  toolName?: string;
  kind?: string | null;
  expandable?: boolean;
};

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <CircleIcon className="size-3 text-yellow-600" />,
  "approval-responded": <CheckIcon className="size-3 text-blue-600" />,
  "input-available": <LoaderCircleIcon className="size-3 animate-spin" />,
  "input-streaming": <CircleIcon className="size-3" />,
  "output-available": <CheckIcon className="size-3 text-green-600" />,
  "output-denied": <XCircleIcon className="size-3 text-orange-600" />,
  "output-error": <XCircleIcon className="size-3 text-red-600" />,
};

const getStatusIndicator = (status: ToolPart["state"]) => (
  <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
    {statusIcons[status]}
    {statusLabels[status]}
  </span>
);

function toolIcon(kind?: string | null): ReactNode {
  const className = "size-3.5 shrink-0 text-muted-foreground";
  switch (kind) {
    case "read":
    case "search": return <FileSearchIcon className={className} />;
    case "edit": return <FilePenIcon className={className} />;
    case "delete": return <Trash2Icon className={className} />;
    case "move":
    case "switch_mode": return <ArrowRightLeftIcon className={className} />;
    case "execute": return <TerminalIcon className={className} />;
    case "think": return <BrainIcon className={className} />;
    case "fetch": return <GlobeIcon className={className} />;
    default: return <HammerIcon className={className} />;
  }
}

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  kind,
  expandable = true,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const body = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        {toolIcon(kind)}
        <span className="truncate text-xs text-muted-foreground">{title ?? derivedName}</span>
        {getStatusIndicator(state)}
      </div>
      {expandable && (
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      )}
    </>
  );

  const classNames = cn(
    "flex min-h-7 w-full items-center justify-between gap-3 rounded px-1.5 text-sm",
    expandable && "transition-colors hover:bg-muted/40",
    className,
  );

  return expandable ? (
    <CollapsibleTrigger
      className={classNames}
      {...props}
    >
      {body}
    </CollapsibleTrigger>
  ) : (
    <div className={classNames}>{body}</div>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-3 rounded-md bg-muted/20 px-2.5 py-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      {/*
        A string input is what the runtime already summarised — "path=…,
        limit=100" — so it is shown as written. Serialising it as JSON would
        wrap it in quotes and escape it, which is the AI SDK's assumption that
        a tool's input is an object meeting this repository's summary strings.
      */}
      <CodeBlock
        code={typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        language={typeof input === "string" ? "plaintext" : "json"}
      />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    // Also a summary, not JSON. See `ToolInput`.
    Output = <CodeBlock code={output} language="plaintext" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
