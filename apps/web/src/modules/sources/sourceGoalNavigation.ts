/** Reading owns setup navigation; Sources continues to own the collection API. */
export function readingGoalsPath(projectId?:unknown){
 return typeof projectId==='string'&&projectId?`/projects/${encodeURIComponent(projectId)}/sources/goals`:'/library/reading/goals'
}
export function readingGoalPath(projectId:unknown,goalId:string){
 return `${readingGoalsPath(projectId)}/${encodeURIComponent(goalId)}`
}
