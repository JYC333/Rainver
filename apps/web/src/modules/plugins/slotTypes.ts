import type { ComponentType, ReactNode } from 'react';
import type { PluginViewOps, PluginViewContext } from '@rainver/protocol';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Select } from '../../components/ui/select';
import { Badge } from '../../components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
export type PluginOps = PluginViewOps;
/** Shared controls and translated helpers the host supplies to bundled plugin views; plugins never import app code. */
export interface PluginUi {
  Button: typeof Button;
  Input: typeof Input;
  Textarea: typeof Textarea;
  Select: typeof Select;
  Badge: typeof Badge;
  Card: typeof Card;
  CardHeader: typeof CardHeader;
  CardTitle: typeof CardTitle;
  CardContent: typeof CardContent;
  /** The shared tabs, for a view with sections of equal rank (keyboard and focus conventions included). */
  Tabs: typeof Tabs;
  TabsList: typeof TabsList;
  TabsTrigger: typeof TabsTrigger;
  TabsContent: typeof TabsContent;
  t: (key: string, options?: Record<string, unknown>) => string;
  /** A calendar day (`YYYY-MM-DD`) in the person's locale, via the shared formatter. */
  formatDay: (day: string) => string;
  ProposalLink: ComponentType<{
    id: string;
  }>;
  /** Opens a Note in the shared Notes editor (its global route, which applies the Note's own access rules). */
  NoteLink: ComponentType<{
    noteId: string;
    children: ReactNode;
  }>;
  /** A link to one of this package's own `project.area` entries in the current Project; renders nothing elsewhere. */
  EntryLink: ComponentType<{
    entry: string;
    children: ReactNode;
  }>;
}
export type PluginSlotContext = PluginViewContext<PluginUi>;
export type PluginSlotComponent = ComponentType<{
  ctx: PluginSlotContext;
}>;
