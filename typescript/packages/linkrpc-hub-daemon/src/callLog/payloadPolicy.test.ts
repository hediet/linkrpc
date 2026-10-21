import { describe, expect, it } from 'vitest';
import { CallLogConfigSchema } from './callLogConfig';
import { payloadBytes, shapePayload } from './payloadPolicy';

const policy = (payloads: object) => CallLogConfigSchema.parse({ payloads }).payloads;

describe('shapePayload', () => {
    const payload = {
        command: 'x'.repeat(10),
        env: { API_KEY: 'k', Path: '/bin' },
        headers: [{ authorization: 'Bearer t' }, { accept: '*/*' }, { a: 1 }],
        nested: { a: { b: { c: 1 } } },
    };

    it('redacts sensitive keys and truncates per property', () => {
        expect(shapePayload(payload, policy({ maxStringLength: 4, maxArrayItems: 2, maxDepth: 3 }))).toMatchInlineSnapshot(`
          {
            "command": "xxxx…(+6 chars)",
            "env": {
              "API_KEY": "[redacted]",
              "Path": "/bin",
            },
            "headers": [
              {
                "authorization": "[redacted]",
              },
              {
                "accept": "*/*",
              },
              "…(+1 items)",
            ],
            "nested": {
              "a": {
                "b": "{…}",
              },
            },
          }
        `);
    });

    it('keeps full payloads, redaction can be turned off, and none records nothing', () => {
        expect(shapePayload(payload, policy({ mode: 'full', redactKeys: [] }))).toEqual(payload);
        expect(shapePayload(payload, policy({ mode: 'none' }))).toBeUndefined();
    });

    it('measures UTF-8 JSON size', () => {
        expect([payloadBytes({ a: 'ä' }), payloadBytes(undefined)]).toEqual([10, undefined]);
    });
});
