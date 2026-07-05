const fs = require('fs');
const path = require('path');
const storage = require('./storage');

const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'app.log');

// Ensure log directory exists
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function formatMessage(level, message, meta) {
    const timestamp = new Date().toISOString();
    const metaString = meta ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaString}`;
}

const colors = {
    INFO: '\x1b[32m',   // green
    WARN: '\x1b[33m',   // yellow
    ERROR: '\x1b[31m',  // red
    DEBUG: '\x1b[36m',  // cyan
    RESET: '\x1b[0m'
};

function writeLog(level, message, meta) {
    const uppercaseLevel = level.toUpperCase();
    const rawMsg = formatMessage(uppercaseLevel, message, meta);
    
    // Console log with colors
    const color = colors[uppercaseLevel] || colors.RESET;
    console.log(`${color}${rawMsg}${colors.RESET}`);

    // Append to file
    fs.appendFile(LOG_FILE, rawMsg + '\n', (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });
}

// Sync log file to cloud storage
async function syncLogs() {
    if (!storage.isCloudEnabled()) return;
    try {
        if (fs.existsSync(LOG_FILE)) {
            await storage.uploadFile(LOG_FILE, 'logs/app.log');
            writeLog('INFO', 'Successfully synced local logs to Cloud Storage.');
        }
    } catch (error) {
        writeLog('ERROR', `Failed to sync logs to Cloud Storage: ${error.message}`);
    }
}

// Periodically sync logs to cloud storage every 30 minutes if cloud storage is active
if (storage.isCloudEnabled()) {
    setInterval(syncLogs, 30 * 60 * 1000).unref();
}

module.exports = {
    info: (msg, meta) => writeLog('INFO', msg, meta),
    warn: (msg, meta) => writeLog('WARN', msg, meta),
    error: (msg, meta) => writeLog('ERROR', msg, meta),
    debug: (msg, meta) => writeLog('DEBUG', msg, meta),
    syncLogs
};
