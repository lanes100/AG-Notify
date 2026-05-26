# AG Notify - VS Code Sound Notification Extension

AG Notify is a lightweight VS Code extension developed exclusively for the Antigravity IDE. It automatically plays a Windows notification sound whenever the Antigravity Agent completes a request, keeping you informed in the background without needing to watch the chat window.

## 🚀 Features

- **Automatic Sound Notifications:** Instantly plays a notification sound as soon as the Antigravity agent finishes thinking and writing code.
- **Polished Status Bar Control:** Adds a sleek `$(bell) AG Notify` indicator to the status bar.
- **Interactive Control Menu:** Click the status bar indicator to:
  - Play a test notification sound.
  - Choose between different Windows system sounds (`Asterisk`, `Beep`, `Exclamation`, `Hand`, `Question`).
  - Instantly mute/unmute notifications.
- **Highly Configurable:** Fully custom settings available in standard VS Code settings.
- **Cross-platform Friendly:** Primarily optimized for Windows, with native fail-safe support for macOS (`afplay`) and Linux (`aplay`).

## 🛠️ Installation

Simply search for **`AG Notify`** in the Antigravity IDE extensions marketplace and click **Install**. 

Alternatively, if installing from a `.vsix` package:
1. Open the Extensions view (`Ctrl+Shift+X`).
2. Click the `...` (More Actions) button in the top-right corner.
3. Select **Install from VSIX...** and select the packaged `.vsix` file.

## ⚙️ Extension Settings

This extension contributes the following settings:

* `agNotify.enabled`: Global toggle to enable or disable all sound notifications (default: `true`).
* `agNotify.soundOnComplete`: Enable/disable sound when agent finishes its final response (default: `true`).
* `agNotify.soundOnCompleteType`: Choose the WAV file in `C:\Windows\Media` or specify an absolute path to play (default: `"Windows Notify System Generic.wav"`).
