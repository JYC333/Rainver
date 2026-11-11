import type {SystemCommandKind} from '@rainver/protocol';
import type {SystemCommandKindHandler} from './intents.js';
import {PROVIDER_SYSTEM_COMMAND_HANDLERS} from '../providers/systemCommandHandlers.js';
import {PLUGIN_SYSTEM_COMMAND_HANDLERS} from '../plugins/settingsOperations.js';
import {SYSTEM_SYSTEM_COMMAND_HANDLERS} from '../system/settingsOperations.js';
import {NOTIFICATION_SYSTEM_COMMAND_HANDLERS} from '../notifications/operations.js';

/** Each kind's handler lives with its owning module; this is the closed map the worker dispatches by. */
const HANDLERS:Record<SystemCommandKind,SystemCommandKindHandler>={
  ...PROVIDER_SYSTEM_COMMAND_HANDLERS,
  ...PLUGIN_SYSTEM_COMMAND_HANDLERS,
  ...SYSTEM_SYSTEM_COMMAND_HANDLERS,
  ...NOTIFICATION_SYSTEM_COMMAND_HANDLERS,
};
export function systemCommandHandler(kind:SystemCommandKind):SystemCommandKindHandler{
  const handler=HANDLERS[kind];
  if(!handler)throw new Error('Unknown system command kind');
  return handler;
}
