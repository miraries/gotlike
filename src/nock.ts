import {Url} from 'node:url';
import {MockAgent, setGlobalDispatcher} from 'undici';

const mockAgent = new MockAgent();

if (process.env.NOCK_OFF !== 'true') {
  setGlobalDispatcher(mockAgent);
}

type Options = {
  reqheaders?: Record<string, string | RegExp | { (fieldValue: string): boolean }>
}

function nock(basePath: string | RegExp | Url | URL) {
  let mockPool;

  if (typeof basePath === 'string') {
    mockPool = mockAgent.get(basePath)
  } else if (basePath instanceof RegExp) {
    mockPool = mockAgent.get(basePath)
  } else if (basePath instanceof URL) {
    mockPool = mockAgent.get(basePath.origin)
  } else {
    mockPool = mockAgent.get(basePath.protocol + '//' + basePath.host)
  }

  const interceptor = {
    get(path: string, bodyMatcher?: string | RegExp | ((body: string) => boolean), options?: Options) {
      const mocked = mockPool.intercept({
        method: 'GET',
        path,
        body: bodyMatcher,
        headers: options?.reqheaders,
      });

      return Object.assign(interceptor, {reply: mocked.reply.bind(mocked)});
    },
    post(path: string, bodyMatcher?: string | RegExp | ((body: string) => boolean), options?: Options) {
      const mocked = mockPool.intercept({
        method: 'POST',
        path,
        body: bodyMatcher,
        headers: options?.reqheaders,
      });

      return Object.assign(interceptor, {reply: mocked.reply.bind(mocked)});
    },
    delete(path: string, bodyMatcher?: string | RegExp | ((body: string) => boolean), options?: Options) {
      const mocked = mockPool.intercept({
        method: 'DELETE',
        path,
        body: bodyMatcher,
        headers: options?.reqheaders,
      });

      return Object.assign(interceptor, {reply: mocked.reply.bind(mocked)});
    },
    patch(path: string, bodyMatcher?: string | RegExp | ((body: string) => boolean), options?: Options) {
      const mocked = mockPool.intercept({
        method: 'PATCH',
        path,
        body: bodyMatcher,
        headers: options?.reqheaders,
      });

      return Object.assign(interceptor, {reply: mocked.reply.bind(mocked)});
    },
    put(path: string, bodyMatcher?: string | RegExp | ((body: string) => boolean), options?: Options) {
      const mocked = mockPool.intercept({
        method: 'PUT',
        path,
        body: bodyMatcher,
        headers: options?.reqheaders,
      });

      return Object.assign(interceptor, {reply: mocked.reply.bind(mocked)});
    },
    reply(responseCode?: number, body?: string | Record<string, any>, headers?: Record<string, string | string[]>) {
      throw new Error('Cannot reply without interceptor (todo: wrong types)');
    }
  }

  return interceptor;
}

Object.assign(nock, {
  active: true,
  activate() {
    mockAgent.activate()

    this.active = true;
  },
  restore() {
    mockAgent.deactivate()

    this.active = false;
  },
  isActive() {
    return this.active;
  },
  disableNetConnect() {
    mockAgent.disableNetConnect()
  },
  enableNetConnect() {
    mockAgent.enableNetConnect()
  },
  pendingMocks() {
    return mockAgent.pendingInterceptors()
  }
})

export default nock;

export {
  mockAgent
}
