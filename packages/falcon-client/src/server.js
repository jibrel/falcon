import fetch from 'isomorphic-unfetch';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import Koa from 'koa';
import serve from 'koa-static';
import helmet from 'koa-helmet';
import Router from 'koa-router';
import { ApolloProvider, renderToStringWithData } from 'react-apollo';
import ClientApp from './clientApp';
import ApolloClient from './service/ApolloClient';
import Html from './components/Html';

// eslint-disable-next-line
const assets = require(process.env.RAZZLE_ASSETS_MANIFEST);

// Polyfill fetch() on the server (used by apollo-client)
global.fetch = fetch;

// Initialize `koa-router` and setup a route listening on `GET /*`
// Logic has been splitted into two chained middleware functions
// @see https://github.com/alexmingoia/koa-router#multiple-middleware
const router = new Router();
router.get(
  '/*',
  async (ctx, next) => {
    const client = new ApolloClient();
    const context = {};

    const AppComponent = (
      <ApolloProvider client={client}>
        <StaticRouter context={context} location={ctx.url}>
          {ClientApp.component}
        </StaticRouter>
      </ApolloProvider>
    );

    ctx.state.client = client;
    ctx.state.markup = await renderToStringWithData(AppComponent);

    return context.url ? ctx.redirect(context.url) : next();
  },
  ctx => {
    const { usePwaManifest, gtmCode } = ClientApp.config;
    const htmlDocument = renderToString(
      <Html
        assets={assets}
        store={ctx.state.client.extract()}
        content={ctx.state.markup}
        usePwaManifest={usePwaManifest}
        gtmCode={gtmCode}
      />
    );

    ctx.status = 200;
    ctx.body = `<!doctype html>${htmlDocument}`;
  }
);

// Intialize and configure Koa application
const server = new Koa();
ClientApp.onServerCreated(server);

server
  // `koa-helmet` provides security headers to help prevent common, well known attacks
  // @see https://helmetjs.github.io/
  .use(helmet())
  // Serve static files located under `process.env.RAZZLE_PUBLIC_DIR`
  .use(serve(process.env.RAZZLE_PUBLIC_DIR))
  .use(router.routes())
  .use(router.allowedMethods());

ClientApp.onServerInitialized(server);

export default server;
