import type { ProblemReference } from '@rainver/protocol';
import { SpaceLink } from '../../../core/spaceNav';
import { useProblemText } from './strings';
export function problemReferences(raw: unknown): ProblemReference[] {
    if (!Array.isArray(raw))
        return [];
    return raw.flatMap(value => { if (!value || typeof value !== 'object')
        return []; const ref = 'ref' in value ? value.ref : value; if (!ref || typeof ref !== 'object' || !('type' in ref) || !('id' in ref) || typeof ref.id !== 'string' || !['note', 'inquiry_thread', 'task', 'artifact'].includes(String(ref.type)))
        return []; return [{ type: ref.type, id: ref.id } as ProblemReference]; });
}
export function ProblemReferences({ project, refs }: {
    project: string;
    refs: ProblemReference[];
}) {
    const text = useProblemText();
    return <div className="flex flex-wrap gap-3 text-sm">{refs.map((ref, i) => <SpaceLink key={`${ref.type}:${ref.id}`} className="text-primary underline" to={ref.type === 'task' ? `/projects/${project}/tasks/${ref.id}` : ref.type === 'inquiry_thread' ? `/projects/${project}/inquiry?thread=${encodeURIComponent(ref.id)}` : ref.type === 'artifact' ? `/artifacts/${ref.id}` : `/notes/${ref.id}`}>{ref.type === 'task' ? text('Task result', '任务结果') : ref.type === 'artifact' ? text('Artifact', '产物') : ref.type === 'inquiry_thread' ? text('Related problem', '相关问题') : text('Evidence note', '证据笔记')} {i + 1}</SpaceLink>)}</div>;
}
