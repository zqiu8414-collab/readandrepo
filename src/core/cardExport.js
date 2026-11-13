// ST Reader — AGPL-3.0
import { domToBlob } from '../../vendor/modern-screenshot.mjs';
import { store } from './store.js?v=0.3.1-self.6';
import { normalizeMaskStyle } from './cardTransforms.js?v=0.3.1-self.6';
import { getCardSource, applyCardParts, renderCardParts, prepareCardAssets, maskTextNodesInPlace } from './cardContent.js?v=0.3.1-self.6';
import { buildCardFontCss } from './cardFonts.js?v=0.3.1-self.6';
import { createCardSnapshot, embedCardImages, finishCardSnapshot, measureCardSnapshot, waitForCardFonts } from './cardSnapshot.js?v=0.3.1-self.6';
import { offlineCaptureGuard } from './offlineCapture.js?v=0.3.1-self.6';
import { waitForExport } from './exportControl.js?v=0.3.1-self.6';

export { createCardMessage, bindCardSource, wrapMaskSpans } from './cardContent.js?v=0.3.1-self.6';
export { replaceNamesInRaw, maskText, automaticNameRules, ruleWords } from './cardTransforms.js?v=0.3.1-self.6';
export { maskCodeText, maskHtmlString } from './codeTransforms.js?v=0.3.1-self.6';

/**
 * 从已连接的预览节点生成 PNG。只在隔离副本重渲染、脱敏，不改输入 DOM。
 * createCardMessage / bindCardSource 提供原始候选；开启名字替换时必须具备此绑定。
 * @param {HTMLElement} rootEl 卡片或单楼预览，可含多楼
 * @param {{maskWords?:string[],replaceNames?:boolean,autoReplaceNames?:boolean,applyReplaceRules?:boolean,maskStyle?:string|object,rules?:object[],assets?:object[],width?:number,scale?:number,signal?:AbortSignal,onWarning?:(message:string)=>void,onProgress?:(progress:object)=>void}} opts
 * @returns {Promise<Blob>} image/png；不会自动下载
 */
export async function exportCard(rootEl, opts = {}) {
    const { signal } = opts;
    signal?.throwIfAborted();
    const scale = opts.scale ?? 2;
    if (!Number.isFinite(scale) || scale < 1 || scale > 3) throw new RangeError('导出倍率须为 1–3');
    if (!rootEl?.querySelectorAll) throw new TypeError('卡片须为 Element');
    const progress = (stage, label) => { signal?.throwIfAborted(); opts.onProgress?.({ stage, label }); };
    progress('prepare', '正在准备卡片');
    const options = { ...opts, replaceNames: opts.replaceNames !== false, maskStyle: normalizeMaskStyle(opts.maskStyle) };
    [options.rules, options.assets, options.maskWords] = await waitForExport(Promise.all([
        options.rules ?? store.replaceRules.list(), options.assets ?? store.assets.list(), options.maskWords ?? store.maskWords.list(),
    ]), { signal, message: '读取卡片设置超时' });
    options.assetMap = await waitForExport(prepareCardAssets(options.assets), { signal, message: '准备卡片素材超时' });
    const sourceElements = [rootEl, ...rootEl.querySelectorAll('*')].filter(element => getCardSource(element));
    if (options.replaceNames && !sourceElements.length) throw new Error('名字替换需要正则前原文；请用 createCardMessage 或 bindCardSource 绑定楼层');
    const snapshot = await createCardSnapshot(rootEl, '', options);
    let captureTask;
    try {
        for (const original of sourceElements) {
            signal?.throwIfAborted();
            const target = snapshot.nodeMap.get(original);
            if (!target) continue;
            const result = await waitForExport(renderCardParts(getCardSource(original), options, snapshot.doc), { signal, message: '卡片正文排版超时' });
            applyCardParts(target, result);
        }
        // 先收集并加载未遮盖副本的字体，让 Range 测到最终字形，亦包含将被完全遮掉的字体。
        progress('fonts', '正在准备字体');
        const font = await buildCardFontCss(snapshot.copy, { signal });
        if (font.fallbacks.length) {
            const message = `以下非 Ny 本地字体没有可嵌入字节，将使用系统回退：${font.fallbacks.join('、')}。需精确字形时请在 Ny 导入并应用本地字体。`;
            console.warn(`[st-reader] ${message}`); opts.onWarning?.(message);
        }
        const fontStyle = snapshot.doc.createElement('style'); fontStyle.textContent = font.cssText; snapshot.doc.head.append(fontStyle);
        await waitForCardFonts(snapshot, { signal });
        maskTextNodesInPlace(snapshot.copy, options.maskWords, options.maskStyle, options.assetMap);
        measureCardSnapshot(snapshot, scale);
        // T73（I052）：美化用到的背景图按 D23 内嵌；拿不到的逐项提示并用占位，不整块丢
        progress('resources', '正在准备图片');
        await embedCardImages(snapshot, { onWarning: message => { console.warn(`[st-reader] ${message}`); opts.onWarning?.(message); }, fetchFn: opts.fetchFn, signal, onProgress: opts.onProgress });
        await finishCardSnapshot(snapshot, { signal, scale });
        progress('render', '正在生成 PNG');
        captureTask = domToBlob(snapshot.copy, {
            type: 'image/png', width: Math.ceil(snapshot.width), height: snapshot.height, scale,
            timeout: 15000, maximumCanvasSize: 32768, workerNumber: 0,
            font: { cssText: font.cssText }, features: { copyScrollbar: false },
            // 只提供内嵌资源；即使依赖尝试补取图片，也绝不回退到 fetch。
            ...offlineCaptureGuard(),
        });
        // 截图库不支持取消。用户可立即关窗/重试，但该任务自己的 iframe 留到截图结束再释放，
        // 避免移除文档破坏在途解码；不同导出各自隔离，绝不移除其他任务的 iframe。
        captureTask.then(() => snapshot.destroy(), () => snapshot.destroy());
        const blob = await waitForExport(captureTask, { signal, timeout: 45000, message: '生成 PNG 超时，请减少选段或使用标准清晰度' });
        signal?.throwIfAborted();
        if (!blob || blob.type !== 'image/png' || !blob.size) throw new Error('浏览器未生成 PNG，请减少选段后重试');
        progress('done', '图片已生成');
        return blob;
    } finally { if (!captureTask) snapshot.destroy(); }
}
