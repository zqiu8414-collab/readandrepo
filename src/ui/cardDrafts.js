// ST Reader — AGPL-3.0
// 卡片编辑历史与会话草稿只在内存；不写聊天、浏览器数据库或服务器。
const LIMIT = 3_000_000;
export const copyDrafts = drafts => new Map([...drafts].map(([key, node]) => [key, node.cloneNode(true)]));
export const captureEdits = mine => ({ drafts: copyDrafts(mine.drafts), marks: mine.marks.snapshot() });
export function restoreEdits(mine, state) {
    mine.drafts = copyDrafts(state.drafts);
    mine.marks.restore(state.marks);
}
const sizeOf = state => [...state.drafts.values()].reduce((size, node) => size + node.outerHTML.length, 0)
    + JSON.stringify(state.marks).length;

export function pushEditHistory(list, state) {
    if (sizeOf(state) > LIMIT) { list.length = 0; return false; }
    list.push(state);
    while (list.length > 12 || list.length > 1 && list.reduce((size, item) => size + sizeOf(item), 0) > LIMIT) list.shift();
    return true;
}

/** 原文、候选、选区、替换规则必须逐字相同才恢复，避免误套到改过的聊天。 */
export function cardDraftKey(source, rules, assets) {
    const key = JSON.stringify({ chat: source.handle.chatKey, kind: source.kind, floors: source.floors,
        messages: source.floors.map(floor => {
            const model = source.handle.getMessage(floor.index);
            return [model.name, model.swipes[floor.swipe]];
        }), annotations: source.annotations ?? [], rules, assets });
    return key.length <= LIMIT / 2 ? key : null;
}

export function createCardDraftCache() {
    const entries = new Map();
    function save(key, mine) {
        if (!key) return;
        entries.delete(key);
        const edits = captureEdits(mine);
        if (!edits.drafts.size && !edits.marks.length && !mine.temp.length) return;
        const state = { ...edits, prefs: { ...mine.prefs }, autoNames: mine.autoNames, myRules: mine.myRules,
            includeReasoning: mine.includeReasoning, temp: [...mine.temp], tempStyles: structuredClone(mine.tempStyles),
            exportScale: mine.exportScale };
        const bytes = key.length + sizeOf(edits);
        if (bytes > LIMIT) return;
        entries.set(key, { state, bytes });
        while (entries.size > 5 || [...entries.values()].reduce((sum, item) => sum + item.bytes, 0) > LIMIT) entries.delete(entries.keys().next().value);
    }
    return { save,
        restore(key, mine) {
            const entry = entries.get(key);
            if (!entry) return false;
            entries.delete(key); entries.set(key, entry);
            const { state } = entry;
            restoreEdits(mine, state);
            Object.assign(mine, { prefs: { ...state.prefs }, autoNames: state.autoNames, myRules: state.myRules,
                includeReasoning: state.includeReasoning, temp: [...state.temp], tempStyles: structuredClone(state.tempStyles),
                exportScale: state.exportScale });
            return true;
        },
    };
}
