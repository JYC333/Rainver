import {systemActionInputJsonSchema,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ZodError} from 'zod';

/** Only schema-owned top-level field names and Zod codes, never received values,
 * custom validator messages, union alternatives or unknown object keys. */
export function safeInputErrors(definition:RegisteredSystemActionDefinition,error:ZodError){
 const schema=systemActionInputJsonSchema(definition) as {properties?:Record<string,unknown>};
 const fields=error.issues.slice(0,20).map(issue=>({
  field:typeof issue.path[0]==='string'&&Object.hasOwn(schema.properties??{},issue.path[0])?issue.path[0]:'$',
  code:issue.code,
 }));
 return {fields,guidance:`Read rainver describe ${definition.id} and correct these fields. Do not automatically replay a write.`};
}
