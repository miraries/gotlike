'use strict';

// nock's own suite builds its client as `got.extend({retry: 0})` (nock/nock#1523). gotlike does
// not retry unless a client is given a `retry` object, so its default client is the equivalent.
module.exports = require('gotlike').default;
