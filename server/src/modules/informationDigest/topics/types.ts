import type {GoalRow} from '../../sources/index.js';
export type ThemeGoal=Omit<GoalRow,'compatibility_json'> & {compatibility_json?:Record<string,unknown>&{theme_analysis?:{enabled:boolean;version_id:string;agent_id:string;runtime_profile_id:string};scheduler_owner?:string}};
