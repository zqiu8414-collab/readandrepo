// ST Reader — AGPL-3.0
// readandrepo 修改：2026-11-09，收集不连续选段；按楼/候选/区域归并，间隔原文不进入卡片。
// 分享卡片的"选段"（T23a、F2、03 §5.9 选段合同）。
// 阅读器里的选区 / 整楼 / 一条划线 → 每楼要摘的范围（用划线同一套"锚点文字"位置）→
// 在 createCardMessage 的已脱敏副本上按位置裁剪，得到不再绑定原文的片段，交给模板。
// 片段一律是克隆出来的新节点：绝不把绑定过原文的楼层放进卡片，导出时用 replaceNames:false 不会还原真名。
// 只读（D02）：只读 handle，不写聊天、不改候选。

import { getAnchorText, locateAnchorText } from '../core/anchor.js?v=0.3.1-self.6';
import { automaticNameRules, createCardMessage } from '../core/cardExport.js?v=0.3.1-self.6';
import { renderMessage } from '../core/formatter.js?v=0.3.1-self.6';
import { replaceLiteralNames } from '../core/textTransforms.js?v=0.3.1-self.6';
import { alignTexts, isSystemLike, mapOffset } from './logic.js?v=0.3.1-self.6';

/** 思维链在前、正文在后，与楼层里的顺序一致。 */
const PARTS = Object.freeze([['reasoning', '.mes_reasoning'], ['body', '.mes_text']]);
export const MAX_CARD_FLOORS = 40;

const rangesOf = pick => !pick || pick === 'all' ? [] : Array.isArray(pick) ? pick : [pick];

/** 只合并重叠或相邻区间；不以首尾包住中间没有选中的文字。 */
function mergeRanges(...picks) {
    if (picks.includes('all')) return 'all';
    const sorted = picks.flatMap(rangesOf)
        .filter(at => Number.isInteger(at?.start) && Number.isInteger(at?.end) && at.start >= 0 && at.end > at.start)
        .map(at => ({ start: at.start, end: at.end })).sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const at of sorted) {
        const last = merged.at(-1);
        if (last && at.start <= last.end) last.end = Math.max(last.end, at.end);
        else merged.push(at);
    }
    return merged.length > 1 ? merged : merged[0] ?? null;
}

/** 同一候选内归并；同楼不同候选各自保留，不改阅读器或 ST 当前候选。 */
export function mergeCardSelections(...groups) {
    const merged = new Map();
    for (const floor of groups.flat()) {
        if (!Number.isInteger(floor?.index) || floor.index < 0 || !Number.isInteger(floor.swipe) || floor.swipe < 0) continue;
        const key = `${floor.index}:${floor.swipe}`;
        const entry = merged.get(key) ?? { index: floor.index, swipe: floor.swipe, body: null, reasoning: null };
        for (const [part] of PARTS) entry[part] = mergeRanges(entry[part], floor[part]);
        if (entry.body || entry.reasoning) merged.set(key, entry);
    }
    return [...merged.values()].sort((a, b) => a.index - b.index || a.swipe - b.swipe);
}

/** 归并后不连续段数；跨正文/思维链分别计数。 */
export const countCardSelections = floors => floors.reduce((count, floor) => count + PARTS.reduce((sum, [part]) =>
    sum + (floor[part] === 'all' ? 1 : rangesOf(floor[part]).length), 0), 0);

/** 列表逐段展示；只有短摘录进入界面，不保留额外的原文 DOM。 */
export function listCardSelections(handle, floors, cache, { displayText = text => text } = {}) {
    return mergeCardSelections(floors).flatMap(floor => PARTS.flatMap(([part]) => {
        if (!floor[part]) return [];
        const text = readerText(cache, handle, floor.index, floor.swipe, part);
        // 先处理完整原文再取摘录，避免边界或180字截断切断屏蔽词，露出半个原名。
        const shown = displayText(text);
        const aligned = shown === text ? null : alignTexts(text, shown);
        const picks = floor[part] === 'all' ? ['all'] : rangesOf(floor[part]);
        return picks.map((pick, rangeIndex) => {
            let excerpt;
            try {
                excerpt = (pick === 'all' ? shown : shown.slice(aligned ? mapOffset(aligned, pick.start, 'start') : pick.start,
                    aligned ? mapOffset(aligned, pick.end, 'end') : pick.end)).trim();
            } catch {
                excerpt = '（此段脱敏预览无法定位，请打开分享卡片查看）';
            }
            return { index: floor.index, swipe: floor.swipe, part, rangeIndex, text: excerpt.slice(0, 180) + (excerpt.length > 180 ? '…' : '') };
        });
    }));
}

