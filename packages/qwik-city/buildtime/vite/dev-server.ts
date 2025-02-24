import type { ViteDevServer, Connect } from 'vite';
import type { ServerResponse } from 'node:http';
import type { RenderToStringResult } from '@builder.io/qwik/server';
import type { BuildContext } from '../types';
import type { RouteModule } from '../../runtime/src/types';
import type { QwikViteDevResponse } from '../../../qwik/src/optimizer/src/plugins/vite';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getRouteMatchPathname,
  loadUserResponse,
} from '../../middleware/request-handler/user-response';
import { getQwikCityEnvData, pageHandler } from '../../middleware/request-handler/page-handler';
import { updateBuildContext } from '../build';
import { endpointHandler } from '../../middleware/request-handler/endpoint-handler';
import {
  errorResponse,
  ErrorResponse,
  notFoundHandler,
} from '../../middleware/request-handler/error-handler';
import {
  redirectResponse,
  RedirectResponse,
} from '../../middleware/request-handler/redirect-handler';
import { getExtension, normalizePath } from '../../utils/fs';
import { getPathParams } from '../../runtime/src/routing';
import { fromNodeHttp } from '../../middleware/node/http';
import { generateCodeFrame } from '../../../qwik/src/optimizer/src/plugins/vite-utils';

export function ssrDevMiddleware(ctx: BuildContext, server: ViteDevServer) {
  const matchRouteRequest = (pathname: string) => {
    for (const route of ctx.routes) {
      const match = route.pattern.exec(pathname);
      if (match) {
        return {
          route,
          params: getPathParams(route.paramNames, match),
        };
      }
    }

    if (ctx.opts.trailingSlash && !pathname.endsWith('/')) {
      const pathnameWithSlash = pathname + '/';
      for (const route of ctx.routes) {
        const match = route.pattern.exec(pathnameWithSlash);
        if (match) {
          return {
            route,
            params: getPathParams(route.paramNames, match),
          };
        }
      }
    }

    return null;
  };

  return async (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    try {
      const url = new URL(req.originalUrl!, `http://${req.headers.host}`);
      const requestHeaders: Record<string, string> = req.headers as any;

      if (skipRequest(url.pathname) || isVitePing(url.pathname, req.headers)) {
        next();
        return;
      }

      const requestCtx = fromNodeHttp(url, req, res, 'dev');

      await updateBuildContext(ctx);

      for (const d of ctx.diagnostics) {
        if (d.type === 'error') {
          console.error(d.message);
        } else {
          console.warn(d.message);
        }
      }

      const matchPathname = getRouteMatchPathname(url.pathname, ctx.opts.trailingSlash);
      const routeResult = matchRouteRequest(matchPathname);
      if (routeResult) {
        // found a matching route
        const { route, params } = routeResult;

        // use vite to dynamically load each layout/page module in this route's hierarchy
        const routeModulePaths = new WeakMap<RouteModule, string>();
        const routeModules: RouteModule[] = [];
        for (const layout of route.layouts) {
          const layoutModule = await server.ssrLoadModule(layout.filePath, {
            fixStacktrace: true,
          });
          routeModules.push(layoutModule);
          routeModulePaths.set(layoutModule, layout.filePath);
        }
        const endpointModule = await server.ssrLoadModule(route.filePath, {
          fixStacktrace: true,
        });
        routeModules.push(endpointModule);
        routeModulePaths.set(endpointModule, route.filePath);

        try {
          const userResponse = await loadUserResponse(
            requestCtx,
            params,
            routeModules,
            ctx.opts.trailingSlash,
            ctx.opts.basePathname
          );

          if (userResponse.type === 'pagedata') {
            // dev server endpoint handler
            await pageHandler(requestCtx, userResponse, noopDevRender);
            return;
          }

          if (userResponse.type === 'endpoint') {
            // dev server endpoint handler
            await endpointHandler(requestCtx, userResponse);
            return;
          }

          // qwik city vite plugin should handle dev ssr rendering
          // but add the qwik city user context to the response object
          const envData = getQwikCityEnvData(
            requestHeaders,
            userResponse,
            requestCtx.locale,
            'dev'
          );
          if (ctx.isDevServerClientOnly) {
            // because we stringify this content for the client only
            // dev server, there's some potential stringify issues
            // client only dev server will re-fetch anyways, so reset
            envData.qwikcity.response.body = undefined;
          }

          (res as QwikViteDevResponse)._qwikEnvData = {
            ...(res as QwikViteDevResponse)._qwikEnvData,
            ...envData,
          };

          // update node response with status and headers
          // but do not end() it, call next() so qwik plugin handles rendering
          res.statusCode = userResponse.status;
          userResponse.headers.forEach((value, key) => res.setHeader(key, value));
          const cookies = userResponse.cookie.headers();
          if (cookies.length > 0) {
            res.setHeader('Set-Cookie', cookies);
          }
          next();
          return;
        } catch (e: any) {
          if (e instanceof RedirectResponse) {
            redirectResponse(requestCtx, e);
          } else if (e instanceof ErrorResponse) {
            errorResponse(requestCtx, e);
          } else if (e instanceof Error && (e as any).id === 'DEV_SERIALIZE') {
            next(formatDevSerializeError(e, routeModulePaths));
          } else {
            next(e);
          }
          return;
        }
      } else {
        // no matching route

        // test if this is a dev service-worker.js request
        for (const sw of ctx.serviceWorkers) {
          const match = sw.pattern.exec(requestCtx.url.pathname);
          if (match) {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(DEV_SERVICE_WORKER);
            return;
          }
        }
      }

      // simple test if it's a static file
      const ext = getExtension(requestCtx.url.pathname);
      if (STATIC_CONTENT_TYPES[ext]) {
        // let the static asset middleware handle this
        next();
        return;
      }

      if (req.headers.accept && req.headers.accept.includes('text/html')) {
        /**
         * if no route match, but is html request, fast path to 404
         * otherwise qwik plugin will take over render without envData causing error
         */
        // TODO: after file change, need to manual page refresh to see changes currently
        //       there's two ways handling HMR for page endpoint with error
        // 1. Html response inject `import.meta.hot.accept('./pageEndpoint_FILE_URL', () => { location.reload })`
        // 2. watcher, diff previous & current file content, a bit expensive
        notFoundHandler(requestCtx);
        return;
      }

      next();
    } catch (e) {
      next(e);
    }
  };
}

