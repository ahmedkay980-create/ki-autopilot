'use strict';
// JSON-Speicher mit atomarem Schreiben (erst .tmp, dann umbenennen) und täglicher Sicherung.
const fs = require('node:fs');
const path = require('node:path');
const { isoDate } = require('./util');

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this.load();
  }

  load() {
    const base = structuredClone(this.defaults);
    if (!fs.existsSync(this.file)) return base;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Object.assign(base, raw);
    } catch (e) {
      // Kaputte Datei nicht überschreiben, sondern beiseitelegen.
      const broken = this.file + '.defekt-' + Date.now();
      fs.copyFileSync(this.file, broken);
      console.error('[store] Datei war beschädigt, gesichert als', broken);
      return base;
    }
  }

  get() { return this.data; }

  update(fn) {
    const result = fn(this.data);
    this.scheduleSave();
    return result;
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 150);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
    this.backup();
  }

  backup() {
    const dir = path.join(path.dirname(this.file), 'sicherungen');
    const target = path.join(dir, path.basename(this.file, '.json') + '-' + isoDate(new Date()) + '.json');
    if (fs.existsSync(target)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(this.file, target);
    // Nur die letzten 14 Sicherungen behalten.
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(this.file, '.json') + '-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(dir, f));
  }
}

module.exports = { Store };
