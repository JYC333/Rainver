/**
 * Project-inherited Project Folder read access.
 *
 * A Project Folder has no owner, visibility, membership, or access-level
 * authority of its own — it inherits its owning Project's ACL completely.
 */
export function projectFolderReadAccessSql(input: {
  spaceExpr: string;
  projectFolderExpr: string;
  userExpr: string;
}): string {
  const { spaceExpr, projectFolderExpr, userExpr } = input;
  return `(
    EXISTS (
      SELECT 1
        FROM project_folders folder_access_folder
        JOIN projects folder_access_project
          ON folder_access_project.id = folder_access_folder.project_id
         AND folder_access_project.space_id = folder_access_folder.space_id
        JOIN spaces folder_access_space
          ON folder_access_space.id = folder_access_folder.space_id
        LEFT JOIN project_members folder_access_member
          ON folder_access_member.space_id = folder_access_project.space_id
         AND folder_access_member.project_id = folder_access_project.id
         AND folder_access_member.user_id = ${userExpr}
         AND folder_access_member.status = 'active'
       WHERE folder_access_folder.id = ${projectFolderExpr}
         AND folder_access_folder.space_id = ${spaceExpr}
         AND folder_access_project.deleted_at IS NULL
         AND (
           folder_access_space.type = 'personal'
           OR folder_access_project.owner_user_id = ${userExpr}
           OR folder_access_member.user_id IS NOT NULL
         )
    )
  )`;
}
