import { DAEMON_FLAG, runDaemonTrampoline } from './electronLaunch';
import { startTrayApp } from './trayApp';

if (process.argv.includes(DAEMON_FLAG)) {
    runDaemonTrampoline();
} else {
    startTrayApp().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
    });
}
