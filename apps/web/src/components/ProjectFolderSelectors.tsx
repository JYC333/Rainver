import { useEffect, useMemo, useState } from 'react'
import { projectFoldersApi, projectsApi } from '../api/client'
import type { Project, ProjectFolder } from '../types/api'
import { Label } from './ui/label'
import { Select } from './ui/select'
import { toast } from 'sonner'
import { errMsg } from '../lib/utils'

export function ProjectSelector({
  value,
  onChange,
  label = 'Project',
  optional = true,
}: {
  value: string
  onChange: (id: string) => void
  label?: string
  optional?: boolean
}) {
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    Promise.resolve().then(() => projectsApi.list({ status: 'active', limit: 200 }))
      .then(page => setProjects(page.items))
      .catch(error => toast.error(errMsg(error)))
  }, [])
  return <div>
    <Label>{label}</Label>
    <Select value={value} onChange={onChange} options={[
      ...(optional ? [{ value: '', label: 'No Project' }] : []),
      ...projects.map(project => ({ value: project.id, label: project.name })),
    ]} />
  </div>
}

export function ProjectFolderSelectors({
  projectId,
  folderId,
  onProjectChange,
  onFolderChange,
  projectLabel = 'Project (optional)',
  folderLabel = 'Project Folder (optional)',
  allowProject = true,
}: {
  projectId: string
  folderId: string
  onProjectChange: (id: string) => void
  onFolderChange: (id: string) => void
  projectLabel?: string
  folderLabel?: string
  allowProject?: boolean
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [foldersByProject, setFoldersByProject] = useState<Record<string, ProjectFolder[]>>({})

  useEffect(() => {
    Promise.resolve().then(() => projectsApi.list({ status: 'active', limit: 200 }))
      .then(page => setProjects(page.items))
      .catch(error => toast.error(errMsg(error)))
  }, [])

  useEffect(() => {
    if (!projectId || foldersByProject[projectId]) return
    Promise.resolve().then(() => projectFoldersApi.list(projectId, { status: 'active', limit: '200' }))
      .then(page => setFoldersByProject(current => ({ ...current, [projectId]: page.items })))
      .catch(error => toast.error(errMsg(error)))
  }, [foldersByProject, projectId])

  const folders = useMemo(() => foldersByProject[projectId] ?? [], [foldersByProject, projectId])

  return (
    <>
      {allowProject && <div>
        <Label>{projectLabel}</Label>
        <Select
          value={projectId}
          onChange={value => {
            onProjectChange(value)
            if (!value || !(foldersByProject[value] ?? []).some(folder => folder.id === folderId)) onFolderChange('')
          }}
          options={[{ value: '', label: 'No Project' }, ...projects.map(project => ({ value: project.id, label: project.name }))]}
        />
      </div>}
      <div>
        <Label>{folderLabel}</Label>
        <Select
          value={folderId}
          disabled={!projectId}
          onChange={onFolderChange}
          options={[
            { value: '', label: projectId ? 'No Project Folder' : 'Select a Project first' },
            ...folders.map(folder => ({ value: folder.id, label: `${folder.name}${folder.execution_enabled ? ' · execution enabled' : ''}` })),
          ]}
        />
      </div>
    </>
  )
}
