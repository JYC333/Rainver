import {PLUGIN_PROJECT_BINDING_OPERATION_SCHEMAS, type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden, markedRefusal} from '../systemActions/operations/errors.js';
import {isProjectOwnerLevel} from '../projects/access.js';
import {bindPluginProject, canViewPluginProjectBindings, listPluginProjectBindings, unbindPluginProject} from './projectBindings.js';

type Id = keyof typeof PLUGIN_PROJECT_BINDING_OPERATION_SCHEMAS;
type Target = {plugin_id: string; project_id: string};

/**
 * Person-only Project binding operations. A binding is Project configuration,
 * not Project content: the list is for the Project's readers and owner-level
 * people, bind/unbind for owner level (a Space owner/admin outside the Project
 * included). The executor's replay path reruns `authorize` with that same gate,
 * so a person who lost it does not receive a stored receipt; bind/unbind
 * authority itself is checked again under locks in the owner (`projectBindings.ts`).
 */
export function pluginProjectBindingRegistrations(defs: ReadonlyMap<string, RegisteredSystemActionDefinition>, config: ServerConfig): OperationRegistration[] {
  return (Object.keys(PLUGIN_PROJECT_BINDING_OPERATION_SCHEMAS) as Id[]).map(id => ({
    definition: defs.get(id)!,
    ...(id.endsWith('.list') ? {readKind: 'metadata' as const} : {}),
    async resolve(_db, raw, a) {
      const i = raw as Partial<Target> & {project_id: string};
      return {authority: `plugin-project:${a.space_id}:${i.project_id}`, targets: {project_id: i.project_id, plugin_id: i.plugin_id ?? null}, resourceType: 'project', resourceId: i.project_id};
    },
    async authorize(db, raw, a) {
      const project = (raw as Target).project_id, person = a.on_behalf_of_user_id!;
      if (!await (id.endsWith('.list') ? canViewPluginProjectBindings(db, a.space_id, project, person) : isProjectOwnerLevel(db, a.space_id, project, person))) throw hidden();
    },
    async execute(db, raw, a) {
      const i = raw as Target;
      if (id === 'official_plugin.project_binding.list') return listPluginProjectBindings(db, config, a, i.project_id);
      return id === 'official_plugin.project_binding.bind' ? bindPluginProject(db, config, a, i.plugin_id, i.project_id) : unbindPluginProject(db, config, a, i.plugin_id, i.project_id);
    },
    classifyError: error => error instanceof HttpError ? markedRefusal(error, 'plugins') : undefined,
  } satisfies OperationRegistration));
}
