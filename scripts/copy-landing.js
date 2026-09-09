const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.copyFileSync(path.join(root, 'landing', 'index.html'), path.join(root, 'dist', 'index.html'));
console.log('[copy-landing] dist/index.html ready');
