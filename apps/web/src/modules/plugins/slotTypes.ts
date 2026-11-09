import type { ComponentType } from 'react';
import type { PluginViewOps, PluginViewContext } from '@rainver/protocol';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
export type PluginOps = PluginViewOps;
export interface PluginUi {
  Button: typeof Button;
  Input: typeof Input;
  Card: typeof Card;
  CardHeader: typeof CardHeader;
  CardTitle: typeof CardTitle;
  CardContent: typeof CardContent;
  t: (key: string) => string;
  ProposalLink: ComponentType<{
    id: string;
  }>;
}
export type PluginSlotContext = PluginViewContext<PluginUi>;
export type PluginSlotComponent = ComponentType<{
  ctx: PluginSlotContext;
}>;
