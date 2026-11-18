const { Worker } = require('node:worker_threads');
const path = require('node:path');

class HistoryCache {
  constructor(directory) {
    this.worker = new Worker(path.join(__dirname, 'history-cache-worker.cjs'), {
      workerData: { directory },
    });
    this.pending = new Map();
    this.next = 0;
    this.worker.on('message', ({ id, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(result);
    });
    this.worker.on('error', (error) => this.failed(error));
    this.worker.on('exit', (code) => {
      this.failed(this.failure ?? new Error(`缓存进程已退出（${code}）。`));
    });
  }

  failed(error) {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(message) {
    if (this.failure) throw this.failure;
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, message });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    try {
      await this.request({ type: 'close' });
    } finally {
      await this.worker.terminate();
    }
  }
}

module.exports = { HistoryCache };
