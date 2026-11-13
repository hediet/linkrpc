import { createSeededMemoryPrincipal, type JsonValue } from '@hediet/linkrpc';
import { describe, expect, it } from 'vitest';
import { loadClaimPrincipal, registerServiceIdAs } from './remoteClaims';

describe('registerServiceIdAs', () => {
    it('signs a registry claim with a capability scoped to exactly that claim', async () => {
        const principal = await createSeededMemoryPrincipal({ seed: 870 });
        const calls: { method: string; params: JsonValue; }[] = [];
        await registerServiceIdAs(async (method, params) => {
            calls.push({ method, params });
            return method === 'hubGrantedServiceId::getHubServiceId' ? { hubServiceId: 'de.hediet' } : {};
        }, 'hediet/tablet', principal);

        const claim = calls[1].params as {
            requestedPrefix: string;
            $hubrpc: { method: string; principal: string; };
            $hubrpcUnsigned: { capabilities: { issuer: string; audience: string; permissions: unknown[]; }[]; };
        };
        expect({
            methods: calls.map(c => c.method),
            requestedPrefix: claim.requestedPrefix,
            signedMethod: claim.$hubrpc.method,
            signedBy: claim.$hubrpc.principal === principal.id,
            capabilities: claim.$hubrpcUnsigned.capabilities.map(c => ({
                selfIssued: c.issuer === principal.id && c.audience === principal.id,
                permissions: c.permissions,
            })),
        }).toMatchInlineSnapshot(`
          {
            "capabilities": [
              {
                "permissions": [
                  {
                    "canInvoke": true,
                    "params": {
                      "requestedPrefix": {
                        "exact": "hediet/tablet",
                      },
                    },
                    "target": {
                      "interfaceId": {
                        "exact": "hubServiceIdRegistry",
                      },
                      "members": [
                        {
                          "exact": "registerServiceId",
                        },
                      ],
                      "serviceId": {
                        "exact": "de.hediet",
                      },
                    },
                  },
                ],
                "selfIssued": true,
              },
            ],
            "methods": [
              "hubGrantedServiceId::getHubServiceId",
              "de.hediet::hubServiceIdRegistry::registerServiceId",
            ],
            "requestedPrefix": "hediet/tablet",
            "signedBy": true,
            "signedMethod": "de.hediet::hubServiceIdRegistry::registerServiceId",
          }
        `);
    });

    it('rejects identities outside the --principal syntax it supports', async () => {
        await expect(loadClaimPrincipal('managed')).rejects.toThrow('expected "user:<id>" or "file:<path>"');
    });
});