/** 只删目标片段；其他区域、其他候选及同楼其他不连续范围不变。 */
export function removeCardSelection(floors, target) {
    return mergeCardSelections(floors).map(floor => {
        if (floor.index !== target.index || floor.swipe !== target.swipe) return floor;
        const pick = floor[target.part];
        const kept = pick === 'all' ? null : rangesOf(pick).filter((_, i) => i !== target.rangeIndex);
        return { ...floor, [target.part]: kept };
    }).filter(floor => floor.body === 'all' || floor.reasoning === 'all' || rangesOf(floor.body).length || rangesOf(floor.reasoning).length);
}

const isShown = el => el.getClientRects().length > 0;

/** 容器开头到某个边界点之间的锚点文字长度（与 core createAnchor 的算法相同）。 */
function offsetIn(container, node, offset) {
    const prefix = container.ownerDocument.createRange();
    prefix.selectNodeContents(container);
    prefix.setEnd(node, offset);
    return getAnchorText(prefix.cloneContents()).length;
}

/**
 * 阅读器里的选区 → 每楼 {index, swipe, body, reasoning}；body/reasoning 为 {start,end}（锚点文字位置）或 null。
 * 看不见的楼（隐藏的用户楼）和收起的思维链不算进去：卡片只放用户看得见、选得到的字。
 */
export function selectionToFloors(range, floorEls) {
    const floors = [];
    for (const el of floorEls) {
        if (el.matches('.stcr-mes--broken') || !isShown(el) || !range.intersectsNode(el)) continue;
        const entry = { index: Number(el.getAttribute('mesid')), swipe: Number(el.dataset.swipe), body: null, reasoning: null };
        for (const [part, selector] of PARTS) {
            const container = el.querySelector(`:scope > .mes_block ${selector}`);
            // 收起的思维链：Chrome 对关着的 <details> 内容也报尺寸，得另外判断
            if (!container || !isShown(container) || container.closest('details:not([open])') || !range.intersectsNode(container)) continue;
            const length = getAnchorText(container).length;
            const start = container.contains(range.startContainer) ? offsetIn(container, range.startContainer, range.startOffset) : 0;
            const end = container.contains(range.endContainer) ? offsetIn(container, range.endContainer, range.endOffset) : length;
            if (end > start) entry[part] = { start, end };
        }
        if (entry.body || entry.reasoning) floors.push(entry);
    }
    return floors;
}

/** 整楼：正文与思维链全部（思维链显示与否由工作台开关决定）。 */
export const wholeFloor = (index, swipe) => ({ index, swipe, body: 'all', reasoning: 'all' });

/**
 * 缓存：同一张卡里重复用到的渲染结果。
 * texts：阅读器那样渲染出来的锚点文字；cards：createCardMessage 的结果（按名字开关分开）。
 */
export const createPieceCache = () => ({ texts: new Map(), cards: new Map() });

/** 这楼这候选在阅读器里显示出来的锚点文字。放在不加载图片的空文档里，不会发出任何请求。 */
function readerText(cache, handle, index, swipe, part) {
    const key = `${index}:${swipe}:${part}`;
    if (!cache.texts.has(key)) {
        const rendered = renderMessage(handle, index, swipe);
        const box = document.implementation.createHTMLDocument('').createElement('div');
        box.innerHTML = part === 'reasoning' ? rendered.reasoningHtml : rendered.html; // core 已清洗
        cache.texts.set(key, getAnchorText(box));
    }
    return cache.texts.get(key);
}

/** 一条划线 → 它所在那楼的选段；原文变了找不到时返回 null。 */
export async function annotationToFloor(handle, record, cache) {
    const { mesIndex, swipeIndex, part = 'body' } = record.anchor;
    const model = handle.getMessage(mesIndex);
    const swipe = model.swipes[swipeIndex];
    if (!swipe) return null;
    const text = readerText(cache, handle, mesIndex, swipeIndex, part);
    const found = await locateAnchorText(text, record.anchor, {
        chatKey: handle.chatKey, mesIndex, swipeIndex, part, rawText: part === 'reasoning' ? swipe.reasoning : swipe.text,
    });
    if (found.status !== 'attached') return null;
    return { index: mesIndex, swipe: swipeIndex, body: null, reasoning: null, [part]: { start: found.start, end: found.end } };
}

