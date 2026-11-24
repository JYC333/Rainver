import { useCallback, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ComponentType, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import type { PluginOperationId, PluginViewContext, OperationOutcome } from '@rainver/protocol';

/** The host's shared controls and helpers as the bundled views see them (structural types), and the views' common helpers. */
export type El<P> = ComponentType<P>;
export interface UI {
  Button: El<ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'success'; size?: 'default' | 'sm' | 'lg' | 'icon' }>;
  Input: El<InputHTMLAttributes<HTMLInputElement>>;
  Textarea: El<TextareaHTMLAttributes<HTMLTextAreaElement>>;
  Select: El<{ options: { value: string; label: string; disabled?: boolean }[]; value: string; onChange: (value: string) => void; ariaLabel?: string; size?: 'sm' | 'md'; disabled?: boolean; className?: string }>;
  Badge: El<HTMLAttributes<HTMLSpanElement> & { variant?: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'muted' | 'outline' }>;
  Card: El<HTMLAttributes<HTMLDivElement>>;
  CardHeader: El<HTMLAttributes<HTMLDivElement>>;
  CardTitle: El<HTMLAttributes<HTMLHeadingElement>>;
  CardContent: El<HTMLAttributes<HTMLDivElement>>;
  /** The host's shared tabs (Radix): keyboard, focus and selection conventions come with them. */
  Tabs: El<{ value: string; onValueChange: (value: string) => void; className?: string; children: ReactNode }>;
  TabsList: El<HTMLAttributes<HTMLDivElement>>;
  TabsTrigger: El<ButtonHTMLAttributes<HTMLButtonElement> & { value: string }>;
  TabsContent: El<HTMLAttributes<HTMLDivElement> & { value: string }>;
  t: (key: string, options?: Record<string, unknown>) => string;
  formatDay: (day: string) => string;
  ProposalLink: El<{ id: string }>;
  NoteLink: El<{ noteId: string; children: ReactNode }>;
  entrySearch: string;
  setEntrySearch: (search: string) => void;
  EntryLink: El<{ entry: string; search?: string; children: ReactNode }>;
}
export type Ctx = PluginViewContext<UI>;

export const op = (name: string) => `plugin.applications.${name}` as PluginOperationId;
export const k = (key: string) => `plugin_applications.${key}`;
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const blank = (value: string) => value.trim() === '' ? null : value.trim();
export const field = 'block space-y-1.5 text-sm';
export const touch = 'max-md:min-h-[44px]';

/** Reads and writes through the scoped port; a refusal reason becomes translated copy, never raw server text. */
export function useOperations(ctx: Ctx) {
  const { ops, ui, projectId } = ctx;
  const port = useRef(ops);
  useLayoutEffect(() => { port.current = ops; }, [ops]);
  const query = useCallback(async <T,>(name: string, input: Record<string, unknown>): Promise<T> => {
    const result = await port.current.query<T>(op(name), { project_id: projectId, ...input });
    if ('status' in result && result.status === 'succeeded') return result.data;
    throw new Error('query_failed');
  }, [projectId]);
  const command = useCallback(async <T,>(name: string, input: Record<string, unknown>): Promise<OperationOutcome<T>> =>
    port.current.command<T>(op(name), { project_id: projectId, ...input }, crypto.randomUUID()), [projectId]);
  const reason = useCallback((error: unknown) => {
    const code = (error as { payload?: { error?: { metadata?: { reason?: unknown } } } })?.payload?.error?.metadata?.reason;
    return typeof code === 'string' ? ui.t(k(`errors.${code}`), { defaultValue: ui.t(k('errors.generic')) }) : ui.t(k('errors.generic'));
  }, [ui]);
  return { query, command, reason };
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className={field}><span className="font-medium">{label}</span>{children}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</label>;
}

export function Notice({ text, tone = 'status' }: { text: string; tone?: 'status' | 'alert' }) {
  return text ? <p role={tone} className={tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{text}</p> : null;
}
