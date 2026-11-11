// ST Reader — AGPL-3.0
// readandrepo 修改：2026-11-07，离屏导出完整排版与末段实际像素回归。
import { exportCard } from './cardExport.js?v=0.3.1-self.5';
import { createCardSnapshot } from './cardSnapshot.js?v=0.3.1-self.5';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const markerColor = [12, 220, 90], footerColor = [220, 20, 180];

function bounds(png, color) {
    let count = 0, minY = png.height, maxY = -1;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
        const offset = (y * png.width + x) * 4;
        if (color.every((value, channel) => Math.abs(png.data[offset + channel] - value) <= 2) && png.data[offset + 3] > 250) {
            count++; minY = Math.min(minY, y); maxY = y;
        }
    }
    return { count, minY, maxY };
}

/** 仅用合成内容；直接调用正式 exportCard，不读聊天、不接触持久化存储。 */
export async function testCardLayoutBrowser() {
    assert(!document.getElementById('stcr_root'), '请先关闭阅读器再验证导出排版');
    const results = [], root = document.createElement('div'), sheet = document.createElement('style');
    root.id = 'stcr_root'; root.className = 'stcr-layout-test';
    root.style.cssText = 'position:fixed!important;left:-20000px!important;top:0!important;display:block!important;width:700px!important;height:auto!important;overflow:visible!important;';
    sheet.textContent = `
      #stcr_root.stcr-layout-test { --mainFontFamily:Arial; --SmartThemeBlurTintColor:#ffffff; --SmartThemeChatTintColor:#ffffff; --SmartThemeBodyColor:#111111; }
      #stcr_root.stcr-layout-test * { box-sizing:border-box; font-family:Arial!important; text-shadow:none!important; }
      #stcr_root.stcr-layout-test .stcr-card { font-size:16px; background:white; color:#111; padding:20px; }
      #stcr_root.stcr-layout-test .stcr-card-page { padding:0; border:0; background:none; }
      #stcr_root.stcr-layout-test #stcr_chat { width:100%; max-width:none; padding:0; margin:0; background:none; }
      #stcr_root.stcr-layout-test .mes { display:grid; grid-template-columns:180px minmax(0,1fr); position:relative; width:100%; margin:0 0 12px; padding:20px 22px 43px; border:0; overflow:visible; background:white; }
      #stcr_root.stcr-layout-test .mes::before { content:none; }
      #stcr_root.stcr-layout-test .mes::after { content:'LONDON · A QUIET AFTERNOON'; position:absolute; bottom:15px; left:50px; right:50px; height:12px; font:8px/12px Arial; text-align:center; background:rgb(${footerColor}); color:#111; }
      #stcr_root.stcr-layout-test .mes_block { display:contents; }
      #stcr_root.stcr-layout-test .mes_text { grid-column:1/-1; width:100%; padding:0; margin:0; font:16px/24px Arial; overflow:visible; }
      #stcr_root.stcr-layout-test p { margin:0 0 12px; padding:0; line-height:24px; }
      #stcr_root.stcr-layout-test .stcr-test-last { height:12px; background:rgb(${markerColor}); }
      #stcr_root.stcr-layout-test .stcr-card-foot { display:block; height:18px; margin:12px 0 0; padding:0; border:0; font:12px/18px Arial; }
    `;
    document.head.append(sheet); document.body.append(root);
    try {
        for (const spec of [
            { name: '长文与底部装饰', width: 600, paragraphs: 40, floors: 1 },
            { name: '短卡片', width: 600, paragraphs: 2, floors: 1 },
            { name: '窄卡片跨两楼', width: 390, paragraphs: 16, floors: 2 },
            { name: '单楼导出合同', width: 600, paragraphs: 40, floors: 1, single: true },
        ]) {
            const chat = document.createElement('div'); chat.id = 'stcr_chat'; chat.className = 'stcr-card-chat';
            const messages = [];
            for (let i = 0; i < spec.floors; i++) {
                const mes = document.createElement('div'); mes.className = spec.single ? 'mes stcr-mes' : 'mes stcr-card-mes';
                mes.setAttribute('is_user', 'false'); mes.setAttribute('is_system', 'false');
                mes.innerHTML = '<div class="mes_block"><div class="mes_text">' + Array.from({ length: spec.paragraphs }, (_, n) =>
                    `<p>第 ${n + 1} 段：午后伦敦的合成测试文字。长文应完整排版，最后一段与底部装饰都必须保留。</p>`).join('')
                    + '<div class="stcr-test-last"></div></div></div>';
                chat.append(mes); messages.push(mes);
            }
            const card = document.createElement('div'); card.className = 'stcr-card stcr-card--theme';
            card.style.cssText = `--stcr-card-w:${spec.width}px;--stcr-card-h:675px;`;
            const page = document.createElement('div'); page.className = 'stcr-card-page'; page.append(chat);
            const foot = document.createElement('div'); foot.className = 'stcr-card-foot'; foot.textContent = 'ST Reader'; page.append(foot);
            card.append(page); root.append(spec.single ? chat : card);
            const source = spec.single ? messages[0] : card;
            if (spec.single) chat.style.width = `${spec.width}px`;
            try {
                // 先按完整预览取得参考尺寸，再恢复源声明，模拟预览已经看全、导出副本尚未排版。
                messages.forEach(mes => mes.style.setProperty('content-visibility', 'visible', 'important'));
                await settle();
                const rect = source.getBoundingClientRect(), expectedHeight = Math.ceil(Math.max(rect.height, source.scrollHeight));
                const last = source.querySelectorAll('.stcr-test-last');
                const expectedLastTop = last[last.length - 1].getBoundingClientRect().top - rect.top;
                messages.forEach(mes => { mes.style.removeProperty('content-visibility'); mes.removeAttribute('style'); });
                await settle();
                const original = source.outerHTML;
                const pngBlob = await exportCard(source, { replaceNames: false, rules: [], assets: [], maskWords: [], width: spec.width, scale: 1 });
                const bitmap = await createImageBitmap(pngBlob), canvas = document.createElement('canvas');
                canvas.width = bitmap.width; canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
                const png = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const marker = bounds(png, markerColor), footer = bounds(png, footerColor);
                assert(marker.count > 100 && marker.maxY >= expectedLastTop + 8, `${spec.name} PNG 最后一段被截断`);
                assert(footer.count > 100 && footer.maxY > marker.maxY + 10, `${spec.name} 尾标未在正文之后`);
                assert(canvas.width === spec.width && Math.abs(canvas.height - expectedHeight) <= 1,
                    `${spec.name} 尺寸不符：${canvas.width}×${canvas.height}，预览 ${spec.width}×${expectedHeight}`);
                assert(source.outerHTML === original, `${spec.name} 导出修改了预览 DOM`);
                assert(!document.querySelector('[data-stcr-export-frame]'), '导出隔离文档未清理');
                results.push({ name: `readandrepo ${spec.name}完整 PNG`, passed: true, width: canvas.width, height: canvas.height, lastRow: marker.maxY });
            } finally { root.replaceChildren(); }
        }
        const hidden = document.createElement('div'); hidden.className = 'mes';
        hidden.style.cssText = 'content-visibility:hidden;height:100px;width:600px;';
        hidden.textContent = '明确隐藏的内容不能因为导出完整排版而重新显示'; root.append(hidden);
        const original = hidden.outerHTML;
        const isolated = await createCardSnapshot(hidden, '', { width: 600 });
        try {
            assert(isolated.doc.defaultView.getComputedStyle(isolated.copy).contentVisibility === 'hidden', '导出揭示了明确隐藏的内容');
            assert(hidden.outerHTML === original, '导出改变了隐藏源节点');
            results.push({ name: 'readandrepo 保留明确隐藏的内容', passed: true });
        } finally { isolated.destroy(); }
    } finally { root.remove(); sheet.remove(); }
    return results;
}
