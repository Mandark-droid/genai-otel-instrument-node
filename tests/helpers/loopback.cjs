/**
 * Preloaded (`node --require`) into the example processes: the vendors' own
 * host names resolve to this machine, so a client pointed at
 * `http://openrouter.ai:<port>` reaches the mock provider. Nothing else is
 * touched.
 */
'use strict';
const dns = require('node:dns');

const HOSTS = ['openrouter.ai', 'api.cometapi.com', 'api.hyperbolic.xyz', 'api.sambanova.ai'];
const original = dns.lookup;

dns.lookup = function lookup(hostname, options, callback) {
  if (typeof hostname === 'string' && HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    const done = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options !== null && options.all;
    process.nextTick(() => (all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)));
    return {};
  }
  return original.apply(this, arguments);
};
