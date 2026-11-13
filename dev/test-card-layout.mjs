// ST Reader — AGPL-3.0
// readandrepo 修改：2026-11-07，只服务本仓库源码和合成页面，无需 ST、依赖安装或真实聊天。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(project, '.tmp');
const chrome = process.env.STCR_TEST_BROWSER || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(file => fs.existsSync(file));
if (!chrome) throw new Error('未找到 Chrome/Edge，请用 STCR_TEST_BROWSER 指定现有浏览器；不自动下载。');
fs.mkdirSync(temporary, { recursive: true });
if (fs.lstatSync(temporary).isSymbolicLink()) throw new Error('.tmp 不能是目录联接');
const profile = fs.mkdtempSync(path.join(temporary, 'card-layout-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><script>window.SillyTavern={getContext:()=>({extensionSettings:{}})};window.testReady=true;</script>';
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end(html); return; }
    const file = path.resolve(project, `.${pathname}`), extension = path.extname(file);
    if (!file.startsWith(project + path.sep) || !['.js', '.mjs', '.css'].includes(extension) || !fs.existsSync(file)) {
        response.writeHead(404).end(); return;
    }
    response.writeHead(200, { 'Content-Type': extension === '.css' ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(response);
});
let browser, socket, serial = 0;
const calls = new Map(), errors = [];
function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => { calls.delete(id); reject(new Error(`${method} 超时`)); }, 60000);
        calls.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
}
try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
        '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--window-size=1280,900',
        `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', chunk => { if (errors.length < 20) errors.push(String(chunk)); });
    const active = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(active); i++) {
        if (i > 100 || browser.exitCode !== null) throw new Error(`浏览器启动失败：${errors.join('')}`);
        await delay(100);
    }
    const port = fs.readFileSync(active, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data), call = calls.get(message.id);
        if (call) { clearTimeout(call.timer); calls.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
    });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: origin });
    for (let i = 0; !(await evaluate('Boolean(window.testReady)')); i++) {
        if (i > 50) throw new Error('合成页面加载超时'); await delay(100);
    }
    const excerpts = process.argv.includes('--excerpts');
    const result = await evaluate(excerpts
        ? `import('/src/ui/cardExcerptsBrowser.test.js').then(module => module.testCardExcerptsBrowser())`
        : `import('/src/core/cardLayoutBrowser.test.js').then(module => module.testCardLayoutBrowser())`);
    console.log(JSON.stringify(result, null, 2));
    console.log(excerpts ? `多段美化回归通过：${result.length} 项，包含隔离副本和 PNG 生成。` : `导出排版回归通过：${result.length} 项，使用真实 PNG 像素验证。`);
} finally {
    for (const call of calls.values()) clearTimeout(call.timer);
    socket?.close();
    if (browser && browser.exitCode === null) {
        browser.kill(); await Promise.race([once(browser, 'exit'), delay(3000)]);
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // 删除前核实绝对路径只能指向本脚本在仓库 .tmp 内刚创建的独立配置目录。
    const resolved = fs.realpathSync(profile), parent = fs.realpathSync(temporary);
    if (!resolved.startsWith(parent + path.sep) || !path.basename(resolved).startsWith('card-layout-')) throw new Error('浏览器临时目录越界，拒绝清理');
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.warn(`浏览器仍占用临时配置，保留 ${resolved}：${error.message}`); }
}
