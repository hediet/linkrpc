import { createInterface } from 'node:readline';

let count = 0;
console.log('Commands: count, reset, echo <text>, quit');
const timer = setInterval(() => console.log(`tick ${++count}`), 1000);
const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', line => {
    const command = line.trim();
    if (command === 'count') {
        console.log(`count ${count}`);
    } else if (command === 'reset') {
        count = 0;
        console.log('reset 0');
    } else if (command.startsWith('echo ')) {
        console.log(`[${count}] ${command.slice(5)}`);
    } else if (command === 'quit') {
        console.log(`bye ${count}`);
        clearInterval(timer);
        input.close();
        process.stdin.destroy();
    } else {
        console.error(`Unknown command: ${command}. Use count, reset, echo <text>, or quit.`);
    }
});
