import { useAppTranslation } from '../../../i18n';
export function useProblemText() { const { locale } = useAppTranslation(); return (en: string, zh: string) => locale === 'zh-CN' ? zh : en; }
export const judgmentWords: Record<string, [
    string,
    string
]> = { open: ['Open', '待判断'], partial: ['Partial answer', '部分回答'], answered: ['Answered', '已回答'], unanswerable: ['Unanswerable', '目前无法回答'], untested: ['Untested', '未经检验'], supported: ['Supported', '得到支持'], challenged: ['Challenged', '受到质疑'], contradicted: ['Contradicted', '已被反驳'], inconclusive: ['Inconclusive', '尚无定论'] };
