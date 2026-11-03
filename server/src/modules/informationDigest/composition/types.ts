import type {ProjectReadingResponse} from '@rainver/protocol';
export interface EditionDay {date:string;timezone:string}
export type RoundSummary=ProjectReadingResponse['rounds'][number];
export interface Section {goal_id:string;purpose_version_id:string;round_id:string;sequence:number;briefing_id:string;published_at:string}
export interface Composition {id:string;space_id:string;project_id:string;revision:number;previous_id:string|null;sections_json:Section[];rounds_json:RoundSummary[];edition_date:string;timezone:string;day_revision:number;created_at:string;reason:string}
