import { useCallback, useEffect, useRef, useState } from 'react';
import {
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import SSHClient from '@dylankenneally/react-native-ssh-sftp';

const PROMPT = 'PS > ';
const INPUT_ACCESSORY_ID = 'forge-lite-keyboard-dismiss';
const STORAGE_KEY = 'forge_lite_ssh_key';
const BG = '#000000';
const FG = '#CCCCCC';
const MAX_HISTORY = 50;

const STARTUP_TEXT =
  'Forge Lite v1.0\n' +
  'Copyright (C) Sentinel Prime. All rights reserved.\n\n' +
  'Install the latest Sentinel: https://sentinelprime.org\n\n' +
  'Commands:\n' +
  '  ssh user@host        Connect to a remote machine\n' +
  '  ssh-add              Import an SSH private key\n' +
  '  ssh-keys             List stored keys\n' +
  "  ssh-remove [n]       Remove a stored key\n\n" +
  PROMPT;

const MONO_FONT = Platform.select({
  ios: 'Courier New',
  android: 'monospace',
  default: 'monospace',
});

function formatKeyDate(iso) {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

async function loadStoredKey() {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.key) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function saveStoredKey(keyMaterial) {
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      key: keyMaterial,
      addedAt: new Date().toISOString(),
    }),
  );
}

async function clearStoredKey() {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

function parseSshCommand(line) {
  const trimmed = line.trim();
  if (!trimmed.toLowerCase().startsWith('ssh ')) {
    return { type: 'not_ssh' };
  }

  const tokens = trimmed.split(/\s+/).slice(1);
  let port = 22;
  const parts = [];

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '-p' && tokens[i + 1]) {
      port = parseInt(tokens[i + 1], 10) || 22;
      i += 1;
      continue;
    }
    parts.push(tokens[i]);
  }

  if (parts.length !== 1) {
    return { type: 'invalid' };
  }

  if (!parts[0].includes('@')) {
    return { type: 'missing_username' };
  }

  const at = parts[0].indexOf('@');
  const username = parts[0].slice(0, at);
  const host = parts[0].slice(at + 1);

  if (!username || !host) {
    return { type: 'missing_username' };
  }

  return { type: 'ok', username, host, port };
}

function parseRemoveIndex(line) {
  const match = line.trim().match(/^ssh-remove(?:\s+(\d+))?$/i);
  if (!match) return null;
  return match[1] ? parseInt(match[1], 10) : null;
}

