const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const activeConversations = new Map(); // convoId -> lastPlayedStep
const seenFilesMtime = new Map(); // filePath -> mtimeMs
let statusBarItem;
let conversationCheckInterval = null;
let isStartupPhase = true;
let extensionPath = ''; // Store extension directory path dynamically

/**
 * Validates the offline premium license key mathematically.
 * Format: AGN-XXXX-XXXX where sum of ASCII values of character blocks modulo 10 equals 7.
 * Example of valid keys you can generate for sponsors:
 * AGN-A1B2-C3D4 (Sum of characters "A1B2C3D4" is 447, 447 % 10 = 7)
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

function activate(context) {
    console.log('AG Notify extension is now active!');
    extensionPath = context.extensionPath;
    
    createStatusBarItem(context);
    setupPollingWatcher(context);
    
    // Check premium status and show support prompt every 5 days for non-premium users
    checkPremiumStatusAndPrompt(context);
    
    // Register commands
    const toggleCmd = vscode.commands.registerCommand('agNotify.toggle', async () => {
        const config = vscode.workspace.getConfiguration('agNotify');
        const enabled = config.get('enabled', true);
        const completeEnabled = config.get('soundOnComplete', true);
        const licenseKey = config.get('premiumLicenseKey', '');
        const isPremium = validateLicenseKey(licenseKey);
        
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
            playSoundDirectly(config.get('soundOnCompleteType', 'minimal_chime.wav'));
        } else if (selection.action === 'premium_license') {
            await promptForLicenseKey();
        } else if (selection.action === 'choose_complete') {
            const sounds = [
                { label: "✨ Premium: Minimal Chime (Recommended)", description: "minimal_chime.wav" },
                { label: "✨ Premium: Success Bell", description: "success_bell.wav" },
                { label: "✨ Premium: Agent Cosmic Sweep", description: "agent_done.wav" },
                { label: "Modern Windows 11 Notify", description: "Windows Notify System Generic.wav" },
                { label: "Modern Windows Quiet Note", description: "Windows Information Bar.wav" },
                { label: "Notification Chirp", description: "notify.wav" },
                { label: "Classic Chimes", description: "chimes.wav" },
                { label: "Soft Bubble", description: "Windows Background.wav" },
                { label: "Nudge Sound", description: "Windows Message Nudge.wav" },
                { label: "Tada Fanfare", description: "tada.wav" },
                { label: "Speech On Chirp", description: "Speech On.wav" },
                { label: "Custom .wav file path...", description: "Specify a full path to your own WAV file" }
            ];
            
            const chosen = await vscode.window.showQuickPick(sounds, {
                placeHolder: `Select sound for Completion`
            });
            
            if (chosen) {
                let targetSound = chosen.description;
                if (chosen.label === "Custom .wav file path...") {
                    const customPath = await vscode.window.showInputBox({
                        prompt: `Enter the absolute path to your custom .wav file for complete`,
                        placeHolder: "C:\\path\\to\\sound.wav"
                    });
                    if (customPath) {
                        targetSound = customPath;
                    } else {
                        return;
                    }
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
        playSoundDirectly(config.get('soundOnCompleteType', 'minimal_chime.wav'));
    });
    
    const enterLicenseCmd = vscode.commands.registerCommand('agNotify.enterLicense', async () => {
        await promptForLicenseKey();
    });
    
    context.subscriptions.push(toggleCmd);
    context.subscriptions.push(playTestCmd);
    context.subscriptions.push(enterLicenseCmd);
    
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
    statusBarItem.command = 'agNotify.toggle';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}

function updateStatusBar() {
    if (!statusBarItem) return;
    
    const config = vscode.workspace.getConfiguration('agNotify');
    const enabled = config.get('enabled', true);
    const licenseKey = config.get('premiumLicenseKey', '');
    const isPremium = validateLicenseKey(licenseKey);
    
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
        if (validateLicenseKey(entered)) {
            await config.update('premiumLicenseKey', entered.trim().toUpperCase(), vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("✨ AG Notify Premium successfully activated! Thank you for your support! 💖");
            updateStatusBar();
        } else {
            vscode.window.showErrorMessage("❌ Invalid license key. Please check and try again.");
        }
    }
}

function checkPremiumStatusAndPrompt(context) {
    const config = vscode.workspace.getConfiguration('agNotify');
    const licenseKey = config.get('premiumLicenseKey', '');
    const isPremium = validateLicenseKey(licenseKey);
    
    if (isPremium) {
        return; // Premium users enjoy a lifetime of zero ads!
    }
    
    const lastAdTime = context.globalState.get('lastAdTime', 0);
    const now = Date.now();
    const fiveDaysInMs = 5 * 24 * 60 * 60 * 1000;
    
    if (now - lastAdTime > fiveDaysInMs) {
        // Update last ad shown time immediately
        context.globalState.update('lastAdTime', now);
        
        vscode.window.showInformationMessage(
            "Enjoying AG Notify? Support the developer on Patreon/Lemon Squeezy to unlock exclusive features and get a Premium Badge! 💖",
            "Support / Get Key",
            "Enter License Key",
            "Maybe Later"
        ).then(async (selection) => {
            if (selection === "Support / Get Key") {
                // Link to Patreon/Gumroad
                vscode.env.openExternal(vscode.Uri.parse("https://github.com/LyTblu7/AG-Notify#support--premium"));
            } else if (selection === "Enter License Key") {
                await promptForLicenseKey();
            }
        });
    }
}

function setupPollingWatcher(context) {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
    
    if (!fs.existsSync(brainDir)) {
        console.log("AG Notify: Brain directory does not exist yet. Retrying in 5 seconds...");
        setTimeout(() => setupPollingWatcher(context), 5000);
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
}

function scanAndProcessAllTranscripts(brainDir) {
    try {
        const convos = fs.readdirSync(brainDir);
        for (const convoId of convos) {
            if (convoId === 'tempmediaStorage') continue;
            
            const logsDir = path.join(brainDir, convoId, '.system_generated', 'logs');
            const transcriptPath = path.join(logsDir, 'transcript.jsonl');
            
            if (fs.existsSync(transcriptPath)) {
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
    } catch (err) {
        console.error("AG Notify error in polling scan:", err);
    }
}

function getLastStepIndex(filePath) {
    try {
        if (!fs.existsSync(filePath)) return -1;
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) return -1;
        
        const lines = content.split('\n');
        const lastLineStr = lines[lines.length - 1].trim();
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
        if (!fs.existsSync(filePath)) return;
        
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) return;
        
        const lines = content.split('\n');
        const lastLineStr = lines[lines.length - 1].trim();
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
        playSoundDirectly(config.get('soundOnCompleteType', 'minimal_chime.wav'));
    }
}

function playSoundDirectly(sound) {
    const platform = process.platform;
    const builtInSounds = ['minimal_chime.wav', 'success_bell.wav', 'agent_done.wav'];
    
    let soundPath = sound;
    if (builtInSounds.includes(sound)) {
        soundPath = path.join(extensionPath, 'sounds', sound);
    }
    
    if (platform === 'win32') {
        if (!soundPath.includes('\\') && !soundPath.includes(':')) {
            soundPath = path.join('C:\\Windows\\Media', soundPath);
        }
        
        const psCommand = `(New-Object Media.SoundPlayer '${soundPath}').PlaySync()`;
        exec(`powershell -c "${psCommand}"`, (error) => {
            if (error) console.error("AG Notify Error playing Windows sound:", error);
        });
    } else if (platform === 'darwin') {
        const cmd = builtInSounds.includes(sound) ? `afplay "${soundPath}"` : 'afplay /System/Library/Sounds/Glass.aiff';
        exec(cmd);
    } else {
        const cmd = builtInSounds.includes(sound) ? `aplay "${soundPath}"` : 'aplay /usr/share/sounds/alsa/Front_Center.wav';
        exec(cmd);
    }
}

module.exports = {
    activate,
    deactivate
};
