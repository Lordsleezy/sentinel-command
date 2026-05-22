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
  '  ssh-add              Import SSH PRIVATE key (id_ed25519, NOT .pub)\n' +
  '  ssh-keys             List stored keys\n' +
  '  ssh-show             Preview stored private key\n' +
  "  ssh-remove [n]       Remove a stored key\n" +
  '  ssh-debug            Show key auth diagnostics\n\n' +
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

async function saveStoredKey(keyMaterial, publicKey = null) {
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      key: keyMaterial,
      publicKey,
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

function normalizeNewlines(key) {
  return key.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function stripPemHeaders(key, label) {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  return key.replace(begin, '').replace(end, '').trim();
}

function isRsaAsn1Body(body) {
  const cleaned = body.replace(/\s/g, '');
  return cleaned.startsWith('MII') && /^[A-Za-z0-9+/=\s]+$/.test(cleaned);
}

function isOpensshKeyBody(body) {
  const cleaned = body.replace(/\s/g, '');
  if (cleaned.startsWith('b3BlbnNzaC1rZXk')) {
    return true;
  }

  try {
    if (typeof globalThis.atob === 'function') {
      const decoded = globalThis.atob(cleaned.slice(0, 24));
      return decoded.startsWith('openssh-key-v1');
    }
  } catch {
    return false;
  }

  return false;
}

function repairMangledKey(key) {
  if (!key.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    return key;
  }

  const body = stripPemHeaders(key, 'OPENSSH PRIVATE KEY');
  if (!isRsaAsn1Body(body)) {
    return key;
  }

  console.warn('[ForgeLite wrapKey] repairing mangled key: RSA body inside OpenSSH headers');
  return `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
}

function detectKeyType(privateKey) {
  if (privateKey.includes('OPENSSH PRIVATE KEY')) return 'openssh';
  if (privateKey.includes('RSA PRIVATE KEY')) return 'rsa-pem';
  if (privateKey.includes('EC PRIVATE KEY')) return 'ecdsa-pem';
  if (privateKey.includes('DSA PRIVATE KEY')) return 'dsa-pem';
  if (privateKey.includes('ENCRYPTED PRIVATE KEY')) return 'pkcs8-encrypted';
  if (isRsaAsn1Body(privateKey)) return 'rsa-pem-body';
  if (isOpensshKeyBody(privateKey)) return 'openssh-body';
  return 'unknown';
}

function wrapKey(raw) {
  let key = normalizeNewlines(raw);
  if (!key) {
    console.log('[ForgeLite wrapKey] empty input');
    return '';
  }

  key = repairMangledKey(key);

  const inputType = detectKeyType(key);
  const inputFirstLine = key.split('\n')[0];
  let wrapped = false;

  console.log('[ForgeLite wrapKey] input', {
    detectedType: inputType,
    firstLine: inputFirstLine,
  });

  if (key.includes('-----BEGIN RSA PRIVATE KEY-----')) {
    const result = key;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: 'rsa-pem',
      conversion: false,
      finalFirstLine: result.split('\n')[0],
    });
    return result;
  }

  if (key.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    const result = key;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: 'openssh',
      conversion: false,
      finalFirstLine: result.split('\n')[0],
    });
    return result;
  }

  if (key.includes('-----BEGIN EC PRIVATE KEY-----')) {
    const result = key;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: 'ecdsa-pem',
      conversion: false,
      finalFirstLine: result.split('\n')[0],
    });
    return result;
  }

  if (key.includes('-----BEGIN DSA PRIVATE KEY-----')) {
    const result = key;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: 'dsa-pem',
      conversion: false,
      finalFirstLine: result.split('\n')[0],
    });
    return result;
  }

  if (key.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')) {
    const result = key;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: 'pkcs8-encrypted',
      conversion: false,
      finalFirstLine: result.split('\n')[0],
    });
    return result;
  }

  if (/-----BEGIN [^-]+-----/.test(key)) {
    const result = key;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: inputType,
      conversion: false,
      finalFirstLine: result.split('\n')[0],
    });
    return result;
  }

  const body = key.replace(/\s/g, '');

  if (isRsaAsn1Body(body)) {
    wrapped = true;
    key = `-----BEGIN RSA PRIVATE KEY-----\n${key}\n-----END RSA PRIVATE KEY-----`;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: 'rsa-pem',
      conversion: true,
      wrapping: 'rsa-pem-headers-added',
      finalFirstLine: key.split('\n')[0],
    });
    return key;
  }

  if (isOpensshKeyBody(body)) {
    wrapped = true;
    key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${key}\n-----END OPENSSH PRIVATE KEY-----`;
    console.log('[ForgeLite wrapKey] result', {
      detectedType: 'openssh',
      conversion: true,
      wrapping: 'openssh-headers-added',
      finalFirstLine: key.split('\n')[0],
    });
    return key;
  }

  wrapped = true;
  key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${key}\n-----END OPENSSH PRIVATE KEY-----`;
  console.log('[ForgeLite wrapKey] result', {
    detectedType: inputType,
    conversion: wrapped,
    wrapping: 'openssh-headers-added-default',
    finalFirstLine: key.split('\n')[0],
  });
  return key;
}

function decodeBase64(str) {
  const cleaned = str.replace(/\s/g, '');
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  throw new Error('Base64 decode unavailable in this runtime');
}

function readSshString(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  const length = view.getUint32(0);
  const start = offset + 4;
  const value = bytes.slice(start, start + length);
  return { value, next: start + length };
}

function encodeSshPublicLine(keyType, keyBytes) {
  const typeBytes = new TextEncoder().encode(keyType);
  const wire = new Uint8Array(4 + typeBytes.length + 4 + keyBytes.length);
  const view = new DataView(wire.buffer);
  let offset = 0;
  view.setUint32(offset, typeBytes.length);
  offset += 4;
  wire.set(typeBytes, offset);
  offset += typeBytes.length;
  view.setUint32(offset, keyBytes.length);
  offset += 4;
  wire.set(keyBytes, offset);

  let binary = '';
  for (let i = 0; i < wire.length; i += 1) {
    binary += String.fromCharCode(wire[i]);
  }
  const encoded = globalThis.btoa(binary);
  return `${keyType} ${encoded}`;
}

function extractPublicKeyFromOpenSSH(privateKey) {
  const body = privateKey
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '');
  const data = decodeBase64(body);
  const magic = new TextDecoder().decode(data.slice(0, 15));
  if (!magic.startsWith('openssh-key-v1')) {
    throw new Error('Not an OpenSSH private key (openssh-key-v1)');
  }

  let offset = 15;
  let part = readSshString(data, offset);
  offset = part.next;
  part = readSshString(data, offset);
  offset = part.next;
  part = readSshString(data, offset);
  offset = part.next;

  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  const keyCount = view.getUint32(0);
  offset += 4;
  if (keyCount < 1) {
    throw new Error('OpenSSH key blob contains no public keys');
  }

  part = readSshString(data, offset);
  offset = part.next;
  const publicSection = part.value;

  let sectionOffset = 0;
  part = readSshString(publicSection, sectionOffset);
  const keyType = new TextDecoder().decode(part.value);
  sectionOffset = part.next;
  part = readSshString(publicSection, sectionOffset);
  const publicKeyBytes = part.value;

  return encodeSshPublicLine(keyType, publicKeyBytes);
}

function extractPublicKeyFromPrivateKey(privateKey) {
  const keyType = detectKeyType(privateKey);
  if (keyType === 'openssh') {
    return extractPublicKeyFromOpenSSH(privateKey);
  }
  return null;
}

function formatAuthError(error) {
  if (error == null) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string' && error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function classifyAuthFailure(message) {
  const lower = message.toLowerCase();
  if (
    lower.includes('authentication') ||
    lower.includes('auth failed') ||
    lower.includes('not authorized') ||
    lower.includes('permission denied')
  ) {
    return 'server-rejected-or-auth-failed';
  }
  if (
    lower.includes('parse') ||
    lower.includes('invalid key') ||
    lower.includes('not an openssh') ||
    lower.includes('base64') ||
    lower.includes('decode')
  ) {
    return 'client-parse-failure';
  }
  if (lower.includes('connect') || lower.includes('timeout') || lower.includes('network')) {
    return 'connection-failure';
  }
  return 'unknown';
}

function diagnoseStoredKey(privateKey, publicKey) {
  const lines = privateKey.split('\n');
  return {
    firstLine: lines[0] || '(empty)',
    lastLine: lines[lines.length - 1] || '(empty)',
    totalLength: privateKey.length,
    lineCount: lines.length,
    hasLiteralBackslashN: privateKey.includes('\\n'),
    hasCrlf: privateKey.includes('\r'),
    keyType: detectKeyType(privateKey),
    publicKeyExtracted: Boolean(publicKey),
    publicKeyPreview: publicKey
      ? `${publicKey.split(/\s+/)[0]} ${(publicKey.split(/\s+/)[1] || '').slice(0, 24)}...`
      : '(none)',
  };
}

function connectWithKeyPair(host, port, username, keyPair) {
  return new Promise((resolve, reject) => {
    const client = new SSHClient(host, port, username, keyPair, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(client);
    });
  });
}

async function prepareKeyAuth(stored) {
  const privateKey = wrapKey(stored.key);

  if (privateKey !== stored.key) {
    await saveStoredKey(privateKey, stored.publicKey);
  }

  let publicKey = stored.publicKey || null;
  let publicKeySource = stored.publicKey ? 'stored' : 'none';

  if (!publicKey) {
    try {
      publicKey = extractPublicKeyFromPrivateKey(privateKey);
      if (publicKey) {
        publicKeySource = 'extracted';
      }
    } catch (error) {
      return {
        privateKey,
        publicKey: null,
        publicKeySource: 'extraction-failed',
        keyType: detectKeyType(privateKey),
        extractionError: formatAuthError(error),
        diagnostics: diagnoseStoredKey(privateKey, null),
      };
    }
  }

  let nativeKeyDetails = null;
  try {
    nativeKeyDetails = await SSHClient.getKeyDetails(privateKey);
  } catch (error) {
    nativeKeyDetails = { error: formatAuthError(error) };
  }

  return {
    privateKey,
    publicKey,
    publicKeySource,
    keyType: detectKeyType(privateKey),
    nativeKeyDetails,
    diagnostics: diagnoseStoredKey(privateKey, publicKey),
  };
}

function isPublicKeyContent(keyContent) {
  if (/-----BEGIN.*PRIVATE KEY-----/.test(keyContent)) {
    return false;
  }

  return (
    keyContent.includes('ssh-ed25519') ||
    keyContent.includes('ssh-rsa') ||
    keyContent.includes('ssh-ecdsa')
  );
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
  const lastAuthDebugRef = useRef(null);
  const lastSshTargetRef = useRef(null);

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
    async (target, authPrep, passphrase = '') => {
      const keyPair = {
        privateKey: authPrep.privateKey,
        passphrase,
      };

      if (authPrep.publicKey) {
        keyPair.publicKey = authPrep.publicKey;
      }

      console.log('[ForgeLite SSH] connectWithKey', {
        host: target.host,
        port: target.port,
        username: target.username,
        authMethod: 'publickey',
        keyType: authPrep.keyType,
        publicKeySource: authPrep.publicKeySource,
        privateKeyFirstLine: authPrep.diagnostics.firstLine,
        privateKeyLength: authPrep.diagnostics.totalLength,
        publicKeyPreview: authPrep.diagnostics.publicKeyPreview,
      });

      const client = await connectWithKeyPair(
        target.host,
        target.port,
        target.username,
        keyPair,
      );
      await establishShell(client);
    },
    [establishShell],
  );

  const reportKeyAuthFailure = useCallback(
    (error, target, authPrep) => {
      const message = formatAuthError(error);
      const failureClass = classifyAuthFailure(message);
      const debug = {
        message,
        failureClass,
        authMethod: 'publickey',
        target: `${target.username}@${target.host}:${target.port}`,
        keyType: authPrep.keyType,
        publicKeySource: authPrep.publicKeySource,
        extractionError: authPrep.extractionError || null,
        nativeKeyDetails: authPrep.nativeKeyDetails || null,
        diagnostics: authPrep.diagnostics,
        rawError: error,
      };

      lastAuthDebugRef.current = debug;
      console.error('[ForgeLite SSH] key auth failed', debug);

      appendOutput(`Key auth failed: ${message}\n`);
      appendOutput(`  failure class: ${failureClass}\n`);
      appendOutput(`  auth method: publickey\n`);
      appendOutput(`  key type: ${authPrep.keyType}\n`);
      appendOutput(`  public key: ${authPrep.publicKeySource}\n`);
      if (authPrep.extractionError) {
        appendOutput(`  public key extraction: ${authPrep.extractionError}\n`);
      }
      if (authPrep.nativeKeyDetails?.keyType) {
        appendOutput(
          `  native parser: ${authPrep.nativeKeyDetails.keyType}` +
            `${authPrep.nativeKeyDetails.keySize ? ` (${authPrep.nativeKeyDetails.keySize})` : ''}\n`,
        );
      } else if (authPrep.nativeKeyDetails?.error) {
        appendOutput(`  native parser: ${authPrep.nativeKeyDetails.error}\n`);
      }
      appendOutput(`  Run ssh-debug for full details.\n`);
    },
    [appendOutput],
  );

  const beginSshConnect = useCallback(
    async (target) => {
      lastSshTargetRef.current = target;
      const stored = await loadStoredKey();

      if (stored?.key) {
        appendOutput(`Connecting to ${target.host}:${target.port}...\n`);

        const authPrep = await prepareKeyAuth(stored);
        if (authPrep.extractionError && authPrep.keyType === 'openssh') {
          reportKeyAuthFailure(
            new Error(`Public key extraction failed: ${authPrep.extractionError}`),
            target,
            authPrep,
          );
          setPending({ ...target, keyAuthFailed: true });
          setMode('password');
          appendOutput(
            `Password for ${target.username}@${target.host}: `,
          );
          return;
        }

        try {
          await connectWithKey(target, authPrep);
          return;
        } catch (error) {
          reportKeyAuthFailure(error, target, authPrep);
          setPending({ ...target, keyAuthFailed: true });
          setMode('password');
          appendOutput(
            `Password for ${target.username}@${target.host}: `,
          );
          return;
        }
      }

      setPending(target);
      setMode('password');
      appendOutput(`${target.username}@${target.host}'s password: `);
    },
    [appendOutput, connectWithKey, reportKeyAuthFailure],
  );

  const saveKeyMaterial = useCallback(
    async (rawKeyMaterial) => {
      setMode('local');

      const keyMaterial = wrapKey(rawKeyMaterial);

      if (!keyMaterial) {
        appendOutput('Error: no key provided.\n\n');
        appendOutput(PROMPT);
        return;
      }

      if (isPublicKeyContent(keyMaterial)) {
        appendOutput('\nError: that is a PUBLIC key, not a private key.\n');
        appendOutput('You need the PRIVATE key file: id_ed25519 (no .pub extension)\n');
        appendOutput('On your PC run: cat ~/.ssh/id_ed25519\n\n');
        appendOutput(PROMPT);
        return;
      }

      let publicKey = null;

      try {
        publicKey = extractPublicKeyFromPrivateKey(keyMaterial);
      } catch (error) {
        appendOutput(
          `Warning: could not extract public key (${formatAuthError(error)}).\n`,
        );
      }

      await saveStoredKey(keyMaterial, publicKey);
      appendOutput('Key saved successfully.\n');
      appendOutput(`  type: ${detectKeyType(keyMaterial)}\n`);
      appendOutput(
        `  public key: ${publicKey ? 'extracted and stored' : 'not extracted'}\n\n`,
      );
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
    appendOutput(
      'Note: Use your PRIVATE key (id_ed25519 or id_rsa, never the .pub file)\n' +
        'On your PC: cat ~/.ssh/id_ed25519\n' +
        "Paste your private key content and type 'done' when finished:\n",
    );
    inputRef.current?.focus();
  }, [appendOutput]);

  const runSshDebug = useCallback(async () => {
    const stored = await loadStoredKey();
    const target = lastSshTargetRef.current;

    appendOutput('=== ssh-debug ===\n');

    if (!stored?.key) {
      appendOutput('No stored private key.\n\n');
      appendOutput(PROMPT);
      return;
    }

    const authPrep = await prepareKeyAuth(stored);
    appendOutput(`stored key first line: ${authPrep.diagnostics.firstLine}\n`);
    appendOutput(`stored key last line: ${authPrep.diagnostics.lastLine}\n`);
    appendOutput(`stored key length: ${authPrep.diagnostics.totalLength}\n`);
    appendOutput(
      `literal \\n present: ${authPrep.diagnostics.hasLiteralBackslashN ? 'yes' : 'no'}\n`,
    );
    appendOutput(`key type detected: ${authPrep.keyType}\n`);
    appendOutput(`public key source: ${authPrep.publicKeySource}\n`);
    appendOutput(`public key preview: ${authPrep.diagnostics.publicKeyPreview}\n`);

    if (authPrep.extractionError) {
      appendOutput(`public key extraction error: ${authPrep.extractionError}\n`);
    }

    if (authPrep.nativeKeyDetails?.keyType) {
      appendOutput(
        `native getKeyDetails: ${authPrep.nativeKeyDetails.keyType}` +
          `${authPrep.nativeKeyDetails.keySize ? ` (${authPrep.nativeKeyDetails.keySize})` : ''}\n`,
      );
    } else if (authPrep.nativeKeyDetails?.error) {
      appendOutput(`native getKeyDetails: ${authPrep.nativeKeyDetails.error}\n`);
    }

    if (target) {
      appendOutput(
        `last connection target: ${target.username}@${target.host}:${target.port}\n`,
      );
    } else {
      appendOutput('last connection target: (none — run ssh user@host first)\n');
    }

    appendOutput('auth method: publickey\n');

    if (lastAuthDebugRef.current) {
      appendOutput(`last auth failure class: ${lastAuthDebugRef.current.failureClass}\n`);
      appendOutput(`last raw SSH error: ${lastAuthDebugRef.current.message}\n`);
    } else {
      appendOutput('last raw SSH error: (none — no failed attempt this session)\n');
    }

    appendOutput(
      'library: @dylankenneally/react-native-ssh-sftp (iOS NMSSH/libssh2)\n',
    );
    appendOutput('=== end ssh-debug ===\n\n');
    appendOutput(PROMPT);
  }, [appendOutput]);

  const showStoredKey = useCallback(async () => {
    const stored = await loadStoredKey();

    if (!stored?.key) {
      appendOutput('\nNo key stored.\n\n');
      appendOutput(PROMPT);
      return;
    }

    const storedKey = stored.key;
    const lines = storedKey.split('\n');
    const lineCount = lines.length;
    const firstLines = lines.slice(0, 3).join('\n');
    const lastLines = lines.slice(Math.max(0, lineCount - 3)).join('\n');
    const processedKey = wrapKey(storedKey);
    const storedType = detectKeyType(storedKey);
    const effectiveType = detectKeyType(processedKey);
    const wasRepaired = processedKey !== storedKey;

    appendOutput('\nStored key preview:\n');
    appendOutput(`--- first 3 lines ---\n${firstLines}\n`);
    appendOutput(`--- last 3 lines ---\n${lastLines}\n`);
    appendOutput(`(${lineCount} lines)\n`);
    appendOutput(`stored key type: ${storedType}\n`);
    appendOutput(`effective key type: ${effectiveType}\n`);
    if (wasRepaired) {
      appendOutput('note: key will be repaired on use (RSA body was in OpenSSH headers)\n');
      appendOutput(`repaired first line: ${processedKey.split('\n')[0]}\n`);
    }
    appendOutput('\n');
    appendOutput(PROMPT);
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

    if (lower === 'ssh-show') {
      await showStoredKey();
      return;
    }

    if (lower === 'ssh-debug') {
      await runSshDebug();
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
    showStoredKey,
    runSshDebug,
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
