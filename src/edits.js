// Every photo's edit settings, keyed by the photo's path. The photos themselves are never written to.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'edits.json');
let db = {};
try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file() + '.tmp', JSON.stringify(db));
      fs.renameSync(file() + '.tmp', file());
    } catch { /* read-only disk */ }
  }, 300);
}
app.on('before-quit', () => { if (timer) { clearTimeout(timer); try { fs.writeFileSync(file(), JSON.stringify(db)); } catch {} } });

module.exports = {
  get: (p) => (db[p] ? db[p].s : null),
  set(p, s) {
    if (s) db[p] = { s, t: Date.now() }; else delete db[p];
    save();
  },
};
