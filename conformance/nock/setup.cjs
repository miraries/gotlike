'use strict';

// Replaces nock's tests/setup.js. Theirs resets nock after every test through API the shim does
// not have (`nock.emitter`), and one missing method in an afterEach would fail every test in the
// file. Each step here is tried on its own instead.

const fs = require('fs');
const http = require('http');
const https = require('https');
const nock = require('..');
const chai = require('chai');
const dirtyChai = require('dirty-chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');

chai.use(dirtyChai);
chai.use(sinonChai);

// A test that calls node's http client directly is testing nock's interception of node's http
// stack, which the shim does not have by design - it replaces undici's global dispatcher. The
// runner reports those failures as `node-http` rather than as findings.
const log = process.env.NOCK_CONFORMANCE_HTTP_LOG;
let drove = false;

function recordDirectUse(module, method) {
  const original = module[method];

  module[method] = function (...args) {
    drove = true;
    return original.apply(this, args);
  };
}

for (const module of [http, https]) {
  recordDirectUse(module, 'request');
  recordDirectUse(module, 'get');
}

beforeEach(function () {
  drove = false;
});

afterEach(function () {
  if (drove && log) {
    fs.appendFileSync(log, this.currentTest.fullTitle() + '\n');
  }

  for (const step of [
    () => nock.restore(),
    () => nock.abortPendingRequests(),
    () => nock.cleanAll(),
    () => nock.enableNetConnect(),
    () => nock.emitter.removeAllListeners(),
    // Sinon before nock is reactivated, as nock's own setup notes.
    () => sinon.restore(),
    () => nock.activate(),
  ]) {
    try {
      step();
    } catch {}
  }
});
