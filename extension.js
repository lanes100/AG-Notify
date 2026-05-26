const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');

// Supabase License Server Configuration
const SUPABASE_URL = 'https://gywtucdynuxokzeeaofa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_eGCxjxg2E7wErEGOZYv0iA_X4Wqe_DF';

const activeConversations = new Map(); // convoId -> lastPlayedStep
const seenFilesMtime = new Map(); // filePath -> mtimeMs
let statusBarItem;
let conversationCheckInterval = null;
let isStartupPhase = true;
let extensionPath = ''; // Store extension directory path dynamically
let extensionContext = null; // Store context reference globally

/**
 * Validates the offline premium license key mathematically.
 */
function validateLicenseKey(key) {
    if (!key || typeof key !== 'string') return false;
    const cleanKey = key.trim().toUpperCase();
    if (!cleanKey.startsWith('AGN-')) return false;
    
    const parts = cleanKey.split('-');
    if (parts.length !== 3) return false;
    
    const block1 = parts[1];
    const block2 = parts[2];
    
    if (block1.length !== 4 || block2.length !== 4) return false;
    
    let sum = 0;
    for (let char of block1 + block2) {
        sum += char.charCodeAt(0);
    }
    return sum % 10 === 7;
}

/**
 * Generates a unique machine fingerprint based on hardware/OS info.
 */
