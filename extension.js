const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');

const activeConversations = new Map(); // convoId -> lastPlayedStep
const seenFilesMtime = new Map(); // filePath -> mtimeMs
const pendingCompletions = new Map(); // convoId -> completion timer
const conversationDbUserSteps = new Map(); // dbPath -> latest USER_INPUT idx
const conversationDbCheckTimers = new Map(); // dbPath -> debounce/retry timer
const COMPLETION_SETTLE_MS = 600;
let statusBarItem;
let conversationCheckInterval = null;
let isStartupPhase = true;
let extensionPath = ''; // Store extension directory path dynamically
let extensionContext = null; // Store context reference globally
let fsWatcher = null;
let conversationDbWatcher = null;
let sqliteDatabaseSync;

function activate(context) {
    console.log('AG Chat Notifications extension is now active!');
    
    setupRetries = 0;
    setupTimeoutHandle = null;
    extensionPath = context.extensionPath;
    extensionContext = context;

    createStatusBarItem(context);
    setupPollingWatcher(context);

    // Register commands
    const toggleCmd = vscode.commands.registerCommand('agNotify.toggle', async () => {
        const config = vscode.workspace.getConfiguration('agNotify');
        const enabled = config.get('enabled', true);
        const completeEnabled = config.get('soundOnComplete', true);
        const sendEnabled = config.get('soundOnSend', true);

        const items = [
            {
                label: enabled ? "$(mute) Global Mute" : "$(unmute) Global Unmute",
                description: enabled ? "Mute all sounds temporarily" : "Unmute all sounds",
                action: 'toggle_global'
            },
            {
                label: completeEnabled ? "$(check) Complete Sound: ENABLED" : "$(circle-slash) Complete Sound: DISABLED",
                description: "Toggle sound when agent finishes its final response",
                action: 'toggle_complete'
            },
            {
                label: sendEnabled ? "$(check) Message Sent Sound: ENABLED" : "$(circle-slash) Message Sent Sound: DISABLED",
                description: "Toggle sound when you send a message",
                action: 'toggle_send'
            },
            {
                label: "$(settings-gear) Configure Completion Sound...",
                description: `Change sound file for completed responses`,
                action: 'choose_complete'
            },
            {
                label: "$(settings-gear) Configure Message Sent Sound...",
                description: `Change sound file for sent messages`,
                action: 'choose_send'
            },
            {
                label: "$(play) Play Test Completion Sound",
                description: "Test your currently set completion chime",
                action: 'test_complete'
            },
            {
                label: "$(play) Play Test Message Sent Sound",
                description: "Test your currently set message sent chime",
                action: 'test_send'
            }
        ];

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: "AG Chat Notifications Controls"
        });

        if (!selection) return;

        if (selection.action === 'toggle_global') {
            await config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`AG Chat Notifications notifications globally ${!enabled ? 'ENABLED' : 'DISABLED'}.`);
        } else if (selection.action === 'toggle_complete') {
            await config.update('soundOnComplete', !completeEnabled, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Completion sound alerts ${!completeEnabled ? 'ENABLED' : 'DISABLED'}.`);
        } else if (selection.action === 'toggle_send') {
            await config.update('soundOnSend', !sendEnabled, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Message sent sound alerts ${!sendEnabled ? 'ENABLED' : 'DISABLED'}.`);
        } else if (selection.action === 'test_complete') {
            playSoundDirectly(config.get('soundOnCompleteType', 'notification_pluck.mp3'));
        } else if (selection.action === 'test_send') {
            playSoundDirectly(config.get('soundOnSendType', 'message_chime.mp3'));
        } else if (selection.action === 'choose_complete' || selection.action === 'choose_send') {
            const configKey = selection.action === 'choose_complete' ? 'soundOnCompleteType' : 'soundOnSendType';
            const configLabel = selection.action === 'choose_complete' ? 'Completion' : 'Message Sent';

            const sounds = [
                { label: "⭐ Pluck Chime (Default)", description: "notification_pluck.mp3" },
                { label: "Smooth Stereo Chime", description: "smooth_stereo.mp3" },
                { label: "Completed Task Alert", description: "completed_alert.mp3" },
                { label: "Intro Sound Bell", description: "intro_bell.mp3" },
                { label: "Premium Chime 1", description: "best_notification_1.mp3" },
                { label: "Premium Chime 2", description: "best_notification_2.mp3" },
                { label: "Message Chime", description: "message_chime.mp3" },
                { label: "Elegant Ding", description: "ding.mp3" },
                { label: "Notification Alert", description: "notification_alert.mp3" },
                { label: "Digital Alert", description: "digital_alert.mp3" },
                { label: "Modern Windows 11 Notify", description: "Windows Notify System Generic.wav" },
                { label: "Modern Windows Quiet Note", description: "Windows Information Bar.wav" },
                { label: "Notification Chirp", description: "notify.wav" },
                { label: "Classic Chimes", description: "chimes.wav" },
                { label: "Soft Bubble", description: "Windows Background.wav" },
                { label: "Nudge Sound", description: "Windows Message Nudge.wav" },
                { label: "Tada Fanfare", description: "tada.wav" },
                { label: "Speech On Chirp", description: "Speech On.wav" },
                { label: "Custom sound file path...", description: "Specify a full path to your own WAV/MP3 file" }
            ];

            const chosen = await vscode.window.showQuickPick(sounds, {
                placeHolder: `Select sound for ${configLabel}`
            });

            if (chosen) {
                let targetSound = chosen.description;
                if (chosen.label === "Custom sound file path...") {
                    const customPath = await vscode.window.showInputBox({
                        prompt: `Enter the absolute path to your custom .wav or .mp3 file`,
                        placeHolder: "C:\\path\\to\\sound.mp3"
                    });
                    if (customPath) {
                        targetSound = customPath;
                    } else {
                        return;
                    }
                }

                await config.update(configKey, targetSound, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`${configLabel} sound set to ${chosen.label}.`);
                playSoundDirectly(targetSound);
            }
        }

        updateStatusBar();
    });

    const playTestCmd = vscode.commands.registerCommand('agNotify.playTest', () => {
        const config = vscode.workspace.getConfiguration('agNotify');
        playSoundDirectly(config.get('soundOnCompleteType', 'notification_pluck.mp3'));
    });

    const openDashboardCmd = vscode.commands.registerCommand('agNotify.openDashboard', (target) => {
        openDashboard(context, target);
    });

    context.subscriptions.push(openDashboardCmd);
    context.subscriptions.push(toggleCmd);
    context.subscriptions.push(playTestCmd);

    // Listen for config changes to update the status bar
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agNotify')) {
            updateStatusBar();
        }
    });
    context.subscriptions.push(configListener);
}