/** 卡片副本里的文字节点（替换成的 char/user 也是文字；样式代码不算）。 */
function cardTextNodes(root) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: node => (node.parentElement?.closest('style, script') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
}

/** 同一区域只扫描一次，多段共用累计文字位置。 */
function indexCardText(root) {
    let offset = 0;
    const entries = cardTextNodes(root).filter(node => node.data.length).map(node => {
        const start = offset;
        offset += node.data.length;
        return { node, start, end: offset };
    });
    return { entries, length: offset, text: entries.map(({ node }) => node.data).join('') };
}

function textBoundary(index, offset, end) {
    let lo = 0, hi = index.entries.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (end ? index.entries[mid].end < offset : index.entries[mid].end <= offset) lo = mid + 1;
        else hi = mid;
    }
    const entry = index.entries[lo];
    return entry ? { node: entry.node, offset: offset - entry.start } : null;
}

/** 只克隆选中字，补回共同祖先上的段落/加粗/颜色，绝不复制其相邻正文。 */
function cloneByOffsets(root, start, end, index) {
    if (end <= start) return null;
    const begin = textBoundary(index, start, false), finish = textBoundary(index, Math.min(end, index.length), true);
    if (!begin || !finish) return null;
    const range = root.ownerDocument.createRange();
    range.setStart(begin.node, begin.offset);
    range.setEnd(finish.node, finish.offset);
    let fragment = range.cloneContents();
    let ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType !== 1) ancestor = ancestor.parentElement;
    while (ancestor && ancestor !== root) {
        const shell = ancestor.cloneNode(false);
        shell.removeAttribute('contenteditable');
        shell.removeAttribute('tabindex');
        for (const attr of [...shell.attributes]) if (/^on/i.test(attr.name)) shell.removeAttribute(attr.name);
        // 选中折叠块内的正文必须在卡片上看得见。
        if (shell.tagName === 'DETAILS') shell.open = true;
        shell.append(fragment);
        fragment = root.ownerDocument.createDocumentFragment();
        fragment.append(shell);
        ancestor = ancestor.parentElement;
    }
    return fragment;
}

/** 楼内 CSS 可能在选区前；保留一次，由工作台 scopeFloorStyles 限定到该楼。 */
function retainPieceStyles(source, fragment) {
    if (!fragment) return;
    for (const style of fragment.querySelectorAll('style')) style.remove();
    fragment.prepend(...[...source.querySelectorAll('style')].map(style => style.cloneNode(true)));
}

function cloneChildren(root) {
    const fragment = root.ownerDocument.createDocumentFragment();
    for (const child of root.childNodes) fragment.append(child.cloneNode(true));
    return fragment;
}

const hasContent = fragment => !!fragment && (fragment.textContent.trim() !== '' || !!fragment.querySelector?.('img, .stcr-replacement, [data-stcr-icon], hr, table'));

/**
 * 选段 → 卡片片段。每个片段：{index, swipe, isUser, isSystem, name, body, reasoning}（后三者是 DocumentFragment 或 null）。
 * mappings 是这些楼实际命中的名字替换（只给工作台私有列表用，不进卡片）。
 * @param {object} handle 阅读器的聊天句柄，导出完成前不能关闭
 * @param {{index:number,swipe:number,body:object|object[]|'all'|null,reasoning:object|object[]|'all'|null}[]} floors
 * @param {{autoReplaceNames:boolean, applyReplaceRules:boolean, rules?:object[], assets?:object[]}} options 两个名字开关各自独立（I021、03 §5.9）
 */