function getMachineId() {
    const raw = `${os.hostname()}-${os.userInfo().username}-${os.cpus()[0]?.model || 'unknown'}-${os.platform()}`;
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

/**
 * Checks premium status using cached server activation + offline math.
 */
function isPremiumActive() {
    const config = vscode.workspace.getConfiguration('agNotify');
    const key = config.get('premiumLicenseKey', '');
    if (!validateLicenseKey(key)) return false;
    
    if (!extensionContext) return false;
    const cached = extensionContext.globalState.get('premiumActivated', false);
    const cachedMachine = extensionContext.globalState.get('premiumMachineId', '');
    return cached && cachedMachine === getMachineId();
}

/**
 * Activates a license key on the Supabase server.
 * Returns {success, reason} object.
 * Falls back to offline validation on network failure.
 */
async function activateKeyOnServer(key) {
    // Quick offline math reject
    if (!validateLicenseKey(key)) {
        return { success: false, reason: 'invalid_key' };
    }
    
    try {
        const machineId = getMachineId();
        const machineName = `${os.hostname()} (${os.platform()})`;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        
        const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/activate_key`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                p_key: key.trim().toUpperCase(),
                p_machine_id: machineId,
                p_machine_name: machineName
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
            console.warn(`AG Notify: Server returned ${response.status}`);
            return offlineFallback(key);
        }
        
        const result = await response.json();
        
        if (result.success) {
            // Cache successful activation locally
            extensionContext.globalState.update('premiumActivated', true);
            extensionContext.globalState.update('premiumMachineId', machineId);
            extensionContext.globalState.update('premiumLastVerified', Date.now());
        }
        
        return result;
    } catch (error) {
        console.warn('AG Notify: Server unreachable, using offline fallback', error.message);
        return offlineFallback(key);
    }
}

/**
 * Offline fallback when server is unreachable.
 * Only succeeds if there's a cached activation for this machine.
 */
function offlineFallback(key) {
    if (!validateLicenseKey(key)) return { success: false, reason: 'invalid_key' };
    
    const cached = extensionContext?.globalState.get('premiumActivated', false);
    const cachedMachine = extensionContext?.globalState.get('premiumMachineId', '');
    
    if (cached && cachedMachine === getMachineId()) {
        return { success: true, reason: 'offline_cached' };
    }
    
    // First-time activation requires internet
    return { success: false, reason: 'offline_no_cache' };
}

function activate(context) {
    console.log('AG Notify extension is now active!');
    setupRetries = 0;
    setupTimeoutHandle = null;
    extensionPath = context.extensionPath;
    extensionContext = context;
    
    createStatusBarItem(context);
    setupPollingWatcher(context);
    
    // Show support prompt on every startup for non-premium users
    checkPremiumStatusAndPrompt(context);
    
    // Register commands
    const toggleCmd = vscode.commands.registerCommand('agNotify.toggle', async () => {
        const config = vscode.workspace.getConfiguration('agNotify');
        const enabled = config.get('enabled', true);
        const completeEnabled = config.get('soundOnComplete', true);
        const isPremium = isPremiumActive();
        
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
                label: "$(settings-gear) Configure Completion Sound...",
                description: `Change sound file for completed responses`,
                action: 'choose_complete'
            },
            {
                label: "$(play) Play Test Completion Sound",
                description: "Test your currently set completion chime",
                action: 'test_complete'
            },
            {
                label: isPremium ? "✨ Premium Status: ACTIVE" : "🎁 Unlock Premium Feature Pack...",
                description: isPremium ? "Thank you for supporting the project!" : "Enter your premium license key",
                action: 'premium_license'
            }
        ];
        
        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: "AG Notify Controls"
        });
        
        if (!selection) return;
        
        if (selection.action === 'toggle_global') {
            await config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`AG Notify notifications globally ${!enabled ? 'ENABLED' : 'DISABLED'}.`);
        } else if (selection.action === 'toggle_complete') {
            await config.update('soundOnComplete', !completeEnabled, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Completion sound alerts ${!completeEnabled ? 'ENABLED' : 'DISABLED'}.`);
        } else if (selection.action === 'test_complete') {
            playSoundDirectly(config.get('soundOnCompleteType', 'notification_pluck.mp3'));
        } else if (selection.action === 'premium_license') {
            await promptForLicenseKey();
        } else if (selection.action === 'choose_complete') {
            const sounds = [
                { label: "⭐ Pluck Chime (Default - Free)", description: "notification_pluck.mp3" },
                { label: "✨ Premium: Smooth Stereo Chime", description: "smooth_stereo.mp3" },
                { label: "✨ Premium: Completed Task Alert", description: "completed_alert.mp3" },
                { label: "✨ Premium: Intro Sound Bell", description: "intro_bell.mp3" },
                { label: "✨ Premium: Premium Notification 1", description: "best_notification_1.mp3" },
                { label: "✨ Premium: Premium Notification 2", description: "best_notification_2.mp3" },
                { label: "✨ Premium: Message Chime", description: "message_chime.mp3" },
                { label: "✨ Premium: Elegant Ding", description: "ding.mp3" },
                { label: "✨ Premium: Notification Alert", description: "notification_alert.mp3" },
                { label: "✨ Premium: Digital Alert", description: "digital_alert.mp3" },
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
                placeHolder: `Select sound for Completion`
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
                
                // Prevent free users from setting premium sounds through QuickPick
                const isPremiumSound = targetSound.endsWith('.mp3') && targetSound !== 'notification_pluck.mp3';
                if (isPremiumSound && !isPremiumActive()) {
                    vscode.window.showWarningMessage(
                        "✨ This is a Premium alert chime. Support the project to unlock all premium sounds!",
                        "Open Dashboard",
                        "Maybe Later"
                    ).then((selection) => {
                        if (selection === "Open Dashboard") {
                            vscode.commands.executeCommand('agNotify.openDashboard');
                        }
                    });
                    return;
                }
                
                await config.update('soundOnCompleteType', targetSound, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Completion sound set to ${chosen.label}.`);
                playSoundDirectly(targetSound);
            }
        }
        
        updateStatusBar();
    });
    
    const playTestCmd = vscode.commands.registerCommand('agNotify.playTest', () => {
        const config = vscode.workspace.getConfiguration('agNotify');
        playSoundDirectly(config.get('soundOnCompleteType', 'notification_pluck.mp3'));
    });
    
    const enterLicenseCmd = vscode.commands.registerCommand('agNotify.enterLicense', async () => {
        await promptForLicenseKey();
    });

    const resetLicenseCmd = vscode.commands.registerCommand('agNotify.resetLicense', async () => {
        const config = vscode.workspace.getConfiguration('agNotify');
        await config.update('premiumLicenseKey', '', vscode.ConfigurationTarget.Global);
        if (extensionContext) {
            extensionContext.globalState.update('premiumActivated', false);
            extensionContext.globalState.update('premiumMachineId', '');
            extensionContext.globalState.update('premiumLastVerified', null);
        }
        vscode.window.showInformationMessage("AG Notify: Premium license status and cache have been successfully reset.");
        updateStatusBar();
    });
    
    // Test command to force trigger the promo message
    const testPromoCmd = vscode.commands.registerCommand('agNotify.testPromo', () => {
        vscode.window.showInformationMessage(
            "Enjoying AG Notify? Open the Settings Dashboard to preview premium sounds, get a lifetime key, or support the developer! 💖",
            "Open Settings",
            "Enter License Key",
            "Later"
        ).then(async (selection) => {
            if (selection === "Open Settings") {
                vscode.commands.executeCommand('agNotify.openDashboard', 'sponsors');
            } else if (selection === "Enter License Key") {
                vscode.commands.executeCommand('agNotify.openDashboard', 'license');
            }
        });
    });
    
    const openDashboardCmd = vscode.commands.registerCommand('agNotify.openDashboard', (target) => {
        openDashboard(context, target);
    });
    
    context.subscriptions.push(openDashboardCmd);
    context.subscriptions.push(toggleCmd);
    context.subscriptions.push(playTestCmd);
    context.subscriptions.push(enterLicenseCmd);
    context.subscriptions.push(resetLicenseCmd);
    context.subscriptions.push(testPromoCmd);
    
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
    const isPremium = isPremiumActive();
    
    if (enabled) {
        if (isPremium) {
            statusBarItem.text = `✨ AG Notify Premium`;
            statusBarItem.tooltip = `AG Notify Premium is active! Thank you for your support! 💖`;
        } else {
            statusBarItem.text = `$(bell) AG Notify`;
            statusBarItem.tooltip = `AG Notify is active. Click to manage alerts.`;
        }
    } else {
        statusBarItem.text = `$(bell-slash) AG Notify: Muted`;
        statusBarItem.tooltip = `AG Notify is globally muted. Click to unmute.`;
    }
}

async function promptForLicenseKey() {
    const config = vscode.workspace.getConfiguration('agNotify');
    const entered = await vscode.window.showInputBox({
        prompt: "Enter your AG Notify Premium License Key (Format: AGN-XXXX-XXXX)",
        placeHolder: "AGN-XXXX-XXXX"
    });
    
    if (entered) {
        if (!validateLicenseKey(entered)) {
            vscode.window.showErrorMessage("❌ Invalid license key. Please check and try again.");
            return;
        }
        
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Activating license..." },
            () => activateKeyOnServer(entered)
        );
        
        if (result.success) {
            await config.update('premiumLicenseKey', entered.trim().toUpperCase(), vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("✨ AG Notify Premium successfully activated! Thank you for your support! 💖");
            updateStatusBar();
        } else if (result.reason === 'device_limit') {
            vscode.window.showErrorMessage(`❌ Device limit reached (${result.max} devices). Deactivate another device first or contact support.`);
        } else if (result.reason === 'key_disabled') {
            vscode.window.showErrorMessage("❌ This license key has been disabled. Contact support.");
        } else if (result.reason === 'offline_no_cache') {
            vscode.window.showErrorMessage("❌ Internet connection required for first-time activation. Please connect and try again.");
        } else {
            vscode.window.showErrorMessage("❌ Activation failed. Please check your key and try again.");
        }
    }
}

function checkPremiumStatusAndPrompt(context) {
    const isPremium = isPremiumActive();
    
    if (isPremium) {
        return; // Premium users enjoy zero ads!
    }
    
    // Trigger immediately on every startup/new window for free users to maximize conversion rate
    vscode.window.showInformationMessage(
        "Enjoying AG Notify? Open the Settings Dashboard to preview premium sounds, get a lifetime key, or support the developer! 💖",
        "Open Settings",
        "Enter License Key",
        "Later"
    ).then(async (selection) => {
        if (selection === "Open Settings") {
            vscode.commands.executeCommand('agNotify.openDashboard', 'sponsors');
        } else if (selection === "Enter License Key") {
            vscode.commands.executeCommand('agNotify.openDashboard', 'license');
        }
    });
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
            console.log(`AG Notify: Brain directory does not exist yet. Retrying in 5 seconds... (Attempt ${setupRetries}/20)`);
            setupTimeoutHandle = setTimeout(() => setupPollingWatcher(context), 5000);
        } else {
            console.log("AG Notify: Brain directory could not be resolved after 20 attempts. Polling watcher stopped.");
        }
        return;
    }
    
    console.log("AG Notify: Brain directory resolved at:", brainDir);
    
    // Startup scan
    try {
        scanAndProcessAllTranscripts(brainDir);
        console.log("AG Notify: Initial startup scan completed successfully.");
    } catch (e) {
        console.error("AG Notify: Error during startup scan:", e);
    } finally {
        isStartupPhase = false;
        console.log("AG Notify: Startup phase finished. New events will now trigger sounds.");
    }
    
    // Polling scanner runs every 1.5 seconds for instant multi-window detection
    conversationCheckInterval = setInterval(() => {
        scanAndProcessAllTranscripts(brainDir);
    }, 1500);
    
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
                            console.log(`AG Notify: Startup conversation indexed: ${convoId} with step ${lastStep}`);
                        } else {
                            activeConversations.set(convoId, -1);
                            console.log(`AG Notify: New conversation detected dynamically: ${convoId}. Initialized lastPlayed to -1.`);
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
            }
        }
        for (const key of seenFilesMtime.keys()) {
            if (!activeTranscriptPaths.has(key)) {
                seenFilesMtime.delete(key);
            }
        }
    } catch (err) {
        console.error("AG Notify error in polling scan:", err);
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

function checkAndPlaySound(filePath, convoId) {
    try {
        if (!isPathSafe(filePath)) return;
        const lastLineStr = getLastLineOfFile(filePath);
        if (!lastLineStr) return;
        
        const step = JSON.parse(lastLineStr);
        
        const isModelResponse = step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE';
        const isDone = step.status === 'DONE';
        const toolCalls = step.tool_calls || [];
        const hasToolCalls = toolCalls.length > 0;
        
        const lastPlayed = activeConversations.has(convoId) ? activeConversations.get(convoId) : -1;
        
        if (isModelResponse && isDone) {
            if (step.step_index > lastPlayed) {
                if (!hasToolCalls) {
                    console.log(`AG Notify: Task completed for step index ${step.step_index} in ${convoId}.`);
                    activeConversations.set(convoId, step.step_index);
                    playSound('complete');
                } else {
                    // Mark as played so we don't trigger anything for intermediate tool execution steps
                    activeConversations.set(convoId, step.step_index);
                }
            }
        }
    } catch (err) {
        // Ignore parsing errors
    }
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
    }
}

function playSoundDirectly(sound) {
    // Safety fallback: if it is a premium sound but the user doesn't have an active premium license,
    // force reset to the default free pluck chime in both runtime and settings.
    const isPremiumSound = sound.endsWith('.mp3') && sound !== 'notification_pluck.mp3';
    if (isPremiumSound && !isPremiumActive()) {
        sound = 'notification_pluck.mp3';
        const config = vscode.workspace.getConfiguration('agNotify');
        config.update('soundOnCompleteType', 'notification_pluck.mp3', vscode.ConfigurationTarget.Global);
    }

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
        
        // Pass path safely via environment variable to prevent command injection
        const env = { ...process.env, AG_SOUND_PATH: soundPath };
        let psCommand;
        if (soundPath.endsWith('.mp3')) {
            psCommand = `Add-Type -AssemblyName PresentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([Uri]"$env:AG_SOUND_PATH"); $player.Play(); Start-Sleep -s 5`;
        } else {
            psCommand = `(New-Object Media.SoundPlayer "$env:AG_SOUND_PATH").PlaySync()`;
        }
        
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { env }, (error) => {
            if (error) console.error("AG Notify Error playing Windows sound:", error);
        });
    } else if (platform === 'darwin') {
        if (builtInSounds.includes(sound) || fs.existsSync(soundPath)) {
            execFile('afplay', [soundPath], (error) => {
                if (error) console.error("AG Notify Error playing macOS sound:", error);
            });
        } else {
            execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], (error) => {
                if (error) console.error("AG Notify Error playing macOS default sound:", error);
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
                if (error) console.error("AG Notify Error playing Linux default sound:", error);
            });
        }
    }
}

function openDashboard(context, target) {
    const panel = vscode.window.createWebviewPanel(
        'agNotifyDashboard',
        'AG Notify - Settings & Dashboard',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(context.extensionPath)]
        }
    );

    const iconUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'icon.png')));

    function getWebviewContent() {
        const config = vscode.workspace.getConfiguration('agNotify');
        const enabled = config.get('enabled', true);
        const completeEnabled = config.get('soundOnComplete', true);
        const isPremium = isPremiumActive();
        
        let activeSound = config.get('soundOnCompleteType', 'notification_pluck.mp3');
        
        // Safety validation: if user has a premium sound selected but premium is inactive, force fallback
        const isPremiumSound = activeSound.endsWith('.mp3') && activeSound !== 'notification_pluck.mp3';
        if (isPremiumSound && !isPremium) {
            activeSound = 'notification_pluck.mp3';
            config.update('soundOnCompleteType', 'notification_pluck.mp3', vscode.ConfigurationTarget.Global);
        }
        
        const escapedActiveSound = activeSound.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const licenseKey = config.get('premiumLicenseKey', '');
        const totalChimes = context.globalState.get('totalChimesPlayed', 0);

        const builtInSounds = [
            { id: 'notification_pluck.mp3', name: '⭐ Pluck Chime (Default)', desc: 'Soft and elegant organic pluck alert (Free)' },
            { id: 'smooth_stereo.mp3', name: '✨ Smooth Stereo (Premium)', desc: 'Wide stereo high-end chime' },
            { id: 'completed_alert.mp3', name: '✨ Task Completed (Premium)', desc: 'Rich synthesizer chime' },
            { id: 'intro_bell.mp3', name: '✨ Intro Sound Bell (Premium)', desc: 'Clear corporate-style bell' },
            { id: 'best_notification_1.mp3', name: '✨ Notification 1 (Premium)', desc: 'Optimized developer chime 1' },
            { id: 'best_notification_2.mp3', name: '✨ Notification 2 (Premium)', desc: 'Optimized developer chime 2' },
            { id: 'message_chime.mp3', name: '✨ Message Chime (Premium)', desc: 'Elegant alert for incoming chats' },
            { id: 'ding.mp3', name: '✨ Elegant Ding (Premium)', desc: 'Short classic premium bell sound' },
            { id: 'notification_alert.mp3', name: '✨ Notification Alert (Premium)', desc: 'Medium pitch notification' },
            { id: 'digital_alert.mp3', name: '✨ Digital Alert (Premium)', desc: 'High tech synth wave chime' },
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
            <title>AG Notify Dashboard</title>
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
                    --accent-gold: linear-gradient(135deg, #ffd700, #ffa500);
                    --accent-gold-glow: rgba(255, 215, 0, 0.3);
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
                    max-width: 1100px;
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
                    background: rgba(255, 255, 255, 0.08);
                    color: var(--text-secondary);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }

                .badge.premium {
                    background: var(--accent-gold);
                    color: #000;
                    box-shadow: 0 0 15px var(--accent-gold-glow);
                }

                /* Stats Row */
                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
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
                    font-size: 16px;
                    font-weight: 600;
                    color: #5dcdfc;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                /* Core Settings & Toggles */
                .main-layout {
                    display: grid;
                    grid-template-columns: 2fr 1fr;
                    gap: 25px;
                }

                @media (max-width: 900px) {
                    .main-layout {
                        grid-template-columns: 1fr;
                    }
                }

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

                .sound-card.premium-locked {
                    opacity: 0.65;
                    border-style: dashed;
                }

                .sound-card.active {
                    background: rgba(0, 122, 204, 0.1);
                    border-color: rgba(0, 122, 204, 0.4);
                    box-shadow: 0 0 10px rgba(0, 122, 204, 0.15);
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
                    gap: 8px;
                }

                .btn {
                    padding: 8px 12px;
                    border-radius: 8px;
                    font-size: 12px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: none;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 5px;
                }

                .btn-play {
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--text-primary);
                    flex: 1;
                }

                .btn-play:hover {
                    background: rgba(255, 255, 255, 0.12);
                }

                .btn-use {
                    background: var(--accent-blue);
                    color: #fff;
                    flex: 1.5;
                }

                .btn-use:hover {
                    background: #0088e0;
                }

                .sound-card.active .btn-use {
                    background: rgba(0, 229, 255, 0.2);
                    color: var(--accent-cyan);
                    cursor: default;
                    pointer-events: none;
                }

                /* Sidebar Panel */
                .sidebar-pane {
                    display: flex;
                    flex-direction: column;
                    gap: 20px;
                }

                .side-card {
                    background: var(--card-bg);
                    border: 1px solid var(--border-color);
                    border-radius: 20px;
                    padding: 24px;
                    backdrop-filter: blur(8px);
                }

                /* License Key Form */
                .license-form {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    margin-top: 15px;
                }

                .license-input-wrapper {
                    position: relative;
                }

                .license-input {
                    width: 100%;
                    padding: 12px 14px;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 10px;
                    color: var(--text-primary);
                    font-size: 14px;
                    font-weight: 600;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    transition: border-color 0.2s ease;
                }

                .license-input:focus {
                    outline: none;
                    border-color: var(--accent-cyan);
                }

                .btn-activate {
                    background: var(--accent-gold);
                    color: #000;
                    font-weight: 700;
                    padding: 12px;
                    width: 100%;
                    border-radius: 10px;
                    font-size: 13px;
                }

                .btn-activate:hover {
                    opacity: 0.9;
                    box-shadow: 0 0 10px rgba(255, 215, 0, 0.2);
                }

                /* Support & Sponsors section */
                .sponsor-btn {
                    padding: 12px;
                    border-radius: 10px;
                    font-size: 13px;
                    font-weight: 700;
                    text-decoration: none;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    transition: transform 0.2s ease, opacity 0.2s ease;
                    margin-top: 10px;
                    width: 100%;
                }

                .sponsor-btn:hover {
                    transform: translateY(-1px);
                }

                .btn-monobank {
                    background: #e9232c;
                    color: #fff;
                }

                .btn-patreon {
                    background: #f96854;
                    color: #fff;
                }

                .btn-lemonsqueezy {
                    background: #eef2f6;
                    color: #000;
                    border: 1px solid rgba(0,0,0,0.1);
                }

                .btn-paypal {
                    background: #003087;
                    color: #fff;
                }

                .sponsor-desc {
                    font-size: 12px;
                    color: var(--text-secondary);
                    line-height: 1.5;
                    margin-top: 10px;
                    text-align: center;
                }

                .sponsor-item {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    margin-top: 15px;
                }
                .sponsor-tag {
                    font-size: 11px;
                    font-weight: 800;
                    letter-spacing: 0.8px;
                    text-transform: uppercase;
                    padding: 3px 8px;
                    border-radius: 4px;
                    width: fit-content;
                }
                .tag-one-time {
                    background: rgba(93, 205, 252, 0.12);
                    color: #5dcdfc;
                    border: 1px solid rgba(93, 205, 252, 0.2);
                }
                .tag-subscription {
                    background: rgba(249, 104, 84, 0.12);
                    color: #f96854;
                    border: 1px solid rgba(249, 104, 84, 0.2);
                }
                .tag-license {
                    background: rgba(255, 215, 0, 0.1);
                    color: #ffd700;
                    border: 1px solid rgba(255, 215, 0, 0.2);
                }
                .sponsor-subtext {
                    font-size: 11px;
                    color: var(--text-secondary);
                    margin-top: 2px;
                    line-height: 1.4;
                }

                /* Feedback Messages */
                .toast {
                    padding: 10px 14px;
                    border-radius: 8px;
                    font-size: 12px;
                    font-weight: 600;
                    text-align: center;
                    display: none;
                    margin-top: 10px;
                }
                .toast.success {
                    background: rgba(46, 204, 113, 0.15);
                    color: #2ecc71;
                    border: 1px solid rgba(46, 204, 113, 0.3);
                }
                .toast.error {
                    background: rgba(231, 76, 60, 0.15);
                    color: #e74c3c;
                    border: 1px solid rgba(231, 76, 60, 0.3);
                }

                .custom-sound-box {
                    display: flex;
                    gap: 10px;
                    margin-top: 15px;
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
            </style>
        </head>
        <body>
            <div class="container">
                <!-- Branding Header -->
                <div class="header-card">
                    <div class="brand">
                        <img class="brand-img" src="${iconUri}" alt="AG Notify Icon">
                        <div class="brand-info">
                            <h1>AG Notify</h1>
                            <p>Premium task completion sound orchestrator for Antigravity Agent</p>
                        </div>
                    </div>
                    <div id="licenseBadge" class="badge ${isPremium ? 'premium' : 'free'}">
                        ${isPremium ? '✨ Premium Active' : '🎁 Free Version'}
                    </div>
                </div>

                <!-- Stats Summary Row -->
                <div class="stats-grid">
                    <div class="stat-card">
                        <span class="stat-label">Total Alerts Played</span>
                        <span id="totalChimesPlayed" class="stat-val">${totalChimes}</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-label">Current Chime Path</span>
                        <span id="currentChimeName" class="stat-val active-sound">${activeSound}</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-label">Status</span>
                        <span id="premiumStatusText" class="stat-val" style="font-size: 20px; color: ${isPremium ? '#ffd700' : 'var(--text-secondary)'}">
                            ${isPremium ? '✨ Premium Unlocked' : 'Ad-Supported Free'}
                        </span>
                    </div>
                </div>

                <div class="main-layout">
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
                        </div>

                        <!-- Sound Library Grid -->
                        <div class="sounds-section">
                            <div class="section-title">🎵 Notification Sound Library</div>
                            <p style="font-size: 13px; color: var(--text-secondary); margin-top: 5px;">
                                Explore built-in premium MP3 alerts. Select "Set Active" to use it as your default completion alert.
                            </p>
                            
                            <div class="sounds-grid">
                                ${builtInSounds.map(s => {
                                    const isSelected = activeSound === s.id;
                                    const isPremiumSound = s.id.endsWith('.mp3') && s.id !== 'notification_pluck.mp3';
                                    const isLocked = isPremiumSound && !isPremium;
                                    return `
                                    <div class="sound-card ${isSelected ? 'active' : ''} ${isLocked ? 'premium-locked' : ''}" id="sound-${s.id}">
                                        <div class="sound-info">
                                            <h4>
                                                ${s.name}
                                                ${isLocked ? '<span style="color:#ffd700; font-size:10px;">[Premium Locked]</span>' : ''}
                                            </h4>
                                            <p>${s.desc}</p>
                                        </div>
                                        <div class="sound-actions">
                                            <button class="btn btn-play" onclick="previewSound('${s.id}')">
                                                ▶ Play
                                            </button>
                                            <button class="btn btn-use" onclick="useSound('${s.id}', ${isLocked})">
                                                ${isSelected ? 'Active' : 'Set Active'}
                                            </button>
                                        </div>
                                    </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>

                        <!-- Custom sound selector -->
                        <div class="custom-sound-section" style="margin-top: 15px;">
                            <div class="section-title" style="font-size: 15px;">📁 Use Custom Sound File Path</div>
                            <div class="custom-sound-box">
                                <input type="text" id="customSoundPath" placeholder="C:\\Path\\To\\CustomSound.wav or .mp3" value="${!builtInSounds.some(s => s.id === activeSound) ? escapedActiveSound : ''}">
                                <button onclick="saveCustomSound()">Save Path</button>
                            </div>
                        </div>
                    </div>

                    <!-- Sidebar content: license keys, checkout URLs -->
                    <div class="sidebar-pane">
                        <div class="side-card" id="licenseSection">
                            <h3 class="section-title" id="sidebarTitle">${isPremium ? '✨ Premium Active' : '🎁 Unlock Premium Feature Pack'}</h3>
                            <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-top: 5px;">
                                Get premium keys, remove promotional pop-ups, and enjoy 10 high-fidelity MP3 soundscapes!
                            </p>

                            <div id="licenseBox" style="display: ${isPremium ? 'none' : 'block'};" class="license-form">
                                <div class="license-input-wrapper">
                                    <input type="text" id="licenseKeyInput" class="license-input" placeholder="AGN-XXXX-XXXX" value="${licenseKey}">
                                </div>
                                <button class="btn btn-activate" onclick="activateLicense()">Activate License Key</button>
                            </div>

                            <div id="toastMessage" class="toast"></div>

                            <div id="premiumSponsorDetails" style="display: ${isPremium ? 'block' : 'none'}; margin-top: 15px;">
                                <p style="font-size: 13px; color: #2ecc71; font-weight: 600;">
                                    Thank you! Your premium status is active. All weekly ad notifications have been permanently disabled. 💖
                                </p>
                            </div>
                        </div>

                        <div class="side-card" id="sponsorSection">
                            <h3 class="section-title">💖 Support & Sponsors</h3>
                            <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-top: 5px;">
                                Choose a convenient way to support the developer and activate premium features:
                            </p>

                            <!-- Lemon Squeezy (License Key) -->
                            <div class="sponsor-item">
                                <span class="sponsor-tag tag-license">🔑 License Key (Lifetime)</span>
                                <a href="https://agnotify.lemonsqueezy.com/checkout/buy/6ea511d7-3ee0-4561-b65b-b792fbc07322" class="sponsor-btn btn-lemonsqueezy" target="_blank" style="margin-top: 4px;">
                                    🍋 Lemon Squeezy Checkout (~$3.00)
                                </a>
                                <span class="sponsor-subtext">One-time purchase. The premium license key is delivered to your email and checkout screen instantly.</span>
                            </div>

                            <!-- Patreon (Subscription) -->
                            <div class="sponsor-item">
                                <span class="sponsor-tag tag-subscription">✨ Subscription (Monthly)</span>
                                <a href="https://www.patreon.com/LyTblu7/membership" class="sponsor-btn btn-patreon" target="_blank" style="margin-top: 4px;">
                                    🧡 Patreon Support ($1.99/mo)
                                </a>
                                <span class="sponsor-subtext">Monthly recurring support. Your unique premium license key will be automatically sent to your email after subscribing.</span>
                            </div>

                            <!-- Monobank & PayPal (One-time Coffee) -->
                            <div class="sponsor-item">
                                <span class="sponsor-tag tag-one-time">☕ Tips</span>
                                <a href="https://send.monobank.ua/jar/5Lpdn6ThL" class="sponsor-btn btn-monobank" target="_blank" style="margin-top: 4px;">
                                    🐱 Monobank Jar (На каву)
                                </a>
                                <a href="https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=myshopandmyl1fe@gmail.com&currency_code=USD&item_name=AG-Notify%20Coffee%20Tip" class="sponsor-btn btn-paypal" target="_blank" style="margin-top: 4px;">
                                    💙 Support via PayPal
                                </a>
                                <span class="sponsor-subtext">One-time voluntary support. Does not issue an automatic premium license key.</span>
                            </div>

                            <!-- Future Updates Note -->
                            <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--border-color); font-size: 12px; color: var(--text-secondary); line-height: 1.4; text-align: center;">
                                🚀 <strong>Continuous Updates:</strong> The extension will be actively maintained. New focus-saving features and high-fidelity sound alert packs will be added in upcoming releases!
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

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

                function useSound(soundId, isLocked) {
                    if (isLocked) {
                        showToast("❌ This sound is locked. Activate a Premium License Key to unlock all premium MP3 sounds!", "error");
                        return;
                    }
                    vscode.postMessage({
                        command: 'useSound',
                        sound: soundId
                    });
                }

                function saveCustomSound() {
                    const customPath = document.getElementById('customSoundPath').value.trim();
                    if (!customPath) return;
                    vscode.postMessage({
                        command: 'useSound',
                        sound: customPath
                    });
                }

                function activateLicense() {
                    const key = document.getElementById('licenseKeyInput').value.trim();
                    if (!key) {
                        showToast("❌ Please enter a license key.", "error");
                        return;
                    }
                    vscode.postMessage({
                        command: 'activateLicense',
                        key: key
                    });
                }

                function showToast(message, type) {
                    const toast = document.getElementById('toastMessage');
                    toast.innerText = message;
                    toast.className = 'toast ' + type;
                    toast.style.display = 'block';
                    setTimeout(() => {
                        toast.style.display = 'none';
                    }, 5000);
                }

                // Handle messages sent from the extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'licenseActivated':
                            // Real-time page upgrade animation
                            document.getElementById('licenseBadge').className = 'badge premium';
                            document.getElementById('licenseBadge').innerText = '✨ Premium Active';
                            document.getElementById('premiumStatusText').innerText = '✨ Premium Unlocked';
                            document.getElementById('premiumStatusText').style.color = '#ffd700';
                            document.getElementById('sidebarTitle').innerText = '✨ Premium Active';
                            document.getElementById('licenseBox').style.display = 'none';
                            document.getElementById('premiumSponsorDetails').style.display = 'block';
                            
                            // Unlock all locked premium cards in real-time
                            const cards = document.querySelectorAll('.sound-card');
                            cards.forEach(card => {
                                card.classList.remove('premium-locked');
                                const lockSpan = card.querySelector('span');
                                if (lockSpan && lockSpan.innerText.includes('Premium Locked')) {
                                    lockSpan.remove();
                                }
                                // Fix use buttons that might have been locked
                                const useBtn = card.querySelector('.btn-use');
                                if (useBtn) {
                                    const soundId = card.id.replace('sound-', '');
                                    useBtn.setAttribute('onclick', 'useSound("' + soundId + '", false)');
                                }
                            });

                            showToast("✨ Premium license successfully activated! Enjoy your premium sounds!", "success");
                            break;
                        case 'licenseFailed':
                            showToast(message.reason || "❌ Invalid license key. Please check the spelling.", "error");
                            break;
                        case 'updateChimeStats':
                            document.getElementById('totalChimesPlayed').innerText = message.count;
                            break;
                        case 'soundChanged':
                            // Update active states
                            document.querySelectorAll('.sound-card').forEach(card => {
                                card.classList.remove('active');
                                const btnUse = card.querySelector('.btn-use');
                                if (btnUse) {
                                    btnUse.innerText = 'Set Active';
                                }
                            });
                            
                            const activeCard = document.getElementById('sound-' + message.sound);
                            if (activeCard) {
                                activeCard.classList.add('active');
                                const activeUseBtn = activeCard.querySelector('.btn-use');
                                if (activeUseBtn) {
                                    activeUseBtn.innerText = 'Active';
                                }
                            }
                            
                            document.getElementById('currentChimeName').innerText = message.sound;
                            break;
                    }
                });

                // Auto-scroll target execution
                window.addEventListener('DOMContentLoaded', () => {
                    const target = "${target || ''}";
                    if (target === 'sponsors') {
                        const sEl = document.getElementById('sponsorSection');
                        if (sEl) {
                            setTimeout(() => {
                                sEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                sEl.style.outline = '2px solid var(--accent-cyan)';
                                sEl.style.transition = 'outline 0.5s';
                                setTimeout(() => sEl.style.outline = 'none', 2000);
                            }, 300);
                        }
                    } else if (target === 'license') {
                        const lEl = document.getElementById('licenseSection');
                        if (lEl) {
                            setTimeout(() => {
                                lEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                const input = document.getElementById('licenseKeyInput');
                                if (input) {
                                    input.focus();
                                    input.style.boxShadow = '0 0 10px var(--accent-cyan)';
                                    setTimeout(() => input.style.boxShadow = 'none', 2000);
                                }
                            }, 300);
                        }
                    }
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
                case 'updateSetting':
                    const allowedKeys = ['enabled', 'soundOnComplete'];
                    if (allowedKeys.includes(message.key)) {
                        await config.update(message.key, message.value, vscode.ConfigurationTarget.Global);
                        updateStatusBar();
                    }
                    break;
                case 'previewSound':
                    playSoundDirectly(message.sound);
                    break;
                case 'useSound':
                    await config.update('soundOnCompleteType', message.sound, vscode.ConfigurationTarget.Global);
                    updateStatusBar();
                    panel.webview.postMessage({
                        command: 'soundChanged',
                        sound: message.sound
                    });
                    break;
                case 'activateLicense':
                    if (!validateLicenseKey(message.key)) {
                        panel.webview.postMessage({ command: 'licenseFailed' });
                        break;
                    }
                    const activationResult = await activateKeyOnServer(message.key);
                    if (activationResult.success) {
                        await config.update('premiumLicenseKey', message.key.trim().toUpperCase(), vscode.ConfigurationTarget.Global);
                        updateStatusBar();
                        panel.webview.postMessage({ command: 'licenseActivated' });
                    } else if (activationResult.reason === 'device_limit') {
                        panel.webview.postMessage({ command: 'licenseFailed', reason: `Device limit reached (${activationResult.max} max). Deactivate another device first.` });
                    } else if (activationResult.reason === 'offline_no_cache') {
                        panel.webview.postMessage({ command: 'licenseFailed', reason: 'Internet required for first activation.' });
                    } else {
                        panel.webview.postMessage({ command: 'licenseFailed' });
                    }
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
                const totalChimes = context.globalState.get('totalChimesPlayed', 0);
                panel.webview.postMessage({
                    command: 'updateChimeStats',
                    count: totalChimes
                });
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