function deactivate() {
    stopWatching();
}

function createStatusBarItem(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'agNotify.openDashboard';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}

function updateStatusBar() {
    if (!statusBarItem) return;

    const config = vscode.workspace.getConfiguration('agNotify');
    const enabled = config.get('enabled', true);

    if (enabled) {
        statusBarItem.text = `$(bell) AG Chat Notifications`;
        statusBarItem.tooltip = `AG Chat Notifications is active. Click to manage alerts.`;
    } else {
        statusBarItem.text = `$(bell-slash) AG Chat Notifications: Muted`;
        statusBarItem.tooltip = `AG Chat Notifications is globally muted. Click to unmute.`;
    }
}

let setupRetries = 0;
let setupTimeoutHandle = null;

function isPathSafe(filePath) {
    const normalizedPath = path.normalize(filePath);
    const brainDir = path.normalize(path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain'));
    return normalizedPath.startsWith(brainDir);
}

function getLastLineOfFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return '';
        const stat = fs.statSync(filePath);
        const size = stat.size;
        if (size === 0) return '';

        // Read only the last 4096 bytes of the file for extreme performance
        const readLength = Math.min(size, 4096);
        const offset = size - readLength;

        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(readLength);
        fs.readSync(fd, buffer, 0, readLength, offset);
        fs.closeSync(fd);

        const text = buffer.toString('utf8').trim();
        if (!text) return '';

        const lines = text.split('\n');
        return (lines.slice(-1)[0] || '').trim();
    } catch (e) {
        return '';
    }
}

function setupPollingWatcher(context) {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');

    if (!fs.existsSync(brainDir)) {
        if (setupRetries < 20) {
            setupRetries++;
            console.log(`AG Chat Notifications: Brain directory does not exist yet. Retrying in 5 seconds... (Attempt ${setupRetries}/20)`);
            setupTimeoutHandle = setTimeout(() => setupPollingWatcher(context), 5000);
        } else {
            console.log("AG Chat Notifications: Brain directory could not be resolved after 20 attempts. Polling watcher stopped.");
        }
        return;
    }

    console.log("AG Chat Notifications: Brain directory resolved at:", brainDir);

    // Startup scan
    try {
        scanAndProcessAllTranscripts(brainDir);
        console.log("AG Chat Notifications: Initial startup scan completed successfully.");
    } catch (e) {
        console.error("AG Chat Notifications: Error during startup scan:", e);
    } finally {
        isStartupPhase = false;
        console.log("AG Chat Notifications: Startup phase finished. New events will now trigger sounds.");
    }

    setupConversationDatabaseWatcher();

    // Set up file watcher for instant near-zero latency playback
    try {
        fsWatcher = fs.watch(brainDir, { recursive: true }, (eventType, filename) => {
            if (!filename) return;

            // === COMPLETION CHIME (transcript.jsonl) ===
            if (filename.endsWith('transcript.jsonl') || filename.includes('transcript.jsonl')) {
                scanAndProcessAllTranscripts(brainDir);
            }
        });
        console.log("AG Chat Notifications: Recursive filesystem watcher initialized successfully.");
    } catch (err) {
        console.warn("AG Chat Notifications: Recursive watcher failed to initialize, using polling backup only:", err);
    }

    // USER_INPUT transcript steps are the authoritative send signal. SQLite WAL
    // pages can contain old USER_INPUT text when unrelated records are updated,
    // so scanning the WAL causes false and repeated send sounds while the model
    // is working. The filesystem watcher above handles the normal low-latency
    // path; polling remains as a backup if the OS drops a watcher notification.
    conversationCheckInterval = setInterval(() => {
        scanAndProcessAllTranscripts(brainDir);
    }, 500);

    context.subscriptions.push({
        dispose: () => {
            stopWatching();
        }
    });
}

function stopWatching() {
    if (conversationCheckInterval) {
        clearInterval(conversationCheckInterval);
        conversationCheckInterval = null;
    }
    if (setupTimeoutHandle) {
        clearTimeout(setupTimeoutHandle);
        setupTimeoutHandle = null;
    }
    if (fsWatcher) {
        try {
            fsWatcher.close();
        } catch (e) { }
        fsWatcher = null;
    }
    if (conversationDbWatcher) {
        try {
            conversationDbWatcher.close();
        } catch (e) { }
        conversationDbWatcher = null;
    }
    for (const timer of conversationDbCheckTimers.values()) {
        clearTimeout(timer);
    }
    conversationDbCheckTimers.clear();
    for (const timer of pendingCompletions.values()) {
        clearTimeout(timer);
    }
    pendingCompletions.clear();
}

function getSqliteDatabaseSync() {
    if (sqliteDatabaseSync !== undefined) return sqliteDatabaseSync;
    try {
        sqliteDatabaseSync = require('node:sqlite').DatabaseSync;
    } catch (error) {
        sqliteDatabaseSync = null;
        console.warn('AG Chat Notifications: Built-in SQLite support is unavailable; using transcript send detection.', error);
    }
    return sqliteDatabaseSync;
}

