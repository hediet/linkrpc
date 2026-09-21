// Tiny linkrpc server used by `pnpm cli` smoke tests.
// Runs over stdio and registers a single demo interface + reflection.
import { z } from "zod";
import {
    bareInterfaceTarget,
    defineInterface,
    notificationType,
    requestType,
} from "@hediet/linkrpc";
import { serveOnStdio } from "@hediet/linkrpc/node";

const echoInterface = defineInterface(
    { id: "demo.echo", description: "A trivial demo interface." },
    {
        echo: requestType(
            z.object({ text: z.string() }),
            z.object({ text: z.string() }),
        ),
        ping: notificationType(z.object({})),
    },
);

void (async () => {
    const conn = await serveOnStdio();
    conn.register(bareInterfaceTarget(echoInterface), {
        echo: async ({ text }) => ({ text: text.toUpperCase() }),
        ping: () => { },
    });
    conn.enableReflection();
})();
