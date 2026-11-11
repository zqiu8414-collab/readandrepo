// ST Reader — AGPL-3.0
// 两个入口：魔杖菜单「阅读器」、斜杠命令 /reader。

import { openReader } from './reader.js?v=0.3.1-self.5';

const TABS = { recent: 'recent', owners: 'owners', characters: 'owners', favorites: 'favorites', current: 'current' };

function open(options) {
    openReader(options).catch(error => {
        console.error('[st-reader] 阅读器打开失败：', error);
        globalThis.toastr?.error?.(String(error?.message ?? error), '阅读器打开失败');
    });
}

function mountWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('stcr_wand_item')) return;
    const item = document.createElement('div');
    item.id = 'stcr_wand_item';
    item.className = 'list-group-item flex-container flexGap5';
    item.title = '像读小说一样读聊天记录（只读）';
    item.innerHTML = '<div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>阅读器</span>';
    item.addEventListener('click', () => open());
    menu.append(item);
}

function registerSlashCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = SillyTavern.getContext();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'reader',
        callback: (_args, value) => {
            const tab = TABS[String(value ?? '').trim().toLowerCase()];
            open(tab ? { tab } : {});
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: '可选：recent（最近）/ owners（按角色）/ favorites（收藏的聊天）/ current（当前）',
            typeList: [ARGUMENT_TYPE.STRING], isRequired: false, enumList: ['recent', 'owners', 'favorites', 'current'],
        })],
        helpString: '打开阅读器（只读，不会修改聊天）。例：<code>/reader</code>、<code>/reader recent</code>',
    }));
}

export function mountEntries() {
    mountWandItem();
    try { registerSlashCommand(); } catch (error) { console.error('[st-reader] /reader 命令注册失败：', error); }
}
