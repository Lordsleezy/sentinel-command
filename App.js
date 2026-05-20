import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import SSHClient from '@dylankenneally/react-native-ssh-sftp';

const APP_VERSION = '1.0';
const PROMPT = '> ';
const BG = '#000000';
const FG = '#f0f0f0';
const MAX_HISTORY = 50;

const STARTUP_TEXT =
  `Forge Lite v${APP_VERSION}\n` +
  "Type 'ssh user@host' to connect.\n\n";

const TOOLBAR_KEYS = [
  { id: 'tab', label: 'Tab', value: '\t' },
  { id: 'esc', label: 'Esc', value: '\x1b' },
  { id: 'ctrl', label: 'Ctrl', value: null },
  { id: 'up', label: '↑', value: '\x1b[A' },
  { id: 'down', label: '↓', value: '\x1b[B' },
  { id: 'left', label: '←', value: '\x1b[D' },
  { id: 'right', label: '→', value: '\x1b[C' },
  { id: 'pipe', label: '|', value: '|' },
  { id: 'slash', label: '/', value: '/' },
];

function ctrlChar(key) {
  const upper = key.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code >= 65 && code <= 90) {
    return String.fromCharCode(code - 64);
  }
  if (key === '[') return '\x1b';
  if (key === '\\') return '\x1c';
  if (key === ']') return '\x1d';
  if (key === '^') return '\x1e';
  if (key === '_') return '\x1f';
  return null;
}

