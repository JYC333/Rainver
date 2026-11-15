/** Row shapes the Reading Method owners read inside a caller-owned transaction. */
export interface ReadingVersionRow {id:string;asset_id:string;space_id:string|null;scope_type:string;scope_id:string|null;status:string;version:number;content_hash:string;content_json:unknown}
export interface ReadingSampleInput {kind?:string;reading_item_id?:string;project_id?:string|null;authority?:string;context_hash?:string;pages?:Array<{url:string;text:string}>}
export interface ReadingSampleRow {id:string;name:string;created_by_user_id:string;baseline_version_id:string;input_json:ReadingSampleInput}
export interface ReadingCountRow {active:number;daily:number}