export function dev404Middleware() {
  return async (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    try {
      const url = new URL(req.originalUrl!, `http://${req.headers.host}`);
      const requestCtx = fromNodeHttp(url, req, res, 'dev');
      await notFoundHandler(requestCtx);
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Static file server for files written directly to the 'dist' dir.
 * Only handles the simplest cases.
 */
export function staticDistMiddleware({ config }: ViteDevServer) {
  const distDirs = new Set(
    ['dist', config.build.outDir, config.publicDir].map((d) =>
      normalizePath(resolve(config.root, d))
    )
  );

  return async (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = new URL(req.originalUrl!, `http://${req.headers.host}`);

    if (skipRequest(url.pathname)) {
      next();
      return;
    }

    const relPath = url.pathname.slice(1);

    const ext = getExtension(relPath);
    const contentType = STATIC_CONTENT_TYPES[ext];
    if (!contentType) {
      next();
      return;
    }

    for (const distDir of distDirs) {
      try {
        const filePath = join(distDir, relPath);
        const s = await fs.promises.stat(filePath);
        if (s.isFile()) {
          res.writeHead(200, {
            'Content-Type': contentType,
            'X-Source-Path': filePath,
          });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      } catch (e) {
        //
      }
    }

    next();
  };
}

async function noopDevRender() {
  const result: RenderToStringResult = {
    html: '',
    timing: {
      render: 0,
      snapshot: 0,
    },
    isStatic: false,
    prefetchResources: [],
    snapshotResult: undefined,
  };
  return result;
}

function formatDevSerializeError(err: any, routeModulePaths: WeakMap<RouteModule, string>) {
  const requestHandler = err.requestHandler;

  if (requestHandler?.name) {
    let errMessage = `Data returned from the ${requestHandler.name}() endpoint must be serializable `;
    errMessage += `so it can also be transferred over the network in an HTTP response. `;
    errMessage += `Please ensure that the data returned from ${requestHandler.name}() is limited to only strings, numbers, booleans, arrays or objects, and does not have any circular references. `;
    errMessage += `Error: ${err.message}`;
    err.message = errMessage;

    const endpointModule = err.endpointModule;
    const filePath = routeModulePaths.get(endpointModule);
    if (filePath) {
      try {
        const code = fs.readFileSync(filePath, 'utf-8');
        err.plugin = 'vite-plugin-eslint';
        err.id = normalizePath(filePath);
        err.loc = {
          file: err.id,
          line: undefined,
          column: undefined,
        };
        err.stack = '';
        const lines = code.split('\n');
        const line = lines.findIndex((line) => line.includes(requestHandler.name));
        if (line > -1) {
          err.loc.line = line + 1;
          err.frame = generateCodeFrame(code, err.loc);
        }
      } catch (e) {
        // nothing
      }
    }
  }
  return err;
}

const FS_PREFIX = `/@fs/`;
const VALID_ID_PREFIX = `/@id/`;
const VITE_PUBLIC_PATH = `/@vite/`;
const internalPrefixes = [FS_PREFIX, VALID_ID_PREFIX, VITE_PUBLIC_PATH];
const InternalPrefixRE = new RegExp(`^(?:${internalPrefixes.join('|')})`);

function skipRequest(pathname: string) {
  if (pathname.startsWith('/@qwik-city-')) {
    return true;
  }
  if (
    pathname.includes('__open-in-editor') ||
    InternalPrefixRE.test(pathname) ||
    pathname.startsWith('/node_modules/')
  ) {
    return true;
  }
  if (pathname.includes('favicon')) {
    return true;
  }
  if (pathname.startsWith('/src/')) {
    const ext = getExtension(pathname);
    if (SKIP_SRC_EXTS[ext]) {
      return true;
    }
  }
  return false;
}

function isVitePing(url: string, headers: Connect.IncomingMessage['headers']) {
  return url === '/' && headers.accept === '*/*' && headers['sec-fetch-mode'] === 'no-cors';
}

const SKIP_SRC_EXTS: { [ext: string]: boolean } = {
  '.tsx': true,
  '.ts': true,
  '.jsx': true,
  '.js': true,
  '.md': true,
  '.mdx': true,
  '.css': true,
  '.scss': true,
  '.sass': true,
};

const STATIC_CONTENT_TYPES: { [ext: string]: string } = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const DEV_SERVICE_WORKER = `/* Qwik City Dev Service Worker */
addEventListener('install', () => self.skipWaiting());
addEventListener('activate', () => self.clients.claim());
`;