function parseSshCommand(line) {
  const trimmed = line.trim();
  if (!trimmed.toLowerCase().startsWith('ssh ')) {
    return null;
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

  if (parts.length !== 1 || !parts[0].includes('@')) {
    return null;
  }

  const at = parts[0].indexOf('@');
  const username = parts[0].slice(0, at);
  const host = parts[0].slice(at + 1);

  if (!username || !host) {
    return null;
  }

  return { username, host, port };
}

export default function App() {
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const sshClientRef = useRef(null);
  const historyRef = useRef([]);
  const historyBrowseRef = useRef(-1);

  const [mode, setMode] = useState('local');
  const [output, setOutput] = useState(STARTUP_TEXT);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(null);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [ctrlArmed, setCtrlArmed] = useState(false);

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
    historyBrowseRef.current = next.length;
  }, []);

  const recallHistory = useCallback((direction) => {
    const history = historyRef.current;
    if (history.length === 0) return;

    if (direction === 'up') {
      if (historyBrowseRef.current <= 0) {
        historyBrowseRef.current = 0;
      } else {
        historyBrowseRef.current -= 1;
      }
    } else if (historyBrowseRef.current >= history.length - 1) {
      historyBrowseRef.current = history.length;
      setInput('');
      return;
    } else {
      historyBrowseRef.current += 1;
    }

    if (historyBrowseRef.current >= history.length) {
      setInput('');
      return;
    }

    setInput(history[historyBrowseRef.current]);
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
    historyBrowseRef.current = historyRef.current.length;
  }, []);

  const connectSSH = useCallback(
    async ({ username, host, port }, password) => {
      const client = await SSHClient.connectWithPassword(
        host,
        port,
        username,
        password,
      );

      client.on('Shell', (data) => {
        if (data) appendOutput(data);
      });

      await client.startShell('vanilla');
      sshClientRef.current = client;
      setMode('ssh');
      setPending(null);
      setInput('');
      historyBrowseRef.current = historyRef.current.length;
    },
    [appendOutput],
  );

  const submitCommand = useCallback(async () => {
    if (mode === 'password') {
      const password = input;
      const target = pending;
      setInput('');
      appendOutput('\n');

      if (!target) {
        setMode('local');
        return;
      }

      appendOutput(`Connecting to ${target.host}:${target.port}...\n`);

      try {
        await connectSSH(target, password);
      } catch (err) {
        const message = err?.message || String(err);
        appendOutput(`\nError: ${message}\n\n`);
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
        }, 80);
        return;
      }
      writeToShell(`${line}\n`);
      setInput('');
      return;
    }

    const line = input;
    appendOutput(`${PROMPT}${line}\n`);
    pushHistory(line);
    setInput('');
    historyBrowseRef.current = historyRef.current.length;

    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const sshTarget = parseSshCommand(line);
    if (sshTarget) {
      setPending(sshTarget);
      setMode('password');
      appendOutput(`${sshTarget.username}@${sshTarget.host}'s password: `);
      return;
    }

    appendOutput(
      `forge-lite: command not found: ${trimmed.split(/\s+/)[0]}\n` +
        "Type 'ssh user@host' to connect.\n\n",
    );
  }, [
    mode,
    input,
    pending,
    appendOutput,
    pushHistory,
    connectSSH,
    disconnect,
    writeToShell,
  ]);

  const handleToolbarPress = useCallback(
    (key) => {
      if (key.id === 'ctrl') {
        setCtrlArmed((armed) => !armed);
        return;
      }

      if (key.id === 'up' && mode === 'local') {
        recallHistory('up');
        setCtrlArmed(false);
        inputRef.current?.focus();
        return;
      }

      if (key.id === 'down' && mode === 'local') {
        recallHistory('down');
        setCtrlArmed(false);
        inputRef.current?.focus();
        return;
      }

      if (mode === 'ssh' && key.value) {
        writeToShell(key.value);
        setCtrlArmed(false);
        inputRef.current?.focus();
        return;
      }

      if (mode === 'local' && key.value && key.id !== 'up' && key.id !== 'down') {
        setInput((prev) => prev + key.value);
        setCtrlArmed(false);
        inputRef.current?.focus();
      }
    },
    [mode, recallHistory, writeToShell],
  );

  const handleInputChange = useCallback(
    (text) => {
      if (mode === 'ssh' && ctrlArmed && text.length > input.length) {
        const added = text.slice(input.length);
        const lastChar = added[added.length - 1];
        const control = ctrlChar(lastChar);
        if (control) {
          writeToShell(control);
          setCtrlArmed(false);
          return;
        }
      }
      setInput(text);
      if (mode === 'local') {
        historyBrowseRef.current = historyRef.current.length;
      }
    },
    [mode, input, ctrlArmed, writeToShell],
  );

  const linePrompt = mode === 'local' ? PROMPT : '';

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
          {linePrompt}
          {mode === 'password' ? '' : input}
          <Text style={{ opacity: cursorVisible ? 1 : 0 }}>▌</Text>
        </Text>
      </ScrollView>

      <View style={styles.toolbar}>
        {TOOLBAR_KEYS.map((key) => (
          <Pressable
            key={key.id}
            style={[
              styles.toolbarKey,
              key.id === 'ctrl' && ctrlArmed && styles.toolbarKeyActive,
            ]}
            onPress={() => handleToolbarPress(key)}
          >
            <Text style={styles.toolbarKeyText}>{key.label}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={input}
        onChangeText={handleInputChange}
        onSubmitEditing={submitCommand}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        blurOnSubmit={false}
        keyboardType="ascii-capable"
        secureTextEntry={mode === 'password'}
        contextMenuHidden={mode === 'password'}
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
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
    lineHeight: 20,
  },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderTopColor: '#333333',
    backgroundColor: '#0a0a0a',
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  toolbarKey: {
    minWidth: 44,
    paddingHorizontal: 10,
    paddingVertical: 10,
    margin: 2,
    borderWidth: 1,
    borderColor: '#333333',
    borderRadius: 4,
    alignItems: 'center',
  },
  toolbarKeyActive: {
    backgroundColor: '#333333',
  },
  toolbarKeyText: {
    color: FG,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    fontWeight: '600',
  },
  hiddenInput: {
    height: 44,
    paddingHorizontal: 12,
    color: FG,
    backgroundColor: '#0a0a0a',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
    borderTopWidth: 1,
    borderTopColor: '#333333',
  },
});
