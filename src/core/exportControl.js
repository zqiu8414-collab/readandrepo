// ST Reader — AGPL-3.0
/** 等待导出步骤；取消只中止等待，不假定底层不可取消的截图已经停止。 */
export function waitForExport(promise, { signal, timeout = 15000, message = '导出准备超时，请重试' } = {}) {
    return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        const finish = (callback, value) => { cleanup(); callback(value); };
        const abort = () => finish(reject, signal.reason ?? new DOMException('导出已取消', 'AbortError'));
        // 先接住底层拒绝；即使用户已经取消，稍后的解码/截图失败也不会成为未处理异常。
        Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        if (timeout > 0) timer = setTimeout(() => finish(reject, new Error(message)), timeout);
    });
}

/** 按最终 PNG 尺寸检查；不交给截图库静默缩小，超限时给出可操作的清晰度建议。 */
export function checkCardDimensions(width, height, scale = 2) {
    if (!Number.isFinite(scale) || scale < 1 || scale > 3) throw new RangeError('导出倍率须为 1–3');
    if (!Number.isFinite(width) || width <= 0 || width > 8192) throw new RangeError('卡片宽度须大于 0 且不超过 8192 像素');
    if (!Number.isFinite(height) || height <= 0 || height > 16384) throw new RangeError('卡片过长（最多 16384 像素），请减少选段或分成多张导出');
    const pixels = Math.ceil(width) * Math.ceil(height) * scale * scale;
    if (pixels > 32_000_000 || Math.ceil(width) * scale > 32768 || Math.ceil(height) * scale > 32768) {
        const standardFits = Math.ceil(width) * Math.ceil(height) <= 32_000_000;
        throw new RangeError(scale > 1 && standardFits
            ? '高清图片过大，请将清晰度改为「标准」后导出，或减少选段'
            : '图片超过 3200 万像素，请减少选段或分成多张导出');
    }
    return pixels;
}
