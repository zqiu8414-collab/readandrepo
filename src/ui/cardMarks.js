// ST Reader — AGPL-3.0
// readandrepo 修改：2026-11-08，分享卡片内的临时划线。仅修改预览副本，不写聊天或阅读批注。
import { locateTextQuote, makeTextQuote } from '../core/textTransforms.js?v=0.3.1-self.6';

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
    const nodes = [], points = [];
    function visit(node) {
        if (node.nodeType === 3) {
            const entry = { node, start: text.length, end: text.length + node.length };
            nodes.push(entry); points.push(entry);
            text += node.data;
        } else if (node.nodeType === 1 || node.nodeType === 11) {
            if (node.nodeType === 1) {
                if (node.matches(SKIP)) return;
                if (node.matches('.stcr-mask')) {
                    const start = text.length;
                    text += words[Number(node.dataset.stcrTw)] ?? '';
                    points.push({ node, start, end: text.length, atomic: true });
                    return;
                }
            }
            for (const child of node.childNodes) visit(child);
        }
    }
    visit(root);
    return { text, nodes, points };
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
    let editingRanges = null;

    /** 编辑用浏览器会随输入移动的 Range；删除后绝不再到别处搜索同名文字。 */
    function beginEdit(card, words = []) {
        editingRanges = new Map();
        for (const container of card.querySelectorAll(PART)) {
            const { text, points } = textIndex(container, words);
            for (const record of records.values()) {
                if (record.part !== container.dataset.stcrCardPart) continue;
                const at = record.text === text ? record : locateTextQuote(text, record.quote);
                if (!at) continue;
                const first = points.find(point => point.end > at.start);
                const last = points.findLast(point => point.start < at.end);
                if (!first || !last) continue;
                const range = container.ownerDocument.createRange();
                if (first.atomic) range.setStartBefore(first.node);
                else range.setStart(first.node, Math.max(0, at.start - first.start));
                if (last.atomic) range.setEndAfter(last.node);
                else range.setEnd(last.node, Math.min(last.node.length, at.end - last.start));
                const overlapping = [...records.values()].some(other => other.id !== record.id && other.part === record.part
                    && other.text === text && other.start < at.end && other.end > at.start);
                editingRanges.set(record.id, { container, range, useWrappers: !overlapping && !first.atomic && !last.atomic,
                    startInset: first.atomic ? at.start - first.start : 0, endInset: last.atomic ? last.end - at.end : 0 });
            }
        }
    }

    function finishEdit(words = []) {
        if (!editingRanges) return 0;
        let removed = 0;
        for (const [id, { container, range, useWrappers, startInset, endInset }] of editingRanges) {
            const record = records.get(id);
            if (!record) continue;
            // 完整可见的划线优先沿用其内联节点：替换末字时包含新字，删除整条后节点不会跑到同名词。
            const spans = useWrappers ? [...container.querySelectorAll('.stcr-card-highlight')]
                .filter(span => span.dataset.stcrCardMark === id && textIndex(span, words).text.length) : [];
            if (spans.length) {
                range.setStartBefore(spans[0]);
                range.setEndAfter(spans.at(-1));
            }
            if (range.collapsed || !container.contains(range.startContainer) || !container.contains(range.endContainer)) {
                records.delete(id); removed++; continue;
            }
            const prefix = container.ownerDocument.createRange();
            prefix.selectNodeContents(container);
            prefix.setEnd(range.startContainer, range.startOffset);
            const start = textIndex(prefix.cloneContents(), words).text.length + startInset;
            prefix.setEnd(range.endContainer, range.endOffset);
            const end = textIndex(prefix.cloneContents(), words).text.length - endInset;
            const { text } = textIndex(container, words);
            if (end <= start) { records.delete(id); removed++; continue; }
            Object.assign(record, { text, start, end, quote: makeTextQuote(text, start, end) });
        }
        editingRanges = null;
        return removed;
    }

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
        capture, add, paint, beginEdit, finishEdit,
        snapshot: () => [...records.values()].map(record => ({ ...record, quote: { ...record.quote } })),
        restore(snapshot = []) {
            records.clear(); editingRanges = null;
            for (const record of snapshot) records.set(record.id, { ...record, quote: { ...record.quote } });
            serial = Math.max(0, ...snapshot.map(record => Number(record.id) || 0));
        },
        get: id => records.get(id),
        update(id, color) { const record = records.get(id); if (record && Object.hasOwn(PALETTE, color)) record.color = color; },
        remove: id => records.delete(id),
    };
}
