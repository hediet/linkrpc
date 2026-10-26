import { describe, expect, it } from 'vitest';
import { classifyServiceChange, parseDaemonConfigText, setCallLogLevelInText, setServiceEnabledInText, stableKey } from './config';

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
              "tty": false,
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
            endpoint: change({ command: undefined, endpoint: 'unix:/tmp/hub.sock' }),
        }).toMatchInlineSnapshot(`
          {
            "command": "restart",
            "enabled": "inPlace",
            "endpoint": "restart",
            "env": "restart",
            "restartPolicy": "inPlace",
            "rpc": "restart",
            "same": "none",
          }
        `);
    });

    it('accepts endpoint services and rejects process settings on them', () => {
        const parse = (service: object) => parseDaemonConfigText(JSON.stringify({ hubServiceId: 'mac', services: { vm: service } })).services.vm;
        expect(parse({ endpoint: 'cmd-stdio:?argv=ssh&argv=vm&argv=bridge', serviceId: 'mac/vm-1', managedIdentity: false }))
            .toMatchObject({ endpoint: 'cmd-stdio:?argv=ssh&argv=vm&argv=bridge', serviceId: 'mac/vm-1', managedIdentity: false });
        expect(() => parse({})).toThrow('set exactly one of "command" and "endpoint"');
        expect(() => parse({ command: ['x'], endpoint: 'unix:/a' })).toThrow('set exactly one of "command" and "endpoint"');
        expect(() => parse({ endpoint: 'unix:/a', env: { A: '1' }, tty: true }))
            .toThrow('"env", "tty" only apply to "command" services');
    });

    it('toggles enabled with a minimal edit that keeps comments', () => {
        const text = '{\n    // my services\n    "services": {\n        "a": { "command": ["x"] }\n    }\n}\n';
        const disabled = setServiceEnabledInText(text, 'a', false);
        expect(disabled).toContain('// my services');
        expect(parseDaemonConfigText(disabled).services.a!.enabled).toBe(false);
        expect(setServiceEnabledInText(disabled, 'a', true)).not.toContain('enabled');
        expect(() => setServiceEnabledInText(text, 'missing', false)).toThrow(`unknown service 'missing'`);
    });

    it('defaults the call log to off with truncated, redacted payloads', () => {
        expect(parseDaemonConfigText('{}').callLog).toMatchInlineSnapshot(`
          {
            "level": "off",
            "payloads": {
              "maxArrayItems": 50,
              "maxDepth": 8,
              "maxStringLength": 256,
              "mode": "truncated",
              "redactKeys": [
                "password",
                "passwd",
                "secret",
                "token",
                "apikey",
                "privatekey",
                "authorization",
                "cookie",
                "credential",
              ],
            },
            "rotation": {
              "maxAgeDays": 14,
              "maxFileSizeMb": 10,
              "maxFiles": 20,
            },
          }
        `);
        expect(parseDaemonConfigText('{ "callLog": { "level": "debug", "payloads": { "mode": "full", "redactKeys": [] } } }').callLog)
            .toMatchObject({ level: 'debug', payloads: { mode: 'full', redactKeys: [] } });
        expect(() => parseDaemonConfigText('{ "callLog": { "level": "loud" } }')).toThrow(/level/);
    });

    it('sets the call-log level with a minimal edit; off removes it', () => {
        const text = '{\n    // keep me\n    "services": {}\n}\n';
        const enabled = setCallLogLevelInText(text, 'info');
        expect(enabled).toMatchInlineSnapshot(`
          "{
              // keep me
              "services": {},
              "callLog": {
                  "level": "info"
              }
          }
          "
        `);
        expect(parseDaemonConfigText(enabled).callLog.level).toBe('info');
        expect(setCallLogLevelInText(enabled, 'off')).toBe(text);
        const tuned = setCallLogLevelInText('{ "callLog": { "level": "debug", "payloads": { "mode": "none" } } }', 'off');
        expect(parseDaemonConfigText(tuned).callLog).toMatchObject({ level: 'off', payloads: { mode: 'none' } });
    });
});
