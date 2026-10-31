import {expect,it} from 'vitest'
import {readingMethodReturn} from '../readingMethodLinks'
it('preserves serendipity and exact edition/list return context without arbitrary redirects',()=>{
 const link='/library/items/item?from=serendipity&returnTo=%2Flibrary%2Fdigests%3Fdate%3D2026-10-29'
 expect(readingMethodReturn('item',link)).toBe(link)
 expect(readingMethodReturn('item','https://evil.test')).toBe('/library/items/item?from=library')
 expect(readingMethodReturn('item','/library/items/other?from=project')).toBe('/library/items/item?from=library')
 expect(readingMethodReturn('item','/library/items/item?from=serendipity&returnTo=https%3A%2F%2Fevil.test')).toBe('/library/items/item?from=library')
 expect(readingMethodReturn('item','/library/items/item?from=project&from=serendipity')).toBe('/library/items/item?from=library')
})
it('scope-only settings navigation accepts only safe reading destinations',()=>{
 expect(readingMethodReturn(null,'/library/reading?settings=reading')).toBe('/library/reading?settings=reading');
 expect(readingMethodReturn(null,'https://outside.test')).toBe('/library/reading?settings=reading');
 expect(readingMethodReturn(null,'/projects/other/sources?tab=settings','p')).toBe('/projects/p/sources?tab=settings');
});
