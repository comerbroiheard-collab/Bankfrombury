'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A tiny durable JSON store. The whole bank fits in memory; every mutation
 * marks the store dirty and a debounced writer flushes it to disk through a
 * temp file + rename so a crash mid-write can never truncate the ledger.
 */
class Store {
  constructor(file, seed = {}) {
    this.file = file;
    this.seed = seed;
    this.data = this.#load();
    this.dirty = false;
    this.timer = null;
    this.flushDelay = 40;
  }

  #load() {
    if (!this.file) return structuredClone(this.seed);
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...structuredClone(this.seed), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt file is kept aside rather than silently overwritten.
        const quarantine = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, quarantine);
          process.emitWarning(`Unreadable store moved to ${quarantine}: ${err.message}`);
        } catch { /* nothing left to preserve */ }
      }
      return structuredClone(this.seed);
    }
  }

  touch() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  flush() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

module.exports = { Store };
