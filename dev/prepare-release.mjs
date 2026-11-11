// ST Reader — AGPL-3.0
// 发布前统一全部运行模块的资源版本。只用 Node 内置模块，不打包、不安装依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), check = args.includes('--check'), list = args.includes('--list');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('manifest.version 格式不正确');
function scan(dir) {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
        const file = `${dir}/${entry.name}`;
        return entry.isDirectory() ? scan(file) : file.endsWith('.js') ? [file] : [];
    });
}
const files = ['index.js', ...scan('src')].sort();
const modules = new Set(files);
const changed = [];
function save(file, value) {
    const target = path.join(root, file), old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (old === value) return;
    changed.push(file);
    if (!check && !list) fs.writeFileSync(target, value, 'utf8');
}
// 同时覆盖静态 import/export from 和字符串形式的动态 import；不改宿主的绝对导入或 vendor。
const imports = /(\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"\r\n]+\.m?js)(?:\?[^'"\r\n]*)?\2/g;
for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const result = source.replace(imports, (full, prefix, quote, specifier) => {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        // 开发演示用的合成数据不随自用安装发布；这些入口只在独立开发实例运行。
        if (target.startsWith('dev/')) return full;
        if (target.startsWith('../') || !fs.existsSync(path.join(root, target))) throw new Error(`${file} 引用了不存在的模块 ${specifier}`);
        if (!modules.has(target)) return full;
        return `${prefix}${quote}${specifier}?v=${version}${quote}`;
    });
    save(file, result);
}
manifest.js = `index.js?v=${version}`;
manifest.css = `style.css?v=${version}`;
save('manifest.json', JSON.stringify(manifest, null, 4) + '\n');
save('src/core/releaseVersion.js', `// ST Reader — AGPL-3.0\n// 由 dev/prepare-release.mjs 根据 manifest.json 生成；显示当前真正运行的代码版本。\nexport const RELEASE_VERSION = '${version}';\n`);
if (list) console.log(JSON.stringify([...files, 'manifest.json', 'style.css', 'dev/prepare-release.mjs']));
else if (check && changed.length) {
    console.error(`资源版本不一致，请先运行 node dev/prepare-release.mjs：\n${changed.join('\n')}`);
    process.exitCode = 1;
} else console.log(check ? `资源版本检查通过：${version}，${files.length} 个模块。` : `已统一资源版本：${version}，更新 ${changed.length} 个文件。`);
