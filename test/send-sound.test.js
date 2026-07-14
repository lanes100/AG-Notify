const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

test('send and completion sounds are deduplicated and never start together', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-notify-test-'));
    const homeDir = path.join(testRoot, 'home');
    const lockDir = path.join(testRoot, 'locks');
    const transcriptPath = path.join(
        homeDir,
        '.gemini',
        'antigravity-ide',
        'brain',
        'conversation-1',
        '.system_generated',
        'logs',
        'transcript.jsonl'
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.mkdirSync(lockDir, { recursive: true });

    const playbackCalls = [];
    const vscodeMock = {
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => {
                    if (key === 'enabled' || key === 'soundOnSend') return true;
                    return fallback;
                }
            })
        }
    };
    const osMock = { ...os, homedir: () => homeDir, tmpdir: () => lockDir };
    const childProcessMock = {
        exec: () => {},
        execFile: (...args) => playbackCalls.push(args)
    };

    const source = `${fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8')}
        module.exports.__test = {
            activeConversations,
            checkAndPlaySound,
            processConversationDatabase,
            setupConversationDatabaseWatcher,
            stopWatching
        };`;
    const moduleMock = { exports: {} };
    const sandbox = {
        Buffer,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        module: moduleMock,
        exports: moduleMock.exports,
        process,
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        require: (id) => {
            if (id === 'vscode') return vscodeMock;
            if (id === 'os') return osMock;
            if (id === 'child_process') return childProcessMock;
            return require(id);
        }
    };

    try {
        vm.runInNewContext(source, sandbox, { filename: 'extension.js' });
        const {
            activeConversations,
            checkAndPlaySound,
            processConversationDatabase,
            setupConversationDatabaseWatcher,
            stopWatching
        } = moduleMock.exports.__test;
        const appendStep = step => fs.appendFileSync(transcriptPath, `${JSON.stringify(step)}\n`);

        activeConversations.set('conversation-1', -1);
        appendStep({ step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE' });

        checkAndPlaySound(transcriptPath, 'conversation-1');
        assert.equal(playbackCalls.length, 1, 'the send sound is started synchronously');

        checkAndPlaySound(transcriptPath, 'conversation-1');
        assert.equal(playbackCalls.length, 1, 'rescanning the same send does not replay it');

        appendStep({
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            tool_calls: [{ name: 'run_command' }]
        });
        appendStep({ step_index: 3, type: 'RUN_COMMAND', source: 'MODEL', status: 'DONE' });
        checkAndPlaySound(transcriptPath, 'conversation-1');
        assert.equal(playbackCalls.length, 1, 'model thinking and tool steps do not play send sounds');

        appendStep({ step_index: 4, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE' });
        checkAndPlaySound(transcriptPath, 'conversation-1');
        assert.equal(playbackCalls.length, 2, 'the next unique send plays exactly once');

        appendStep({
            step_index: 5,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            tool_calls: []
        });
        checkAndPlaySound(transcriptPath, 'conversation-1');
        assert.equal(playbackCalls.length, 2, 'completion does not start alongside the send sound');
        await new Promise(resolve => setTimeout(resolve, 700));
        assert.equal(playbackCalls.length, 3, 'a settled final response plays one completion sound');

        appendStep({ step_index: 6, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE' });
        appendStep({
            step_index: 7,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            tool_calls: []
        });
        checkAndPlaySound(transcriptPath, 'conversation-1');
        assert.equal(playbackCalls.length, 4, 'a batched send still starts only its outgoing sound immediately');
        await new Promise(resolve => setTimeout(resolve, 700));
        assert.equal(playbackCalls.length, 5, 'the batched final response settles before its incoming sound');

        appendStep({
            step_index: 8,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            tool_calls: []
        });
        checkAndPlaySound(transcriptPath, 'conversation-1');
        appendStep({ step_index: 9, type: 'RUN_COMMAND', source: 'MODEL', status: 'DONE' });
        checkAndPlaySound(transcriptPath, 'conversation-1');
        await new Promise(resolve => setTimeout(resolve, 700));
        assert.equal(playbackCalls.length, 5, 'later agent activity cancels a false completion candidate');

        const databasePath = path.join(testRoot, 'database-conversation.db');
        let database = new DatabaseSync(databasePath);
        database.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL)');
        database.exec('INSERT INTO steps (idx, step_type) VALUES (0, 14)');
        database.close();
        assert.equal(processConversationDatabase(databasePath, false), true);
        assert.equal(playbackCalls.length, 5, 'existing database sends are only indexed at startup');

        database = new DatabaseSync(databasePath);
        database.exec('INSERT INTO steps (idx, step_type) VALUES (1, 15)');
        database.close();
        assert.equal(processConversationDatabase(databasePath, true), true);
        assert.equal(playbackCalls.length, 5, 'new model database rows do not play outgoing sounds');

        database = new DatabaseSync(databasePath);
        database.exec('INSERT INTO steps (idx, step_type) VALUES (2, 14)');
        database.close();
        assert.equal(processConversationDatabase(databasePath, true), true);
        assert.equal(playbackCalls.length, 6, 'a new database USER_INPUT plays immediately');
        processConversationDatabase(databasePath, true);
        assert.equal(playbackCalls.length, 6, 'rescanning the database USER_INPUT does not replay it');

        const watchedDirectory = path.join(homeDir, '.gemini', 'antigravity-ide', 'conversations');
        const watchedDatabasePath = path.join(watchedDirectory, 'watched-conversation.db');
        fs.mkdirSync(watchedDirectory, { recursive: true });
        database = new DatabaseSync(watchedDatabasePath);
        database.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL)');
        database.exec('INSERT INTO steps (idx, step_type) VALUES (0, 14)');
        database.close();
        setupConversationDatabaseWatcher();

        database = new DatabaseSync(watchedDatabasePath);
        database.exec('INSERT INTO steps (idx, step_type) VALUES (1, 15)');
        database.close();
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(playbackCalls.length, 6, 'the live watcher ignores model database writes');

        database = new DatabaseSync(watchedDatabasePath);
        database.exec('INSERT INTO steps (idx, step_type) VALUES (2, 14)');
        database.close();
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(playbackCalls.length, 7, 'the live watcher catches USER_INPUT before transcript fallback');
        stopWatching();
    } finally {
        if (moduleMock.exports.__test) {
            moduleMock.exports.__test.stopWatching();
        }
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});