function readLatestUserInputIndex(dbPath) {
    const DatabaseSync = getSqliteDatabaseSync();
    if (!DatabaseSync || !fs.existsSync(dbPath)) return { ok: false, index: -1 };

    let db;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare('SELECT MAX(idx) AS idx FROM steps WHERE step_type = 14').get();
        return { ok: true, index: row && row.idx !== null ? Number(row.idx) : -1 };
    } catch (error) {
        return { ok: false, index: -1 };
    } finally {
        if (db) {
            try { db.close(); } catch (e) { }
        }
    }
}

function processConversationDatabase(dbPath, playNewEvents) {
    const result = readLatestUserInputIndex(dbPath);
    if (!result.ok) return false;

    const previousIndex = conversationDbUserSteps.get(dbPath);
    conversationDbUserSteps.set(dbPath, result.index);

    if (playNewEvents && result.index >= 0 && (previousIndex === undefined || result.index > previousIndex)) {
        const convoId = path.basename(dbPath, '.db');
        console.log(`AG Chat Notifications: Message sent for database step index ${result.index} in ${convoId}.`);
        playWithLock(convoId, result.index, 'send');
    }
    return true;
}

function scheduleConversationDatabaseCheck(dbPath, attempt = 0) {
    const existingTimer = conversationDbCheckTimers.get(dbPath);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
        conversationDbCheckTimers.delete(dbPath);
        const succeeded = processConversationDatabase(dbPath, true);
        if (!succeeded && attempt < 3) {
            scheduleConversationDatabaseCheck(dbPath, attempt + 1);
        }
    }, attempt === 0 ? 15 : 50);
    conversationDbCheckTimers.set(dbPath, timer);
}

function setupConversationDatabaseWatcher() {
    const conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'conversations');
    if (!fs.existsSync(conversationsDir) || !getSqliteDatabaseSync()) return;

    try {
        for (const filename of fs.readdirSync(conversationsDir)) {
            if (filename.endsWith('.db')) {
                processConversationDatabase(path.join(conversationsDir, filename), false);
            }
        }

        conversationDbWatcher = fs.watch(conversationsDir, (eventType, filename) => {
            if (!filename) return;
            const changedName = filename.toString();
            const dbName = changedName.replace(/\.db-(?:wal|shm|journal)$/i, '.db');
            if (!dbName.endsWith('.db')) return;
            scheduleConversationDatabaseCheck(path.join(conversationsDir, dbName));
        });
        console.log('AG Chat Notifications: Conversation database watcher initialized for immediate send detection.');
    } catch (error) {
        console.warn('AG Chat Notifications: Conversation database watcher failed; using transcript send detection.', error);
    }
}

function scanAndProcessAllTranscripts(brainDir) {
    try {
        const activeConvoIds = new Set();
        const activeTranscriptPaths = new Set();

        const normalizedBrain = path.normalize(brainDir);
        const convos = fs.readdirSync(normalizedBrain);
        for (const convoId of convos) {
            if (convoId === 'tempmediaStorage') continue;

            const logsDir = path.normalize(path.join(normalizedBrain, convoId, '.system_generated', 'logs'));
            const transcriptPath = path.normalize(path.join(logsDir, 'transcript.jsonl'));

            // Security check: prevent directory traversal
            if (!isPathSafe(transcriptPath)) continue;

            if (fs.existsSync(transcriptPath)) {
                activeConvoIds.add(convoId);
                activeTranscriptPaths.add(transcriptPath);

                const stat = fs.statSync(transcriptPath);
                const prevMtime = seenFilesMtime.get(transcriptPath) || 0;

                if (stat.mtimeMs > prevMtime) {
                    seenFilesMtime.set(transcriptPath, stat.mtimeMs);

                    if (!activeConversations.has(convoId)) {
                        if (isStartupPhase) {
                            const lastStep = getLastStepIndex(transcriptPath);
                            activeConversations.set(convoId, lastStep);
                            console.log(`AG Chat Notifications: Startup conversation indexed: ${convoId} with step ${lastStep}`);
                        } else {
                            activeConversations.set(convoId, -1);
                            console.log(`AG Chat Notifications: New conversation detected dynamically: ${convoId}. Initialized lastPlayed to -1.`);
                            checkAndPlaySound(transcriptPath, convoId);
                        }
                    } else {
                        checkAndPlaySound(transcriptPath, convoId);
                    }
                }
            }
        }

        // Memory pruning to prevent leaks over time
        for (const key of activeConversations.keys()) {
            if (!activeConvoIds.has(key)) {
                activeConversations.delete(key);
                cancelPendingCompletion(key);
            }
        }
        for (const key of seenFilesMtime.keys()) {
            if (!activeTranscriptPaths.has(key)) {
                seenFilesMtime.delete(key);
            }
        }
    } catch (err) {
        console.error("AG Chat Notifications error in polling scan:", err);
    }
}

function getLastStepIndex(filePath) {
    try {
        if (!isPathSafe(filePath)) return -1;
        const lastLineStr = getLastLineOfFile(filePath);
        if (!lastLineStr) return -1;

        const step = JSON.parse(lastLineStr);
        if (step && typeof step.step_index === 'number') {
            return step.step_index;
        }
    } catch (e) {
        // Ignore errors
    }
    return -1;
}

function getRecentSteps(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        const stat = fs.statSync(filePath);
        const size = stat.size;
        if (size === 0) return [];

        // Read only the last 4096 bytes of the file for extreme performance
        const readLength = Math.min(size, 4096);
        const offset = size - readLength;

        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(readLength);
        fs.readSync(fd, buffer, 0, readLength, offset);
        fs.closeSync(fd);

        const text = buffer.toString('utf8').trim();
        if (!text) return [];

        return text.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    return null;
                }
            })
            .filter(step => step !== null && typeof step.step_index === 'number');
    } catch (e) {
        return [];
    }
}

