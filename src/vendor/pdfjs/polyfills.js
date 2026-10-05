// Small polyfills for the APIs pdf.js's modern build calls that Chrome 116
// (the manifest's minimum) does not have yet. Written here, in plain code,
// rather than shipping the legacy build, whose bundled core-js polyfills
// were flagged by the Chrome Web Store as obfuscated. Loaded before pdf.js
// both in the offscreen document and in the pdf.js worker.

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof Promise.try !== 'function') {
  Promise.try = function tryCall(callback, ...args) {
    return new Promise((resolve) => resolve(callback(...args)));
  };
}

if (typeof Math.sumPrecise !== 'function') {
  // pdf.js only sums arrays of lengths and sizes; a plain sum is exact for those.
  Math.sumPrecise = function sumPrecise(values) {
    let total = 0;
    for (const value of values) total += value;
    return total;
  };
}

for (const Collection of [Map, WeakMap]) {
  const proto = Collection.prototype;
  if (typeof proto.getOrInsert !== 'function') {
    proto.getOrInsert = function getOrInsert(key, value) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    };
  }
  if (typeof proto.getOrInsertComputed !== 'function') {
    proto.getOrInsertComputed = function getOrInsertComputed(key, callback) {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key);
    };
  }
}

if (typeof URL.parse !== 'function') {
  URL.parse = function parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

if (typeof Set.prototype.intersection !== 'function') {
  Set.prototype.intersection = function intersection(other) {
    const result = new Set();
    for (const value of this) {
      if (other.has(value)) result.add(value);
    }
    return result;
  };
}
