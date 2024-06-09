import https from 'node:https';
import axios from 'axios';
import Benchmark from 'benchmark';
import nodeFetch from 'node-fetch';
import request from 'request';
import got, {OptionsInit} from 'got';
import {Agent, setGlobalDispatcher} from 'undici';
import gotlikeDefault from '../src/index.js';

// import './server.js';

setGlobalDispatcher(new Agent({
  connect: {
    rejectUnauthorized: false
  }
}));

const gotlike = gotlikeDefault.default;

// Configuration
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
});

const url = new URL('https://127.0.0.1:8080');
const urlString = url.toString();

const gotOptions: OptionsInit & { isStream?: true } = {
  agent: {
    https: httpsAgent,
  },
  https: {
    rejectUnauthorized: false,
  },
  retry: {
    limit: 0,
  },
};

const requestOptions = {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  strictSSL: false,
  agent: httpsAgent,
};

const fetchOptions = {
  agent: httpsAgent,
};

const axiosOptions = {
  url: urlString,
  httpsAgent,
  https: {
    rejectUnauthorized: false,
  },
};

const httpsOptions = {
  https: {
    rejectUnauthorized: false,
  },
  agent: httpsAgent,
};

const suite = new Benchmark.Suite();

// Benchmarking
suite.add('got - promise', {
  defer: true,
  async fn(deferred: { resolve: () => void }) {
    await got(url, gotOptions);
    deferred.resolve();
  },
}).add('got - stream', {
  defer: true,
  async fn(deferred: { resolve: () => void }) {
    got.stream(url, gotOptions).resume().once('end', () => {
      deferred.resolve();
    });
  },
}).add('request - callback', {
  defer: true,
  fn(deferred: { resolve: () => void }) {
    request(urlString, requestOptions, (error: Error) => {
      if (error) {
        throw error;
      }

      deferred.resolve();
    });
  },
}).add('node-fetch - promise', {
  defer: true,
  async fn(deferred: { resolve: () => void }) {
    const response = await nodeFetch(urlString, fetchOptions);
    await response.text();

    deferred.resolve();
  },
}).add('axios - promise', {
  defer: true,
  async fn(deferred: { resolve: () => void }) {
    await axios.request(axiosOptions);

    deferred.resolve();
  },
}).add('native fetch - promise', {
  defer: true,
  async fn(deferred: { resolve: () => void }) {
    await fetch(url);

    deferred.resolve();
  },
}).add('gotlike - promise', {
  defer: true,
  async fn(deferred: { resolve: () => void }) {
    await gotlike.get(url);

    deferred.resolve();
  },
}).on('cycle', (event: Benchmark.Event) => {
  console.log(String(event.target));
}).on('complete', function (this: any) {
  console.log(`Fastest is ${this.filter('fastest').map('name') as string}`);
}).run();