function checkAndPlaySound(filePath, convoId) {
    try {
        if (!isPathSafe(filePath)) return;
        const steps = getRecentSteps(filePath);
        if (steps.length === 0) return;

        // Sort steps by step_index ascending to process them chronologically
        steps.sort((a, b) => a.step_index - b.step_index);

        let lastPlayed = activeConversations.has(convoId) ? activeConversations.get(convoId) : -1;

        const newSteps = steps.filter(step => step.step_index > lastPlayed);
        if (newSteps.length === 0) return;

        // Any newer transcript activity means a previously final-looking model
        // response was not actually final.
        cancelPendingCompletion(convoId);

        lastPlayed = newSteps[newSteps.length - 1].step_index;
        activeConversations.set(convoId, lastPlayed);

        // A newly discovered transcript can already contain several historical
        // steps. Only the newest USER_INPUT represents the current send event.
        const latestUserInput = [...newSteps].reverse().find(step => step.type === 'USER_INPUT');
        if (latestUserInput) {
            console.log(`AG Chat Notifications: Message sent for step index ${latestUserInput.step_index} in ${convoId}.`);
            playWithLock(convoId, latestUserInput.step_index, 'send');
        }

        // Completion is valid only when the newest step is a tool-free, finished
        // model response and the transcript stays unchanged briefly. This keeps
        // incoming and outgoing sounds from firing together and lets later agent
        // activity cancel false completion candidates.
        const latestStep = newSteps[newSteps.length - 1];
        const toolCalls = latestStep.tool_calls || [];
        const isCompletion = latestStep.source === 'MODEL'
            && latestStep.type === 'PLANNER_RESPONSE'
            && latestStep.status === 'DONE'
            && toolCalls.length === 0;

        if (isCompletion) {
            scheduleCompletion(convoId, latestStep.step_index);
        }
    } catch (err) {
        // Ignore parsing errors
    }
}

function cancelPendingCompletion(convoId) {
    const timer = pendingCompletions.get(convoId);
    if (timer) {
        clearTimeout(timer);
        pendingCompletions.delete(convoId);
    }
}

function scheduleCompletion(convoId, stepIndex) {
    cancelPendingCompletion(convoId);
    const timer = setTimeout(() => {
        pendingCompletions.delete(convoId);
        console.log(`AG Chat Notifications: Task completed for step index ${stepIndex} in ${convoId}.`);
        playWithLock(convoId, stepIndex, 'complete');
    }, COMPLETION_SETTLE_MS);
    pendingCompletions.set(convoId, timer);
}

function playWithLock(convoId, stepIndex, type) {
    try {
        const tempDir = os.tmpdir();
        const lockFile = path.join(tempDir, `ag_notify_${convoId}_${stepIndex}_${type}.lock`);

        // Clean up old lock files dynamically to keep temp dir clean
        cleanupOldLockFiles();

        // Attempt to create the lock file. 'wx' flag throws if file already exists.
        fs.writeFileSync(lockFile, '', { flag: 'wx' });

        // Lock acquired successfully! Play the sound.
        playSound(type);
    } catch (e) {
        // Lock acquisition failed (file already exists or write error).
        // Another window is playing this sound.
        console.log(`AG Chat Notifications: Lock for ${type} sound on step ${stepIndex} already held. Skipping playback.`);
    }
}

function cleanupOldLockFiles() {
    try {
        const tempDir = os.tmpdir();
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        const tenMinutes = 10 * 60 * 1000;

        for (const file of files) {
            if (file.startsWith('ag_notify_') && file.endsWith('.lock')) {
                const filePath = path.join(tempDir, file);
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > tenMinutes) {
                    fs.unlinkSync(filePath);
                }
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}

function playSendSound() {
    const config = vscode.workspace.getConfiguration('agNotify');
    const enabled = config.get('enabled', true);
    const sendEnabled = config.get('soundOnSend', true);
    if (!enabled || !sendEnabled) return;

    if (extensionContext) {
        const count = extensionContext.globalState.get('totalChimesPlayed', 0);
        extensionContext.globalState.update('totalChimesPlayed', count + 1);
    }

    playSoundDirectly(config.get('soundOnSendType', 'message_chime.mp3'));
}

function playSound(type) {
    const config = vscode.workspace.getConfiguration('agNotify');
    const globalEnabled = config.get('enabled', true);
    if (!globalEnabled) return;

    if (type === 'complete') {
        const completeEnabled = config.get('soundOnComplete', true);
        if (!completeEnabled) return;

        if (extensionContext) {
            const count = extensionContext.globalState.get('totalChimesPlayed', 0);
            extensionContext.globalState.update('totalChimesPlayed', count + 1);
        }

        playSoundDirectly(config.get('soundOnCompleteType', 'notification_pluck.mp3'));
    } else if (type === 'send') {
        playSendSound();
    }
}

function playSoundDirectly(sound) {
    const platform = process.platform;
    const builtInSounds = [
        'notification_pluck.mp3',
        'message_chime.mp3',
        'ding.mp3',
        'notification_alert.mp3',
        'digital_alert.mp3',
        'smooth_stereo.mp3',
        'completed_alert.mp3',
        'intro_bell.mp3',
        'best_notification_1.mp3',
        'best_notification_2.mp3'
    ];

    let soundPath = sound;
    if (builtInSounds.includes(sound)) {
        soundPath = path.join(extensionPath, 'sounds', sound);
    }

    if (platform === 'win32') {
        if (!soundPath.includes('\\') && !soundPath.includes(':')) {
            soundPath = path.join('C:\\Windows\\Media', soundPath);
        }

        const tempDir = os.tmpdir();
        const vbsPath = path.join(tempDir, 'ag_notify_play.vbs');
        
        if (!fs.existsSync(vbsPath)) {
            const vbsContent = 
                'Dim oPlayer\r\n' +
                'Set oPlayer = CreateObject("WMPlayer.OCX")\r\n' +
                'oPlayer.URL = WScript.Arguments(0)\r\n' +
                'oPlayer.controls.play\r\n' +
                'Do While oPlayer.playState <> 1\r\n' +
                '    WScript.Sleep 50\r\n' +
                'Loop\r\n' +
                'oPlayer.close\r\n' +
                'Set oPlayer = Nothing\r\n';
            try {
                fs.writeFileSync(vbsPath, vbsContent, 'utf8');
            } catch (err) {
                console.error("AG Chat Notifications: Failed to write VBS file:", err);
            }
        }
        
        execFile('cscript', ['/nologo', vbsPath, soundPath], (error) => {
            if (error) {
                console.error("AG Chat Notifications Error playing Windows sound via VBS, trying PowerShell fallback...", error);
                
                // PowerShell fallback
                const env = { ...process.env, AG_SOUND_PATH: soundPath };
                const psCommand = `Add-Type -AssemblyName PresentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([Uri]"$env:AG_SOUND_PATH"); $player.Play(); Start-Sleep -s 5`;
                execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { env }, (psError) => {
                    if (psError) console.error("AG Chat Notifications PowerShell fallback error:", psError);
                });
            }
        });
    } else if (platform === 'darwin') {
        if (builtInSounds.includes(sound) || fs.existsSync(soundPath)) {
            execFile('afplay', [soundPath], (error) => {
                if (error) console.error("AG Chat Notifications Error playing macOS sound:", error);
            });
        } else {
            execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], (error) => {
                if (error) console.error("AG Chat Notifications Error playing macOS default sound:", error);
            });
        }
    } else {
        // Linux fallback chain for MP3 / WAV
        if (builtInSounds.includes(sound) || fs.existsSync(soundPath)) {
            const players = [
                { cmd: 'mpg123', args: [soundPath] },
                { cmd: 'paplay', args: [soundPath] },
                { cmd: 'play', args: [soundPath] },
                { cmd: 'aplay', args: [soundPath] }
            ];

            function tryPlay(index) {
                if (index >= players.length) return;
                const p = players[index];
                execFile(p.cmd, p.args, (error) => {
                    if (error) {
                        tryPlay(index + 1);
                    }
                });
            }
            tryPlay(0);
        } else {
            execFile('aplay', ['/usr/share/sounds/alsa/Front_Center.wav'], (error) => {
                if (error) console.error("AG Chat Notifications Error playing Linux default sound:", error);
            });
        }
    }
}

