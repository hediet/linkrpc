import { describe, expect, it } from 'vitest';
import { classifyServiceChange, parseDaemonConfigText, setServiceEnabledInText, stableKey } from './config';

describe('daemon config', () => {
    it('applies service defaults and the per-user hub defaults', () => {
        const config = parseDaemonConfigText(`{
            // comments and trailing commas are fine
            "services": { "echo": { "command": ["node", "echo.js"], }, },
        }`);
        expect({ forwardChecking: config.hub.forwardChecking, echo: config.services.echo }).toMatchInlineSnapshot(`
          {
            "echo": {
              "command": [
                "node",
                "echo.js",
              ],
              "enabled": true,
              "env": {},
              "managedIdentity": true,
              "readiness": "connected",
              "restart": "on-failure",
              "rpc": true,
              "serviceId": "hub/echo",
              "startTimeoutMs": 30000,
              "stopTimeoutMs": 5000,
            },
            "forwardChecking": false,
          }
        `);
    });

    it('nests service IDs under the hub service ID by default', () => {
        const config = parseDaemonConfigText(`{ "hubServiceId": "pc", "services": {
            "a": { "command": ["x"] },
            "b": { "command": ["x"], "serviceId": "custom" } } }`);
        expect([config.services.a!.serviceId, config.services.b!.serviceId]).toEqual(['pc/a', 'custom']);
    });

    it('reports syntax errors with their position', () => {
        expect(() => parseDaemonConfigText('{\n  "services": {\n}')).toThrowErrorMatchingInlineSnapshot(
            `[Error: invalid JSON at 3:2: CloseBraceExpected]`,
        );
    });

    it('rejects unknown service fields and duplicate service IDs', () => {
        expect(() => parseDaemonConfigText('{ "services": { "a": { "command": ["x"], "comand": [] } } }'))
            .toThrow(/comand/);
        expect(() => parseDaemonConfigText(`{ "services": {
            "a": { "command": ["x"], "serviceId": "shared" },
            "b": { "command": ["x"], "serviceId": "shared" } } }`))
            .toThrowErrorMatchingInlineSnapshot(`[Error: services 'a' and 'b' both claim serviceId 'shared']`);
    });

    it('ignores editor metadata when comparing hub settings', () => {
        const withSchema = parseDaemonConfigText('{ "$schema": "./config.schema.json" }');
        const without = parseDaemonConfigText('{}');
        expect(stableKey(withSchema.hub)).toBe(stableKey(without.hub));
    });

    it('classifies which service changes need a new process', () => {
        const base = parseDaemonConfigText('{ "services": { "a": { "command": ["x"] } } }').services.a!;
        const change = (patch: object) => classifyServiceChange(base, { ...base, ...patch });
        expect({
            same: change({}),
            enabled: change({ enabled: false }),
            restartPolicy: change({ restart: 'always' }),
            env: change({ env: { A: '1' } }),
            command: change({ command: ['y'] }),
            rpc: change({ rpc: false }),
        }).toMatchInlineSnapshot(`
          {
            "command": "restart",
            "enabled": "inPlace",
            "env": "restart",
            "restartPolicy": "inPlace",
            "rpc": "restart",
            "same": "none",
          }
        `);
    });

    it('toggles enabled with a minimal edit that keeps comments', () => {
        const text = '{\n    // my services\n    "services": {\n        "a": { "command": ["x"] }\n    }\n}\n';
        const disabled = setServiceEnabledInText(text, 'a', false);
        expect(disabled).toContain('// my services');
        expect(parseDaemonConfigText(disabled).services.a!.enabled).toBe(false);
        expect(setServiceEnabledInText(disabled, 'a', true)).not.toContain('enabled');
        expect(() => setServiceEnabledInText(text, 'missing', false)).toThrow(`unknown service 'missing'`);
    });
});
