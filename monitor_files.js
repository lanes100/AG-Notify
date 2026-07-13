const fs = require('fs');
const path = require('path');
const os = require('os');

const watchDir = path.join(os.homedir(), '.gemini', 'antigravity-ide');
const logFile = path.join(os.tmpdir(), 'ag_notify_file_monitor.log');
if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

console.log("Watching directory:", watchDir);

function watchRecursive(dir) {
    try {
        fs.watch(dir, (eventType, filename) => {
            if (filename) {
                const fullPath = path.join(dir, filename);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile()) {
                        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${eventType}: ${fullPath}\n`);
                    }
                } catch(e) {}
            }
        });
        
        // Watch subdirectories
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                if (fs.statSync(fullPath).isDirectory()) {
                    watchRecursive(fullPath);
                }
            } catch(e) {}
        }
    } catch (e) {
        // ignore errors
    }
}

watchRecursive(watchDir);

// keep process alive
setInterval(() => {}, 1000);
