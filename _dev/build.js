'use strict';
/* 把 core.js / pipeline.js / app.js 内联成一个单文件 HTML */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const out = path.join(dir, '..', '存档编辑器.html');
let html = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');

for (const name of ['items.js', 'core.js', 'pipeline.js', 'app.js']) {
  const code = fs.readFileSync(path.join(dir, name), 'utf8').replace(/<\/script>/gi, '<\\/script>');
  html = html.replace('<!--INCLUDE:' + name + '-->', '<script>\n' + code + '\n</script>');
}
if (html.includes('<!--INCLUDE:')) throw new Error('还有未替换的 include');
fs.writeFileSync(out, html, 'utf8');
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('已生成 ' + out + '  ' + kb + ' KB');
console.log('外部依赖: ' + (/<(script[^>]+src|link[^>]+href="http)/i.test(html) ? '有' : '无（单文件自包含）'));
