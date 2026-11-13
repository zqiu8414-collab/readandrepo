// ST Reader — AGPL-3.0
// 合成选段验证：使用午后伦敦的 Markdown 排除条件，不读取真实聊天或字体。
import { buildPieces, createPieceCache } from './cardPieces.js?v=0.3.1-self.6';
import { createCardSnapshot, finishCardSnapshot } from '../core/cardSnapshot.js?v=0.3.1-self.6';
import { exportCard } from '../core/cardExport.js?v=0.3.1-self.6';

export async function testCardExcerptsBrowser() {
    const results = [];
    const assert = (ok, name) => { if (!ok) throw new Error(name); results.push({ name, passed: true }); };
    const root = document.createElement('div'); root.id = 'stcr_root';
    const chat = document.createElement('div'); chat.id = 'stcr_chat'; root.append(chat);
    const style = document.createElement('style');
    const plain = ':not([class]):not([style]):not([color]):not(.mes_text [class] *):not(.mes_text [style] *):not(.mes_text [color] *)';
    style.textContent = `#stcr_chat .mes_text q${plain}{color:#5c402b;background:#a88e5830;border-bottom:1px solid #92734466;padding:.08em .24em;border-radius:3px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
        #stcr_chat .mes_text > blockquote${plain}{border-left:3px solid #77805d;padding:12px 18px}
        #stcr_chat .mes_text > h2${plain}{color:rgb(70,88,58)}
        .stcr-excerpt-test-card{background:white;color:black;width:600px;padding:20px;box-sizing:border-box;font:20px/1.7 serif}`;
    document.head.append(style); document.body.append(root);
    const source = document.createElement('div');
    source.innerHTML = '<span class="name_text">合成角色</span><div class="mes_text"><p><q>“第一段对话。”</q></p><p>这段不能出现在卡片里</p><p><q>“第二段对话。”</q></p><h2>合成标题</h2><blockquote>合成引用</blockquote></div>';
    const body = source.querySelector('.mes_text'), text = body.textContent;
    const pick = value => ({ start: text.indexOf(value), end: text.indexOf(value) + value.length });
    const values = ['“第一段对话。”', '“第二段对话。”', '合成标题', '合成引用'];
    const handle = { getMessage: () => ({ name: '合成角色', isUser: false, isSystem: false }) };
    const cache = createPieceCache();
    cache.cards.set('0:0:00', { element: source, mappings: [] }); cache.texts.set('0:0:body', text);
    async function make(ranges) {
        const built = await buildPieces(handle, [{ index: 0, swipe: 0, body: ranges }], { autoReplaceNames: false, applyReplaceRules: false }, cache);
        const card = document.createElement('div'); card.className = 'stcr-excerpt-test-card';
        const content = document.createElement('div'); content.className = 'mes_text';
        content.append(built.pieces[0].body); card.append(content); chat.append(card);
        return card;
    }
    let snapshot;
    try {
        const single = await make(pick(values[0]));
        const multi = await make(values.map(pick));
        const reference = getComputedStyle(single.querySelector('q')).backgroundColor;
        assert(reference !== 'rgba(0, 0, 0, 0)', '单段命中午后伦敦的引号底色');
        assert([...multi.querySelectorAll('q')].every(q => getComputedStyle(q).backgroundColor === reference), '多段与单段引号底色相同');
        assert(multi.textContent === values.join(''), '只包含选中文字，间隔原文未混入');
        assert(multi.querySelectorAll('.mes_text > p').length === 2, '选段段落仍是正文直接子级');
        assert(getComputedStyle(multi.querySelector('blockquote')).borderLeftWidth === '3px', '直接子级引用的美化保留');
        assert(getComputedStyle(multi.querySelector('h2')).color === 'rgb(70, 88, 58)', '直接子级标题的美化保留');
        // 旧结构确实会触发主题的排除规则，确保样本能够检测这次回归。
        const old = document.createElement('div'); old.className = 'stcr-card-excerpt';
        const paragraph = multi.querySelector('p'); paragraph.replaceWith(old); old.append(paragraph);
        assert(getComputedStyle(old.querySelector('q')).backgroundColor !== reference, '旧包裹层复现引号底色丢失');
        old.replaceWith(paragraph);
        snapshot = await createCardSnapshot(multi, '', { width: 600 });
        await finishCardSnapshot(snapshot, { scale: 1 });
        assert([...snapshot.copy.querySelectorAll('q')].every(q => snapshot.doc.defaultView.getComputedStyle(q).backgroundColor === reference), '导出副本保留多段引号底色');
        const blob = await exportCard(multi, { width: 600, scale: 1, replaceNames: false, rules: [], assets: [], maskWords: [] });
        assert(blob.type === 'image/png' && blob.size > 0, '多段卡片可生成 PNG');
        return results;
    } finally { snapshot?.destroy(); root.remove(); style.remove(); }
}
