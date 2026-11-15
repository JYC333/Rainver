import type { Room } from '../../types/api'

/**
 * A Room's name as every Room surface shows it. The mainline is created with
 * the placeholder title `Project conversation`, which is shown as
 * `<Project name> Room`; any title a person typed is shown as typed.
 */
export function displayRoomTitle(room: Pick<Room, 'title'>, projectName: string | null | undefined): string {
  if (room.title.trim().toLocaleLowerCase() !== 'project conversation') return room.title
  return `${projectName?.trim() || 'Project'} Room`
}
