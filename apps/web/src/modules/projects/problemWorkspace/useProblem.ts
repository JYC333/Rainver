import { useCallback, useEffect, useRef, useState } from 'react';
import { inquiryApi } from '../../../api/client';
import type { InquiryThreadDetail } from '../../../types/api';
import { useSpace } from '../../../contexts/SpaceContext';
import { errMsg } from '../../../lib/utils';
export type ProblemProjection = Awaited<ReturnType<typeof inquiryApi.problem>>;
export function useProblem(project: string, thread: string | null) {
    const { activeSpaceId } = useSpace(), key = `${activeSpaceId}:${project}:${thread}`, current = useRef(key);
    current.current = key;
    const [state, setState] = useState<{
        key: string;
        detail: InquiryThreadDetail | null;
        projection: ProblemProjection | null;
        error: string | null;
        loading: boolean;
    }>({ key: '', detail: null, projection: null, error: null, loading: true });
    const refresh = useCallback(async (quiet=false) => {
        if (!thread) {
            setState({ key, detail: null, projection: null, error: null, loading: false });
            return;
        }
        if(!quiet)setState(s => s.key === key ? { ...s, loading: true } : { key, detail: null, projection: null, error: null, loading: true });
        const [d, p] = await Promise.allSettled([inquiryApi.getThread(project, thread), inquiryApi.problem(project, thread)]);
        if (current.current !== key)
            return;
        setState({ key, detail: d.status === 'fulfilled' ? d.value : null, projection: p.status === 'fulfilled' ? p.value : null, error: d.status === 'rejected' ? errMsg(d.reason) : p.status === 'rejected' ? errMsg(p.reason) : null, loading: false });
    }, [key, project, thread]);
    useEffect(() => { void refresh(); }, [refresh]);
    return { ...(state.key === key ? state : { detail: null, projection: null, error: null, loading: true }), refresh };
}
export const problemToken = (p: ProblemProjection) => ({ method_version: 'problem_solving.v1' as const, expected_version: p.version, expected_revision: p.revision, idempotency_key: crypto.randomUUID() });
