import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import SSHClient from '@dylankenneally/react-native-ssh-sftp';

const PROMPT = 'PS > ';
const BG = '#012456';
const FG = '#CCCCCC';
const MAX_HISTORY = 50;

const STARTUP_TEXT =
  'Windows PowerShell\n' +
  'Copyright (C) Sentinel Prime. All rights reserved.\n\n' +
  'Install the latest Sentinel: https://sentinelprime.org\n\n' +
  PROMPT;

const MONO_FONT = Platform.select({
  ios: 'Courier New',
  android: 'monospace',
  default: 'monospace',
});

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

export default function App() {
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const sshClientRef = useRef(null);
  const historyRef = useRef([]);

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

    const parsed = parseSshCommand(line);
    if (parsed.type === 'ok') {
      setPending({
        username: parsed.username,
        host: parsed.host,
        port: parsed.port,
      });
      setMode('password');
      appendOutput(`${parsed.username}@${parsed.host}'s password: `);
      return;
    }

    if (parsed.type === 'missing_username') {
      appendOutput('ssh: missing username. Use: ssh user@host\n\n');
      appendOutput(PROMPT);
      return;
    }

    if (parsed.type === 'invalid' || trimmed.toLowerCase().startsWith('ssh')) {
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
    connectSSH,
    disconnect,
    writeToShell,
  ]);

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
          {mode === 'password' ? '' : input}
          <Text style={{ opacity: cursorVisible ? 1 : 0 }}>▌</Text>
        </Text>
      </ScrollView>

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
});
