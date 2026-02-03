const pty = require('node-pty');
const os = require('os');

const shell = '/bin/zsh';
console.log(`Testing spawn of ${shell}`);

try {
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: process.cwd(),
        env: process.env
    });

    console.log('Spawn success!');
    ptyProcess.on('data', function(data) {
        console.log('Data:', data);
        process.exit(0);
    });
    
    ptyProcess.write('ls\r');
} catch (e) {
    console.error('Spawn failed:', e);
}
