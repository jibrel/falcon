const supertest = require('supertest');
const FalconServer = require('./');

describe('Falcon Server', () => {
  const config = {
    debug: true,
    port: 4000,
    logLevel: 'error',
    endpoints: {
      'fake-api': {
        package: 'fake-backend-api',
        config: {
          host: 'fake.host.com',
          protocol: 'http'
        }
      }
    },
    session: {
      keys: ['secret']
    }
  };

  it('Should handle an incoming request to a custom API DataSource endpoint', async () => {
    const server = new FalconServer(config);
    await server.initialize();
    const serverCallback = server.app.callback();
    const response = await supertest(serverCallback).get('/api/info');
    expect(response.text).toBe('foo');
  });
});