function openDashboard(context, target) {
    const panel = vscode.window.createWebviewPanel(
        'agNotifyDashboard',
        'AG Chat Notifications - Settings & Dashboard',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(context.extensionPath)]
        }
    );

    const iconUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'icon.png')));

    function sendStateToWebview() {
        const config = vscode.workspace.getConfiguration('agNotify');
        panel.webview.postMessage({
            command: 'configUpdated',
            completeSound: config.get('soundOnCompleteType', 'notification_pluck.mp3'),
            sendSound: config.get('soundOnSendType', 'message_chime.mp3'),
            enabled: config.get('enabled', true),
            soundOnComplete: config.get('soundOnComplete', true),
            soundOnSend: config.get('soundOnSend', true),
            totalChimes: context.globalState.get('totalChimesPlayed', 0)
        });
    }

    function getWebviewContent() {
        const config = vscode.workspace.getConfiguration('agNotify');
        const enabled = config.get('enabled', true);
        const completeEnabled = config.get('soundOnComplete', true);
        const sendEnabled = config.get('soundOnSend', true);

        const completeSound = config.get('soundOnCompleteType', 'notification_pluck.mp3');
        const sendSound = config.get('soundOnSendType', 'message_chime.mp3');
        const totalChimes = context.globalState.get('totalChimesPlayed', 0);

        const builtInSounds = [
            { id: 'notification_pluck.mp3', name: '⭐ Pluck Chime (Default)', desc: 'Soft and elegant organic pluck alert' },
            { id: 'smooth_stereo.mp3', name: 'Smooth Stereo Chime', desc: 'Wide stereo high-end chime' },
            { id: 'completed_alert.mp3', name: 'Completed Task Alert', desc: 'Rich synthesizer chime' },
            { id: 'intro_bell.mp3', name: 'Intro Sound Bell', desc: 'Clear corporate-style bell' },
            { id: 'best_notification_1.mp3', name: 'Developer Chime 1', desc: 'Optimized developer chime 1' },
            { id: 'best_notification_2.mp3', name: 'Developer Chime 2', desc: 'Optimized developer chime 2' },
            { id: 'message_chime.mp3', name: 'Message Chime', desc: 'Elegant alert for incoming chats' },
            { id: 'ding.mp3', name: 'Elegant Ding', desc: 'Short classic bell sound' },
            { id: 'notification_alert.mp3', name: 'Notification Alert', desc: 'Medium pitch notification' },
            { id: 'digital_alert.mp3', name: 'Digital Alert', desc: 'High tech synth wave chime' },
            { id: 'Windows Notify System Generic.wav', name: 'Win11 Notify', desc: 'Modern Windows 11 default alert' },
            { id: 'Windows Information Bar.wav', name: 'Win11 Quiet Note', desc: 'Soft and quiet notification' },
            { id: 'notify.wav', name: 'Chirp', desc: 'Short notification chirp' },
            { id: 'chimes.wav', name: 'Classic Chimes', desc: 'Classic chimes sound effect' },
            { id: 'Windows Background.wav', name: 'Soft Bubble', desc: 'Relaxing ambient bubble pop' },
            { id: 'Windows Message Nudge.wav', name: 'Nudge Sound', desc: 'Energetic nudge notification' },
            { id: 'tada.wav', name: 'Tada Fanfare', desc: 'Classic retro tada celebration' },
            { id: 'Speech On.wav', name: 'Speech On Chirp', desc: 'Microphone speech on alert' }
        ];

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: vscode-webview-resource: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';">
            <title>AG Chat Notifications Dashboard</title>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
            <style>
                :root {
                    --bg-dark: #0f0f15;
                    --card-bg: rgba(30, 30, 46, 0.7);
                    --border-color: rgba(255, 255, 255, 0.08);
                    --text-primary: #f1f1f7;
                    --text-secondary: #9499b3;
                    --accent-blue: #007acc;
                    --accent-cyan: #00e5ff;
                }

                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                }

                body {
                    background-color: var(--bg-dark);
                    color: var(--text-primary);
                    padding: 30px;
                    display: flex;
                    justify-content: center;
                    min-height: 100vh;
                    overflow-y: auto;
                }

                /* Scrollbar Styles */
                ::-webkit-scrollbar {
                    width: 8px;
                }
                ::-webkit-scrollbar-track {
                    background: rgba(0, 0, 0, 0.2);
                }
                ::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.2);
                }

                .container {
                    width: 100%;
                    max-width: 900px;
                    display: flex;
                    flex-direction: column;
                    gap: 25px;
                }

                /* Brand Header */
                .header-card {
                    background: linear-gradient(135deg, rgba(35, 35, 55, 0.8), rgba(20, 20, 30, 0.8));
                    border: 1px solid var(--border-color);
                    border-radius: 20px;
                    padding: 25px 35px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    backdrop-filter: blur(12px);
                    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
                }

                .brand {
                    display: flex;
                    align-items: center;
                    gap: 20px;
                }

                .brand-img {
                    width: 70px;
                    height: 70px;
                    border-radius: 16px;
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
                }

                .brand-info h1 {
                    font-size: 26px;
                    font-weight: 800;
                    letter-spacing: 0.5px;
                    background: linear-gradient(90deg, #fff, #b9bbdf);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }

                .brand-info p {
                    font-size: 14px;
                    color: var(--text-secondary);
                    margin-top: 4px;
                }

                .badge {
                    padding: 8px 16px;
                    border-radius: 30px;
                    font-size: 13px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .badge.free {
                    background: rgba(46, 204, 113, 0.12);
                    color: #2ecc71;
                    border: 1px solid rgba(46, 204, 113, 0.2);
                }

                /* Stats Row */
                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 20px;
                }

                .stat-card {
                    background: var(--card-bg);
                    border: 1px solid var(--border-color);
                    border-radius: 16px;
                    padding: 20px 24px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    backdrop-filter: blur(8px);
                    transition: transform 0.2s ease, border-color 0.2s ease;
                }

                .stat-card:hover {
                    transform: translateY(-2px);
                    border-color: rgba(255, 255, 255, 0.15);
                }

                .stat-label {
                    font-size: 12px;
                    color: var(--text-secondary);
                    text-transform: uppercase;
                    letter-spacing: 1px;
                    font-weight: 600;
                }

                .stat-val {
                    font-size: 28px;
                    font-weight: 800;
                    color: var(--text-primary);
                }

                .stat-val.active-sound {
                    font-size: 15px;
                    font-weight: 600;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .stat-val.active-sound.complete {
                    color: #5dcdfc;
                }

                .stat-val.active-sound.send {
                    color: #2ecc71;
                }

                /* Core Settings & Toggles */
                .settings-pane {
                    background: var(--card-bg);
                    border: 1px solid var(--border-color);
                    border-radius: 20px;
                    padding: 30px;
                    display: flex;
                    flex-direction: column;
                    gap: 25px;
                }

                .section-title {
                    font-size: 18px;
                    font-weight: 700;
                    margin-bottom: 5px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .toggle-group {
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                }

                .toggle-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 15px 20px;
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 12px;
                    border: 1px solid rgba(255, 255, 255, 0.03);
                }

                .toggle-info h3 {
                    font-size: 15px;
                    font-weight: 600;
                }

                .toggle-info p {
                    font-size: 12px;
                    color: var(--text-secondary);
                    margin-top: 3px;
                }

                /* Toggle Switch CSS */
                .switch {
                    position: relative;
                    display: inline-block;
                    width: 50px;
                    height: 26px;
                }

                .switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }

                .slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(255, 255, 255, 0.1);
                    transition: .4s;
                    border-radius: 34px;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }

                .slider:before {
                    position: absolute;
                    content: "";
                    height: 18px;
                    width: 18px;
                    left: 3px;
                    bottom: 3px;
                    background-color: var(--text-primary);
                    transition: .3s;
                    border-radius: 50%;
                }

                input:checked + .slider {
                    background-color: var(--accent-blue);
                }

                input:checked + .slider:before {
                    transform: translateX(24px);
                    background-color: #fff;
                }

                /* Sound Library Grid */
                .sounds-section {
                    margin-top: 10px;
                }

                .sounds-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                    gap: 15px;
                    margin-top: 15px;
                }

                .sound-card {
                    background: rgba(0, 0, 0, 0.18);
                    border: 1px solid rgba(255, 255, 255, 0.04);
                    border-radius: 14px;
                    padding: 16px;
                    display: flex;
                    flex-direction: column;
                    justify-content: space-between;
                    gap: 12px;
                    transition: all 0.2s ease;
                }

                .sound-card.active-complete {
                    background: rgba(0, 122, 204, 0.05);
                    border-color: rgba(0, 122, 204, 0.4);
                    box-shadow: 0 0 10px rgba(0, 122, 204, 0.15);
                }

                .sound-card.active-send {
                    background: rgba(46, 204, 113, 0.05);
                    border-color: rgba(46, 204, 113, 0.4);
                    box-shadow: 0 0 10px rgba(46, 204, 113, 0.15);
                }

                .sound-card.active-both {
                    background: rgba(155, 89, 182, 0.05);
                    border-color: rgba(155, 89, 182, 0.4);
                    box-shadow: 0 0 10px rgba(155, 89, 182, 0.15);
                }

                .sound-info h4 {
                    font-size: 14px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .sound-info p {
                    font-size: 11px;
                    color: var(--text-secondary);
                    margin-top: 4px;
                }

                .sound-actions {
                    display: flex;
                    gap: 6px;
                }

                .btn {
                    padding: 8px 10px;
                    border-radius: 8px;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: none;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                }

                .btn-play {
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--text-primary);
                    flex: 1;
                }

                .btn-play:hover {
                    background: rgba(255, 255, 255, 0.12);
                }

                .btn-use-complete {
                    background: rgba(0, 122, 204, 0.08);
                    color: rgba(255, 255, 255, 0.8);
                    flex: 1.5;
                }

                .btn-use-complete:hover {
                    background: rgba(0, 122, 204, 0.15);
                }

                .btn-use-complete.active {
                    background: rgba(0, 122, 204, 0.25) !important;
                    color: var(--accent-cyan) !important;
                    border: 1px solid rgba(0, 122, 204, 0.4) !important;
                }

                .btn-use-send {
                    background: rgba(46, 204, 113, 0.08);
                    color: rgba(255, 255, 255, 0.8);
                    flex: 1.5;
                }

                .btn-use-send:hover {
                    background: rgba(46, 204, 113, 0.15);
                }

                .btn-use-send.active {
                    background: rgba(46, 204, 113, 0.25) !important;
                    color: #2ecc71 !important;
                    border: 1px solid rgba(46, 204, 113, 0.4) !important;
                }

                .custom-sound-box {
                    display: flex;
                    gap: 10px;
                    margin-top: 10px;
                }
                .custom-sound-box input {
                    flex: 1;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    padding: 10px;
                    border-radius: 8px;
                    color: #fff;
                    font-size: 12px;
                }
                .custom-sound-box button {
                    background: var(--accent-blue);
                    color: #fff;
                    border: none;
                    padding: 0 15px;
                    border-radius: 8px;
                    font-size: 12px;
                    font-weight: 600;
                    cursor: pointer;
                }
                .custom-sound-box button:hover {
                    background: #0088e0;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <!-- Branding Header -->
                <div class="header-card">
                    <div class="brand">
                        <img class="brand-img" src="${iconUri}" alt="AG Chat Notifications Icon">
                        <div class="brand-info">
                            <h1>AG Chat Notifications</h1>
                            <p>Premium task notification sound orchestrator for Antigravity Agent</p>
                        </div>
                    </div>
                    <div class="badge free">
                        ✨ 100% Free
                    </div>
                </div>

                <!-- Stats Summary Row -->
                <div class="stats-grid">
                    <div class="stat-card">
                        <span class="stat-label">Total Alerts Played</span>
                        <span id="totalChimesPlayed" class="stat-val">${totalChimes}</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-label">Completion Chime</span>
                        <span id="completeChimeName" class="stat-val active-sound complete">${completeSound}</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-label">Message Sent Chime</span>
                        <span id="sendChimeName" class="stat-val active-sound send">${sendSound}</span>
                    </div>
                </div>

                <!-- Main settings layout -->
                <div class="settings-pane">
                    <div class="section-title">🛡️ Notification Controllers</div>
                    <div class="toggle-group">
                        <div class="toggle-row">
                            <div class="toggle-info">
                                <h3>Enable Notification Sound Alerts</h3>
                                <p>Global switch to activate or mute all notification alerts.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="globalToggle" ${enabled ? 'checked' : ''} onchange="toggleSetting('enabled', this.checked)">
                                <span class="slider"></span>
                            </label>
                        </div>

                        <div class="toggle-row">
                            <div class="toggle-info">
                                <h3>Play Sound on Task Completion</h3>
                                <p>Play chosen chime when Antigravity Agent completes its final response.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="completeToggle" ${completeEnabled ? 'checked' : ''} onchange="toggleSetting('soundOnComplete', this.checked)">
                                <span class="slider"></span>
                            </label>
                        </div>

                        <div class="toggle-row">
                            <div class="toggle-info">
                                <h3>Play Sound on Message Sent</h3>
                                <p>Play chosen chime when you send a message in the chat.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="sendToggle" ${sendEnabled ? 'checked' : ''} onchange="toggleSetting('soundOnSend', this.checked)">
                                <span class="slider"></span>
                            </label>
                        </div>
                    </div>

                    <!-- Sound Library Grid -->
                    <div class="sounds-section">
                        <div class="section-title">🎵 Notification Sound Library</div>
                        <p style="font-size: 13px; color: var(--text-secondary); margin-top: 5px;">
                            Explore built-in chimes. Select "Completion" or "Sent" to configure the chime for that action.
                        </p>
                        
                        <div class="sounds-grid">
                            ${builtInSounds.map(s => {
            const isComplete = completeSound === s.id;
            const isSend = sendSound === s.id;
            return `
                                <div class="sound-card ${isComplete && isSend ? 'active-both' : isComplete ? 'active-complete' : isSend ? 'active-send' : ''}" id="sound-${s.id}">
                                    <div class="sound-info">
                                        <h4>${s.name}</h4>
                                        <p>${s.desc}</p>
                                    </div>
                                    <div class="sound-actions">
                                        <button class="btn btn-play" onclick="previewSound('${s.id}')">
                                            ▶ Play
                                        </button>
                                        <button class="btn btn-use-complete ${isComplete ? 'active' : ''}" onclick="useSound('${s.id}', 'complete')">
                                            ${isComplete ? 'Completion: Active' : 'Set Completion'}
                                        </button>
                                        <button class="btn btn-use-send ${isSend ? 'active' : ''}" onclick="useSound('${s.id}', 'send')">
                                            ${isSend ? 'Sent: Active' : 'Set Sent'}
                                        </button>
                                    </div>
                                </div>
                                `;
        }).join('')}
                        </div>
                    </div>

                    <!-- Custom sound selector -->
                    <div class="custom-sound-section" style="margin-top: 15px; display: flex; flex-direction: column; gap: 15px;">
                        <div>
                            <div class="section-title" style="font-size: 15px;">📁 Custom Completion Sound File Path</div>
                            <div class="custom-sound-box">
                                <input type="text" id="customCompletePath" placeholder="C:\\Path\\To\\CustomSound.wav or .mp3" value="">
                                <button onclick="saveCustomSound('complete')">Save Completion</button>
                            </div>
                        </div>
                        <div>
                            <div class="section-title" style="font-size: 15px;">📁 Custom Message Sent Sound File Path</div>
                            <div class="custom-sound-box">
                                <input type="text" id="customSendPath" placeholder="C:\\Path\\To\\CustomSound.wav or .mp3" value="">
                                <button onclick="saveCustomSound('send')">Save Message Sent</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                const builtInIds = [
                    'notification_pluck.mp3',
                    'smooth_stereo.mp3',
                    'completed_alert.mp3',
                    'intro_bell.mp3',
                    'best_notification_1.mp3',
                    'best_notification_2.mp3',
                    'message_chime.mp3',
                    'ding.mp3',
                    'notification_alert.mp3',
                    'digital_alert.mp3',
                    'Windows Notify System Generic.wav',
                    'Windows Information Bar.wav',
                    'notify.wav',
                    'chimes.wav',
                    'Windows Background.wav',
                    'Windows Message Nudge.wav',
                    'tada.wav',
                    'Speech On.wav'
                ];

                function toggleSetting(key, value) {
                    vscode.postMessage({
                        command: 'updateSetting',
                        key: key,
                        value: value
                    });
                }

                function previewSound(soundId) {
                    vscode.postMessage({
                        command: 'previewSound',
                        sound: soundId
                    });
                }

                function useSound(soundId, type) {
                    vscode.postMessage({
                        command: 'useSound',
                        sound: soundId,
                        type: type
                    });
                }

                function saveCustomSound(type) {
                    const inputId = type === 'complete' ? 'customCompletePath' : 'customSendPath';
                    const customPath = document.getElementById(inputId).value.trim();
                    if (!customPath) return;
                    vscode.postMessage({
                        command: 'useSound',
                        sound: customPath,
                        type: type
                    });
                }

                function updateUI(state) {
                    document.getElementById('totalChimesPlayed').innerText = state.totalChimes;
                    document.getElementById('completeChimeName').innerText = state.completeSound;
                    document.getElementById('sendChimeName').innerText = state.sendSound;
                    
                    document.getElementById('globalToggle').checked = state.enabled;
                    document.getElementById('completeToggle').checked = state.soundOnComplete;
                    document.getElementById('sendToggle').checked = state.soundOnSend;
                    
                    // Update sound cards
                    document.querySelectorAll('.sound-card').forEach(card => {
                        const soundId = card.id.replace('sound-', '');
                        
                        const isComplete = soundId === state.completeSound;
                        const isSend = soundId === state.sendSound;
                        
                        card.className = 'sound-card';
                        if (isComplete && isSend) {
                            card.classList.add('active-both');
                        } else if (isComplete) {
                            card.classList.add('active-complete');
                        } else if (isSend) {
                            card.classList.add('active-send');
                        }
                        
                        const completeBtn = card.querySelector('.btn-use-complete');
                        if (completeBtn) {
                            completeBtn.className = 'btn btn-use-complete ' + (isComplete ? 'active' : '');
                            completeBtn.innerText = isComplete ? 'Completion: Active' : 'Set Completion';
                        }
                        
                        const sendBtn = card.querySelector('.btn-use-send');
                        if (sendBtn) {
                            sendBtn.className = 'btn btn-use-send ' + (isSend ? 'active' : '');
                            sendBtn.innerText = isSend ? 'Sent: Active' : 'Set Sent';
                        }
                    });
                    
                    // Update custom path textboxes
                    const customCompleteInput = document.getElementById('customCompletePath');
                    const customSendInput = document.getElementById('customSendPath');
                    
                    customCompleteInput.value = !builtInIds.includes(state.completeSound) ? state.completeSound : '';
                    customSendInput.value = !builtInIds.includes(state.sendSound) ? state.sendSound : '';
                }

                // Handle messages sent from the extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'configUpdated':
                            updateUI(message);
                            break;
                    }
                });

                // Request initial sync once loaded
                window.addEventListener('DOMContentLoaded', () => {
                    vscode.postMessage({ command: 'requestSync' });
                });
            </script>
        </body>
        </html>`;
    }

    panel.webview.html = getWebviewContent();

    // Listen for events in the Webview panel
    panel.webview.onDidReceiveMessage(
        async message => {
            const config = vscode.workspace.getConfiguration('agNotify');
            switch (message.command) {
                case 'requestSync':
                    sendStateToWebview();
                    break;
                case 'updateSetting':
                    const allowedKeys = ['enabled', 'soundOnComplete', 'soundOnSend'];
                    if (allowedKeys.includes(message.key)) {
                        await config.update(message.key, message.value, vscode.ConfigurationTarget.Global);
                        updateStatusBar();
                        sendStateToWebview();
                    }
                    break;
                case 'previewSound':
                    playSoundDirectly(message.sound);
                    break;
                case 'useSound':
                    const configKey = message.type === 'complete' ? 'soundOnCompleteType' : 'soundOnSendType';
                    await config.update(configKey, message.sound, vscode.ConfigurationTarget.Global);
                    updateStatusBar();
                    sendStateToWebview();
                    break;
            }
        },
        undefined,
        context.subscriptions
    );

    // Refresh stats when the panel is focused
    panel.onDidChangeViewState(
        () => {
            if (panel.visible) {
                sendStateToWebview();
            }
        },
        undefined,
        context.subscriptions
    );
}

module.exports = {
    activate,
    deactivate
};