export default function App() {
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const sshClientRef = useRef(null);
  const historyRef = useRef([]);
  const keyPasteLinesRef = useRef([]);

  const [mode, setMode] = useState('local');
  const [output, setOutput] = useState(STARTUP_TEXT);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(null);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((visible) => !visible);
    }, 530);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [output, input, mode]);

  const appendOutput = useCallback((chunk) => {
    if (!chunk) return;
    setOutput((prev) => prev + chunk);
  }, []);

  const writeToShell = useCallback((text) => {
    const client = sshClientRef.current;
    if (!client) return;
    client.writeToShell(text).catch((error) => {
      appendOutput(`\n${error}`);
    });
  }, [appendOutput]);

  const pushHistory = useCallback((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const next = historyRef.current.filter((entry) => entry !== trimmed);
    next.push(trimmed);
    if (next.length > MAX_HISTORY) {
      next.shift();
    }
    historyRef.current = next;
  }, []);

  const disconnect = useCallback(() => {
    const client = sshClientRef.current;
    if (client) {
      try {
        client.closeShell();
      } catch {
        /* ignore */
      }
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
    }
    sshClientRef.current = null;
    setMode('local');
    setPending(null);
    setInput('');
  }, []);

  const establishShell = useCallback(
    async (client) => {
      client.on('Shell', (data) => {
        if (data) appendOutput(data);
      });
      await client.startShell('vanilla');
      sshClientRef.current = client;
      setMode('ssh');
      setPending(null);
      setInput('');
    },
    [appendOutput],
  );

  const connectWithPassword = useCallback(
    async (target, password) => {
      const client = await SSHClient.connectWithPassword(
        target.host,
        target.port,
        target.username,
        password,
      );
      await establishShell(client);
    },
    [establishShell],
  );

  const connectWithKey = useCallback(
    async (target, privateKey, passphrase = '') => {
      const client = await SSHClient.connectWithKey(
        target.host,
        target.port,
        target.username,
        privateKey,
        passphrase,
      );
      await establishShell(client);
    },
    [establishShell],
  );

  const beginSshConnect = useCallback(
    async (target) => {
      const stored = await loadStoredKey();

      if (stored?.key) {
        appendOutput(`Connecting to ${target.host}:${target.port}...\n`);

        try {
          await connectWithKey(target, stored.key);
          return;
        } catch {
          setPending({ ...target, keyAuthFailed: true });
          setMode('password');
          appendOutput(
            `Key auth failed. Password for ${target.username}@${target.host}: `,
          );
          return;
        }
      }

      setPending(target);
      setMode('password');
      appendOutput(`${target.username}@${target.host}'s password: `);
    },
    [appendOutput, connectWithKey],
  );

  const saveKeyMaterial = useCallback(
    async (keyMaterial) => {
      setMode('local');

      if (!keyMaterial) {
        appendOutput('Error: no key provided.\n\n');
        appendOutput(PROMPT);
        return;
      }

      if (!keyMaterial.includes('-----BEGIN')) {
        appendOutput(
          'Error: not a valid private key. Must begin with -----BEGIN\n\n',
        );
        appendOutput(PROMPT);
        return;
      }

      await saveStoredKey(keyMaterial);
      appendOutput('Key saved successfully.\n\n');
      appendOutput(PROMPT);
    },
    [appendOutput],
  );

  const finishKeyPaste = useCallback(async () => {
    const keyMaterial = keyPasteLinesRef.current.join('\n').trim();
    keyPasteLinesRef.current = [];
    setInput('');
    await saveKeyMaterial(keyMaterial);
  }, [saveKeyMaterial]);

  const startKeyPaste = useCallback(() => {
    keyPasteLinesRef.current = [];
    setInput('');
    setMode('keypaste');
    appendOutput("Paste your private key and type 'done' when finished:\n");
    inputRef.current?.focus();
  }, [appendOutput]);

  const listSshKeys = useCallback(async () => {
    const stored = await loadStoredKey();

    if (!stored?.key) {
      appendOutput('No stored keys.\n\n');
      appendOutput(PROMPT);
      return;
    }

    appendOutput(`1 key stored (added ${formatKeyDate(stored.addedAt)})\n\n`);
    appendOutput(PROMPT);
  }, [appendOutput]);

  const removeSshKey = useCallback(
    async (index) => {
      if (index == null || Number.isNaN(index)) {
        appendOutput('ssh-remove: missing index. Use: ssh-remove 1\n\n');
        appendOutput(PROMPT);
        return;
      }

      if (index !== 1) {
        appendOutput(`ssh-remove: invalid index ${index}\n\n`);
        appendOutput(PROMPT);
        return;
      }

      const stored = await loadStoredKey();
      if (!stored?.key) {
        appendOutput('No stored keys.\n\n');
        appendOutput(PROMPT);
        return;
      }

      await clearStoredKey();
      appendOutput('Key removed.\n\n');
      appendOutput(PROMPT);
    },
    [appendOutput],
  );

  const submitCommand = useCallback(async () => {
    if (mode === 'keypaste') {
      const line = input;
      setInput('');

      if (line.includes('\n')) {
        const lines = line.split('\n');
        while (lines.length && lines[lines.length - 1].trim() === '') {
          lines.pop();
        }
        if (lines.length && lines[lines.length - 1].trim().toLowerCase() === 'done') {
          lines.pop();
          keyPasteLinesRef.current.push(...lines);
          lines.forEach((entry) => appendOutput(`${entry}\n`));
          appendOutput('done\n');
          await finishKeyPaste();
          return;
        }
        keyPasteLinesRef.current.push(...lines);
        lines.forEach((entry) => appendOutput(`${entry}\n`));
        return;
      }

      if (line.trim().toLowerCase() === 'done') {
        appendOutput('done\n');
        await finishKeyPaste();
        return;
      }

      keyPasteLinesRef.current.push(line);
      appendOutput(`${line}\n`);
      return;
    }

    if (mode === 'password') {
      const password = input;
      const target = pending;
      setInput('');
      appendOutput('\n');

      if (!target) {
        setMode('local');
        appendOutput(PROMPT);
        return;
      }

      if (!target.keyAuthFailed) {
        appendOutput(`Connecting to ${target.host}:${target.port}...\n`);
      }

      try {
        await connectWithPassword(target, password);
      } catch (err) {
        const message = err?.message || String(err);
        appendOutput(`\nError: ${message}\n\n${PROMPT}`);
        sshClientRef.current = null;
        setMode('local');
        setPending(null);
      }
      return;
    }

    if (mode === 'ssh') {
      const line = input;
      const trimmed = line.trim().toLowerCase();
      if (trimmed === 'exit' || trimmed === 'logout') {
        writeToShell(`${line}\n`);
        setInput('');
        setTimeout(() => {
          appendOutput('\n');
          disconnect();
          appendOutput(PROMPT);
        }, 80);
        return;
      }
      writeToShell(`${line}\n`);
      setInput('');
      return;
    }

    const line = input;
    appendOutput(`${line}\n`);
    pushHistory(line);
    setInput('');

    const trimmed = line.trim();
    if (!trimmed) {
      appendOutput(PROMPT);
      return;
    }

    const lower = trimmed.toLowerCase();

    if (lower === 'ssh-add') {
      startKeyPaste();
      return;
    }

    if (lower === 'ssh-keys') {
      await listSshKeys();
      return;
    }

    const removeIndex = parseRemoveIndex(trimmed);
    if (removeIndex !== null || lower === 'ssh-remove') {
      await removeSshKey(removeIndex);
      return;
    }

    const parsed = parseSshCommand(line);
    if (parsed.type === 'ok') {
      await beginSshConnect({
        username: parsed.username,
        host: parsed.host,
        port: parsed.port,
      });
      return;
    }

    if (parsed.type === 'missing_username') {
      appendOutput('ssh: missing username. Use: ssh user@host\n\n');
      appendOutput(PROMPT);
      return;
    }

    if (parsed.type === 'invalid' || lower.startsWith('ssh')) {
      appendOutput('ssh: invalid syntax. Use: ssh user@host\n\n');
      appendOutput(PROMPT);
      return;
    }

    appendOutput(`${trimmed.split(/\s+/)[0]}: command not found\n\n`);
    appendOutput(PROMPT);
  }, [
    mode,
    input,
    pending,
    appendOutput,
    pushHistory,
    connectWithPassword,
    disconnect,
    writeToShell,
    startKeyPaste,
    finishKeyPaste,
    listSshKeys,
    removeSshKey,
    beginSshConnect,
  ]);

  const showInput = mode !== 'password';

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="light" />
      <ScrollView
        ref={scrollRef}
        style={styles.terminalScroll}
        contentContainerStyle={styles.terminalContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.terminalText} selectable>
          {output}
          {showInput ? input : ''}
          <Text style={{ opacity: cursorVisible ? 1 : 0 }}>▌</Text>
        </Text>
      </ScrollView>

      {Platform.OS === 'ios' ? (
        <InputAccessoryView nativeID={INPUT_ACCESSORY_ID}>
          <View style={styles.keyboardAccessory}>
            <Pressable
              onPress={() => Keyboard.dismiss()}
              style={styles.keyboardDoneButton}
            >
              <Text style={styles.keyboardDoneText}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}

      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={input}
        onChangeText={setInput}
        onSubmitEditing={submitCommand}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        blurOnSubmit={false}
        keyboardType="ascii-capable"
        secureTextEntry={mode === 'password'}
        contextMenuHidden={mode === 'password'}
        inputAccessoryViewID={
          Platform.OS === 'ios' ? INPUT_ACCESSORY_ID : undefined
        }
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
  },
  terminalScroll: {
    flex: 1,
  },
  terminalContent: {
    paddingTop: 56,
    paddingHorizontal: 12,
    paddingBottom: 24,
  },
  terminalText: {
    color: FG,
    fontFamily: MONO_FONT,
    fontSize: 14,
    lineHeight: 20,
  },
  hiddenInput: {
    height: 44,
    paddingHorizontal: 12,
    color: FG,
    backgroundColor: BG,
    fontFamily: MONO_FONT,
    fontSize: 14,
  },
  keyboardAccessory: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    backgroundColor: '#1c1c1e',
    borderTopWidth: 1,
    borderTopColor: '#3a3a3c',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  keyboardDoneButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  keyboardDoneText: {
    color: '#0a84ff',
    fontSize: 17,
    fontWeight: '600',
  },
});
