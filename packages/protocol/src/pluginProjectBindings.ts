import {z} from 'zod';
import {IdSchema,ISODateTimeSchema} from './common.js';

/**
 * Project bindings of Project-level operation packages (manifest
 * `project_binding: 'required'`). Installation and Space/user enablement stay
 * the admission layers; a binding attaches one enabled package to one Project.
 * Unbinding stops every entry for that Project and keeps the package's data.
 */
const pluginId=z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const target=z.object({plugin_id:pluginId,project_id:IdSchema}).strict();
export const PluginProjectBindingStatusSchema=z.enum(['bound','unbound']);
export const PluginProjectBindingSchema=z.object({
 plugin_id:pluginId,space_id:IdSchema,project_id:IdSchema,status:PluginProjectBindingStatusSchema,
 bound_by_user_id:IdSchema.nullable(),bound_at:ISODateTimeSchema.nullable(),
 unbound_by_user_id:IdSchema.nullable(),unbound_at:ISODateTimeSchema.nullable(),
}).strict();
/**
 * One bindable package as one Project's reader sees it. `effective` is what the
 * Project's entries and every operation check: bound and enabled for this person now.
 */
export const PluginProjectBindingItemSchema=z.object({
 plugin_id:pluginId,name:z.string(),version:z.string(),
 status:z.enum(['bound','unbound','available']),
 plugin_enabled:z.boolean(),effective:z.boolean(),
 bound_at:ISODateTimeSchema.nullable(),unbound_at:ISODateTimeSchema.nullable(),
}).strict();
export const PLUGIN_PROJECT_BINDING_OPERATION_SCHEMAS={
 'official_plugin.project_binding.list':{input:z.object({project_id:IdSchema}).strict(),output:z.object({
  project_id:IdSchema,
  /** Project owner level (owner, owner member, Space owner/admin): may bind and unbind. */
  can_manage:z.boolean(),
  items:z.array(PluginProjectBindingItemSchema),
 }).strict()},
 'official_plugin.project_binding.bind':{input:target,output:PluginProjectBindingSchema},
 'official_plugin.project_binding.unbind':{input:target,output:PluginProjectBindingSchema},
} as const;
export const PLUGIN_PROJECT_BINDING_OPERATION_TITLES:Record<keyof typeof PLUGIN_PROJECT_BINDING_OPERATION_SCHEMAS,string>={
 'official_plugin.project_binding.list':"List a Project's plugin bindings",
 'official_plugin.project_binding.bind':'Bind an enabled Project plugin to this Project',
 'official_plugin.project_binding.unbind':'Unbind a plugin from this Project, keeping its data',
};
export type PluginProjectBinding=z.infer<typeof PluginProjectBindingSchema>;
export type PluginProjectBindingItem=z.infer<typeof PluginProjectBindingItemSchema>;
