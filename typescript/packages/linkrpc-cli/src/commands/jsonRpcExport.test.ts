import { describe, expect, it } from 'vitest';
import { JsonRpcExportRoutes } from './jsonRpcExport';

describe('JSON-RPC export route arguments', () => {
    it('keeps ordered pairs and accepts paths with and without a slash', () => {
        const routes = new JsonRpcExportRoutes();
        routes.serviceId('foo');
        routes.path('foo');
        routes.serviceId('bar');
        routes.path('/bar');
        expect(routes.getRoutes()).toMatchInlineSnapshot(`
          [
            {
              "path": "/foo",
              "serviceId": "foo",
            },
            {
              "path": "/bar",
              "serviceId": "bar",
            },
          ]
        `);
    });

    it('rejects a path without a service', () => {
        expect(() => new JsonRpcExportRoutes().path('/foo')).toThrow('--path must follow --serviceId');
    });

    it('rejects both an unfinished pair and a second service without a path', () => {
        const routes = new JsonRpcExportRoutes();
        routes.serviceId('foo');
        expect(() => routes.getRoutes()).toThrow('Each --serviceId must be followed by --path');
        expect(() => routes.serviceId('bar')).toThrow('Each --serviceId must be followed by --path');
    });
});
