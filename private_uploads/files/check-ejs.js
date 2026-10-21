'use strict';
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const root = path.join(__dirname, '..');
const failures = [];
let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'private_uploads') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.ejs')) {
      count++;
      try { ejs.compile(fs.readFileSync(full, 'utf8'), { filename: full }); }
      catch (e) { failures.push(`${path.relative(root, full)}: ${e.message}`); }
    }
  }
}
walk(path.join(root, 'views'));
if (failures.length) {
  console.error(`EJS compile failed: ${failures.length}/${count}`);
  failures.forEach(x => console.error(` - ${x}`));
  process.exit(1);
}
console.log(`EJS compile OK: ${count} templates`);