export async function buildPieces(handle, floors, options, cache) {
    const pieces = [], mappings = [];
    const auto = options.autoReplaceNames !== false, mine = options.applyReplaceRules !== false;
    for (const floor of mergeCardSelections(floors)) {
        const key = `${floor.index}:${floor.swipe}:${auto ? 1 : 0}${mine ? 1 : 0}`;
        if (!cache.cards.has(key)) {
            cache.cards.set(key, await createCardMessage(handle, floor.index, {
                swipeIndex: floor.swipe, replaceNames: auto || mine, autoReplaceNames: auto, applyReplaceRules: mine,
                rules: options.rules ?? [], assets: options.assets ?? [],
            }));
        }
        const made = cache.cards.get(key);
        const model = handle.getMessage(floor.index);
        const piece = { index: floor.index, swipe: floor.swipe, isUser: model.isUser, isSystem: isSystemLike(model),
            name: cloneChildren(made.element.querySelector('.name_text')), body: null, reasoning: null };
        for (const [part, selector] of PARTS) {
            const pick = floor[part];
            const source = made.element.querySelector(selector);
            if (!pick || !source) continue;
            let fragment;
            if (pick === 'all') fragment = cloneChildren(source);
            else {
                const index = indexCardText(source);
                const segments = alignTexts(readerText(cache, handle, floor.index, floor.swipe, part), index.text);
                // 名字替换会把半个名字扩展成完整替换词；在映射后的坐标再归并，避免同一替换词重复。
                const mapped = mergeRanges(rangesOf(pick).map(at => ({ start: mapOffset(segments, at.start, 'start'), end: mapOffset(segments, at.end, 'end') })));
                const ranges = rangesOf(mapped);
                if (ranges.length === 1) fragment = cloneByOffsets(source, ranges[0].start, ranges[0].end, index);
                else {
                    fragment = source.ownerDocument.createDocumentFragment();
                    for (const at of ranges) {
                        const excerpt = cloneByOffsets(source, at.start, at.end, index);
                        if (!hasContent(excerpt)) continue;
                        // 美化常排除 .mes_text [class] *，并用 > p / > blockquote 限定正文。
                        // 不给选段增加祖先；间距是空的兄弟节点，不影响原元素命中主题规则。
                        if (fragment.hasChildNodes()) {
                            const gap = source.ownerDocument.createElement('div');
                            gap.className = 'stcr-card-excerpt-gap';
                            gap.setAttribute('aria-hidden', 'true');
                            gap.setAttribute('data-stcr-ignore-anchor', '');
                            fragment.append(gap);
                        }
                        fragment.append(excerpt);
                    }
                }
                if (part === 'body' && hasContent(fragment)) retainPieceStyles(source, fragment);
            }
            if (hasContent(fragment)) piece[part] = fragment;
        }
        if (piece.body || piece.reasoning) pieces.push(piece);
        mappings.push(...made.mappings);
    }
    return { pieces, mappings };
}

/**
 * 书摘模板的"我的想法"：选段覆盖到的、写了批注的划线，按楼层与位置排序。
 * @param {object[]} annotations 这个聊天的批注记录
 */
export async function findThoughts(handle, floors, annotations, cache) {
    const found = [];
    for (const [order, floor] of mergeCardSelections(floors).entries()) {
        const model = handle.getMessage(floor.index);
        const swipe = model.swipes[floor.swipe];
        for (const [partOrder, [part]] of PARTS.entries()) {
            const pick = floor[part];
            if (!pick || !swipe) continue;
            const mine = annotations.filter(r => !r.orphan && r.note?.trim() && r.anchor.chatKey === handle.chatKey && r.anchor.mesIndex === floor.index
                && r.anchor.swipeIndex === floor.swipe && (r.anchor.part ?? 'body') === part);
            if (!mine.length) continue;
            const text = readerText(cache, handle, floor.index, floor.swipe, part);
            const context = { chatKey: handle.chatKey, mesIndex: floor.index, swipeIndex: floor.swipe, part, rawText: part === 'reasoning' ? swipe.reasoning : swipe.text };
            for (const record of mine) {
                const at = await locateAnchorText(text, record.anchor, context);
                if (at.status !== 'attached') continue;
                if (pick !== 'all' && !rangesOf(pick).some(picked => at.start < picked.end && at.end > picked.start)) continue;
                found.push({ key: [order, partOrder, at.start], note: record.note.trim(), id: record.id });
            }
        }
    }
    found.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
    return found;
}

/**
 * 批注是用户自己写的字，可能带着真名：按本卡实际命中的替换（mappings 只含真的执行了的）换掉；
 * 自动名字开着时再补上自动规则（{{user}}→user、角色→char），批注里提到而正文没出现的名字也换掉。
 * 批注不经过正则前原文，所以只做字面替换；屏蔽词之后会在整张卡上统一遮盖。
 */
export function scrubNote(note, handle, mappings, { autoNames = true } = {}) {
    const pairs = [];
    const add = (from, to) => { if (from && !pairs.some(pair => pair.from === from)) pairs.push({ from, to }); };
    for (const item of mappings) if (item.to?.kind === 'text') add(item.from, item.to.value);
    if (autoNames) for (const rule of automaticNameRules({ userName: handle.header.userName, characterName: handle.header.characterName, isGroup: handle.isGroup })) add(rule.from, rule.to.value);
    if (!pairs.length) return note;
    return replaceLiteralNames(note, pairs);
}
