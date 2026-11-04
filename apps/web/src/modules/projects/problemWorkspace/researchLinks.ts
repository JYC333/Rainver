/** Maps old Research page URLs to their problem workspace destinations; API /research and report object routes stay unchanged. */
export function researchPageDestination(project: string, params: URLSearchParams, operations = false) {
    const next = new URLSearchParams(params), tab = next.get('tab');
    if(!operations&&tab==='standing'){next.delete('tab');next.delete('thread');next.set('section','standing');return `/projects/${project}/inquiry?${next}`;}
    const focus = !operations && (next.get('research') === 'new' || tab === 'focus' || !tab);
    next.delete('research');
    if (focus) {
        next.delete('tab');
        if (tab !== 'standing')
            next.set('section', 'research');
        return `/projects/${project}/inquiry${next.size ? '?' + next : ''}`;
    }
    if (operations)
        next.set('tab', 'runs');
    return `/projects/${project}/inquiry/records?${next}`;
}
