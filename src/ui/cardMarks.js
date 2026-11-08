// ST Reader — AGPL-3.0
// readandrepo 修改：2026-11-08，分享卡片内的临时划线。仅修改预览副本，不写聊天或阅读批注。
import { locateTextQuote, makeTextQuote } from '../core/textTransforms.js';

const PART = '[data-stcr-card-part]';
const SKIP = 'style, script, template, button, textarea, svg, [data-stcr-ignore-anchor]';
const PALETTE = {
    yellow: ['rgba(255, 208, 0, .34)', 'rgba(230, 180, 0, .95)'],
    green: ['rgba(64, 200, 110, .30)', 'rgba(40, 170, 90, .95)'],
    blue: ['rgba(70, 150, 255, .30)', 'rgba(60, 130, 240, .95)'],
    pink: ['rgba(255, 100, 170, .30)', 'rgba(235, 80, 150, .95)'],
};

/** 遮盖按内存词表计算原长度；原词始终不写入 DOM、属性或导出图片。 */
function textIndex(root, words) {
    let text = '';
    const nodes = [];
    function visit(node) {
        if (node.nodeType === 3) {
            nodes.push({ node, start: text.length, end: text.length + node.length });
            text += node.data;
        } else if (node.nodeType === 1 || node.nodeType === 11) {
            if (node.nodeType === 1) {
                if (node.matches(SKIP)) return;
                if (node.matches('.stcr-mask')) { text += words[Number(node.dataset.stcrTw)] ?? ''; return; }
            }
            for (const child of node.childNodes) visit(child);
        }
    }
    visit(root);
    return { text, nodes };
}

function containerFor(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (element?.closest(`${SKIP}, .stcr-mask`)) return null;
    return element?.closest(PART) ?? null;
}

/** 每次打开工作台创建一份，关闭随工作台释放；模板与尺寸变化只重画，不丢记录。 */
export function createCardMarks() {
    const records = new Map();
    let serial = 0;

    function capture(card, range, words = []) {
        if (!range || range.collapsed) return null;
        const container = containerFor(range.startContainer);
        if (!container || container !== containerFor(range.endContainer) || !card.contains(container)) return null;
        const { text } = textIndex(container, words);
        const prefix = container.ownerDocument.createRange();
        prefix.selectNodeContents(container);
        prefix.setEnd(range.startContainer, range.startOffset);
        const start = textIndex(prefix.cloneContents(), words).text.length;
        prefix.setEnd(range.endContainer, range.endOffset);
        const end = textIndex(prefix.cloneContents(), words).text.length;
        if (end <= start || !range.toString().trim()) return null;
        return { part: container.dataset.stcrCardPart, text, start, end, quote: makeTextQuote(text, start, end) };
    }

    function add(selection, color) {
        if (!selection || !Object.hasOwn(PALETTE, color)) return null;
        // 同一范围重复选色视为换色，避免叠出无法取消的同范围划线。
        const existing = [...records.values()].find(record => {
            if (record.part !== selection.part) return false;
            const at = record.text === selection.text ? record : locateTextQuote(selection.text, record.quote);
            return at?.start === selection.start && at?.end === selection.end;
        });
        const id = existing?.id ?? String(++serial);
        records.delete(id);
        records.set(id, { ...selection, id, color });
        return id;
    }

    function paint(card, words = []) {
        // 换色/删除可直接重画同一副本；不触碰原始片段、宿主正文或遮盖。
        for (const span of card.querySelectorAll('.stcr-card-highlight')) span.replaceWith(...span.childNodes);
        for (const container of card.querySelectorAll(PART)) {
            container.normalize();
            const { text, nodes } = textIndex(container, words);
            const intervals = [];
            for (const record of records.values()) {
                if (record.part !== container.dataset.stcrCardPart) continue;
                const at = record.text === text ? record : locateTextQuote(text, record.quote);
                if (at) intervals.push({ ...at, id: record.id, color: record.color });
            }
            for (const { node, start, end } of nodes) {
                const hits = intervals.filter(at => at.start < end && at.end > start);
                if (!hits.length) continue;
                const edges = [...new Set([start, end, ...hits.flatMap(at => [Math.max(start, at.start), Math.min(end, at.end)])])].sort((a, b) => a - b);
                const fragment = node.ownerDocument.createDocumentFragment();
                for (let i = 1; i < edges.length; i++) {
                    const a = edges[i - 1], b = edges[i];
                    const value = node.data.slice(a - start, b - start);
                    const mark = hits.findLast(at => at.start <= a && at.end >= b);
                    if (!mark) { fragment.append(node.ownerDocument.createTextNode(value)); continue; }
                    const span = node.ownerDocument.createElement('span');
                    span.className = `stcr-card-highlight stcr-card-highlight--${mark.color}`;
                    span.dataset.stcrCardMark = mark.id;
                    const [background, line] = PALETTE[mark.color];
                    // 普通内联样式可被隔离快照与 PNG 复制，CSS Highlight API 的 Range 不会进入克隆文档。
                    span.style.cssText = `display:inline!important;font:inherit!important;color:inherit!important;margin:0!important;padding:0!important;border:0!important;background-color:${background}!important;text-decoration-line:underline!important;text-decoration-color:${line}!important;text-decoration-thickness:2px!important;text-underline-offset:.12em!important;`;
                    span.textContent = value;
                    fragment.append(span);
                }
                node.replaceWith(fragment);
            }
        }
    }

    return {
        capture, add, paint,
        get: id => records.get(id),
        update(id, color) { const record = records.get(id); if (record && Object.hasOwn(PALETTE, color)) record.color = color; },
        remove: id => records.delete(id),
    };
}
