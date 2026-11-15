import {z} from 'zod';
import {IdSchema} from './common.js';
import {CreatePublicationRequestSchema,ContentPublicationSchema,PublicationImportSchema} from './publications.js';
const target=z.object({publication_id:IdSchema}).strict();
export const PUBLICATION_OPERATION_SCHEMAS={
 'publication.create':{input:CreatePublicationRequestSchema,output:ContentPublicationSchema},
 'publication.import':{input:target,output:PublicationImportSchema},
 'publication.revoke':{input:target,output:ContentPublicationSchema},
} as const;
